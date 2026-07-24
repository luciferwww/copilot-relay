import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { AUTH_FILE, ensureDataDir, type AppConfig } from '../config.js';
import { logger } from '../logger.js';

export interface AuthState {
  /** Long-lived GitHub OAuth access token. Used to mint short-lived Copilot tokens. */
  accessToken: string;
  /** Short-lived Copilot API token. */
  copilotToken?: string;
  /** Copilot token expiry, epoch seconds. */
  copilotExpiresAt?: number;
  /** endpoints.api from the Copilot token response. */
  copilotApiBase?: string;
  /**
   * Reason of the last failed Copilot token refresh (e.g. access_token revoked).
   * Cleared on any successful refresh. Consumed by {@link isAuthValid} and
   * `copilot-relay status` (spec §1.3 / §11.1).
   */
  lastRefreshError?: string;
}

export interface EnsureOptions {
  /** True to bypass the 5 min expiry margin and force an upstream refresh. */
  force?: boolean;
}

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

export function loadAuth(): AuthState | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as AuthState;
  } catch (e) {
    logger.warn('Failed to parse auth file:', (e as Error).message);
    return null;
  }
}

export function saveAuth(state: AuthState): void {
  ensureDataDir();
  writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2), 'utf8');
  try {
    chmodSync(AUTH_FILE, 0o600);
  } catch {
    /* Windows ACLs make chmod largely a no-op; ignore (spec §3). */
  }
}

export function clearAuth(): void {
  if (existsSync(AUTH_FILE)) unlinkSync(AUTH_FILE);
}

/** Spec §11.1: state exists, accessToken present, last refresh did not fail. */
export function isAuthValid(state: AuthState | null): boolean {
  if (!state || !state.accessToken) return false;
  return !state.lastRefreshError;
}

export function isCopilotTokenValid(state: AuthState): boolean {
  if (!state.copilotToken || !state.copilotExpiresAt) return false;
  return state.copilotExpiresAt * 1000 - Date.now() > REFRESH_MARGIN_MS;
}

export async function refreshCopilotToken(
  state: AuthState,
  cfg: AppConfig,
): Promise<AuthState> {
  logger.debug('Refreshing Copilot token...');
  const res = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      Authorization: `token ${state.accessToken}`,
      Accept: 'application/json',
      'User-Agent': cfg.userAgent,
      'Editor-Version': cfg.editorVersion,
      'Editor-Plugin-Version': cfg.editorPluginVersion,
    },
  });
  if (!res.ok) {
    // Persist the failure marker but do NOT overwrite the copilot token fields
    // (spec §11.1: on refresh failure, previously stored token fields are kept as-is).
    // Truncate the upstream body so a large HTML error page cannot bloat auth.json
    // (or any log line that echoes this message). Slice by code points (via
    // Array.from) rather than UTF-16 code units so a multi-byte character
    // (emoji, CJK supplementary plane) is not cut in the middle, which would
    // leave a lone surrogate that renders as a replacement character downstream.
    const MAX_BODY_CODEPOINTS = 500;
    const rawBody = await res.text();
    const codePoints = Array.from(rawBody);
    const bodyExcerpt =
      codePoints.length > MAX_BODY_CODEPOINTS
        ? codePoints.slice(0, MAX_BODY_CODEPOINTS).join('') + '…(truncated)'
        : rawBody;
    const reason = `Copilot token exchange failed: ${res.status} ${bodyExcerpt}`;
    saveAuth({ ...state, lastRefreshError: reason });
    throw new Error(reason);
  }
  const data = (await res.json()) as {
    token: string;
    expires_at: number;
    endpoints?: { api?: string };
  };
  const next: AuthState = {
    ...state,
    copilotToken: data.token,
    copilotExpiresAt: data.expires_at,
    copilotApiBase:
      data.endpoints?.api ?? state.copilotApiBase ?? 'https://api.githubcopilot.com',
    lastRefreshError: undefined,
  };
  saveAuth(next);
  return next;
}

/**
 * Return a usable AuthState for calling Copilot API.
 *
 * @param opts.force  When true, skip the 5 min cache check and always refresh
 *                    (spec §11.1). Used by the reactive 401 retry path in
 *                    spec §2.7.
 */
export async function ensureCopilotToken(
  cfg: AppConfig,
  opts?: EnsureOptions,
): Promise<AuthState> {
  const state = loadAuth();
  if (!state) throw new Error('Not logged in. Run `copilot-relay login` first.');
  if (!opts?.force && isCopilotTokenValid(state)) return state;
  return refreshCopilotToken(state, cfg);
}
