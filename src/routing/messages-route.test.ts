import test from 'node:test';
import assert from 'node:assert/strict';
import { planMessagesRoute } from './messages-route.js';
import type { ModelRecord } from '../models/ModelCatalog.js';

test('messages route uses exact endpoint priority without treating websocket as HTTP', () => {
  const native: ModelRecord = {
    id: 'same-model',
    supported_endpoints: ['/responses', '/v1/messages'],
  };
  assert.equal(planMessagesRoute('same-model', native).kind, 'messages-passthrough');

  const responses: ModelRecord = {
    id: 'same-model',
    supported_endpoints: ['ws:/responses', '/responses'],
  };
  assert.equal(planMessagesRoute('same-model', responses).kind, 'responses-translation');

  const websocketOnly: ModelRecord = {
    id: 'same-model',
    supported_endpoints: ['ws:/responses'],
  };
  assert.equal(planMessagesRoute('same-model', websocketOnly).kind, 'client-error');
});

test('messages route rejects mismatched metadata instead of substituting a model', () => {
  const model: ModelRecord = { id: 'other-model', supported_endpoints: ['/responses'] };
  assert.equal(planMessagesRoute('requested-model', model).kind, 'upstream-metadata-error');
});