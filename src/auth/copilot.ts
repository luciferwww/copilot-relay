import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
    /* Windows ACLs make chmod largely a no-op; ignore. */
  }
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
    throw new Error(
      `Copilot token exchange failed: ${res.status} ${await res.text()}`,
    );
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
  };
  saveAuth(next);
  return next;
}

export async function ensureCopilotToken(cfg: AppConfig): Promise<AuthState> {
  const state = loadAuth();
  if (!state) throw new Error('Not logged in. Run `copilot-relay login` first.');
  if (isCopilotTokenValid(state)) return state;
  return refreshCopilotToken(state, cfg);
}
