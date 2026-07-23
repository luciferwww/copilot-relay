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
    } catch (e) {
      logger.warn('Failed to open browser automatically:', (e as Error).message);
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
    throw new Error(`Device code request failed: ${res.status} ${await res.text()}`);
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
  let waitMs = Math.max(interval, 1) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, waitMs));

    const res = await fetch(GH_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = (await res.json()) as AccessTokenResponse;

    if (data.access_token) return data.access_token;

    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      waitMs += 5000;
      continue;
    }
    throw new Error(
      `Device auth failed: ${data.error ?? 'unknown_error'} ${data.error_description ?? ''}`.trim(),
    );
  }
  throw new Error('Device code expired before user authorized.');
}
