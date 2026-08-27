import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { logger, type ContinuationCapacityEvictionLog } from '../../logger.js';
import type {
  ContinuationStoreLike,
  PersistedContinuationGroupV1,
} from './ContinuationStore.js';
import type {
  CompletedContinuationItem,
  ContinuationCall,
  ContinuationGroup,
  ContinuationStage,
} from './types.js';
import { TranslationError } from './types.js';

export const CONTINUATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CONTINUATION_MAX_GROUPS = 256;
export const CONTINUATION_GROUP_MAX_BYTES = 2 * 1024 * 1024;
export const CONTINUATION_TOTAL_MAX_BYTES = 32 * 1024 * 1024;

interface ContinuationRegistryOptions {
  now?: () => number;
  randomId?: () => string;
  ttlMs?: number;
  maxGroups?: number;
  groupMaxBytes?: number;
  totalMaxBytes?: number;
  onCapacityEviction?: (fields: ContinuationCapacityEvictionLog) => void;
  store?: ContinuationStoreLike;
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
  private readonly maxGroups: number;
  private readonly groupMaxBytes: number;
  private readonly totalMaxBytes: number;
  private readonly onCapacityEviction: (fields: ContinuationCapacityEvictionLog) => void;
  private readonly store?: ContinuationStoreLike;

  constructor(options: ContinuationRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.ttlMs = options.ttlMs ?? CONTINUATION_TTL_MS;
    this.maxGroups = options.maxGroups ?? CONTINUATION_MAX_GROUPS;
    this.groupMaxBytes = options.groupMaxBytes ?? CONTINUATION_GROUP_MAX_BYTES;
    this.totalMaxBytes = options.totalMaxBytes ?? CONTINUATION_TOTAL_MAX_BYTES;
    this.onCapacityEviction = options.onCapacityEviction ?? logger.continuationCapacityEvicted;
    this.store = options.store;
    if (this.store) this.recover();
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
      if (group && group.expiresAt <= now) this.removeGroup(group);
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
    const expiration: ExpirationState = {
      lastAccessedAt: createdAt,
      expiresAt: createdAt + this.ttlMs,
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
      const groupCountBefore = live.length + 1;
      const totalBytesBefore = liveBytes + byteSize;
      const exceedsGroupCount = groupCountBefore > this.maxGroups;
      const exceedsAggregateBytes = totalBytesBefore > this.totalMaxBytes;
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
      items: Object.freeze(items),
      calls: Object.freeze(new ReadonlyMapView(calls)),
      byteSize,
    });

    this.writeRecord(group);
    for (const removed of [...expired, ...evicted]) this.removeGroup(removed);
    this.groups.set(group.groupId, group);
    this.expirations.set(group.groupId, expiration);
    for (const toolId of group.calls.keys()) this.toolToGroup.set(toolId, group.groupId);
    stage.published = true;
    if (evicted.length > 0) {
      this.onCapacityEviction({
        trigger: exceedsGroupCount && exceedsAggregateBytes
          ? 'group-count-and-aggregate-bytes'
          : exceedsGroupCount ? 'group-count' : 'aggregate-bytes',
        evictedGroupCount: evicted.length,
        groupCountBefore,
        groupCountAfter: live.length + 1,
        totalBytesBefore,
        totalBytesAfter: liveBytes + byteSize,
        oldestEvictedIdleAgeMs: Math.max(0, createdAt - evicted[0].lastAccessedAt),
      });
    }
    return group;
  }

  discard(stage: ContinuationStage): void {
    if (!stage.published) stage.discarded = true;
  }

  close(): void {
    this.store?.close?.();
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
    if (this.store) {
      try {
        this.store.remove(group.groupId);
      } catch {
        logger.warn('Failed to remove an unavailable continuation record.');
      }
    }
  }

  private renewGroup(group: ContinuationGroup, now: number): ContinuationGroup {
    const expiration = this.expirations.get(group.groupId);
    if (!expiration) {
      throw this.invalidContinuation('Continuation expiration state is unavailable.', 502);
    }
    this.writeRecord(group, now, now + this.ttlMs);
    expiration.lastAccessedAt = now;
    expiration.expiresAt = now + this.ttlMs;
    return group;
  }

  private recover(): void {
    const now = this.now();
    const loaded = this.store?.load() ?? [];
    const candidates = loaded.flatMap((record) => {
      const calls = new Map(record.calls.map(([toolId, call]) => [
        toolId,
        deepFreeze({ ...call, input: cloneJson(call.input) }),
      ]));
      const items = record.items.map((entry) => deepFreeze({
        outputIndex: entry.outputIndex,
        item: cloneJson(entry.item),
      }));
      const byteSize = continuationByteSize(record.groupId, record.modelId, items, calls);
      if (record.expiresAt <= now || byteSize > this.groupMaxBytes) {
        this.removeStoredRecord(record.groupId);
        return [];
      }
      const expiration: ExpirationState = {
        lastAccessedAt: record.lastAccessedAt,
        expiresAt: record.expiresAt,
      };
      const group: ContinuationGroup = Object.freeze({
        groupId: record.groupId,
        modelId: record.modelId,
        createdAt: record.createdAt,
        get lastAccessedAt(): number { return expiration.lastAccessedAt; },
        get expiresAt(): number { return expiration.expiresAt; },
        items: Object.freeze(items),
        calls: Object.freeze(new ReadonlyMapView(calls)),
        byteSize,
      });
      return [{ group, expiration }];
    });

    const toolOwners = new Map<string, string[]>();
    for (const { group } of candidates) {
      for (const toolId of group.calls.keys()) {
        const owners = toolOwners.get(toolId) ?? [];
        owners.push(group.groupId);
        toolOwners.set(toolId, owners);
      }
    }
    const collidingGroups = new Set(
      [...toolOwners.values()].filter((owners) => owners.length > 1).flat(),
    );
    const eligible = candidates
      .filter(({ group }) => {
        if (!collidingGroups.has(group.groupId)) return true;
        this.removeStoredRecord(group.groupId);
        return false;
      });
    const groupCountBefore = eligible.length;
    const totalBytesBefore = eligible.reduce((total, { group }) => total + group.byteSize, 0);
    const live = eligible
      .sort(({ group: left }, { group: right }) =>
        left.lastAccessedAt - right.lastAccessedAt ||
        left.createdAt - right.createdAt ||
        left.groupId.localeCompare(right.groupId),
      );
    let liveBytes = live.reduce((total, { group }) => total + group.byteSize, 0);
    const evicted: ContinuationGroup[] = [];
    while (live.length > this.maxGroups || liveBytes > this.totalMaxBytes) {
      const oldest = live.shift();
      if (!oldest) break;
      liveBytes -= oldest.group.byteSize;
      evicted.push(oldest.group);
      this.removeStoredRecord(oldest.group.groupId);
    }

    for (const { group, expiration } of live) {
      this.groups.set(group.groupId, group);
      this.expirations.set(group.groupId, expiration);
      for (const toolId of group.calls.keys()) this.toolToGroup.set(toolId, group.groupId);
    }
    if (evicted.length > 0) {
      this.onCapacityEviction({
        trigger: groupCountBefore > this.maxGroups && totalBytesBefore > this.totalMaxBytes
          ? 'group-count-and-aggregate-bytes'
          : groupCountBefore > this.maxGroups ? 'group-count' : 'aggregate-bytes',
        evictedGroupCount: evicted.length,
        groupCountBefore,
        groupCountAfter: live.length,
        totalBytesBefore,
        totalBytesAfter: liveBytes,
        oldestEvictedIdleAgeMs: Math.max(0, now - evicted[0].lastAccessedAt),
      });
    }
  }

  private writeRecord(group: ContinuationGroup, lastAccessedAt?: number, expiresAt?: number): void {
    if (!this.store) return;
    const record: PersistedContinuationGroupV1 = {
      version: 1,
      groupId: group.groupId,
      modelId: group.modelId,
      createdAt: group.createdAt,
      lastAccessedAt: lastAccessedAt ?? group.lastAccessedAt,
      expiresAt: expiresAt ?? group.expiresAt,
      items: group.items,
      calls: [...group.calls],
    };
    try {
      this.store.write(record);
    } catch {
      throw this.invalidContinuation('Continuation state could not be persisted.', 502);
    }
  }

  private removeStoredRecord(groupId: string): void {
    try {
      this.store?.remove(groupId);
    } catch {
      logger.warn('Failed to remove an unavailable continuation record.');
    }
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

function continuationByteSize(
  groupId: string,
  modelId: string,
  items: readonly CompletedContinuationItem[],
  calls: ReadonlyMap<string, ContinuationCall>,
): number {
  return Buffer.byteLength(JSON.stringify({ groupId, modelId, items, calls: [...calls] }), 'utf8');
}