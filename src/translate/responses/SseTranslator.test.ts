import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRecord } from '../../models/ModelCatalog.js';
import { ContinuationRegistry } from './ContinuationRegistry.js';
import { SseTranslator } from './SseTranslator.js';
import { TranslationError, type MappingContext } from './types.js';

function frame(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

test('SSE translator accepts rotated opaque response and item ids', async () => {
  const model: ModelRecord = {
    id: 'gpt-test',
    supported_endpoints: ['/responses'],
  };
  const context: MappingContext = { model, registry: new ContinuationRegistry() };
  const output: string[] = [];
  const translator = new SseTranslator(context, async (value) => {
    output.push(value);
  });
  const responseBase = { id: 'response-id', model: 'gpt-test' };
  const source = [
    frame('response.created', { response: { ...responseBase, status: 'in_progress', usage: null } }),
    frame('response.output_item.added', {
      output_index: 0,
      item: { id: 'item-id', type: 'message', status: 'in_progress', role: 'assistant' },
    }),
    frame('response.content_part.added', {
      output_index: 0,
      item_id: 'part-added-id',
      part: { type: 'output_text', text: '' },
    }),
    frame('response.output_text.delta', {
      output_index: 0,
      item_id: 'text-delta-id',
      delta: 'hello',
    }),
    frame('response.output_text.done', {
      output_index: 0,
      item_id: 'text-done-id',
      text: 'hello',
    }),
    frame('response.content_part.done', {
      output_index: 0,
      item_id: 'part-done-id',
      part: { type: 'output_text', text: 'hello' },
    }),
    frame('response.output_item.done', {
      output_index: 0,
      item: {
        id: 'completed-item-id',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    }),
    frame('response.completed', {
      response: {
        ...responseBase,
        id: 'rotated-terminal-id',
        status: 'completed',
        usage: { input_tokens: 11, output_tokens: 3 },
      },
    }),
  ].join('');
  const bytes = new TextEncoder().encode(source);
  for (let index = 0; index < bytes.length; index += 7) {
    await translator.push(bytes.slice(index, index + 7));
  }
  await translator.finish();

  assert.match(output[0], /event: message_start/);
  assert.equal(output.filter((entry) => entry.includes('event: message_delta')).length, 1);
  assert.match(output.at(-2) ?? '', /"input_tokens":11,"output_tokens":3/);
  assert.match(output.at(-1) ?? '', /event: message_stop/);
});

test('SSE translator emits sequential text parts from one message item', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  const context: MappingContext = { model, registry: new ContinuationRegistry() };
  const output: string[] = [];
  const translator = new SseTranslator(context, async (value) => { output.push(value); });
  const responseBase = { id: 'response-id', model: 'gpt-test' };
  const events = [
    frame('response.created', { response: { ...responseBase, status: 'in_progress', usage: null } }),
    frame('response.output_item.added', {
      output_index: 0,
      item: { id: 'message-item', type: 'message', status: 'in_progress', role: 'assistant' },
    }),
  ];
  for (const text of ['first', 'second']) {
    events.push(
      frame('response.content_part.added', {
        output_index: 0,
        item_id: 'message-item',
        part: { type: 'output_text', text: '' },
      }),
      frame('response.output_text.delta', {
        output_index: 0,
        item_id: 'message-item',
        delta: text,
      }),
      frame('response.output_text.done', {
        output_index: 0,
        item_id: 'message-item',
        text,
      }),
      frame('response.content_part.done', {
        output_index: 0,
        item_id: 'message-item',
        part: { type: 'output_text', text },
      }),
    );
  }
  events.push(
    frame('response.output_item.done', {
      output_index: 0,
      item: {
        id: 'message-item',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'first' },
          { type: 'output_text', text: 'second' },
        ],
      },
    }),
    frame('response.completed', {
      response: {
        ...responseBase,
        status: 'completed',
        usage: { input_tokens: 2, output_tokens: 2 },
      },
    }),
  );

  await translator.push(new TextEncoder().encode(events.join('')));
  await translator.finish();

  assert.equal(output.filter((entry) => entry.includes('event: content_block_start')).length, 2);
  assert.equal(output.some((entry) => entry.includes('"text":"first"')), true);
  assert.equal(output.some((entry) => entry.includes('"text":"second"')), true);
});

test('SSE translator rejects incomplete responses after a function call', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  const context: MappingContext = { model, registry: new ContinuationRegistry() };
  const output: string[] = [];
  const translator = new SseTranslator(context, async (value) => { output.push(value); });
  const responseBase = { id: 'response-id', model: 'gpt-test' };
  const source = [
    frame('response.created', { response: { ...responseBase, status: 'in_progress', usage: null } }),
    frame('response.output_item.added', {
      output_index: 0,
      item: {
        id: 'call-item',
        type: 'function_call',
        status: 'in_progress',
        call_id: 'call-id',
        name: 'lookup',
      },
    }),
    frame('response.function_call_arguments.delta', {
      output_index: 0,
      item_id: 'call-item',
      delta: '{}',
    }),
    frame('response.function_call_arguments.done', {
      output_index: 0,
      item_id: 'call-item',
      arguments: '{}',
    }),
    frame('response.output_item.done', {
      output_index: 0,
      item: {
        id: 'call-item',
        type: 'function_call',
        status: 'completed',
        call_id: 'call-id',
        name: 'lookup',
        arguments: '{}',
      },
    }),
    frame('response.incomplete', {
      response: {
        ...responseBase,
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 2, output_tokens: 3 },
      },
    }),
  ].join('');
  await assert.rejects(
    translator.push(new TextEncoder().encode(source)),
    TranslationError,
  );
  assert.equal(output.some((entry) => entry.includes('event: message_delta')), false);
});

test('SSE translator assigns safe diagnostic codes to terminal failures', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  const context: MappingContext = { model, registry: new ContinuationRegistry() };
  const responseBase = { id: 'response-id', model: 'gpt-test' };
  const upstreamFailure = new SseTranslator(context, async () => undefined);
  const source = [
    frame('response.created', { response: { ...responseBase, status: 'in_progress', usage: null } }),
    frame('response.failed', { response: { ...responseBase, status: 'failed' } }),
  ].join('');

  await assert.rejects(
    upstreamFailure.push(new TextEncoder().encode(source)),
    (error: unknown) => error instanceof TranslationError
      && error.failure.code === 'responses_stream_upstream_failure',
  );

  const incomplete = new SseTranslator(context, async () => undefined);
  await assert.rejects(
    incomplete.finish(),
    (error: unknown) => error instanceof TranslationError
      && error.failure.code === 'responses_stream_incomplete',
  );
});

test('SSE translator ignores hosted tool events and emits the final text', async () => {
  const model: ModelRecord = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  const context: MappingContext = { model, registry: new ContinuationRegistry() };
  const output: string[] = [];
  const translator = new SseTranslator(context, async (value) => { output.push(value); });
  const responseBase = { id: 'response-id', model: 'gpt-test' };
  const source = [
    frame('response.created', { response: { ...responseBase, status: 'in_progress', usage: null } }),
    frame('response.output_item.added', {
      output_index: 0,
      item: { id: 'reasoning-item', type: 'reasoning' },
    }),
    frame('response.output_item.done', {
      output_index: 0,
      item: { id: 'reasoning-item', type: 'reasoning', summary: [] },
    }),
    frame('response.output_item.added', {
      output_index: 1,
      item: { id: 'search-item', type: 'web_search_call', status: 'in_progress' },
    }),
    frame('response.web_search_call.in_progress', {
      output_index: 1,
      item_id: 'search-item',
    }),
    frame('response.web_search_call.searching', {
      output_index: 1,
      item_id: 'search-item',
    }),
    frame('response.future_search_progress', {
      output_index: 1,
      item_id: 'search-item',
    }),
    frame('response.web_search_call.completed', {
      output_index: 1,
      item_id: 'search-item',
    }),
    frame('response.output_item.done', {
      output_index: 1,
      item: {
        id: 'search-item',
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'search' },
      },
    }),
    frame('response.output_item.added', {
      output_index: 2,
      item: { id: 'message-item', type: 'message', status: 'in_progress', role: 'assistant' },
    }),
    frame('response.content_part.added', {
      output_index: 2,
      item_id: 'message-item',
      part: { type: 'output_text', text: '' },
    }),
    frame('response.output_text.delta', {
      output_index: 2,
      item_id: 'message-item',
      delta: 'answer',
    }),
    frame('response.output_text.done', {
      output_index: 2,
      item_id: 'message-item',
      text: 'answer',
    }),
    frame('response.content_part.done', {
      output_index: 2,
      item_id: 'message-item',
      part: { type: 'output_text', text: 'answer' },
    }),
    frame('response.output_item.done', {
      output_index: 2,
      item: {
        id: 'message-item',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }],
      },
    }),
    frame('response.completed', {
      response: {
        ...responseBase,
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    }),
  ].join('');

  await translator.push(new TextEncoder().encode(source));
  await translator.finish();

  assert.equal(output.some((entry) => entry.includes('"text":"answer"')), true);
  assert.equal(output.at(-1)?.includes('event: message_stop'), true);
});