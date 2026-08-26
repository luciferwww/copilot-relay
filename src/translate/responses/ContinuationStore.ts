import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { CompletedContinuationItem, ContinuationCall } from './types.js';

const RECORD_VERSION = 1;
const DEFAULT_RECORD_MAX_BYTES = 2 * 1024 * 1024 + 64 * 1024;
const DEFAULT_DIRECTORY_ENTRY_MAX = 1024;
const OWNER_FILE = '.owner';
const OWNER_MAX_BYTES = 1024;
const OWNER_KEYS = ['version', 'pid', 'nonce'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RECORD_KEYS = [
  'version',
  'groupId',
  'modelId',
  'createdAt',
  'lastAccessedAt',
  'expiresAt',
  'items',
  'calls',
] as const;

export interface PersistedContinuationGroupV1 {
  readonly version: 1;
  readonly groupId: string;
  readonly modelId: string;
  readonly createdAt: number;
  readonly lastAccessedAt: number;
  readonly expiresAt: number;
  readonly items: readonly CompletedContinuationItem[];
  readonly calls: readonly (readonly [string, ContinuationCall])[];
}

export interface ContinuationStoreLike {
  load(): PersistedContinuationGroupV1[];
  write(record: PersistedContinuationGroupV1): void;
  remove(groupId: string): void;
  close?(): void;
}

export interface ContinuationStoreOptions {
  recordMaxBytes?: number;
  directoryEntryMax?: number;
  processId?: number;
  randomId?: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

interface ContinuationStoreOwnerV1 {
  readonly version: 1;
  readonly pid: number;
  readonly nonce: string;
}

export class ContinuationStore implements ContinuationStoreLike {
  private readonly recordMaxBytes: number;
  private readonly directoryEntryMax: number;
  private readonly processId: number;
  private readonly randomId: () => string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private owner?: ContinuationStoreOwnerV1;

  constructor(
    private readonly directory: string,
    options: ContinuationStoreOptions = {},
  ) {
    this.recordMaxBytes = options.recordMaxBytes ?? DEFAULT_RECORD_MAX_BYTES;
    this.directoryEntryMax = options.directoryEntryMax ?? DEFAULT_DIRECTORY_ENTRY_MAX;
    this.processId = options.processId ?? process.pid;
    this.randomId = options.randomId ?? randomUUID;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    if (!Number.isSafeInteger(this.processId) || this.processId <= 0) {
      throw new Error('Continuation store owner process id is invalid.');
    }
    this.ensureDirectory();
    this.acquireOwnership();
  }

  load(): PersistedContinuationGroupV1[] {
    this.ensureDirectory();
    this.assertOwnership();
    const entries = readdirSync(this.directory, { withFileTypes: true });
    if (entries.length > this.directoryEntryMax) {
      throw new Error('Continuation store contains too many directory entries.');
    }

    const records: PersistedContinuationGroupV1[] = [];
    for (const entry of entries) {
      const path = join(this.directory, entry.name);
      if (entry.name.startsWith('.tmp-')) {
        this.removePath(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const expectedGroupId = basename(entry.name, '.json');
      if (!isUuid(expectedGroupId)) {
        this.removePath(path);
        continue;
      }
      const metadata = lstatSync(path);
      if (!metadata.isFile()) continue;
      if (metadata.size <= 0 || metadata.size > this.recordMaxBytes) {
        this.removePath(path);
        continue;
      }
      this.protectFile(path);
      const text = readFileSync(path, 'utf8');
      try {
        const record = parseRecord(text);
        if (record.groupId !== expectedGroupId) {
          throw new Error('Continuation record filename mismatch.');
        }
        records.push(record);
      } catch {
        this.removePath(path);
      }
    }
    return records;
  }

  write(record: PersistedContinuationGroupV1): void {
    this.ensureDirectory();
    this.assertOwnership();
    if (!isValidRecord(record) || record.version !== RECORD_VERSION) {
      throw new Error('Invalid continuation record.');
    }
    const body = JSON.stringify(record);
    if (Buffer.byteLength(body, 'utf8') > this.recordMaxBytes) {
      throw new Error('Continuation record exceeds the size limit.');
    }

    const target = this.recordPath(record.groupId);
    const temporary = join(this.directory, `.tmp-${randomUUID()}`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      this.protectFile(temporary);
      writeFileSync(descriptor, body, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, target);
      this.flushDirectory();
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      this.removePath(temporary);
      throw error;
    }
  }

  remove(groupId: string): void {
    this.ensureDirectory();
    this.assertOwnership();
    const path = this.recordPath(groupId);
    if (existsSync(path)) rmSync(path, { force: true });
  }

  close(): void {
    const owner = this.owner;
    if (!owner) return;
    try {
      const current = this.readOwner();
      if (current && current.pid === owner.pid && current.nonce === owner.nonce) {
        unlinkSync(this.ownerPath());
        this.flushDirectory();
      }
    } catch {
      // Ownership may already have been lost; never remove a non-matching owner.
    } finally {
      this.owner = undefined;
    }
  }

  private recordPath(groupId: string): string {
    if (!isUuid(groupId)) throw new Error('Invalid continuation group id.');
    return join(this.directory, `${groupId}.json`);
  }

  private ownerPath(): string {
    return join(this.directory, OWNER_FILE);
  }

  private acquireOwnership(): void {
    const owner: ContinuationStoreOwnerV1 = {
      version: 1,
      pid: this.processId,
      nonce: this.randomId(),
    };
    if (!isUuid(owner.nonce)) throw new Error('Continuation store owner nonce is invalid.');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        this.createOwner(owner);
        this.owner = owner;
        return;
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
      }
      const current = this.readOwner();
      if (!current) throw new Error('Continuation store ownership record is invalid.');
      if (this.isProcessAlive(current.pid)) {
        throw new Error('Continuation store is already owned by another relay process.');
      }

      const claimPath = join(this.directory, `.tmp-owner-claim-${randomUUID()}`);
      try {
        renameSync(this.ownerPath(), claimPath);
      } catch (error) {
        if (hasCode(error, 'ENOENT')) continue;
        throw error;
      }
      const claimed = this.readOwner(claimPath);
      if (!claimed || claimed.pid !== current.pid || claimed.nonce !== current.nonce) {
        this.restoreClaim(claimPath);
        continue;
      }
      try {
        this.createOwner(owner);
        this.owner = owner;
        return;
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
      } finally {
        this.removePath(claimPath);
      }
    }
    throw new Error('Continuation store ownership could not be acquired.');
  }

  private createOwner(owner: ContinuationStoreOwnerV1): void {
    const path = this.ownerPath();
    const candidate = join(this.directory, `.tmp-owner-${randomUUID()}`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidate, 'wx', 0o600);
      this.protectFile(candidate);
      writeFileSync(descriptor, JSON.stringify(owner), 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      linkSync(candidate, path);
      this.flushDirectory();
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    } finally {
      this.removePath(candidate);
    }
  }

  private assertOwnership(): void {
    const owner = this.owner;
    const current = this.readOwner();
    if (!owner || !current || current.pid !== owner.pid || current.nonce !== owner.nonce) {
      throw new Error('Continuation store ownership is unavailable.');
    }
  }

  private readOwner(path = this.ownerPath()): ContinuationStoreOwnerV1 | undefined {
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > OWNER_MAX_BYTES) {
      return undefined;
    }
    this.protectFile(path);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
    if (
      !isRecord(value) ||
      !hasExactKeys(value, OWNER_KEYS) ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      !isUuid(value.nonce)
    ) {
      return undefined;
    }
    return value as unknown as ContinuationStoreOwnerV1;
  }

  private restoreClaim(claimPath: string): void {
    try {
      linkSync(claimPath, this.ownerPath());
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    } finally {
      this.removePath(claimPath);
    }
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Continuation store path must be a directory.');
    }
    if (process.platform !== 'win32') chmodSync(this.directory, 0o700);
  }

  private protectFile(path: string): void {
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  }

  private flushDirectory(): void {
    if (process.platform === 'win32') return;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.directory, 'r');
      fsyncSync(descriptor);
    } catch {
      // The record itself is already durable; some filesystems do not support directory fsync.
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private removePath(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      // A later startup will retry cleanup; rejected files are never returned as live records.
    }
  }
}

function parseRecord(text: string): PersistedContinuationGroupV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Malformed continuation record JSON.');
  }
  if (!isValidRecord(value)) throw new Error('Invalid continuation record schema.');
  return value;
}

function isValidRecord(value: unknown): value is PersistedContinuationGroupV1 {
  if (!isRecord(value) || !hasExactKeys(value, RECORD_KEYS)) return false;
  if (
    value.version !== RECORD_VERSION ||
    !isUuid(value.groupId) ||
    !isNonEmptyString(value.modelId) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.lastAccessedAt) ||
    !isTimestamp(value.expiresAt) ||
    value.createdAt > value.lastAccessedAt ||
    value.lastAccessedAt >= value.expiresAt ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    !Array.isArray(value.calls) ||
    value.calls.length === 0
  ) {
    return false;
  }

  const outputIndexes = new Set<number>();
  for (const entry of value.items) {
    if (!isContinuationItem(entry) || outputIndexes.has(entry.outputIndex)) return false;
    outputIndexes.add(entry.outputIndex);
  }

  const toolIds = new Set<string>();
  const callOutputIndexes = new Set<number>();
  for (const entry of value.calls) {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [toolId, call] = entry;
    if (
      !isUuid(toolId) ||
      toolIds.has(toolId) ||
      !isContinuationCall(call) ||
      callOutputIndexes.has(call.outputIndex)
    ) {
      return false;
    }
    const item = value.items.find((candidate) => candidate.outputIndex === call.outputIndex)?.item;
    if (
      !item ||
      item.type !== 'function_call' ||
      item.call_id !== call.callId ||
      item.name !== call.name
    ) {
      return false;
    }
    toolIds.add(toolId);
    callOutputIndexes.add(call.outputIndex);
  }
  return value.items.every(({ outputIndex, item }) =>
    item.type !== 'function_call' || callOutputIndexes.has(outputIndex));
}

function isContinuationItem(value: unknown): value is CompletedContinuationItem {
  if (!isRecord(value) || !hasExactKeys(value, ['outputIndex', 'item'])) return false;
  if (!Number.isSafeInteger(value.outputIndex) || (value.outputIndex as number) < 0) return false;
  const item = value.item;
  if (!isRecord(item)) return false;
  if (item.type === 'function_call') {
    return isNonEmptyString(item.call_id)
      && isNonEmptyString(item.name)
      && typeof item.arguments === 'string'
      && (item.status === undefined || typeof item.status === 'string')
      && (item.id === undefined || typeof item.id === 'string');
  }
  if (item.type === 'reasoning') {
    return (item.encrypted_content === undefined || typeof item.encrypted_content === 'string')
      && (item.summary === undefined || Array.isArray(item.summary))
      && (item.status === undefined || typeof item.status === 'string')
      && (item.id === undefined || typeof item.id === 'string');
  }
  return false;
}

function isContinuationCall(value: unknown): value is ContinuationCall {
  return isRecord(value)
    && hasExactKeys(value, ['callId', 'outputIndex', 'name', 'input'])
    && isNonEmptyString(value.callId)
    && Number.isSafeInteger(value.outputIndex)
    && (value.outputIndex as number) >= 0
    && isNonEmptyString(value.name)
    && isRecord(value.input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && value === value.toLowerCase() && UUID_PATTERN.test(value);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}