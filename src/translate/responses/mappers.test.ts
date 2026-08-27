import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRecord } from '../../models/ModelCatalog.js';
import { ContinuationRegistry } from './ContinuationRegistry.js';
import { mapMessagesRequest } from './request-mapper.js';
import { mapResponsesResult } from './response-mapper.js';
import { TranslationError, type MappingContext } from './types.js';

function createContext(): MappingContext {
  const model: ModelRecord = {
    id: 'gpt-test',
    supported_endpoints: ['/responses'],
    capabilities: {
      supports: {
        streaming: true,
        tool_calls: true,
        parallel_tool_calls: true,
        vision: true,
        reasoning_effort: ['low', 'medium', 'high'],
      },
      limits: { max_output_tokens: 4096 },
    },
  };
  return { model, registry: new ContinuationRegistry() };
}

function publishCall(context: MappingContext, name: string): { id: string; input: Record<string, unknown> } {
  const stage = context.registry.createStage('gpt-test');
  const id = context.registry.allocateToolId(stage);
  const input = { value: name };
  context.registry.addItem(stage, {
    outputIndex: 0,
    item: {
      type: 'function_call',
      status: 'completed',
      call_id: `call-${name}`,
      name,
      arguments: JSON.stringify(input),
    },
  });
  context.registry.addCall(stage, id, {
    callId: `call-${name}`,
    outputIndex: 0,
    name,
    input,
  });
  context.registry.publish(stage);
  return { id, input };
}

test('request mapper emits the minimal stateless Responses request', () => {
  const mapped = mapMessagesRequest(
    {
      model: 'gpt-test',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    },
    createContext(),
  );
  assert.deepEqual(mapped.body, {
    model: 'gpt-test',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    max_output_tokens: 32,
    stream: false,
    store: false,
  });
  assert.equal('previous_response_id' in mapped.body, false);
});

test('request mapper fails closed on unsupported fields', () => {
  assert.throws(
    () => mapMessagesRequest(
      {
        model: 'gpt-test',
        max_tokens: 32,
        top_k: 1,
        messages: [{ role: 'user', content: 'hello' }],
      },
      createContext(),
    ),
    TranslationError,
  );
});

test('request mapper accepts the narrow Claude Code request envelope', () => {
  const mapped = mapMessagesRequest(
    {
      model: 'gpt-test',
      max_tokens: 32,
      stream: true,
      temperature: 1,
      metadata: { user_id: 'claude-code-user' },
      output_config: { effort: 'medium' },
      tools: [],
      system: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    },
    createContext(),
  );

  assert.deepEqual(mapped.body, {
    model: 'gpt-test',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    max_output_tokens: 32,
    stream: true,
    store: false,
    instructions: 'first\n\nsecond',
    metadata: { user_id: 'claude-code-user' },
    reasoning: { effort: 'medium' },
    temperature: 1,
  });
});

test('request mapper emits Copilot tool definitions without a type field', () => {
  const mapped = mapMessagesRequest(
    {
      model: 'gpt-test',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'search the web' }],
      tools: [{
        name: 'WebSearch',
        description: 'Search the web',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      }],
    },
    createContext(),
  );

  assert.deepEqual(mapped.body.tools, [{
    name: 'WebSearch',
    description: 'Search the web',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  }]);
  assert.equal('type' in (mapped.body.tools as Record<string, unknown>[])[0], false);
  assert.equal(mapped.body.tool_choice, 'auto');
  assert.equal(mapped.body.parallel_tool_calls, true);
});

test('request mapper maps VS Code system messages in place', () => {
  const mapped = mapMessagesRequest(
    {
      model: 'gpt-test',
      max_tokens: 32,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'system', content: 'tool execution completed; continue with the result' },
        {
          role: 'system',
          content: [
            { type: 'text', text: 'late instruction', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    },
    createContext(),
  );

  assert.deepEqual(mapped.body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    {
      role: 'system',
      content: [{ type: 'input_text', text: 'tool execution completed; continue with the result' }],
    },
    { role: 'system', content: [{ type: 'input_text', text: 'late instruction' }] },
  ]);
});

test('request mapper rejects broader system message shapes', () => {
  const contents = [
    '',
    [],
    [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }],
    [{ type: 'tool_use', id: 'tool', name: 'tool', input: {} }],
  ];

  for (const content of contents) {
    assert.throws(
      () => mapMessagesRequest(
        {
          model: 'gpt-test',
          max_tokens: 32,
          messages: [{ role: 'system', content }],
        },
        createContext(),
      ),
      TranslationError,
    );
  }
});

test('request mapper rejects unsupported output configuration', () => {
  const variants = [
    {},
    { effort: 'max' },
    { effort: '' },
    { effort: 1 },
    { effort: 'medium', format: { type: 'json_schema' } },
  ];

  for (const outputConfig of variants) {
    assert.throws(
      () => mapMessagesRequest(
        {
          model: 'gpt-test',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hello' }],
          output_config: outputConfig,
        },
        createContext(),
      ),
      TranslationError,
    );
  }
});

test('request mapper requires valid reasoning-effort metadata', () => {
  const supportsVariants = [
    { streaming: true },
    { streaming: true, reasoning_effort: true },
    { streaming: true, reasoning_effort: ['medium', 1] },
  ];

  for (const supports of supportsVariants) {
    const context = createContext();
    context.model.capabilities = { ...context.model.capabilities, supports };
    assert.throws(
      () => mapMessagesRequest(
        {
          model: 'gpt-test',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hello' }],
          output_config: { effort: 'medium' },
        },
        context,
      ),
      (error: unknown) => error instanceof TranslationError && error.failure.status === 502,
    );
  }
});

test('request mapper rejects broader metadata and cache-control shapes', () => {
  const requests = [
    { metadata: { user_id: 'user', extra: true }, content: 'hello' },
    { metadata: { user_id: 42 }, content: 'hello' },
    {
      metadata: { user_id: 'user' },
      content: [{ type: 'text', text: 'hello', cache_control: { type: 'persistent' } }],
    },
    {
      metadata: { user_id: 'user' },
      content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: 60 } }],
    },
  ];

  for (const request of requests) {
    assert.throws(
      () => mapMessagesRequest(
        {
          model: 'gpt-test',
          max_tokens: 32,
          metadata: request.metadata,
          messages: [{ role: 'user', content: request.content }],
        },
        createContext(),
      ),
      TranslationError,
    );
  }
});

test('response mapper rejects incomplete output containing a completed function call', () => {
  assert.throws(
    () => mapResponsesResult(
      {
        id: 'response-id',
        model: 'gpt-test',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          {
            type: 'function_call',
            status: 'completed',
            call_id: 'call-id',
            name: 'lookup',
            arguments: '{}',
          },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
      },
      createContext(),
    ),
    TranslationError,
  );
});

test('response mapper stages a completed function call for publication', () => {
  const context = createContext();
  const mapped = mapResponsesResult(
    {
      id: 'response-id',
      model: 'gpt-test',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          status: 'completed',
          call_id: 'call-id',
          name: 'lookup',
          arguments: '{"key":"value"}',
        },
      ],
      usage: { input_tokens: 5, output_tokens: 7 },
    },
    context,
  );
  assert.equal(mapped.message.stop_reason, 'tool_use');
  assert.ok(mapped.stage);
  const group = context.registry.publish(mapped.stage);
  assert.equal(group.calls.size, 1);
});

test('request mapper replays multiple closed continuation groups in history order', () => {
  const context = createContext();
  const first = publishCall(context, 'first');
  const second = publishCall(context, 'second');
  const mapped = mapMessagesRequest(
    {
      model: 'gpt-test',
      max_tokens: 32,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: first.id, name: 'first', input: first.input }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: first.id, content: 'one' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: second.id, name: 'second', input: second.input }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: second.id, content: 'two' }],
        },
        { role: 'user', content: 'continue' },
      ],
    },
    context,
  );
  assert.deepEqual(
    (mapped.body.input as Array<{ type?: string }>).map((item) => item.type ?? 'message'),
    ['function_call', 'function_call_output', 'function_call', 'function_call_output', 'message'],
  );
});

test('request mapper accepts ephemeral cache hints on a continuation pair', () => {
  const context = createContext();
  const call = publishCall(context, 'cached');
  const mapped = mapMessagesRequest(
    {
      model: 'gpt-test',
      max_tokens: 32,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: call.id,
              name: 'cached',
              input: call.input,
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: call.id,
              content: 'done',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    },
    context,
  );

  assert.deepEqual(
    (mapped.body.input as Array<{ type?: string }>).map((item) => item.type),
    ['function_call', 'function_call_output'],
  );
});

test('request mapper preserves content from an error tool result', () => {
  const context = createContext();
  const call = publishCall(context, 'failing');
  const mapped = mapMessagesRequest(
    {
      model: 'gpt-test',
      max_tokens: 32,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: call.id, name: 'failing', input: call.input }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: call.id,
              content: 'command failed',
              is_error: true,
            },
          ],
        },
      ],
    },
    context,
  );

  assert.deepEqual(mapped.body.input, [
    {
      type: 'function_call',
      status: 'completed',
      call_id: 'call-failing',
      name: 'failing',
      arguments: '{"value":"failing"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call-failing',
      output: 'command failed',
    },
  ]);
});

test('request mapper accepts omitted top-level false tool defaults', () => {
  const context = createContext();
  const stage = context.registry.createStage('gpt-test');
  const id = context.registry.allocateToolId(stage);
  context.registry.addItem(stage, {
    outputIndex: 0,
    item: {
      type: 'function_call',
      status: 'completed',
      call_id: 'call-defaults',
      name: 'run',
      arguments: '{"command":"pwd","background":false,"nested":{"enabled":false}}',
    },
  });
  context.registry.addCall(stage, id, {
    callId: 'call-defaults',
    outputIndex: 0,
    name: 'run',
    input: { command: 'pwd', background: false, nested: { enabled: false } },
  });
  context.registry.publish(stage);

  const mapped = mapMessagesRequest(
    {
      model: 'gpt-test',
      max_tokens: 32,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id, name: 'run', input: { command: 'pwd', nested: { enabled: false } } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }],
        },
      ],
    },
    context,
  );

  assert.deepEqual(
    (mapped.body.input as Array<{ type?: string }>).map((item) => item.type),
    ['function_call', 'function_call_output'],
  );
});

test('request mapper rejects unsafe historical tool input normalization', () => {
  const variants = [
    { command: 'pwd', background: false, count: 1 },
    { command: 'changed', background: false },
    { command: 'pwd' },
    { command: 'pwd', background: false, nested: {} },
  ];

  for (const input of variants) {
    const context = createContext();
    const stage = context.registry.createStage('gpt-test');
    const id = context.registry.allocateToolId(stage);
    context.registry.addItem(stage, {
      outputIndex: 0,
      item: {
        type: 'function_call',
        status: 'completed',
        call_id: 'call-strict',
        name: 'run',
        arguments: '{"command":"pwd","background":false,"nested":{"enabled":false}}',
      },
    });
    context.registry.addCall(stage, id, {
      callId: 'call-strict',
      outputIndex: 0,
      name: 'run',
      input: { command: 'pwd', background: false, nested: { enabled: false } },
    });
    context.registry.publish(stage);

    assert.throws(
      () => mapMessagesRequest(
        {
          model: 'gpt-test',
          max_tokens: 32,
          messages: [
            { role: 'assistant', content: [{ type: 'tool_use', id, name: 'run', input }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
          ],
        },
        context,
      ),
      TranslationError,
    );
  }
});

test('request mapper rejects reopening a closed continuation group', () => {
  const context = createContext();
  const call = publishCall(context, 'once');
  const round = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: call.id, name: 'once', input: call.input }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: call.id, content: 'done' }],
    },
  ];
  assert.throws(
    () => mapMessagesRequest(
      {
        model: 'gpt-test',
        max_tokens: 32,
        messages: [...round, ...round, { role: 'user', content: 'continue' }],
      },
      context,
    ),
    TranslationError,
  );
});