import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config.js';
import { AuthManager } from '../auth/AuthManager.js';
import { CopilotTransport } from './CopilotTransport.js';

const CONFIG: AppConfig = {
  port: 0,
  logLevel: 'error',
  githubClientId: 'client',
  editorVersion: 'editor',
  editorPluginVersion: 'plugin',
  copilotIntegrationId: 'integration',
  userAgent: 'agent',
};

function initialAuth(fetchImpl: typeof fetch): AuthManager {
  return new AuthManager(CONFIG, {
    initialState: {
      accessToken: 'access',
      copilotToken: 'copilot',
      copilotExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      copilotApiBase: 'https://copilot.test',
    },
    fetchImpl,
    saveState: () => undefined,
  });
}

test('reactive model 401 exchanges auth once and retries the invocation once', async () => {
  let authCalls = 0;
  let modelCalls = 0;
  const auth = initialAuth(async () => {
    authCalls += 1;
    return Response.json({
      token: 'new-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      endpoints: { api: 'https://copilot.test' },
    });
  });
  const transport = new CopilotTransport(CONFIG, auth, {
    fetchImpl: async () => {
      modelCalls += 1;
      return modelCalls === 1
        ? new Response('rejected', { status: 401 })
        : new Response('ok', { status: 200 });
    },
  });
  const context = transport.createInvocationContext();
  const response = await transport.invoke(
    { endpoint: '/responses', body: new Uint8Array(), accept: 'application/json' },
    new AbortController().signal,
    context,
  );

  assert.equal(await response.text(), 'ok');
  assert.equal(authCalls, 1);
  assert.equal(modelCalls, 2);
  assert.equal(context.invocationCount, 2);
});

test('request abort remains connected after upstream headers arrive', async () => {
  const auth = initialAuth(async () => {
    throw new Error('auth exchange was not expected');
  });
  const transport = new CopilotTransport(CONFIG, auth, {
    fetchImpl: async (_url, init) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(new Error('aborted')), {
            once: true,
          });
        },
      }));
    },
  });
  const controller = new AbortController();
  const response = await transport.invoke(
    { endpoint: '/responses', body: new Uint8Array(), accept: 'text/event-stream' },
    controller.signal,
    transport.createInvocationContext(),
  );
  controller.abort();
  await assert.rejects(response.text(), /aborted/);
});

test('an already-aborted invocation starts no auth refresh or model request', async () => {
  let authCalls = 0;
  let modelCalls = 0;
  const auth = new AuthManager(CONFIG, {
    initialState: {
      accessToken: 'access',
      copilotToken: 'expired',
      copilotExpiresAt: 0,
      copilotApiBase: 'https://copilot.test',
    },
    fetchImpl: async () => {
      authCalls += 1;
      return Response.json({
        token: 'new-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        endpoints: { api: 'https://copilot.test' },
      });
    },
    saveState: () => undefined,
  });
  const transport = new CopilotTransport(CONFIG, auth, {
    fetchImpl: async () => {
      modelCalls += 1;
      return new Response('unexpected');
    },
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    transport.invoke(
      { endpoint: '/responses', body: new Uint8Array() },
      controller.signal,
      transport.createInvocationContext(),
    ),
    { name: 'AbortError' },
  );
  assert.equal(authCalls, 0);
  assert.equal(modelCalls, 0);
});