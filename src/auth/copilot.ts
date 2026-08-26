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
  invalid?: {
    code: 'access_token_rejected';
    at: string;
  };
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
  } catch {
    logger.warn('Failed to parse the auth file.');
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
  return !state.invalid;
}

export function isCopilotTokenValid(state: AuthState): boolean {
  if (!state.copilotToken || !state.copilotExpiresAt) return false;
  return state.copilotExpiresAt * 1000 - Date.now() > REFRESH_MARGIN_MS;
}

export async function refreshCopilotToken(
  state: AuthState,
  cfg: AppConfig,
  signal?: AbortSignal,
): Promise<AuthState> {
  logger.debug('Refreshing Copilot token...');
  const res = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    signal,
    headers: {
      Authorization: `token ${state.accessToken}`,
      Accept: 'application/json',
      'User-Agent': cfg.userAgent,
      'Editor-Version': cfg.editorVersion,
      'Editor-Plugin-Version': cfg.editorPluginVersion,
    },
  });
  if (!res.ok) {
    if (res.status === 401) {
      saveAuth({
        ...state,
        invalid: { code: 'access_token_rejected', at: new Date().toISOString() },
        lastRefreshError: undefined,
      });
      throw new Error('GitHub access token was rejected. Run login again.');
    }
    throw new Error(`Copilot token exchange failed with HTTP ${res.status}.`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('Copilot token exchange returned invalid JSON.');
  }
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { token?: unknown }).token !== 'string' ||
    (data as { token: string }).token.length === 0 ||
    typeof (data as { expires_at?: unknown }).expires_at !== 'number' ||
    !Number.isFinite((data as { expires_at: number }).expires_at) ||
    typeof (data as { endpoints?: { api?: unknown } }).endpoints?.api !== 'string' ||
    (data as { endpoints: { api: string } }).endpoints.api.length === 0
  ) {
    throw new Error('Copilot token exchange returned incomplete data.');
  }
  const tokenData = data as { token: string; expires_at: number; endpoints: { api: string } };
  const next: AuthState = {
    ...state,
    copilotToken: tokenData.token,
    copilotExpiresAt: tokenData.expires_at,
    copilotApiBase: tokenData.endpoints.api,
    invalid: undefined,
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
