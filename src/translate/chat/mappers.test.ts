import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRecord } from '../../models/ModelCatalog.js';
import { TranslationError } from '../responses/types.js';
import { mapMessagesRequest } from './request-mapper.js';
import { mapChatResult } from './response-mapper.js';

const model: ModelRecord = {
  id: 'gpt-test',
  supported_endpoints: ['/chat/completions'],
  capabilities: {
    supports: { streaming: true, tool_calls: true, parallel_tool_calls: true },
    limits: { max_output_tokens: 4096 },
  },
};

test('Chat mappers preserve tool ids across a complete round trip', () => {
  const request = mapMessagesRequest({
    model: 'gpt-test',
    max_tokens: 32,
    messages: [
      { role: 'user', content: 'look it up' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-123', name: 'lookup', input: { key: 'value' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-123', content: 'found' }],
      },
    ],
    tools: [{ name: 'lookup', description: 'Look up a value', input_schema: { type: 'object' } }],
  }, { model });

  assert.equal(request.body.max_completion_tokens, 32);
  assert.equal('max_tokens' in request.body, false);
  assert.deepEqual(request.body.messages, [
    { role: 'user', content: 'look it up' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-123',
        type: 'function',
        function: { name: 'lookup', arguments: '{"key":"value"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-123', content: 'found' },
  ]);

  const response = mapChatResult({
    id: 'chat-response',
    model: 'gpt-test-2026-03-17',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-456',
          type: 'function',
          function: { name: 'lookup', arguments: '{"other":true}' },
        }],
      },
    }],
    usage: { prompt_tokens: 5, completion_tokens: 7 },
  }, { model });

  assert.deepEqual(response.message.content, [
    { type: 'tool_use', id: 'call-456', name: 'lookup', input: { other: true } },
  ]);
  assert.equal(response.message.model, 'gpt-test');
  assert.equal(response.message.stop_reason, 'tool_use');
});

test('Chat request mapper rejects an unassociated tool result', () => {
  assert.throws(() => mapMessagesRequest({
    model: 'gpt-test',
    max_tokens: 32,
    messages: [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'result' }],
    }],
  }, { model }), TranslationError);
});

test('Chat response mapper decomposes prompt cache usage', () => {
  const response = mapChatResult({
    id: 'chat-response',
    model: 'gpt-test',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'answer' },
    }],
    usage: {
      prompt_tokens: 12,
      prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 },
      completion_tokens: 2,
    },
  }, { model });

  assert.deepEqual(response.message.usage, {
    input_tokens: 5,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 4,
    output_tokens: 2,
  });
});