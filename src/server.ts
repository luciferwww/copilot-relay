import http from 'node:http';
import { Readable } from 'node:stream';
import type { AppConfig } from './config.js';
import {
  ensureCopilotToken,
  isAuthValid,
  loadAuth,
  type AuthState,
} from './auth/copilot.js';
import * as openaiTr from './translate/openai.js';
import * as anthropicTr from './translate/anthropic.js';
import { logger } from './logger.js';

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

type Translator = typeof openaiTr;

export async function startServer(cfg: AppConfig): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, cfg).catch((err) => {
      // Truly unexpected — handleRequest already catches expected paths.
      logger.error('Unhandled error:', err);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        // Simplified OpenAI shape (spec §2.5) — route/translator unknown here.
        res.end(
          JSON.stringify({
            error: {
              type: 'api_error',
              message: (err as Error)?.message ?? 'unhandled error',
            },
          }),
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
  logger.info(`copilot-relay listening on http://127.0.0.1:${port}`);
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: AppConfig,
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const method = req.method ?? 'GET';
  // Route on the path only; query strings and hashes are transport-level
  // metadata that should not affect dispatch (e.g. Claude Code sends
  // /v1/messages?beta=true).
  const path = rawUrl.split('?')[0].split('#')[0];
  logger.debug(`${method} ${rawUrl}`);

  if (method === 'GET' && path === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'GET' && path === '/v1/models') {
    await proxyModels(req, res, cfg);
    return;
  }

  if (method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    await proxy(req, res, cfg, openaiTr);
    return;
  }

  if (method === 'POST' && path === '/v1/messages') {
    await proxy(req, res, cfg, anthropicTr);
    return;
  }

  // Spec §2.5 — simplified OpenAI shape for unmatched routes.
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { message: `No route for ${method} ${rawUrl}` } }));
}

async function proxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: AppConfig,
  translator: Translator,
): Promise<void> {
  const body = await readBody(req);

  // Spec §2.9 — abort upstream when the client disconnects before we finish.
  const abort = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) {
      logger.debug('Client disconnected; aborting upstream.');
      abort.abort();
    }
  };
  req.on('close', onClose);

  try {
    // ---- Auth ---------------------------------------------------------------
    let auth: AuthState;
    try {
      auth = await ensureCopilotToken(cfg);
    } catch (err) {
      // Spec §2.7 rule 3 / §11.1 — refresh failure or absent auth: return 401.
      const status = isAuthValid(loadAuth()) ? 502 : 401;
      respondError(
        res,
        translator,
        status,
        'authentication_error',
        (err as Error)?.message ?? 'authentication failure',
      );
      return;
    }

    // ---- Upstream call (with reactive 401 retry, spec §2.7) -----------------
    let upstream = await callUpstream(req, cfg, auth, body, translator, abort.signal);

    if (upstream.status === 401 && !res.headersSent) {
      logger.info('Upstream 401; forcing Copilot token refresh and retrying once.');
      try {
        auth = await ensureCopilotToken(cfg, { force: true });
      } catch (err) {
        respondError(
          res,
          translator,
          401,
          'authentication_error',
          (err as Error)?.message ?? 'token refresh failed',
        );
        return;
      }
      upstream = await callUpstream(req, cfg, auth, body, translator, abort.signal);
    }

    // ---- Non-2xx (spec §2.6): rewrite body into protocol shape --------------
    if (!upstream.ok) {
      const bodyText = await upstream.text();
      const errClass = classifyStatus(upstream.status);
      const msg =
        pickUpstreamMessage(bodyText) ??
        `Upstream ${upstream.status}${upstream.statusText ? ' ' + upstream.statusText : ''}`;
      respondError(res, translator, upstream.status, errClass, msg);
      if (upstream.status === 401) {
        logger.warn('Upstream 401 after refresh; please re-run `copilot-relay login`.');
      }
      return;
    }

    // ---- 2xx success: stream body straight through --------------------------
    res.statusCode = upstream.status;
    copyResponseHeaders(res, upstream);
    if (!upstream.body) {
      res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(
      upstream.body as unknown as import('node:stream/web').ReadableStream,
    );
    nodeStream.on('error', (streamErr) => {
      // Spec §2.8 — mid-stream failure: emit protocol-specific error frame.
      logger.warn('Upstream stream error:', streamErr);
      translator.writeStreamErrorFrame(res, {
        class: 'api_error',
        message: (streamErr as Error)?.message ?? 'stream error',
      });
    });
    nodeStream.pipe(res);
  } catch (err) {
    if (abort.signal.aborted) {
      // Client left; upstream aborted intentionally. Silent.
      return;
    }
    logger.error('Proxy error:', err);
    if (!res.headersSent) {
      respondError(
        res,
        translator,
        502,
        'api_error',
        (err as Error)?.message ?? 'proxy error',
      );
    } else if (!res.writableEnded) {
      translator.writeStreamErrorFrame(res, {
        class: 'api_error',
        message: (err as Error)?.message ?? 'stream error',
      });
    }
  } finally {
    req.off('close', onClose);
  }
}

async function callUpstream(
  req: http.IncomingMessage,
  cfg: AppConfig,
  auth: AuthState,
  body: Buffer,
  translator: Translator,
  signal: AbortSignal,
): Promise<Response> {
  const { url, headers } = translator.buildUpstreamRequest(req, cfg, auth);
  logger.debug(`-> ${url}`);
  // Upstream bodies are always JSON per spec §2.3/§2.4; pass as UTF-8 string
  // to satisfy fetch's BodyInit typing without a raw type cast.
  return await fetch(url, {
    method: 'POST',
    headers,
    body: body.toString('utf8'),
    signal,
  });
}

/**
 * Spec §2.2 — GET /v1/models proxies upstream and never invents its own list.
 * Uses OpenAI-shape error responses (spec §2.6). Non-streaming, but reuses the
 * same 401 retry (spec §2.7) and client-abort (spec §2.9) contracts as proxy().
 */
async function proxyModels(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: AppConfig,
): Promise<void> {
  const abort = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) {
      logger.debug('Client disconnected; aborting upstream /models.');
      abort.abort();
    }
  };
  req.on('close', onClose);

  try {
    let auth: AuthState;
    try {
      auth = await ensureCopilotToken(cfg);
    } catch (err) {
      const status = isAuthValid(loadAuth()) ? 502 : 401;
      respondError(
        res,
        openaiTr,
        status,
        'authentication_error',
        (err as Error)?.message ?? 'authentication failure',
      );
      return;
    }

    let upstream = await callModelsUpstream(cfg, auth, abort.signal);

    if (upstream.status === 401 && !res.headersSent) {
      logger.info('Upstream 401 on /models; forcing token refresh and retrying once.');
      try {
        auth = await ensureCopilotToken(cfg, { force: true });
      } catch (err) {
        respondError(
          res,
          openaiTr,
          401,
          'authentication_error',
          (err as Error)?.message ?? 'token refresh failed',
        );
        return;
      }
      upstream = await callModelsUpstream(cfg, auth, abort.signal);
    }

    if (!upstream.ok) {
      const bodyText = await upstream.text();
      const errClass = classifyStatus(upstream.status);
      const msg =
        pickUpstreamMessage(bodyText) ??
        `Upstream ${upstream.status}${upstream.statusText ? ' ' + upstream.statusText : ''}`;
      respondError(res, openaiTr, upstream.status, errClass, msg);
      if (upstream.status === 401) {
        logger.warn('Upstream 401 after refresh; please re-run `copilot-relay login`.');
      }
      return;
    }

    res.statusCode = upstream.status;
    copyResponseHeaders(res, upstream);
    if (!upstream.body) {
      res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(
      upstream.body as unknown as import('node:stream/web').ReadableStream,
    );
    nodeStream.on('error', (streamErr) => {
      logger.warn('Upstream /models stream error:', streamErr);
      if (!res.writableEnded) res.end();
    });
    nodeStream.pipe(res);
  } catch (err) {
    if (abort.signal.aborted) return;
    logger.error('Proxy /models error:', err);
    if (!res.headersSent) {
      respondError(
        res,
        openaiTr,
        502,
        'api_error',
        (err as Error)?.message ?? 'proxy error',
      );
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    req.off('close', onClose);
  }
}

async function callModelsUpstream(
  cfg: AppConfig,
  auth: AuthState,
  signal: AbortSignal,
): Promise<Response> {
  const base = auth.copilotApiBase ?? 'https://api.githubcopilot.com';
  const url = `${base}/models`;
  // Per spec §7.2 minus Content-Type (GET has no body).
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.copilotToken ?? ''}`,
    Accept: 'application/json',
    'User-Agent': cfg.userAgent,
    'Editor-Version': cfg.editorVersion,
    'Editor-Plugin-Version': cfg.editorPluginVersion,
    'Copilot-Integration-Id': cfg.copilotIntegrationId,
  };
  logger.debug(`-> GET ${url}`);
  return await fetch(url, { method: 'GET', headers, signal });
}

function respondError(
  res: http.ServerResponse,
  translator: Translator,
  status: number,
  errClass: string,
  message: string,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(translator.formatError(errClass, message)));
}

/** Spec §2.6 — map upstream HTTP status to an OpenAI error class string. */
function classifyStatus(status: number): string {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  return 'api_error';
}

/** Try to pull a human message out of the upstream body; fall back to raw. */
function pickUpstreamMessage(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    if (typeof parsed?.error?.message === 'string') return parsed.error.message;
    if (typeof parsed?.message === 'string') return parsed.message;
  } catch {
    /* not JSON */
  }
  const trimmed = bodyText.trim().slice(0, 500);
  return trimmed || undefined;
}

function copyResponseHeaders(res: http.ServerResponse, upstream: Response): void {
  upstream.headers.forEach((value, key) => {
    // Skip hop-by-hop / conflicting headers so Node can manage framing itself.
    const lower = key.toLowerCase();
    if (
      lower === 'transfer-encoding' ||
      lower === 'content-encoding' ||
      lower === 'content-length' ||
      lower === 'connection'
    )
      return;
    res.setHeader(key, value);
  });
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
