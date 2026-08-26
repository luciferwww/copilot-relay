import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AppConfig } from './config.js';
import { isLoopbackHost, RemoteAccessRequiredError } from './bind-policy.js';
import { startHttpServer, type HttpRuntime } from './http-server.js';
import { setLevel } from './logger.js';
import { ModelCatalogError, type ModelRecord } from './models/ModelCatalog.js';
import { ContinuationRegistry } from './translate/responses/ContinuationRegistry.js';
import { REQUEST_BODY_MAX_BYTES } from './translate/responses/types.js';
import type { InvocationContext, InvocationPlan } from './upstream/CopilotTransport.js';

const CONFIG: AppConfig = {
  host: '127.0.0.1',
  port: 0,
  logLevel: 'error',
  githubClientId: 'client',
  editorVersion: 'editor',
  editorPluginVersion: 'plugin',
  copilotIntegrationId: 'integration',
  userAgent: 'agent',
};

test('bind policy recognizes only explicit loopback hosts', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.255.10.20', '::1', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'relay.local']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('HTTP server requires explicit opt-in before remote binding', async () => {
  await assert.rejects(
    startHttpServer({ ...CONFIG, host: '0.0.0.0' }),
    RemoteAccessRequiredError,
  );
});

test('HTTP server accepts explicitly authorized wildcard binding', async () => {
  const server = await startHttpServer(
    { ...CONFIG, host: '0.0.0.0' },
    { runtime: runtimeFor({ id: 'unused', supported_endpoints: [] }, async () => {
      throw new Error('upstream must not be called');
    }), allowRemoteAccess: true },
  );
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await server.close();
  }
});

function invocationContext(): InvocationContext {
  return {
    authRetryUsed: false,
    replanUsed: false,
    downstreamStarted: false,
    invocationCount: 0,
  };
}

function runtimeFor(
  model: ModelRecord,
  invoke: (plan: InvocationPlan, context: InvocationContext) => Promise<Response>,
): HttpRuntime {
  return {
    registry: new ContinuationRegistry(),
    catalog: {
      currentGeneration: 1,
      resolve: async () => model,
      invalidate: () => undefined,
    } as unknown as HttpRuntime['catalog'],
    transport: {
      createInvocationContext: invocationContext,
      invoke: async (plan: InvocationPlan, _signal: AbortSignal, context: InvocationContext) => {
        context.invocationCount += 1;
        return await invoke(plan, context);
      },
      proxyModels: async () => new Response('{"data":[]}'),
    } as unknown as HttpRuntime['transport'],
  };
}

test('HTTP Messages body boundary returns Anthropic 415 and 400 errors', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/v1/messages'] };
  const runtime = runtimeFor(model, async () => {
    throw new Error('upstream must not be called');
  });
  const server = await startHttpServer(CONFIG, { runtime });
  try {
    const missingType = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(missingType.status, 415);
    assert.equal((await missingType.json() as { type: string }).type, 'error');

    const malformed = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);

    const nonObject = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    assert.equal(nonObject.status, 400);
  } finally {
    await server.close();
  }
});

test('HTTP Messages distinguishes unknown models from invalid model metadata', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  for (const variant of [
    { kind: 'missing' as const, status: 400, type: 'invalid_request_error' },
    { kind: 'invalid' as const, status: 502, type: 'api_error' },
  ]) {
    const baseRuntime = runtimeFor(model, async () => {
      throw new Error('upstream must not be called');
    });
    const runtime: HttpRuntime = {
      ...baseRuntime,
      catalog: {
        currentGeneration: 1,
        resolve: async () => {
          throw new ModelCatalogError(variant.kind, 'model resolution failed');
        },
        invalidate: () => undefined,
      } as unknown as HttpRuntime['catalog'],
    };
    const server = await startHttpServer(CONFIG, { runtime });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-test', messages: [], max_tokens: 16 }),
      });
      const body = await response.json() as { error: { type: string } };
      assert.equal(response.status, variant.status);
      assert.equal(body.error.type, variant.type);
    } finally {
      await server.close();
    }
  }
});

test('native Messages passthrough preserves request and response bytes', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/v1/messages'] };
  const requestText = '{ "model": "gpt-test", "messages": [], "max_tokens": 16 }';
  const responseText = '{ "native" : true }';
  let upstreamBody = '';
  const runtime = runtimeFor(model, async (plan) => {
    upstreamBody = Buffer.from(plan.body).toString('utf8');
    return new Response(responseText, {
      headers: { 'content-type': 'application/json' },
    });
  });
  const server = await startHttpServer(CONFIG, { runtime });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestText,
    });
    assert.equal(upstreamBody, requestText);
    assert.equal(await response.text(), responseText);
  } finally {
    await server.close();
  }
});

test('native Responses passthrough preserves request, query, and JSON response bytes', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  const requestText = '{ "model": "gpt-test", "input": "hello", "stream": false }';
  const responseText = '{ "id": "resp_test", "status": "completed" }';
  let upstreamPlan: InvocationPlan | undefined;
  const baseRuntime = runtimeFor(model, async (plan) => {
    upstreamPlan = plan;
    return new Response(responseText, {
      headers: { 'content-type': 'application/json' },
    });
  });
  const runtime: HttpRuntime = {
    ...baseRuntime,
    registry: new Proxy(baseRuntime.registry, {
      get() {
        throw new Error('native Responses must not access continuation state');
      },
    }),
  };
  const server = await startHttpServer(CONFIG, { runtime });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses?api-version=2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestText,
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), responseText);
    assert.equal(upstreamPlan?.endpoint, '/responses');
    assert.equal(upstreamPlan?.query, '?api-version=2');
    assert.equal(Buffer.from(upstreamPlan?.body ?? []).toString('utf8'), requestText);
    assert.equal(upstreamPlan?.accept, 'application/json');
    assert.equal(upstreamPlan?.headers?.['Openai-Intent'], 'conversation-panel');
  } finally {
    await server.close();
  }
});

test('native Responses passthrough preserves SSE bytes', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  const responseText = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  let accept: InvocationPlan['accept'];
  const runtime = runtimeFor(model, async (plan) => {
    accept = plan.accept;
    return new Response(responseText, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const server = await startHttpServer(CONFIG, { runtime });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', input: 'hello', stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(await response.text(), responseText);
    assert.equal(accept, 'text/event-stream');
  } finally {
    await server.close();
  }
});

test('native Responses invokes upstream without accessing the model catalog', async () => {
  const model: ModelRecord = { id: 'unused', supported_endpoints: [] };
  let invocations = 0;
  const baseRuntime = runtimeFor(model, async () => {
    invocations += 1;
    return Response.json({ id: 'resp_test', status: 'completed' });
  });
  const runtime: HttpRuntime = {
    ...baseRuntime,
    catalog: new Proxy(baseRuntime.catalog, {
      get() {
        throw new Error('native Responses must not access the model catalog');
      },
    }),
  };
  const server = await startHttpServer(CONFIG, { runtime });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { id: string }).id, 'resp_test');
    assert.equal(invocations, 1);
  } finally {
    await server.close();
  }
});

test('native Responses applies the shared request body limit before transport', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  let invoked = false;
  const baseRuntime = runtimeFor(model, async () => {
    invoked = true;
    return new Response('unexpected');
  });
  const server = await startHttpServer(CONFIG, { runtime: baseRuntime });
  try {
    const oversizedBody = JSON.stringify({
      model: 'gpt-test',
      input: 'x'.repeat(REQUEST_BODY_MAX_BYTES),
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversizedBody,
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json() as { error: { type: string } }).error.type, 'invalid_request_error');
    assert.equal(invoked, false);
  } finally {
    await server.close();
  }
});

test('native Responses does not retry a plain upstream 400', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  const upstreamSentinel = 'UPSTREAM_RESPONSES_ERROR_SENTINEL';
  let invocations = 0;
  const runtime = runtimeFor(model, async () => {
    invocations += 1;
    return Response.json({ error: { message: upstreamSentinel } }, { status: 400 });
  });
  const server = await startHttpServer(CONFIG, { runtime });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        type: 'invalid_request_error',
        message: 'Upstream rejected the request.',
        code: null,
      },
    });
    assert.equal(invocations, 1);
  } finally {
    await server.close();
  }
});

test('exact unsupported endpoint code refreshes and replans the same model once', async () => {
  const responsesModel: ModelRecord = {
    id: 'gpt-test',
    supported_endpoints: ['/responses'],
    capabilities: { supports: {}, limits: { max_output_tokens: 1024 } },
  };
  const nativeModel: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/v1/messages'] };
  const endpoints: string[] = [];
  let resolves = 0;
  const baseRuntime = runtimeFor(responsesModel, async (plan) => {
    endpoints.push(plan.endpoint);
    if (endpoints.length === 1) {
      return Response.json(
        { error: { code: 'unsupported_api_for_model' } },
        { status: 400 },
      );
    }
    return new Response('{"native":true}', {
      headers: { 'content-type': 'application/json' },
    });
  });
  const runtime: HttpRuntime = {
    ...baseRuntime,
    catalog: {
      currentGeneration: 1,
      resolve: async () => ++resolves === 1 ? responsesModel : nativeModel,
      invalidate: () => undefined,
    } as unknown as HttpRuntime['catalog'],
  };
  const server = await startHttpServer(CONFIG, { runtime });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 16,
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(endpoints, ['/responses', '/v1/messages']);
    assert.equal(resolves, 2);
  } finally {
    await server.close();
  }
});

test('broken non-SSE passthrough closes without appending an SSE error frame', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/v1/messages'] };
  let pullCount = 0;
  const runtime = runtimeFor(model, async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) controller.enqueue(new TextEncoder().encode('{"partial":'));
      else controller.error(new Error('upstream reset'));
    },
  }), { headers: { 'content-type': 'application/json' } }));
  const server = await startHttpServer(CONFIG, { runtime });
  try {
    const received = await requestUntilClose(server.port, JSON.stringify({
      model: 'gpt-test',
      messages: [],
      max_tokens: 16,
    }));
    assert.equal(received.includes('event: error'), false);
    assert.equal(received.includes('data:'), false);
  } finally {
    await server.close();
  }
});

test('non-SSE passthrough failure before its first byte returns a shaped 502', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/v1/messages'] };
  const runtime = runtimeFor(model, async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('upstream reset'));
    },
  }), { headers: { 'content-type': 'application/json' } }));
  const server = await startHttpServer(CONFIG, { runtime });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', messages: [], max_tokens: 16 }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      type: 'error',
      error: { type: 'api_error', message: 'The upstream response ended unexpectedly.' },
    });
  } finally {
    await server.close();
  }
});

test('translated stream protocol failure cancels the upstream response body', async () => {
  const model: ModelRecord = {
    id: 'gpt-test',
    supported_endpoints: ['/responses'],
    capabilities: {
      supports: { streaming: true },
      limits: { max_output_tokens: 1024 },
    },
  };
  let canceled = false;
  const runtime = runtimeFor(model, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'event: response.unknown\ndata: {"type":"response.unknown"}\n\n',
      ));
    },
    cancel() {
      canceled = true;
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const server = await startHttpServer(CONFIG, { runtime });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 16,
        stream: true,
      }),
    });
    await response.text();
    assert.equal(canceled, true);
  } finally {
    await server.close();
  }
});

test('HTTP lifecycle logs expose request structure without content values', async () => {
  const imageSentinel = 'IMAGE_SECRET_SENTINEL';
  const promptSentinel = 'PROMPT_SECRET_SENTINEL';
  const upstreamSentinel = 'UPSTREAM_SECRET_SENTINEL';
  const model: ModelRecord = {
    id: 'gpt-test',
    supported_endpoints: ['/responses'],
    capabilities: { supports: {}, limits: { max_output_tokens: 1024 } },
  };
  const runtime = runtimeFor(model, async () => new Response(upstreamSentinel, { status: 503 }));
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.join(' ')); };
  setLevel('debug');
  const server = await startHttpServer({ ...CONFIG, logLevel: 'debug' }, { runtime });
  try {
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(health.status, 200);

    const localFailure = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test',
        max_tokens: 16,
        messages: [{
          role: 'system',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageSentinel },
          }],
        }],
      }),
    });
    assert.equal(localFailure.status, 400);

    const upstreamFailure = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test',
        max_tokens: 16,
        messages: [{ role: 'user', content: promptSentinel }],
      }),
    });
    assert.equal(upstreamFailure.status, 502);
  } finally {
    await server.close();
    setLevel('error');
    console.log = originalLog;
  }

  const output = lines.join('\n');
  assert.equal(output.includes(imageSentinel), false);
  assert.equal(output.includes(promptSentinel), false);
  assert.equal(output.includes(upstreamSentinel), false);
  assert.match(output, /request\.received .*"role":"system".*"contentKind":"array".*"blockTypes":\["image"\]/);
  assert.match(output, /request\.received .*"role":"user".*"contentKind":"string"/);

  const terminalLines = lines.filter((line) => /request\.(?:completed|failed|canceled)/.test(line));
  assert.equal(terminalLines.length, 3);
  assert.ok(terminalLines.some((line) => /request\.completed .*"route":"health".*"status":200/.test(line)));
  assert.ok(terminalLines.some((line) => /request\.failed .*"route":"responses-translation".*"status":400.*"phase":"mapping".*"failureCode":"invalid_request_error".*"diagnosticCode":"request_mapping"/.test(line)));
  assert.ok(terminalLines.some((line) => /request\.failed .*"route":"responses-translation".*"endpoint":"\/responses".*"status":502.*"phase":"upstream".*"failureCode":"api_error".*"diagnosticCode":"upstream_http".*"invocationCount":1/.test(line)));
});

test('native Responses logs exclude input and upstream error content', async () => {
  const inputSentinel = 'NATIVE_RESPONSES_INPUT_SENTINEL';
  const upstreamSentinel = 'NATIVE_RESPONSES_UPSTREAM_SENTINEL';
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  const runtime = runtimeFor(model, async () => new Response(upstreamSentinel, { status: 503 }));
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.join(' ')); };
  setLevel('debug');
  const server = await startHttpServer({ ...CONFIG, logLevel: 'debug' }, { runtime });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', input: inputSentinel }),
    });
    assert.equal(response.status, 502);
  } finally {
    await server.close();
    setLevel('error');
    console.log = originalLog;
  }

  const output = lines.join('\n');
  assert.equal(output.includes(inputSentinel), false);
  assert.equal(output.includes(upstreamSentinel), false);
  assert.match(output, /request\.received .*"path":"\/v1\/responses".*"modelId":"gpt-test"/);
  assert.match(output, /request\.failed .*"route":"responses-passthrough".*"endpoint":"\/responses".*"status":502/);
});

function requestUntilClose(port: number, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(received);
    };
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNRESET') finish();
      else reject(error);
    });
    request.on('response', (response) => {
      response.on('data', (chunk: Buffer) => { received += chunk.toString('utf8'); });
      response.on('end', finish);
      response.on('aborted', finish);
      response.on('error', finish);
    });
    request.end(body);
  });
}