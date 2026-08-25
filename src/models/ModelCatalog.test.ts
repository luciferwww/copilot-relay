import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalog, ModelCatalogError } from './ModelCatalog.js';

function catalogResponse(id = 'gpt-test'): Response {
  return Response.json({
    data: [{ id, supported_endpoints: ['/responses'], capabilities: { supports: {}, limits: {} } }],
  });
}

test('invalidated catalog retains bounded-stale data when refresh fails', async () => {
  let requests = 0;
  const catalog = new ModelCatalog({
    fetchCatalog: async () => {
      requests += 1;
      if (requests === 1) return catalogResponse();
      throw new Error('network failure');
    },
  });
  const signal = new AbortController().signal;
  const first = await catalog.resolve('gpt-test', signal);
  catalog.invalidate(catalog.currentGeneration);
  const stale = await catalog.resolve('gpt-test', signal);

  assert.equal(stale, first);
  assert.equal(requests, 2);
});

test('invalidated catalog does not reuse stale data when the caller forbids it', async () => {
  let requests = 0;
  const catalog = new ModelCatalog({
    fetchCatalog: async () => {
      requests += 1;
      if (requests === 1) return catalogResponse();
      throw new Error('network failure');
    },
  });
  const signal = new AbortController().signal;
  await catalog.resolve('gpt-test', signal);
  catalog.invalidate(catalog.currentGeneration);

  await assert.rejects(
    catalog.resolve('gpt-test', signal, { allowStale: false }),
    (error: unknown) =>
      error instanceof ModelCatalogError && error.kind === 'unavailable',
  );
  assert.equal(requests, 2);
});

test('a new catalog waiter starts fresh work after last-waiter cancellation', async () => {
  let requests = 0;
  const catalog = new ModelCatalog({
    fetchCatalog: async (signal) => {
      requests += 1;
      if (requests > 1) return catalogResponse();
      return await new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('canceled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  const firstController = new AbortController();
  const first = catalog.resolve('gpt-test', firstController.signal);
  firstController.abort();
  await assert.rejects(first, { name: 'AbortError' });

  const result = await catalog.resolve('gpt-test', new AbortController().signal);
  assert.equal(result.id, 'gpt-test');
  assert.equal(requests, 2);
});

test('an already-aborted catalog waiter starts no refresh work', async () => {
  let requests = 0;
  const catalog = new ModelCatalog({
    fetchCatalog: async () => {
      requests += 1;
      return catalogResponse();
    },
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(catalog.resolve('gpt-test', controller.signal), { name: 'AbortError' });
  assert.equal(requests, 0);
});

test('catalog skips unrelated records that omit routing metadata', async () => {
  const catalog = new ModelCatalog({
    fetchCatalog: async () => Response.json({
      data: [
        { id: 'non-routable-record' },
        { id: 'gpt-test', supported_endpoints: ['/responses'] },
      ],
    }),
  });

  const model = await catalog.resolve('gpt-test', new AbortController().signal);
  assert.deepEqual(model.supported_endpoints, ['/responses']);
});

test('catalog distinguishes unknown models from invalid routing metadata', async () => {
  const catalog = new ModelCatalog({
    fetchCatalog: async () => Response.json({
      data: [
        { id: 'invalid-model' },
        { id: 'gpt-test', supported_endpoints: ['/responses'] },
      ],
    }),
  });
  const signal = new AbortController().signal;

  await assert.rejects(
    catalog.resolve('invalid-model', signal),
    (error: unknown) => error instanceof ModelCatalogError && error.kind === 'invalid',
  );
  await assert.rejects(
    catalog.resolve('unknown-model', signal),
    (error: unknown) => error instanceof ModelCatalogError && error.kind === 'missing',
  );
});