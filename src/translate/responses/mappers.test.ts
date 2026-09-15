import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRecord } from '../../models/ModelCatalog.js';
import { mapMessagesRequest } from './request-mapper.js';
import { mapResponsesResult } from './response-mapper.js';
import { TranslationError } from './types.js';

const model: ModelRecord = {
  id: 'gpt-test',
  supported_endpoints: ['/responses'],
  capabilities: {
    supports: { streaming: true, tool_calls: true, parallel_tool_calls: true },
    limits: { max_output_tokens: 4096 },
  },
};

test('Responses request mapper emits a minimal stateless request', () => {
  const mapped = mapMessagesRequest({
    model: 'gpt-test',
    max_tokens: 32,
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: 'hello' }],
  }, { model });

  assert.deepEqual(mapped.body, {
    model: 'gpt-test',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    max_output_tokens: 32,
    stream: false,
    store: false,
  });
  assert.equal('previous_response_id' in mapped.body, false);
  assert.equal('reasoning' in mapped.body, false);
});

test('Responses mappers preserve tool ids across a complete round trip', () => {
  const mapped = mapMessagesRequest({
    model: 'gpt-test',
    max_tokens: 32,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-123', name: 'lookup', input: { path: 'README.md' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-123', content: 'contents' }],
      },
    ],
  }, { model });

  assert.deepEqual(mapped.body.input, [
    {
      type: 'function_call',
      call_id: 'call-123',
      name: 'lookup',
      arguments: '{"path":"README.md"}',
    },
    { type: 'function_call_output', call_id: 'call-123', output: 'contents' },
  ]);

  const response = mapResponsesResult({
    id: 'response-id',
    model: 'gpt-test-2026-03-17',
    status: 'completed',
    output: [{
      type: 'function_call',
      status: 'completed',
      call_id: 'call-456',
      name: 'lookup',
      arguments: '{"path":"package.json"}',
    }],
    usage: { input_tokens: 5, output_tokens: 7 },
  }, { model });

  assert.deepEqual(response.message.content, [{
    type: 'tool_use',
    id: 'call-456',
    name: 'lookup',
    input: { path: 'package.json' },
  }]);
  assert.equal(response.message.model, 'gpt-test');
  assert.equal(response.message.stop_reason, 'tool_use');
});

test('Responses request mapper rejects missing, duplicate, and out-of-order tool ids', () => {
  const invalidMessages = [
    [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'result' }] }],
    [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'one', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same', content: 'one' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'two', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same', content: 'two' }] },
    ],
    [{ role: 'assistant', content: [{ type: 'tool_use', id: '', name: 'lookup', input: {} }] }],
  ];

  for (const messages of invalidMessages) {
    assert.throws(
      () => mapMessagesRequest({ model: 'gpt-test', max_tokens: 32, messages }, { model }),
      TranslationError,
    );
  }
});

test('Responses response mapper rejects malformed function arguments', () => {
  for (const argumentsValue of ['not-json', '[]']) {
    assert.throws(() => mapResponsesResult({
      id: 'response-id',
      model: 'gpt-test',
      status: 'completed',
      output: [{
        type: 'function_call',
        status: 'completed',
        call_id: 'call-123',
        name: 'lookup',
        arguments: argumentsValue,
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }, { model }), TranslationError);
  }
});

test('Responses response mapper omits opaque output and preserves text', () => {
  const mapped = mapResponsesResult({
    id: 'response-id',
    model: 'gpt-test',
    status: 'completed',
    output: [
      { type: 'reasoning', encrypted_content: 'opaque', summary: [] },
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }],
      },
    ],
    usage: { input_tokens: 2, output_tokens: 3 },
  }, { model });

  assert.deepEqual(mapped.message.content, [{ type: 'text', text: 'answer' }]);
  assert.equal(mapped.message.stop_reason, 'end_turn');
});

test('Responses response mapper rejects duplicate function call ids', () => {
  assert.throws(() => mapResponsesResult({
    id: 'response-id',
    model: 'gpt-test',
    status: 'completed',
    output: ['one', 'two'].map((name) => ({
      type: 'function_call',
      status: 'completed',
      call_id: 'duplicate',
      name,
      arguments: '{}',
    })),
    usage: { input_tokens: 1, output_tokens: 1 },
  }, { model }), TranslationError);
});