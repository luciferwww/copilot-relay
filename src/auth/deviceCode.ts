import openUrl from 'open';
import { logger } from '../logger.js';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

export interface GitHubDeviceLoginResult {
  accessToken: string;
}

const GH_DEVICE_URL = 'https://github.com/login/device/code';
const GH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const SCOPE = 'read:user';

export async function loginWithDeviceCode(
  clientId: string,
  options: { openBrowser?: boolean } = {},
): Promise<GitHubDeviceLoginResult> {
  if (!clientId) {
    throw new Error(
      'githubClientId is empty. Set it in ~/.copilot-relay/config.json before running login.',
    );
  }
  const openBrowser = options.openBrowser ?? true;
  const dc = await requestDeviceCode(clientId);

  console.log('');
  console.log('  Open this URL in your browser:  ' + dc.verification_uri);
  console.log('  Enter code:                     ' + dc.user_code);
  console.log('');

  if (openBrowser) {
    try {
      await openUrl(dc.verification_uri);
    } catch {
      logger.warn('Failed to open the browser automatically.');
    }
  }

  const token = await pollForToken(clientId, dc.device_code, dc.interval, dc.expires_in);
  return { accessToken: token };
}

async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const res = await fetch(GH_DEVICE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: SCOPE }),
  });
  if (!res.ok) {
    throw new Error(`Device code request failed with HTTP ${res.status}.`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

async function pollForToken(
  clientId: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000;
  const baseInterval = Math.max(interval, 1) * 1000;
  // Cap slow_down backoff so a chatty upstream cannot make us sleep past
  // `deadline` before we notice.
  const MAX_INTERVAL_MS = 60_000;
  let waitMs = baseInterval;

  while (Date.now() < deadline) {
    // Cap this sleep by the remaining time so we cannot sleep past `deadline`
    // and wake up only to report expiry. A negative value would sleep
    // indefinitely on some platforms; clamp to 0.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(waitMs, remaining)));

    const res = await fetch(GH_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    if (!res.ok) {
      // GitHub returns 200 for the documented OAuth states (pending / slow_down / etc).
      // Non-2xx here means transport-level trouble (5xx, 429, HTML error page) that
      // will not parse as AccessTokenResponse. Surface it instead of silently looping.
      throw new Error(`Device auth poll failed with HTTP ${res.status}.`);
    }
    const data = (await res.json()) as AccessTokenResponse;

    if (data.access_token) return data.access_token;

    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      waitMs = Math.min(waitMs + 5000, MAX_INTERVAL_MS);
      continue;
    }
    const knownError = ['access_denied', 'expired_token', 'incorrect_device_code'].includes(
      data.error ?? '',
    )
      ? data.error
      : 'unknown_error';
    throw new Error(`Device auth failed with ${knownError}.`);
  }
  throw new Error('Device code expired before user authorized.');
}
