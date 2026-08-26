import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config.js';
import { AuthManager } from './AuthManager.js';

const CONFIG: AppConfig = {
  port: 0,
  logLevel: 'error',
  githubClientId: 'client',
  editorVersion: 'editor',
  editorPluginVersion: 'plugin',
  copilotIntegrationId: 'integration',
  userAgent: 'agent',
};

function tokenResponse(token: string): Response {
  return Response.json({
    token,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    endpoints: { api: 'https://copilot.test' },
  });
}

test('reactive refresh reuses a generation newer than the rejected one', async () => {
  let exchanges = 0;
  const manager = new AuthManager(CONFIG, {
    initialState: {
      accessToken: 'access',
      copilotToken: 'old',
      copilotExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      copilotApiBase: 'https://copilot.test',
    },
    fetchImpl: async () => {
      exchanges += 1;
      return tokenResponse('new');
    },
    saveState: () => undefined,
  });
  const signal = new AbortController().signal;
  const refreshed = await manager.refreshAfterRejection(signal, 0);
  const reused = await manager.refreshAfterRejection(signal, 0);

  assert.equal(refreshed.generation, 1);
  assert.equal(reused.copilotToken, 'new');
  assert.equal(exchanges, 1);
});

test('canceling one auth waiter does not abort another waiter', async () => {
  let completeExchange: ((response: Response) => void) | undefined;
  const manager = new AuthManager(CONFIG, {
    initialState: { accessToken: 'access' },
    fetchImpl: async () => await new Promise<Response>((resolve) => {
      completeExchange = resolve;
    }),
    saveState: () => undefined,
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = manager.getSnapshot(firstController.signal);
  const second = manager.getSnapshot(secondController.signal);
  firstController.abort();
  await assert.rejects(first, { name: 'AbortError' });
  completeExchange?.(tokenResponse('shared'));
  assert.equal((await second).copilotToken, 'shared');
});