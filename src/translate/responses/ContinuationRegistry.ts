import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type {
  CompletedContinuationItem,
  ContinuationCall,
  ContinuationGroup,
  ContinuationStage,
} from './types.js';
import { TranslationError } from './types.js';

export const CONTINUATION_TTL_MS = 24 * 60 * 60 * 1000;
export const CONTINUATION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CONTINUATION_MAX_GROUPS = 256;
export const CONTINUATION_GROUP_MAX_BYTES = 2 * 1024 * 1024;
export const CONTINUATION_TOTAL_MAX_BYTES = 32 * 1024 * 1024;

interface ContinuationRegistryOptions {
  now?: () => number;
  randomId?: () => string;
  ttlMs?: number;
  absoluteTtlMs?: number;
  maxGroups?: number;
  groupMaxBytes?: number;
  totalMaxBytes?: number;
}

interface ExpirationState {
  lastAccessedAt: number;
  expiresAt: number;
}

class ReadonlyMapView<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #source: ReadonlyMap<Key, Value>;

  constructor(source: ReadonlyMap<Key, Value>) {
    this.#source = source;
  }

  get size(): number { return this.#source.size; }
  get(key: Key): Value | undefined { return this.#source.get(key); }
  has(key: Key): boolean { return this.#source.has(key); }
  entries(): IterableIterator<[Key, Value]> { return this.#source.entries(); }
  keys(): IterableIterator<Key> { return this.#source.keys(); }
  values(): IterableIterator<Value> { return this.#source.values(); }
  [Symbol.iterator](): IterableIterator<[Key, Value]> { return this.#source[Symbol.iterator](); }
  forEach(callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void): void {
    this.#source.forEach((value, key) => callbackfn(value, key, this));
  }
}

/** Stores immutable Responses continuation groups for stateless tool-result replay. */
export class ContinuationRegistry {
  private readonly groups = new Map<string, ContinuationGroup>();
  private readonly toolToGroup = new Map<string, string>();
  private readonly expirations = new Map<string, ExpirationState>();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly ttlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly maxGroups: number;
  private readonly groupMaxBytes: number;
  private readonly totalMaxBytes: number;

  constructor(options: ContinuationRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.ttlMs = options.ttlMs ?? CONTINUATION_TTL_MS;
    this.absoluteTtlMs = options.absoluteTtlMs ?? CONTINUATION_ABSOLUTE_TTL_MS;
    this.maxGroups = options.maxGroups ?? CONTINUATION_MAX_GROUPS;
    this.groupMaxBytes = options.groupMaxBytes ?? CONTINUATION_GROUP_MAX_BYTES;
    this.totalMaxBytes = options.totalMaxBytes ?? CONTINUATION_TOTAL_MAX_BYTES;
  }

  createStage(modelId: string): ContinuationStage {
    return {
      groupId: this.randomId(),
      modelId,
      items: [],
      calls: new Map<string, ContinuationCall>(),
      published: false,
      discarded: false,
    };
  }

  allocateToolId(stage: ContinuationStage): string {
    this.assertMutableStage(stage);
    let toolId = this.randomId();
    while (stage.calls.has(toolId) || this.toolToGroup.has(toolId)) {
      toolId = this.randomId();
    }
    return toolId;
  }

  addItem(stage: ContinuationStage, item: CompletedContinuationItem): void {
    this.assertMutableStage(stage);
    stage.items.push(item);
  }

  addCall(stage: ContinuationStage, toolId: string, call: ContinuationCall): void {
    this.assertMutableStage(stage);
    if (stage.calls.has(toolId) || this.toolToGroup.has(toolId)) {
      throw this.invalidContinuation('Continuation tool id collision.');
    }
    stage.calls.set(toolId, call);
  }

  resolve(toolUseIds: readonly string[], modelId: string): ContinuationGroup {
    if (toolUseIds.length === 0 || new Set(toolUseIds).size !== toolUseIds.length) {
      throw this.invalidContinuation('Tool-use ids must be unique and non-empty.');
    }

    const now = this.now();
    let resolved: ContinuationGroup | undefined;
    for (const toolUseId of toolUseIds) {
      const groupId = this.toolToGroup.get(toolUseId);
      const group = groupId ? this.groups.get(groupId) : undefined;
      if (!group || group.expiresAt <= now || group.modelId !== modelId) {
        throw this.invalidContinuation(`Tool-use id "${toolUseId}" is unavailable.`);
      }
      if (resolved && resolved.groupId !== group.groupId) {
        throw this.invalidContinuation('Tool-use ids belong to different continuation groups.');
      }
      resolved = group;
    }

    if (!resolved || toolUseIds.length !== resolved.calls.size) {
      throw this.invalidContinuation('A continuation group requires every tool-use id.');
    }
    return this.renewGroup(resolved, now);
  }

  publish(stage: ContinuationStage): ContinuationGroup {
    this.assertMutableStage(stage);
    if (this.groups.has(stage.groupId)) {
      throw this.invalidContinuation('Continuation group id collision.', 502);
    }
    if (stage.calls.size === 0 || stage.items.length === 0) {
      throw this.invalidContinuation('Cannot publish an empty continuation group.', 502);
    }

    const createdAt = this.now();
    const absoluteExpiresAt = createdAt + this.absoluteTtlMs;
    const expiration: ExpirationState = {
      lastAccessedAt: createdAt,
      expiresAt: Math.min(createdAt + this.ttlMs, absoluteExpiresAt),
    };
    const items = stage.items.map((entry) => deepFreeze({
      outputIndex: entry.outputIndex,
      item: cloneJson(entry.item),
    }));
    const calls = new Map(
      [...stage.calls.entries()].map(([toolId, call]) => [
        toolId,
        deepFreeze({ ...call, input: cloneJson(call.input) }),
      ]),
    );
    const byteSize = Buffer.byteLength(
      JSON.stringify({ groupId: stage.groupId, modelId: stage.modelId, items, calls: [...calls] }),
      'utf8',
    );
    if (byteSize > this.groupMaxBytes) {
      throw this.invalidContinuation('Continuation group exceeds the size limit.', 502);
    }

    for (const toolId of calls.keys()) {
      if (this.toolToGroup.has(toolId)) {
        throw this.invalidContinuation('Continuation tool id collision.', 502);
      }
    }

    const expired = [...this.groups.values()].filter((group) => group.expiresAt <= createdAt);
    const live = [...this.groups.values()]
      .filter((group) => group.expiresAt > createdAt)
      .sort((left, right) =>
        left.lastAccessedAt - right.lastAccessedAt ||
        left.createdAt - right.createdAt ||
        left.groupId.localeCompare(right.groupId),
      );
    let liveBytes = live.reduce((total, group) => total + group.byteSize, 0);
    const evicted: ContinuationGroup[] = [];
    while (live.length + 1 > this.maxGroups || liveBytes + byteSize > this.totalMaxBytes) {
      const oldest = live.shift();
      if (!oldest) {
        throw this.invalidContinuation('Continuation registry capacity is unavailable.', 502);
      }
      liveBytes -= oldest.byteSize;
      evicted.push(oldest);
    }

    const group: ContinuationGroup = Object.freeze({
      groupId: stage.groupId,
      modelId: stage.modelId,
      createdAt,
      get lastAccessedAt(): number { return expiration.lastAccessedAt; },
      get expiresAt(): number { return expiration.expiresAt; },
      absoluteExpiresAt,
      items: Object.freeze(items),
      calls: Object.freeze(new ReadonlyMapView(calls)),
      byteSize,
    });

    for (const removed of [...expired, ...evicted]) this.removeGroup(removed);
    this.groups.set(group.groupId, group);
    this.expirations.set(group.groupId, expiration);
    for (const toolId of group.calls.keys()) this.toolToGroup.set(toolId, group.groupId);
    stage.published = true;
    return group;
  }

  discard(stage: ContinuationStage): void {
    if (!stage.published) stage.discarded = true;
  }

  private assertMutableStage(stage: ContinuationStage): void {
    if (stage.published || stage.discarded) {
      throw this.invalidContinuation('Continuation stage is no longer mutable.', 502);
    }
  }

  private removeGroup(group: ContinuationGroup): void {
    this.groups.delete(group.groupId);
    this.expirations.delete(group.groupId);
    for (const toolId of group.calls.keys()) this.toolToGroup.delete(toolId);
  }

  private renewGroup(group: ContinuationGroup, now: number): ContinuationGroup {
    const expiration = this.expirations.get(group.groupId);
    if (!expiration) {
      throw this.invalidContinuation('Continuation expiration state is unavailable.', 502);
    }
    expiration.lastAccessedAt = now;
    expiration.expiresAt = Math.min(now + this.ttlMs, group.absoluteExpiresAt);
    return group;
  }

  private invalidContinuation(message: string, status = 400): TranslationError {
    return new TranslationError({
      status,
      type: status === 400 ? 'invalid_request_error' : 'api_error',
      message,
    });
  }
}

function cloneJson<Value>(value: Value): Value {
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry)) as Value;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]),
    ) as Value;
  }
  return value;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}