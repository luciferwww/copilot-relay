import type http from 'node:http';
import type { AuthState } from '../auth/copilot.js';
import type { AppConfig } from '../config.js';
import { buildCopilotBaseHeaders, extractQueryString } from './shared.js';

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
}

/** Spec §11.4 / §7.2 — build the upstream URL + headers for Anthropic-shaped calls. */
export function buildUpstreamRequest(
  inbound: http.IncomingMessage,
  cfg: AppConfig,
  auth: AuthState,
): UpstreamRequest {
  const base = auth.copilotApiBase ?? 'https://api.githubcopilot.com';
  const qs = extractQueryString(inbound.url);
  const url = `${base}/v1/messages${qs}`;

  const anthVer = inbound.headers['anthropic-version'];
  const anthBeta = inbound.headers['anthropic-beta'];
  const accept = inbound.headers['accept'];

  const headers: Record<string, string> = {
    ...buildCopilotBaseHeaders(cfg, auth),
    'Content-Type': 'application/json',
    'anthropic-version': typeof anthVer === 'string' ? anthVer : '2023-06-01',
  };

  if (typeof anthBeta === 'string') headers['anthropic-beta'] = anthBeta;
  if (typeof accept === 'string') headers['Accept'] = accept;

  return { url, headers };
}

/**
 * Spec §2.6 — Anthropic error shape: { type: "error", error: { type, message } }.
 * The `code` argument is accepted for signature parity with the OpenAI translator
 * but intentionally not surfaced (Anthropic shape has no `code` field).
 */
export function formatError(
  errClass: string,
  message: string,
  _code?: string | null,
): object {
  return { type: 'error', error: { type: errClass, message } };
}

/**
 * Spec §2.8 — mid-stream error termination for Anthropic SSE.
 * Writes one `event: error` frame then closes. Idempotent.
 */
export function writeStreamErrorFrame(
  res: http.ServerResponse,
  err: { class: string; message: string; code?: string | null },
): void {
  if (res.writableEnded) return;
  const body = {
    type: 'error',
    error: { type: err.class, message: err.message },
  };
  res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
  res.end();
}
