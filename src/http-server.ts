import http from 'node:http';
import { CONTINUATION_DIR, type AppConfig } from './config.js';
import { isLoopbackHost, requireRemoteAccessOptIn } from './bind-policy.js';
import { AuthManager, AuthManagerError } from './auth/AuthManager.js';
import { ModelCatalog, ModelCatalogError } from './models/ModelCatalog.js';
import { planMessagesRoute, type MessagesRoutePlan } from './routing/messages-route.js';
import { CopilotTransport, type InvocationContext, type InvocationPlan } from './upstream/CopilotTransport.js';
import { ContinuationRegistry } from './translate/responses/ContinuationRegistry.js';
import { ContinuationStore } from './translate/responses/ContinuationStore.js';
import { mapMessagesRequest } from './translate/responses/request-mapper.js';
import { mapResponsesResult } from './translate/responses/response-mapper.js';
import { SseTranslator } from './translate/responses/SseTranslator.js';
import {
  ERROR_BODY_MAX_BYTES,
  NON_STREAM_RESPONSE_MAX_BYTES,
  REQUEST_BODY_MAX_BYTES,
  TranslationError,
  type MappedRequest,
  type MappingContext,
  type SafeFailure,
} from './translate/responses/types.js';
import {
  logger,
  type ContentBlockType,
  type ContentKind,
  type MessageRole,
  type MessageShape,
  type RequestEndpoint,
  type RequestDiagnosticCode,
  type RequestFailureCode,
  type RequestPhase,
  type RequestRoute,
} from './logger.js';

export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
}

export interface HttpRuntime {
  readonly transport: CopilotTransport;
  readonly catalog: ModelCatalog;
  readonly registry: ContinuationRegistry;
  close?(): void;
}

export interface HttpServerOptions {
  runtime?: HttpRuntime;
  allowRemoteAccess?: boolean;
}

interface ParsedBody {
  readonly raw: Buffer;
  readonly value: Record<string, unknown>;
}

interface RequestTrace {
  readonly requestId: number;
  readonly method: string;
  readonly path: string;
  readonly startedAt: number;
  route?: RequestRoute;
  phase: RequestPhase;
  modelId?: string;
  endpoint?: RequestEndpoint;
  invocation?: InvocationContext;
  failureStatus?: number;
  failureCode?: RequestFailureCode;
  diagnosticCode?: RequestDiagnosticCode;
}

type Protocol = 'openai' | 'anthropic';

let nextRequestId = 0;

export async function startHttpServer(
  cfg: AppConfig,
  options: HttpServerOptions = {},
): Promise<HttpServerHandle> {
  requireRemoteAccessOptIn(cfg.host, options.allowRemoteAccess === true);
  if (!isLoopbackHost(cfg.host)) {
    logger.warn('Remote access enabled; the relay listener has no inbound authentication.');
  }
  const runtime = options.runtime ?? createRuntime(cfg);
  let runtimeClosed = false;
  const closeRuntime = (): void => {
    if (runtimeClosed) return;
    runtimeClosed = true;
    runtime.close?.();
  };
  const server = http.createServer((req, res) => {
    handleRequest(req, res, runtime).catch(() => {
      if (!res.headersSent && !res.destroyed) {
        writeError(res, 'openai', {
          status: 502,
          type: 'api_error',
          message: 'The relay could not complete the request.',
        });
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, resolve);
    });
  } catch (error) {
    closeRuntime();
    throw error;
  }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : cfg.port;
  const displayHost = cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
  logger.info(`copilot-relay listening on http://${displayHost}:${port}`);
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => {
      closeRuntime();
      if (error) reject(error);
      else resolve();
    })),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: HttpRuntime,
): Promise<void> {
  const method = normalizeMethod(req.method);
  const rawUrl = req.url ?? '/';
  const path = rawUrl.split('?')[0].split('#')[0];
  const trace: RequestTrace = {
    requestId: ++nextRequestId,
    method,
    path: normalizeLogPath(path),
    startedAt: Date.now(),
    phase: 'routing',
  };

  const requestController = new AbortController();
  const onAborted = (): void => requestController.abort();
  const onResponseClose = (): void => {
    if (!res.writableEnded) requestController.abort();
  };
  req.once('aborted', onAborted);
  res.once('close', onResponseClose);
  try {
    if (method === 'GET' && path === '/health') {
      trace.route = 'health';
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    if (method === 'GET' && path === '/v1/models') {
      await proxyModels(res, runtime, requestController.signal, trace);
      return;
    }
    if (method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      trace.phase = 'request-body';
      const body = await parseRequestBody(req, 'openai');
      if (!body || requestController.signal.aborted) return;
      logReceivedRequest(trace, body.value);
      await proxyChat(rawUrl, body, res, runtime, requestController.signal, trace);
      return;
    }
    if (method === 'POST' && path === '/v1/responses') {
      trace.phase = 'request-body';
      const body = await parseRequestBody(req, 'openai');
      if (!body || requestController.signal.aborted) return;
      logReceivedRequest(trace, body.value);
      await handleResponses(rawUrl, body, res, runtime, requestController.signal, trace);
      return;
    }
    if (method === 'POST' && path === '/v1/messages') {
      trace.phase = 'request-body';
      const body = await parseRequestBody(req, 'anthropic');
      if (!body || requestController.signal.aborted) return;
      logReceivedRequest(trace, body.value);
      await handleMessages(req, body, res, runtime, requestController.signal, trace);
      return;
    }
    trace.route = 'not-found';
    writeError(res, 'openai', {
      status: 404,
      type: 'invalid_request_error',
      message: `No route for ${method} ${path}.`,
    });
  } catch (error) {
    if (requestController.signal.aborted || res.destroyed) return;
    const protocol: Protocol = path === '/v1/messages' ? 'anthropic' : 'openai';
    const failure = toSafeFailure(error);
    trace.failureStatus = failure.status;
    trace.failureCode = failure.type;
    trace.diagnosticCode = isRequestDiagnosticCode(failure.code) ? failure.code : undefined;
    if (!res.headersSent) writeError(res, protocol, failure);
    else if (!res.writableEnded) writeStreamError(res, protocol, failure);
  } finally {
    req.off('aborted', onAborted);
    res.off('close', onResponseClose);
    logTerminalRequest(trace, res, requestController.signal);
  }
}

async function proxyChat(
  rawUrl: string,
  body: ParsedBody,
  res: http.ServerResponse,
  runtime: HttpRuntime,
  signal: AbortSignal,
  trace: RequestTrace,
): Promise<void> {
  const context = runtime.transport.createInvocationContext();
  trace.route = 'chat-passthrough';
  trace.endpoint = '/chat/completions';
  trace.invocation = context;
  trace.phase = 'upstream';
  logPlannedRequest(trace, false);
  const response = await runtime.transport.invoke(
    {
      endpoint: '/chat/completions',
      query: queryOf(rawUrl),
      body: body.raw,
      accept: acceptsSse(body.value) ? 'text/event-stream' : 'application/json',
      headers: { 'Openai-Intent': 'conversation-panel' },
    },
    signal,
    context,
  );
  if (!response.ok) {
    await discardErrorBody(response);
    throw statusFailure(response.status);
  }
  trace.phase = 'response';
  await pipePassthrough(response, res, 'openai', signal);
}

async function proxyModels(
  res: http.ServerResponse,
  runtime: HttpRuntime,
  signal: AbortSignal,
  trace: RequestTrace,
): Promise<void> {
  trace.route = 'models-passthrough';
  trace.endpoint = '/models';
  trace.phase = 'upstream';
  logPlannedRequest(trace, false);
  const response = await runtime.transport.proxyModels(signal);
  if (!response.ok) {
    await discardErrorBody(response);
    throw statusFailure(response.status);
  }
  trace.phase = 'response';
  await pipePassthrough(response, res, 'openai', signal);
}

async function handleResponses(
  rawUrl: string,
  body: ParsedBody,
  res: http.ServerResponse,
  runtime: HttpRuntime,
  signal: AbortSignal,
  trace: RequestTrace,
): Promise<void> {
  const modelId = requireModelId(body.value);
  trace.modelId = modelId;
  trace.route = 'responses-passthrough';
  trace.endpoint = '/responses';
  const invocation = runtime.transport.createInvocationContext();
  trace.invocation = invocation;
  logPlannedRequest(trace, false);
  trace.phase = 'upstream';
  const response = await runtime.transport.invoke(
    {
      endpoint: '/responses',
      query: queryOf(rawUrl),
      body: body.raw,
      accept: acceptsSse(body.value) ? 'text/event-stream' : 'application/json',
      headers: { 'Openai-Intent': 'conversation-panel' },
    },
    signal,
    invocation,
  );

  if (!response.ok) {
    await discardErrorBody(response);
    throw statusFailure(response.status);
  }
  invocation.downstreamStarted = true;
  trace.phase = 'response';
  await pipePassthrough(response, res, 'openai', signal);
}

async function handleMessages(
  req: http.IncomingMessage,
  body: ParsedBody,
  res: http.ServerResponse,
  runtime: HttpRuntime,
  signal: AbortSignal,
  trace: RequestTrace,
): Promise<void> {
  const modelId = requireModelId(body.value);
  trace.modelId = modelId;
  trace.phase = 'catalog';
  let model = await runtime.catalog.resolve(modelId, signal);
  let plan = planMessagesRoute(modelId, model);
  const invocation = runtime.transport.createInvocationContext();
  let mapped: MappedRequest | undefined;
  let response: Response;

  while (true) {
    if (plan.kind === 'client-error' || plan.kind === 'upstream-metadata-error') throw plan.error;
    trace.route = plan.kind;
    trace.endpoint = plan.kind === 'messages-passthrough' ? '/v1/messages' : '/responses';
    logPlannedRequest(trace, invocation.replanUsed);
    trace.phase = 'mapping';
    const mappingContext: MappingContext = { model, registry: runtime.registry };
    mapped = plan.kind === 'responses-translation'
      ? mapMessagesRequest(body.value, mappingContext)
      : undefined;
    trace.invocation = invocation;
    trace.phase = 'upstream';
    response = await runtime.transport.invoke(
      createMessagesInvocation(req, body.raw, plan, mapped),
      signal,
      invocation,
    );
    if (
      response.status === 400 &&
      !invocation.replanUsed &&
      !invocation.downstreamStarted &&
      (await hasUnsupportedEndpointCode(response))
    ) {
      invocation.replanUsed = true;
      const generation = runtime.catalog.currentGeneration;
      runtime.catalog.invalidate(generation);
      trace.phase = 'catalog';
      model = await runtime.catalog.resolve(modelId, signal, { allowStale: false });
      plan = planMessagesRoute(modelId, model);
      continue;
    }
    break;
  }

  if (!response.ok) {
    await discardErrorBody(response);
    throw statusFailure(response.status);
  }
  invocation.downstreamStarted = true;
  trace.phase = 'response';
  if (plan.kind === 'messages-passthrough') {
    await pipePassthrough(response, res, 'anthropic', signal);
    return;
  }
  if (!mapped) throw new Error('Responses mapping was not initialized.');
  const mappingContext: MappingContext = { model, registry: runtime.registry };
  if (mapped.stream) await translateStream(response, res, mappingContext, signal);
  else await translateNonStream(response, res, mappingContext);
}

function createMessagesInvocation(
  req: http.IncomingMessage,
  rawBody: Buffer,
  plan: Exclude<MessagesRoutePlan, { kind: 'client-error' | 'upstream-metadata-error' }>,
  mapped: MappedRequest | undefined,
): InvocationPlan {
  if (plan.kind === 'messages-passthrough') {
    const headers: Record<string, string> = {
      'anthropic-version': headerValue(req.headers['anthropic-version']) ?? '2023-06-01',
    };
    const beta = headerValue(req.headers['anthropic-beta']);
    if (beta) headers['anthropic-beta'] = beta;
    return {
      endpoint: '/v1/messages',
      query: queryOf(req.url ?? ''),
      body: rawBody,
      accept: headerValue(req.headers.accept) === 'text/event-stream'
        ? 'text/event-stream'
        : 'application/json',
      headers,
    };
  }
  if (!mapped) throw new Error('Responses mapping was not initialized.');
  return {
    endpoint: '/responses',
    body: Buffer.from(JSON.stringify(mapped.body), 'utf8'),
    accept: mapped.stream ? 'text/event-stream' : 'application/json',
    headers: { 'Openai-Intent': 'conversation-panel' },
  };
}

async function translateNonStream(
  response: Response,
  res: http.ServerResponse,
  context: MappingContext,
): Promise<void> {
  const body = await readBoundedResponse(response, NON_STREAM_RESPONSE_MAX_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new TranslationError({
      status: 502,
      type: 'api_error',
      message: 'Responses endpoint returned invalid JSON.',
    });
  }
  const mapped = mapResponsesResult(value, context);
  if (mapped.stage) context.registry.publish(mapped.stage);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(mapped.message));
}

async function translateStream(
  response: Response,
  res: http.ServerResponse,
  context: MappingContext,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error('Responses stream body is missing.');
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  const translator = new SseTranslator(context, async (frame) => {
    if (!res.write(frame)) await waitForDrain(res, signal);
  });
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await translator.push(value);
    }
    await translator.finish();
    res.end();
  } catch (error) {
    translator.abort();
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function pipePassthrough(
  response: Response,
  res: http.ServerResponse,
  protocol: Protocol,
  signal: AbortSignal,
): Promise<void> {
  res.statusCode = response.status;
  copyResponseHeaders(res, response);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await waitForDrain(res, signal);
    }
    res.end();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (!signal.aborted && !res.writableEnded) {
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (contentType.startsWith('text/event-stream')) {
        writeStreamError(res, protocol, {
          status: 502,
          type: 'api_error',
          message: 'The upstream stream ended unexpectedly.',
        });
      } else if (!res.headersSent) {
        writeError(res, protocol, {
          status: 502,
          type: 'api_error',
          message: 'The upstream response ended unexpectedly.',
        });
      } else {
        res.destroy();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function parseRequestBody(
  req: http.IncomingMessage,
  protocol: Protocol,
): Promise<ParsedBody | undefined> {
  const contentType = headerValue(req.headers['content-type']);
  if (!contentType || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw failure(415, 'invalid_request_error', 'Content-Type must be application/json.');
  }
  const encoding = headerValue(req.headers['content-encoding']);
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw failure(415, 'invalid_request_error', 'Content-Encoding is not supported.');
  }
  const contentLength = headerValue(req.headers['content-length']);
  if (contentLength !== undefined && Number(contentLength) > REQUEST_BODY_MAX_BYTES) {
    req.resume();
    throw failure(413, 'invalid_request_error', 'Request body exceeds its size limit.');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunkValue of req) {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue as Uint8Array);
      if (total + chunk.byteLength > REQUEST_BODY_MAX_BYTES) {
        req.resume();
        throw failure(413, 'invalid_request_error', 'Request body exceeds its size limit.');
      }
      total += chunk.byteLength;
      chunks.push(chunk);
    }
  } catch (error) {
    if (req.aborted || req.destroyed) return undefined;
    if (isSafeFailure(error)) throw error;
    throw failure(400, 'invalid_request_error', 'Request body could not be read.');
  }
  if (req.aborted) return undefined;
  const raw = Buffer.concat(chunks, total);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw failure(400, 'invalid_request_error', 'Request body is not valid UTF-8.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw failure(400, 'invalid_request_error', 'Request body is not valid JSON.');
  }
  if (!isRecord(value)) throw failure(400, 'invalid_request_error', 'Request body must be an object.');
  void protocol;
  return { raw, value };
}

async function hasUnsupportedEndpointCode(response: Response): Promise<boolean> {
  const body = await readBoundedResponse(response, ERROR_BODY_MAX_BYTES, false);
  if (!body) return false;
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    return isRecord(value) && isRecord(value.error) && value.error.code === 'unsupported_api_for_model';
  } catch {
    return false;
  }
}

async function discardErrorBody(response: Response): Promise<void> {
  await readBoundedResponse(response, ERROR_BODY_MAX_BYTES, false);
}

async function readBoundedResponse(
  response: Response,
  limit: number,
  failOnOverflow = true,
): Promise<Buffer | undefined> {
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
        if (failOnOverflow) {
          throw new TranslationError({
            status: 502,
            type: 'api_error',
            message: 'Upstream response exceeds its size limit.',
          });
        }
        return undefined;
      }
      total += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function writeError(res: http.ServerResponse, protocol: Protocol, failureValue: SafeFailure): void {
  if (res.headersSent || res.destroyed) return;
  res.statusCode = failureValue.status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(formatError(protocol, failureValue)));
}

function writeStreamError(
  res: http.ServerResponse,
  protocol: Protocol,
  failureValue: SafeFailure,
): void {
  if (res.writableEnded || res.destroyed) return;
  const value = formatError(protocol, failureValue);
  const frame = protocol === 'anthropic'
    ? `event: error\ndata: ${JSON.stringify(value)}\n\n`
    : `data: ${JSON.stringify(value)}\n\n`;
  res.end(frame);
}

function formatError(protocol: Protocol, failureValue: SafeFailure): Record<string, unknown> {
  if (protocol === 'anthropic') {
    return { type: 'error', error: { type: failureValue.type, message: failureValue.message } };
  }
  return {
    error: {
      type: failureValue.type,
      message: failureValue.message,
      code: failureValue.code ?? null,
    },
  };
}

function toSafeFailure(error: unknown): SafeFailure {
  if (isSafeFailure(error)) return error;
  if (error instanceof TranslationError) return error.failure;
  if (error instanceof AuthManagerError) {
    return {
      status: error.status,
      type: error.status === 401 ? 'authentication_error' : 'api_error',
      message: error.message,
    };
  }
  if (error instanceof ModelCatalogError) {
    if (error.kind === 'missing') {
      return { status: 400, type: 'invalid_request_error', message: error.message };
    }
    return {
      status: 502,
      type: 'api_error',
      message: 'Live model metadata is unavailable or malformed.',
    };
  }
  return { status: 502, type: 'api_error', message: 'The relay could not complete the request.' };
}

function statusFailure(status: number): SafeFailure {
  if (status === 400) return failure(400, 'invalid_request_error', 'Upstream rejected the request.');
  if (status === 401) return failure(401, 'authentication_error', 'Upstream authentication failed.');
  if (status === 403) return failure(403, 'permission_error', 'Upstream permission was denied.');
  if (status === 429) return failure(429, 'rate_limit_error', 'Upstream rate limit was reached.');
  return failure(502, 'api_error', `Upstream request failed with HTTP ${status}.`);
}

function failure(status: number, type: SafeFailure['type'], message: string): SafeFailure {
  return { status, type, message };
}

function isSafeFailure(value: unknown): value is SafeFailure {
  return (
    isRecord(value) &&
    typeof value.status === 'number' &&
    typeof value.type === 'string' &&
    typeof value.message === 'string'
  );
}

function requireModelId(body: Record<string, unknown>): string {
  if (typeof body.model !== 'string' || body.model.length === 0) {
    throw failure(400, 'invalid_request_error', 'model must be a non-empty string.');
  }
  return body.model;
}

function acceptsSse(body: Record<string, unknown>): boolean {
  return body.stream === true;
}

function queryOf(url: string): string {
  const index = url.indexOf('?');
  return index < 0 ? '' : url.slice(index);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function copyResponseHeaders(res: http.ServerResponse, response: Response): void {
  response.headers.forEach((value, key) => {
    if (!['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

function waitForDrain(res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      res.off('drain', onDrain);
      res.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = (): void => finish();
    const onAbort = (): void => finish(abortError());
    const onClose = (): void => finish(abortError());
    if (signal.aborted || res.destroyed || res.writableEnded) {
      onAbort();
      return;
    }
    res.once('drain', onDrain);
    res.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted || res.destroyed || res.writableEnded) onAbort();
  });
}

function abortError(): Error {
  const error = new Error('Operation canceled.');
  error.name = 'AbortError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMethod(method: string | undefined): string {
  return method === 'GET' || method === 'POST' ? method : 'OTHER';
}

function normalizeLogPath(path: string): string {
  return [
    '/health',
    '/v1/models',
    '/v1/chat/completions',
    '/chat/completions',
    '/v1/responses',
    '/v1/messages',
  ].includes(path) ? path : '/other';
}

function logReceivedRequest(trace: RequestTrace, body: Record<string, unknown>): void {
  const modelId = typeof body.model === 'string' ? body.model : undefined;
  if (modelId !== undefined) trace.modelId = modelId;
  const messageValues = Array.isArray(body.messages) ? body.messages : [];
  logger.requestReceived({
    requestId: trace.requestId,
    method: trace.method,
    path: trace.path,
    modelId,
    stream: body.stream === true,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    messageCount: messageValues.length,
    messages: messageValues.slice(0, 64).map(summarizeMessage),
  });
}

function logPlannedRequest(trace: RequestTrace, replanUsed: boolean): void {
  if (!trace.route || !trace.endpoint) return;
  logger.requestPlanned({
    requestId: trace.requestId,
    method: trace.method,
    path: trace.path,
    modelId: trace.modelId,
    route: trace.route,
    endpoint: trace.endpoint,
    replanUsed,
  });
}

function summarizeMessage(value: unknown): MessageShape {
  if (!isRecord(value)) {
    return { role: 'unknown', contentKind: 'other', blockCount: 0, blockTypes: [] };
  }
  const role: MessageRole = value.role === 'user' || value.role === 'assistant' || value.role === 'system'
    ? value.role
    : 'unknown';
  const contentKind: ContentKind = typeof value.content === 'string'
    ? 'string'
    : Array.isArray(value.content) ? 'array' : 'other';
  const blockValues = Array.isArray(value.content) ? value.content : [];
  const blockTypes = [...new Set(blockValues.map(summarizeBlockType))];
  return {
    role,
    contentKind,
    blockCount: contentKind === 'string' ? 1 : blockValues.length,
    blockTypes,
  };
}

function summarizeBlockType(value: unknown): ContentBlockType {
  if (!isRecord(value)) return 'unknown';
  return value.type === 'text' || value.type === 'tool_use' || value.type === 'tool_result' || value.type === 'image'
    ? value.type
    : 'unknown';
}

function logTerminalRequest(
  trace: RequestTrace,
  res: http.ServerResponse,
  signal: AbortSignal,
): void {
  const canceled = signal.aborted && !res.writableEnded;
  const status = canceled ? 499 : trace.failureStatus ?? res.statusCode;
  const invocation = trace.invocation;
  const event = canceled
    ? 'request.canceled'
    : status >= 400 ? 'request.failed' : 'request.completed';
  logger.requestTerminal(event, {
    requestId: trace.requestId,
    method: trace.method,
    path: trace.path,
    modelId: trace.modelId,
    route: trace.route,
    endpoint: trace.endpoint,
    status,
    durationMs: Math.max(0, Date.now() - trace.startedAt),
    phase: trace.phase,
    failureCode: status >= 400 ? trace.failureCode ?? failureCodeForStatus(status) : undefined,
    diagnosticCode: status >= 400
      ? trace.diagnosticCode ?? diagnosticCodeForTrace(trace, canceled)
      : undefined,
    invocationCount: invocation?.invocationCount ?? 0,
    authRetryUsed: invocation?.authRetryUsed ?? false,
    replanUsed: invocation?.replanUsed ?? false,
  });
}

function failureCodeForStatus(status: number): RequestFailureCode {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 400 && status < 500 && status !== 499) return 'invalid_request_error';
  return 'api_error';
}

function diagnosticCodeForTrace(trace: RequestTrace, canceled: boolean): RequestDiagnosticCode {
  if (canceled) return 'client_canceled';
  if (trace.phase === 'request-body') return 'invalid_request_body';
  if (trace.phase === 'catalog') return 'model_catalog';
  if (trace.phase === 'mapping') return 'request_mapping';
  if (trace.phase === 'upstream') return 'upstream_http';
  if (trace.route === 'not-found') return 'route_not_found';
  return 'response_processing';
}

function isRequestDiagnosticCode(value: string | undefined): value is RequestDiagnosticCode {
  return value === 'responses_stream_upstream_failure'
    || value === 'responses_stream_incomplete'
    || value === 'responses_stream_unsupported_event'
    || value === 'responses_stream_protocol';
}

function createRuntime(cfg: AppConfig): HttpRuntime {
  const auth = new AuthManager(cfg);
  const transport = new CopilotTransport(cfg, auth);
  const store = new ContinuationStore(CONTINUATION_DIR);
  let registry: ContinuationRegistry;
  try {
    registry = new ContinuationRegistry({ store });
  } catch (error) {
    store.close();
    throw error;
  }
  return {
    transport,
    catalog: new ModelCatalog(transport),
    registry,
    close: () => registry.close(),
  };
}