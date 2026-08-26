import type { AppConfig } from '../config.js';
import { AuthManager } from '../auth/AuthManager.js';
import { buildCopilotBaseHeaders } from '../translate/shared.js';

export const EXTERNAL_MODELS_TIMEOUT_MS = 30 * 1000;
export const MODEL_INVOCATION_TIMEOUT_MS = 10 * 60 * 1000;

export interface InvocationPlan {
  endpoint: '/chat/completions' | '/v1/messages' | '/responses';
  body: Uint8Array;
  query?: string;
  accept?: 'application/json' | 'text/event-stream';
  headers?: Readonly<Record<string, string>>;
}

export interface InvocationContext {
  authRetryUsed: boolean;
  replanUsed: boolean;
  downstreamStarted: boolean;
  invocationCount: number;
  deadlineAt?: number;
}

interface CopilotTransportOptions {
  fetchImpl?: typeof fetch;
}

/** Executes authenticated Copilot requests without choosing models or parsing payloads. */
export class CopilotTransport {
  private readonly cfg: AppConfig;
  private readonly auth: AuthManager;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: AppConfig, auth: AuthManager, options: CopilotTransportOptions = {}) {
    this.cfg = cfg;
    this.auth = auth;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  createInvocationContext(): InvocationContext {
    return {
      authRetryUsed: false,
      replanUsed: false,
      downstreamStarted: false,
      invocationCount: 0,
    };
  }

  async invoke(
    plan: InvocationPlan,
    signal: AbortSignal,
    context: InvocationContext,
  ): Promise<Response> {
    context.deadlineAt ??= Date.now() + MODEL_INVOCATION_TIMEOUT_MS;
    while (true) {
      if (context.invocationCount >= 3) {
        throw new Error('Model invocation limit exceeded.');
      }
      const snapshot = await this.getAuthSnapshot(signal, context.deadlineAt);
      context.invocationCount += 1;
      const response = await this.fetchWithDeadline(
        `${snapshot.copilotApiBase}${plan.endpoint}${plan.query ?? ''}`,
        {
          method: 'POST',
          headers: {
            ...buildCopilotBaseHeaders(this.cfg, snapshot),
            'Content-Type': 'application/json',
            Accept: plan.accept ?? 'application/json',
            ...plan.headers,
          },
          body: plan.body as unknown as BodyInit,
        },
        signal,
        remainingTime(context.deadlineAt),
      );
      if (response.status !== 401 || context.authRetryUsed || context.downstreamStarted) {
        return response;
      }
      context.authRetryUsed = true;
      await response.body?.cancel();
      await this.refreshRejectedAuth(signal, context.deadlineAt, snapshot.generation);
    }
  }

  async fetchCatalog(signal: AbortSignal): Promise<Response> {
    return await this.fetchModelsWithAuthRetry(signal, MODEL_INVOCATION_TIMEOUT_MS);
  }

  async proxyModels(signal: AbortSignal): Promise<Response> {
    return await this.fetchModelsWithAuthRetry(signal, EXTERNAL_MODELS_TIMEOUT_MS);
  }

  private async fetchModelsWithAuthRetry(
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Response> {
    const deadlineAt = Date.now() + timeoutMs;
    let snapshot = await this.getAuthSnapshot(signal, deadlineAt);
    let response = await this.fetchWithDeadline(
      `${snapshot.copilotApiBase}/models`,
      {
        method: 'GET',
        headers: {
          ...buildCopilotBaseHeaders(this.cfg, snapshot),
          Accept: 'application/json',
        },
      },
      signal,
      remainingTime(deadlineAt),
    );
    if (response.status !== 401) return response;
    await response.body?.cancel();
    snapshot = await this.refreshRejectedAuth(signal, deadlineAt, snapshot.generation);
    response = await this.fetchWithDeadline(
      `${snapshot.copilotApiBase}/models`,
      {
        method: 'GET',
        headers: {
          ...buildCopilotBaseHeaders(this.cfg, snapshot),
          Accept: 'application/json',
        },
      },
      signal,
      remainingTime(deadlineAt),
    );
    return response;
  }

  private async fetchWithDeadline(
    url: string,
    init: RequestInit,
    requestSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<Response> {
    if (requestSignal.aborted) throw abortError();
    if (timeoutMs <= 0) throw abortError();
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    requestSignal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timeout);
      requestSignal.removeEventListener('abort', onAbort);
    };
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      return wrapResponseLifecycle(response, cleanup);
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  private async getAuthSnapshot(
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<Awaited<ReturnType<AuthManager['getSnapshot']>>> {
    return await withDeadlineSignal(
      signal,
      deadlineAt,
      async (deadlineSignal) => await this.auth.getSnapshot(deadlineSignal),
    );
  }

  private async refreshRejectedAuth(
    signal: AbortSignal,
    deadlineAt: number,
    rejectedGeneration: number,
  ): Promise<Awaited<ReturnType<AuthManager['getSnapshot']>>> {
    return await withDeadlineSignal(
      signal,
      deadlineAt,
      async (deadlineSignal) =>
        await this.auth.refreshAfterRejection(deadlineSignal, rejectedGeneration),
    );
  }
}

function wrapResponseLifecycle(response: Response, cleanup: () => void): Response {
  if (!response.body) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        cleanup();
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        cleanup();
        reader.releaseLock();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function withDeadlineSignal<Result>(
  requestSignal: AbortSignal,
  deadlineAt: number,
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(requestSignal.reason);
  requestSignal.addEventListener('abort', onAbort, { once: true });
  const remaining = remainingTime(deadlineAt);
  if (requestSignal.aborted) onAbort();
  else if (remaining <= 0) controller.abort();
  const timeout = remaining > 0
    ? setTimeout(() => controller.abort(), remaining)
    : undefined;
  try {
    return await operation(controller.signal);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    requestSignal.removeEventListener('abort', onAbort);
  }
}

function remainingTime(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

function abortError(): Error {
  const error = new Error('Operation canceled.');
  error.name = 'AbortError';
  return error;
}