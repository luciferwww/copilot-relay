import http from 'node:http';
import { Readable } from 'node:stream';
import type { AppConfig } from './config.js';
import { ensureCopilotToken } from './auth/copilot.js';
import * as openaiTr from './translate/openai.js';
import * as anthropicTr from './translate/anthropic.js';
import { logger } from './logger.js';

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startServer(cfg: AppConfig): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, cfg).catch((err) => {
      logger.error('Unhandled error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
      }
      res.end(JSON.stringify({ error: { message: (err as Error).message } }));
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
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  logger.debug(`${method} ${url}`);

  if (method === 'GET' && url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'GET' && url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'gpt-4o', object: 'model', owned_by: 'github-copilot' },
          { id: 'gpt-4o-mini', object: 'model', owned_by: 'github-copilot' },
          { id: 'claude-3.5-sonnet', object: 'model', owned_by: 'github-copilot' },
          { id: 'claude-sonnet-4', object: 'model', owned_by: 'github-copilot' },
        ],
      }),
    );
    return;
  }

  if (method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    await proxy(req, res, cfg, 'openai');
    return;
  }

  if (method === 'POST' && url === '/v1/messages') {
    await proxy(req, res, cfg, 'anthropic');
    return;
  }

  res.statusCode = 404;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { message: `No route for ${method} ${url}` } }));
}

async function proxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: AppConfig,
  kind: 'openai' | 'anthropic',
): Promise<void> {
  const body = await readBody(req);
  const auth = await ensureCopilotToken(cfg);
  const translator = kind === 'openai' ? openaiTr : anthropicTr;
  const { url, headers } = translator.buildUpstreamRequest(req, cfg, auth);

  logger.debug(`-> ${url}`);
  const upstream = await fetch(url, { method: 'POST', headers, body });

  res.statusCode = upstream.status;
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

  if (!upstream.body) {
    res.end();
    return;
  }
  // Convert the WHATWG ReadableStream returned by fetch into a Node Readable
  // and pipe it straight through — this preserves SSE streaming semantics.
  const nodeStream = Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream);
  nodeStream.pipe(res);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
