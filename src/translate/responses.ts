import type http from 'node:http';
import type { AuthState } from '../auth/copilot.js';
import type { AppConfig } from '../config.js';
import { buildCopilotBaseHeaders, extractQueryString } from './shared.js';

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Spec §11.4 / §7.2 — build the upstream URL + headers for OpenAI Responses
 * shaped calls. Goes to `<base>/responses` (not `/chat/completions`):
 * models such as gpt-5.x expose only the `/responses` endpoint.
 */
export function buildUpstreamRequest(
  inbound: http.IncomingMessage,
  cfg: AppConfig,
  auth: AuthState,
): UpstreamRequest {
  const base = auth.copilotApiBase ?? 'https://api.githubcopilot.com';
  const qs = extractQueryString(inbound.url);
  const url = `${base}/responses${qs}`;

  const headers: Record<string, string> = {
    ...buildCopilotBaseHeaders(cfg, auth),
    'Content-Type': 'application/json',
    'Openai-Intent': 'conversation-panel',
  };

  const accept = inbound.headers['accept'];
  if (typeof accept === 'string') headers['Accept'] = accept;

  return { url, headers };
}

/**
 * Spec §2.6 — OpenAI Responses error shape:
 * `{ error: { code, message, param, type } }` (per OpenAI `ErrorResponse`).
 * Returned as a plain object; caller stringifies.
 */
export function formatError(
  errClass: string,
  message: string,
  code?: string | null,
): object {
  return { error: { code: code ?? null, message, param: null, type: errClass } };
}

/**
 * Spec §2.8 — mid-stream error termination for Responses SSE.
 * Writes ONE `event: error` frame (OpenAI `ErrorEvent`: `event: "error"`,
 * `data` is the bare `Error` object) and closes the connection. Idempotent:
 * no-op if the response is already ended.
 */
export function writeStreamErrorFrame(
  res: http.ServerResponse,
  err: { class: string; message: string; code?: string | null },
): void {
  if (res.writableEnded) return;
  const body = {
    code: err.code ?? null,
    message: err.message,
    param: null,
    type: err.class,
  };
  res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
  res.end();
}