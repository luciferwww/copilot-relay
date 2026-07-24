import type { AuthState } from '../auth/copilot.js';
import type { AppConfig } from '../config.js';

/**
 * Extract the `?...` portion (including the leading `?`) from an inbound URL,
 * or empty string if there isn't one. Preserves query params (e.g. `api-version`,
 * `beta=true`) that upstream may act on.
 */
export function extractQueryString(inbound: string | undefined): string {
  if (!inbound) return '';
  const q = inbound.indexOf('?');
  return q >= 0 ? inbound.slice(q) : '';
}

/**
 * Spec §7.2 — build the Copilot request headers common to every upstream call.
 * The returned map covers only the always-present set (Authorization,
 * User-Agent, Editor-Version, Editor-Plugin-Version, Copilot-Integration-Id).
 * Callers add `Content-Type`, `Accept`, `Openai-Intent`, `anthropic-*`, etc.
 * on top of the returned map.
 */
export function buildCopilotBaseHeaders(
  cfg: AppConfig,
  auth: AuthState,
): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.copilotToken ?? ''}`,
    'User-Agent': cfg.userAgent,
    'Editor-Version': cfg.editorVersion,
    'Editor-Plugin-Version': cfg.editorPluginVersion,
    'Copilot-Integration-Id': cfg.copilotIntegrationId,
  };
}
