import type http from 'node:http';
import type { AuthState } from '../auth/copilot.js';
import type { AppConfig } from '../config.js';

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
}

/** Spec §11.4 / §7.2 — build the upstream URL + headers for OpenAI-shaped calls. */
export function buildUpstreamRequest(
  inbound: http.IncomingMessage,
  cfg: AppConfig,
  auth: AuthState,
): UpstreamRequest {
  const base = auth.copilotApiBase ?? 'https://api.githubcopilot.com';
  const qs = extractQueryString(inbound.url);
  const url = `${base}/chat/completions${qs}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.copilotToken ?? ''}`,
    'Content-Type': 'application/json',
    'User-Agent': cfg.userAgent,
    'Editor-Version': cfg.editorVersion,
    'Editor-Plugin-Version': cfg.editorPluginVersion,
    'Copilot-Integration-Id': cfg.copilotIntegrationId,
    'Openai-Intent': 'conversation-panel',
  };

  const accept = inbound.headers['accept'];
  if (typeof accept === 'string') headers['Accept'] = accept;

  return { url, headers };
}

/**
 * Spec §2.6 — OpenAI error shape: { error: { type, message, code } }.
 * Returned as a plain object; caller stringifies.
 */
export function formatError(
  errClass: string,
  message: string,
  code?: string | null,
): object {
  return { error: { type: errClass, message, code: code ?? null } };
}

/**
 * Spec §2.8 — mid-stream error termination for OpenAI SSE.
 * Writes ONE `data:` frame and closes the connection. Does NOT emit
 * `data: [DONE]` (SDKs would treat that as a normal end and swallow the error).
 * Idempotent: no-op if the response is already ended.
 */
export function writeStreamErrorFrame(
  res: http.ServerResponse,
  err: { class: string; message: string; code?: string | null },
): void {
  if (res.writableEnded) return;
  const body = {
    error: { type: err.class, message: err.message, code: err.code ?? null },
  };
  res.write(`data: ${JSON.stringify(body)}\n\n`);
  res.end();
}

/**
 * Extract the `?...` portion (including the leading `?`) from an inbound URL,
 * or empty string if there isn't one. Preserves query params (e.g. api-version)
 * that upstream may act on.
 */
function extractQueryString(inbound: string | undefined): string {
  if (!inbound) return '';
  const q = inbound.indexOf('?');
  return q >= 0 ? inbound.slice(q) : '';
}
