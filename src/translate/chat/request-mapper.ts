import { logger } from '../../logger.js';
import type { ModelRecord } from '../../models/ModelCatalog.js';
import { TranslationError, type MappedRequest } from '../responses/types.js';

const TOP_LEVEL_FIELDS = new Set([
  'model',
  'messages',
  'max_tokens',
  'system',
  'stream',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'metadata',
  'output_config',
]);

interface HistoricalToolCall {
  resultSeen: boolean;
}

/** Maps one complete Anthropic Messages request to Chat Completions. */
export function mapMessagesRequest(
  input: unknown,
  context: { readonly model: ModelRecord },
): MappedRequest {
  const request = requireRecord(input, 'Request body');
  warnUnknownFields(request, TOP_LEVEL_FIELDS, 'request');
  const modelId = requireNonEmptyString(request.model, 'model');
  if (modelId !== context.model.id) upstream('Resolved model metadata does not match the request.');
  const maxTokens = requireInteger(request.max_tokens, 'max_tokens');
  if (maxTokens < 1) invalid('max_tokens must be positive.');
  const modelLimit = context.model.capabilities?.limits?.max_output_tokens;
  if (typeof modelLimit === 'number' && maxTokens > modelLimit) {
    invalid(`max_tokens must not exceed ${modelLimit}.`);
  }
  const stream = request.stream === undefined ? false : requireBoolean(request.stream, 'stream');
  if (stream && context.model.capabilities?.supports?.streaming === false) {
    invalid('Model does not support streaming.');
  }

  const messages = mapMessages(request.messages);
  const system = mapSystem(request.system);
  if (system !== undefined) messages.unshift({ role: 'system', content: system });
  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    max_completion_tokens: maxTokens,
    stream,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.top_p !== undefined) body.top_p = request.top_p;
  const ignored = ['top_k', 'stop_sequences', 'metadata', 'output_config']
    .filter((field) => request[field] !== undefined);
  if (ignored.length > 0) logger.translationFieldsIgnored({ context: 'request', fields: ignored });
  mapTools(request.tools, request.tool_choice, context.model, body);
  return { body, stream };
}

function mapMessages(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) invalid('messages must be a non-empty array.');
  const output: Record<string, unknown>[] = [];
  const toolCalls = new Map<string, HistoricalToolCall>();

  for (const messageValue of value) {
    const message = requireRecord(messageValue, 'message');
    warnUnknownFields(message, new Set(['role', 'content']), 'message');
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') {
      logger.translationComponentIgnored({ context: 'message' });
      continue;
    }
    const blocks = normalizeContent(message.content);
    if (message.role === 'assistant') {
      mapAssistantMessage(blocks, output, toolCalls);
    } else if (message.role === 'user') {
      mapUserMessage(blocks, output, toolCalls);
    } else {
      const text = collectText(blocks, 'system-block');
      if (text.length === 0) invalid('System message content must not be empty.');
      output.push({ role: 'system', content: text });
    }
  }

  const missingResult = [...toolCalls.entries()].find(([, call]) => !call.resultSeen);
  if (missingResult) invalid(`Tool use "${missingResult[0]}" is missing its result.`);
  if (output.length === 0) invalid('messages contain no translatable content.');
  return output;
}

function mapAssistantMessage(
  blocks: readonly Record<string, unknown>[],
  output: Record<string, unknown>[],
  toolCalls: Map<string, HistoricalToolCall>,
): void {
  const text: string[] = [];
  const mappedCalls: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      warnUnknownFields(block, new Set(['type', 'text', 'cache_control']), 'text-block');
      text.push(requireString(block.text, 'text'));
      continue;
    }
    if (block.type !== 'tool_use') {
      logger.translationComponentIgnored({ context: 'content-block' });
      continue;
    }
    warnUnknownFields(block, new Set(['type', 'id', 'name', 'input', 'cache_control']), 'tool-use');
    const id = requireNonEmptyString(block.id, 'tool_use.id');
    if (toolCalls.has(id)) invalid(`Duplicate tool use "${id}".`);
    const name = requireNonEmptyString(block.name, 'tool_use.name');
    const toolInput = requireRecord(block.input, 'tool_use.input');
    toolCalls.set(id, { resultSeen: false });
    mappedCalls.push({
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(toolInput) },
    });
  }
  if (text.length === 0 && mappedCalls.length === 0) return;
  output.push({
    role: 'assistant',
    content: text.length > 0 ? text.join('') : null,
    ...(mappedCalls.length > 0 ? { tool_calls: mappedCalls } : {}),
  });
}

function mapUserMessage(
  blocks: readonly Record<string, unknown>[],
  output: Record<string, unknown>[],
  toolCalls: Map<string, HistoricalToolCall>,
): void {
  let text = '';
  const flushText = (): void => {
    if (text.length === 0) return;
    output.push({ role: 'user', content: text });
    text = '';
  };
  for (const block of blocks) {
    if (block.type === 'text') {
      warnUnknownFields(block, new Set(['type', 'text', 'cache_control']), 'text-block');
      text += requireString(block.text, 'text');
      continue;
    }
    if (block.type !== 'tool_result') {
      logger.translationComponentIgnored({ context: 'content-block' });
      continue;
    }
    flushText();
    warnUnknownFields(
      block,
      new Set(['type', 'tool_use_id', 'content', 'is_error', 'cache_control']),
      'tool-result',
    );
    const id = requireNonEmptyString(block.tool_use_id, 'tool_result.tool_use_id');
    const call = toolCalls.get(id);
    if (!call) invalid(`Tool result "${id}" appears before its tool use.`);
    if (call.resultSeen) invalid(`Duplicate tool result "${id}".`);
    if (block.is_error !== undefined && typeof block.is_error !== 'boolean') {
      invalid('tool_result.is_error must be boolean when provided.');
    }
    call.resultSeen = true;
    output.push({ role: 'tool', tool_call_id: id, content: mapToolResultContent(block.content) });
  }
  flushText();
}

function mapToolResultContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalid('tool_result.content must be text.');
  return value.map((entry) => {
    const block = requireRecord(entry, 'tool result content');
    if (block.type !== 'text') {
      logger.translationComponentIgnored({ context: 'content-block' });
      return '';
    }
    return requireString(block.text, 'tool result text');
  }).join('');
}

function mapSystem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (!Array.isArray(value)) {
    logger.translationComponentIgnored({ context: 'content-block' });
    return undefined;
  }
  const text = collectText(value.map((entry) => requireRecord(entry, 'system block')), 'system-block');
  return text.length > 0 ? text : undefined;
}

function collectText(
  blocks: readonly Record<string, unknown>[],
  context: 'system-block',
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    warnUnknownFields(block, new Set(['type', 'text', 'cache_control']), context);
    if (block.type !== 'text') {
      logger.translationComponentIgnored({ context: 'content-block' });
      continue;
    }
    parts.push(requireString(block.text, 'text'));
  }
  return parts.join('');
}

function mapTools(
  value: unknown,
  choiceValue: unknown,
  model: ModelRecord,
  output: Record<string, unknown>,
): void {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return;
  if (!Array.isArray(value)) invalid('tools must be an array.');
  const names = new Set<string>();
  const tools: Record<string, unknown>[] = [];
  for (const entry of value) {
    const tool = requireRecord(entry, 'tool');
    if (tool.type !== undefined && tool.type !== 'custom') {
      logger.translationComponentIgnored({ context: 'tool' });
      continue;
    }
    const name = requireNonEmptyString(tool.name, 'tool.name');
    if (names.has(name)) invalid(`Duplicate tool name "${name}".`);
    names.add(name);
    const parameters = requireRecord(tool.input_schema, 'tool.input_schema');
    const definition: Record<string, unknown> = { name, parameters };
    if (tool.description !== undefined) {
      definition.description = requireString(tool.description, 'tool.description');
    }
    tools.push({ type: 'function', function: definition });
  }
  if (tools.length === 0) return;
  output.tools = tools;
  const choice = choiceValue === undefined ? { type: 'auto' } : requireRecord(choiceValue, 'tool_choice');
  if (choice.type === 'auto') output.tool_choice = 'auto';
  else if (choice.type === 'any') output.tool_choice = 'required';
  else if (choice.type === 'none') output.tool_choice = 'none';
  else if (choice.type === 'tool') {
    const name = requireNonEmptyString(choice.name, 'tool_choice.name');
    if (!names.has(name)) invalid(`tool_choice names unknown tool "${name}".`);
    output.tool_choice = { type: 'function', function: { name } };
  } else {
    logger.translationComponentIgnored({ context: 'tool-choice' });
    output.tool_choice = 'auto';
  }
  output.parallel_tool_calls = choice.disable_parallel_tool_use === true
    ? false
    : model.capabilities?.supports?.parallel_tool_calls === true;
}

function normalizeContent(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value) || value.length === 0) invalid('Message content must be non-empty.');
  return value.map((entry) => requireRecord(entry, 'content block'));
}

function warnUnknownFields(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  context: Parameters<typeof logger.translationFieldsIgnored>[0]['context'],
): void {
  const fields = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (fields.length > 0) logger.translationFieldsIgnored({ context, fields });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} must be an object.`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (result.length === 0) invalid(`${label} must not be empty.`);
  return result;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be a string.`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid(`${label} must be an integer.`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new TranslationError({ status: 400, type: 'invalid_request_error', message });
}

function upstream(message: string): never {
  throw new TranslationError({ status: 502, type: 'api_error', message });
}