import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRecord } from '../../models/ModelCatalog.js';
import { SseTranslator } from './SseTranslator.js';

function data(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
}

test('Chat SSE translator preserves a tool id across split frames and arguments', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/chat/completions'] };
  const output: string[] = [];
  const translator = new SseTranslator({ model }, async (frame) => { output.push(frame); });
  const base = {
    id: 'chat-response',
    object: 'chat.completion.chunk',
    model: 'gpt-test-2026-03-17',
  };
  const source = [
    data({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
    data({
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call-123',
            type: 'function',
            function: { name: 'lookup', arguments: '{"key"' },
          }],
        },
        finish_reason: null,
      }],
    }),
    data({
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: ':"value"}' } }] },
        finish_reason: null,
      }],
    }),
    data({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: {
        prompt_tokens: 9,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
        completion_tokens: 7,
      },
    }),
    data('[DONE]'),
  ].join('');
  const bytes = new TextEncoder().encode(source);
  for (let index = 0; index < bytes.length; index += 7) {
    await translator.push(bytes.slice(index, index + 7));
  }
  await translator.finish();

  assert.equal(output.some((frame) => frame.includes('"id":"call-123"')), true);
  assert.equal(output.filter((frame) => frame.includes('input_json_delta')).length, 2);
  assert.match(output.at(-2) ?? '', /"stop_reason":"tool_use"/u);
  assert.match(
    output.at(-2) ?? '',
    /"input_tokens":4,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":7/u,
  );
  assert.match(output.at(-1) ?? '', /event: message_stop/u);
});