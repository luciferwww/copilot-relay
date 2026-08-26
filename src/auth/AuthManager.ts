import { Buffer } from 'node:buffer';
import type { AppConfig } from '../config.js';
import { loadAuth, saveAuth, type AuthState } from './copilot.js';

export const AUTH_REFRESH_TIMEOUT_MS = 15 * 1000;

export interface AuthSnapshot extends AuthState {
  generation: number;
  copilotToken: string;
  copilotExpiresAt: number;
  copilotApiBase: string;
}

export class AuthManagerError extends Error {
  readonly status: 401 | 502;

  constructor(status: 401 | 502, message: string) {
    super(message);
    this.name = 'AuthManagerError';
    this.status = status;
  }
}

interface RefreshOperation {
  readonly sourceGeneration: number;
  readonly controller: AbortController;
  readonly waiters: Set<symbol>;
  promise: Promise<AuthSnapshot>;
  terminal: boolean;
}

interface AuthManagerOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  initialState?: AuthState;
  saveState?: (state: AuthState) => void;
}

const TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const RESPONSE_MAX_BYTES = 64 * 1024;

/** Owns the current auth generation and one independently cancelable shared refresh. */
export class AuthManager {
  private readonly cfg: AppConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly saveState: (state: AuthState) => void;
  private state: AuthState;
  private generation = 0;
  private operation?: RefreshOperation;

  constructor(cfg: AppConfig, options: AuthManagerOptions = {}) {
    const state = options.initialState ?? loadAuth();
    if (!state) throw new AuthManagerError(401, 'Not logged in. Run login again.');
    this.cfg = cfg;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? AUTH_REFRESH_TIMEOUT_MS;
    this.saveState = options.saveState ?? saveAuth;
    this.state = { ...state, lastRefreshError: undefined };
  }

  get currentGeneration(): number {
    return this.generation;
  }

  async getSnapshot(waiter: AbortSignal, force = false): Promise<AuthSnapshot> {
    if (waiter.aborted) throw abortError();
    if (this.state.invalid) {
      throw new AuthManagerError(401, 'GitHub access token was rejected. Run login again.');
    }
    if (!force && this.isTokenFresh()) return this.snapshot();
    return await this.awaitOperation(this.getOrStartRefresh(), waiter);
  }

  async refreshAfterRejection(
    waiter: AbortSignal,
    rejectedGeneration: number,
  ): Promise<AuthSnapshot> {
    if (waiter.aborted) throw abortError();
    if (this.state.invalid) {
      throw new AuthManagerError(401, 'GitHub access token was rejected. Run login again.');
    }
    if (this.generation > rejectedGeneration) return this.snapshot();
    if (this.generation !== rejectedGeneration) {
      throw new AuthManagerError(502, 'Rejected auth generation is inconsistent.');
    }
    return await this.awaitOperation(this.getOrStartRefresh(), waiter);
  }

  private getOrStartRefresh(): RefreshOperation {
    if (!this.operation || this.operation.terminal || this.operation.controller.signal.aborted) {
      return this.startRefresh();
    }
    return this.operation;
  }

  private isTokenFresh(): boolean {
    return Boolean(
      this.state.copilotToken &&
        this.state.copilotExpiresAt &&
        this.state.copilotExpiresAt * 1000 - this.now() > REFRESH_MARGIN_MS,
    );
  }

  private startRefresh(): RefreshOperation {
    const operation: RefreshOperation = {
      sourceGeneration: this.generation,
      controller: new AbortController(),
      waiters: new Set(),
      promise: Promise.resolve(undefined as never),
      terminal: false,
    };
    this.operation = operation;
    operation.promise = this.runRefresh(operation);
    operation.promise.catch(() => undefined);
    return operation;
  }

  private async runRefresh(operation: RefreshOperation): Promise<AuthSnapshot> {
    const timeout = setTimeout(() => operation.controller.abort(), this.timeoutMs);
    try {
      const next = await this.exchange(operation.controller.signal);
      if (
        operation.terminal ||
        operation.controller.signal.aborted ||
        operation.sourceGeneration !== this.generation ||
        this.operation !== operation
      ) {
        throw abortError();
      }
      this.state = next;
      this.generation += 1;
      this.saveState(next);
      return this.snapshot();
    } catch (error) {
      if (
        error instanceof AuthManagerError &&
        error.status === 401 &&
        operation.sourceGeneration === this.generation &&
        this.operation === operation &&
        !operation.terminal
      ) {
        this.state = {
          ...this.state,
          invalid: { code: 'access_token_rejected', at: new Date(this.now()).toISOString() },
          lastRefreshError: undefined,
        };
        this.saveState(this.state);
      }
      if (operation.controller.signal.aborted && !(error instanceof AuthManagerError)) {
        throw new AuthManagerError(502, 'Copilot token exchange timed out or was canceled.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      operation.terminal = true;
      if (this.operation === operation) this.operation = undefined;
    }
  }

  private async exchange(signal: AbortSignal): Promise<AuthState> {
    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: 'GET',
        headers: {
          Authorization: `token ${this.state.accessToken}`,
          Accept: 'application/json',
          'User-Agent': this.cfg.userAgent,
          'Editor-Version': this.cfg.editorVersion,
          'Editor-Plugin-Version': this.cfg.editorPluginVersion,
        },
        signal,
      });
    } catch {
      throw new AuthManagerError(502, 'Copilot token exchange failed.');
    }
    if (response.status === 401) {
      throw new AuthManagerError(401, 'GitHub access token was rejected. Run login again.');
    }
    if (!response.ok) throw new AuthManagerError(502, 'Copilot token exchange failed.');

    const body = await readBoundedBody(response, RESPONSE_MAX_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      throw new AuthManagerError(502, 'Copilot token exchange returned invalid JSON.');
    }
    if (!isRecord(value) || !isRecord(value.endpoints)) {
      throw new AuthManagerError(502, 'Copilot token exchange returned invalid data.');
    }
    if (
      typeof value.token !== 'string' ||
      value.token.length === 0 ||
      typeof value.expires_at !== 'number' ||
      !Number.isFinite(value.expires_at) ||
      typeof value.endpoints.api !== 'string' ||
      value.endpoints.api.length === 0
    ) {
      throw new AuthManagerError(502, 'Copilot token exchange returned incomplete data.');
    }
    return {
      accessToken: this.state.accessToken,
      copilotToken: value.token,
      copilotExpiresAt: value.expires_at,
      copilotApiBase: value.endpoints.api,
    };
  }

  private async awaitOperation(
    operation: RefreshOperation,
    signal: AbortSignal,
  ): Promise<AuthSnapshot> {
    const waiterId = Symbol('auth-waiter');
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

  private snapshot(): AuthSnapshot {
    if (!this.state.copilotToken || !this.state.copilotExpiresAt) {
      throw new AuthManagerError(502, 'Copilot auth snapshot is incomplete.');
    }
    return {
      ...this.state,
      copilotToken: this.state.copilotToken,
      copilotExpiresAt: this.state.copilotExpiresAt,
      copilotApiBase: this.state.copilotApiBase ?? 'https://api.githubcopilot.com',
      generation: this.generation,
    };
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > limit) {
        await reader.cancel();
        throw new AuthManagerError(502, 'Copilot token exchange response was too large.');
      }
      total += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  const error = new Error('Operation canceled.');
  error.name = 'AbortError';
  return error;
}