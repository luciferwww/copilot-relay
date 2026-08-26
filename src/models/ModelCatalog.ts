import { Buffer } from 'node:buffer';

export const MODEL_CATALOG_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const MODEL_CATALOG_MAX_RECORDS = 512;
export const MODEL_CATALOG_FRESH_MS = 5 * 60 * 1000;
export const MODEL_CATALOG_STALE_MS = 60 * 60 * 1000;
export const MODEL_CATALOG_TIMEOUT_MS = 15 * 1000;

export interface ModelCapabilities {
  supports?: Readonly<Record<string, unknown>>;
  limits?: Readonly<Record<string, unknown>>;
}

export interface ModelRecord {
  id: string;
  supported_endpoints: readonly string[];
  capabilities?: ModelCapabilities;
}

export interface ModelSnapshot {
  generation: number;
  fetchedAt: number;
  records: ReadonlyMap<string, ModelRecord>;
  invalidRecordIds: ReadonlySet<string>;
}

export class ModelCatalogError extends Error {
  readonly kind: 'unavailable' | 'malformed' | 'missing' | 'invalid';

  constructor(kind: 'unavailable' | 'malformed' | 'missing' | 'invalid', message: string) {
    super(message);
    this.name = 'ModelCatalogError';
    this.kind = kind;
  }
}

interface CatalogTransport {
  fetchCatalog(signal: AbortSignal): Promise<Response>;
}

interface RefreshOperation {
  readonly controller: AbortController;
  readonly waiters: Set<symbol>;
  readonly sourceGeneration: number;
  promise: Promise<ModelSnapshot>;
  terminal: boolean;
}

interface ModelCatalogOptions {
  now?: () => number;
  timeoutMs?: number;
}

interface ResolveOptions {
  allowStale?: boolean;
}

/** Maintains an atomically published, bounded live Copilot model snapshot. */
export class ModelCatalog {
  private readonly transport: CatalogTransport;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private snapshot?: ModelSnapshot;
  private operation?: RefreshOperation;
  private invalidatedGeneration?: number;
  private readonly negativeResults = new Map<string, number>();

  constructor(transport: CatalogTransport, options: ModelCatalogOptions = {}) {
    this.transport = transport;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS;
  }

  get currentGeneration(): number {
    return this.snapshot?.generation ?? 0;
  }

  async resolve(
    modelId: string,
    waiter: AbortSignal,
    options: ResolveOptions = {},
  ): Promise<ModelRecord> {
    if (waiter.aborted) throw abortError();
    if (!modelId) throw new ModelCatalogError('missing', 'Model id is required.');
    let snapshot = this.snapshot;
    let refreshed = false;
    if (
      !snapshot ||
      this.invalidatedGeneration === snapshot.generation ||
      this.now() - snapshot.fetchedAt >= MODEL_CATALOG_FRESH_MS
    ) {
      snapshot = await this.refresh(waiter, false, options.allowStale ?? true);
      refreshed = true;
    }

    const record = snapshot.records.get(modelId);
    if (record) return record;
    if (snapshot.invalidRecordIds.has(modelId)) {
      throw new ModelCatalogError('invalid', `Model "${modelId}" has invalid routing metadata.`);
    }
    if (this.negativeResults.get(modelId) === snapshot.generation) {
      throw new ModelCatalogError('missing', `Model "${modelId}" is absent from live metadata.`);
    }

    if (!refreshed) snapshot = await this.refresh(waiter, true);
    const refreshedRecord = snapshot.records.get(modelId);
    if (refreshedRecord) return refreshedRecord;
    if (snapshot.invalidRecordIds.has(modelId)) {
      throw new ModelCatalogError('invalid', `Model "${modelId}" has invalid routing metadata.`);
    }
    this.negativeResults.set(modelId, snapshot.generation);
    throw new ModelCatalogError('missing', `Model "${modelId}" is absent from live metadata.`);
  }

  invalidate(generation: number): void {
    if (this.snapshot?.generation === generation) {
      this.invalidatedGeneration = generation;
    }
  }

  private async refresh(
    waiter: AbortSignal,
    force = false,
    allowStale = true,
  ): Promise<ModelSnapshot> {
    if (
      !force &&
      this.snapshot &&
      this.invalidatedGeneration !== this.snapshot.generation &&
      this.now() - this.snapshot.fetchedAt < MODEL_CATALOG_FRESH_MS
    ) {
      return this.snapshot;
    }
    const operation = this.getOrStartRefresh();
    try {
      return await this.awaitOperation(operation, waiter);
    } catch (error) {
      if (waiter.aborted) throw error;
      if (
        allowStale &&
        this.snapshot &&
        this.now() - this.snapshot.fetchedAt < MODEL_CATALOG_STALE_MS
      ) {
        return this.snapshot;
      }
      if (error instanceof ModelCatalogError) throw error;
      throw new ModelCatalogError('unavailable', 'Live model metadata is unavailable.');
    }
  }

  private getOrStartRefresh(): RefreshOperation {
    if (!this.operation || this.operation.terminal || this.operation.controller.signal.aborted) {
      return this.startRefresh();
    }
    return this.operation;
  }

  private startRefresh(): RefreshOperation {
    const operation: RefreshOperation = {
      controller: new AbortController(),
      waiters: new Set(),
      sourceGeneration: this.currentGeneration,
      promise: Promise.resolve(undefined as never),
      terminal: false,
    };
    this.operation = operation;
    operation.promise = this.runRefresh(operation);
    operation.promise.catch(() => undefined);
    return operation;
  }

  private async runRefresh(operation: RefreshOperation): Promise<ModelSnapshot> {
    const timeout = setTimeout(() => operation.controller.abort(), this.timeoutMs);
    try {
      const response = await this.transport.fetchCatalog(operation.controller.signal);
      if (!response.ok) {
        throw new ModelCatalogError('unavailable', 'Live model metadata request failed.');
      }
      const value = await readCatalogResponse(response);
      const { records, invalidRecordIds } = validateCatalog(value);
      if (
        operation.terminal ||
        operation.controller.signal.aborted ||
        operation.sourceGeneration !== this.currentGeneration ||
        this.operation !== operation
      ) {
        throw abortError();
      }
      const snapshot: ModelSnapshot = Object.freeze({
        generation: operation.sourceGeneration + 1,
        fetchedAt: this.now(),
        records,
        invalidRecordIds,
      });
      this.snapshot = snapshot;
      this.invalidatedGeneration = undefined;
      this.negativeResults.clear();
      return snapshot;
    } finally {
      clearTimeout(timeout);
      operation.terminal = true;
      if (this.operation === operation) this.operation = undefined;
    }
  }

  private async awaitOperation(
    operation: RefreshOperation,
    signal: AbortSignal,
  ): Promise<ModelSnapshot> {
    if (signal.aborted) throw abortError();
    const waiterId = Symbol('catalog-waiter');
    operation.waiters.add(waiterId);
    let removeAbort = (): void => undefined;
    try {
      const canceled = new Promise<never>((_, reject) => {
        const onAbort = (): void => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', onAbort);
      });
      return await Promise.race([operation.promise, canceled]);
    } finally {
      removeAbort();
      operation.waiters.delete(waiterId);
      if (!operation.terminal && operation.waiters.size === 0) operation.controller.abort();
    }
  }
}

async function readCatalogResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new ModelCatalogError('malformed', 'Model metadata body is empty.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > MODEL_CATALOG_BODY_MAX_BYTES) {
        await reader.cancel();
        throw new ModelCatalogError('malformed', 'Model metadata body exceeds its limit.');
      }
      total += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new ModelCatalogError('malformed', 'Model metadata is not valid JSON.');
  }
}

function validateCatalog(value: unknown): Pick<ModelSnapshot, 'records' | 'invalidRecordIds'> {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new ModelCatalogError('malformed', 'Model metadata must contain a data array.');
  }
  if (value.data.length > MODEL_CATALOG_MAX_RECORDS) {
    throw new ModelCatalogError('malformed', 'Model metadata contains too many records.');
  }
  const records = new Map<string, ModelRecord>();
  const invalidRecordIds = new Set<string>();
  for (const candidate of value.data) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || candidate.id.length === 0) {
      throw new ModelCatalogError('malformed', 'Model metadata contains an invalid id.');
    }
    if (candidate.supported_endpoints === undefined) {
      invalidRecordIds.add(candidate.id);
      continue;
    }
    if (
      !Array.isArray(candidate.supported_endpoints) ||
      !candidate.supported_endpoints.every((endpoint) => typeof endpoint === 'string')
    ) {
      throw new ModelCatalogError(
        'malformed',
        `Model "${candidate.id}" has invalid supported endpoints.`,
      );
    }
    if (records.has(candidate.id)) {
      throw new ModelCatalogError('malformed', `Model "${candidate.id}" is duplicated.`);
    }
    let capabilities: ModelCapabilities | undefined;
    if (candidate.capabilities !== undefined) {
      if (!isRecord(candidate.capabilities)) {
        throw new ModelCatalogError(
          'malformed',
          `Model "${candidate.id}" has invalid capabilities.`,
        );
      }
      capabilities = {
        supports: isRecord(candidate.capabilities.supports)
          ? Object.freeze({ ...candidate.capabilities.supports })
          : undefined,
        limits: isRecord(candidate.capabilities.limits)
          ? Object.freeze({ ...candidate.capabilities.limits })
          : undefined,
      };
    }
    records.set(
      candidate.id,
      Object.freeze({
        id: candidate.id,
        supported_endpoints: Object.freeze([...candidate.supported_endpoints]),
        capabilities,
      }),
    );
  }
  return {
    records: new Map(records),
    invalidRecordIds: new Set(invalidRecordIds),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  const error = new Error('Operation canceled.');
  error.name = 'AbortError';
  return error;
}