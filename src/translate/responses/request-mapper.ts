import type { ModelRecord } from '../../models/ModelCatalog.js';
import type { ContinuationGroup, MappedRequest, MappingContext } from './types.js';
import { TranslationError } from './types.js';

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

interface OpenContinuation {
  group: ContinuationGroup;
  remaining: Set<string>;
}

/** Validates and maps one complete Anthropic Messages request. */
export function mapMessagesRequest(input: unknown, context: MappingContext): MappedRequest {
  const request = requireRecord(input, 'Request body');
  rejectUnknownFields(request, TOP_LEVEL_FIELDS, 'request');
  if ('top_k' in request) invalid('top_k is not supported.');

  const modelId = requireNonEmptyString(request.model, 'model');
  if (modelId !== context.model.id) upstream('Resolved model metadata does not match the request.');
  const maxTokens = requireInteger(request.max_tokens, 'max_tokens');
  const maxOutputTokens = requireModelLimit(context.model, 'max_output_tokens');
  if (maxTokens < 16 || maxTokens > maxOutputTokens) {
    invalid(`max_tokens must be between 16 and ${maxOutputTokens}.`);
  }
  const stream = request.stream === undefined ? false : requireBoolean(request.stream, 'stream');
  if (stream) requireModelSupport(context.model, 'streaming');

  if (request.temperature !== undefined && request.temperature !== 1) {
    invalid('temperature must be exactly 1 when provided.');
  }
  if (request.top_p !== undefined && request.top_p !== 0.98) {
    invalid('top_p must be exactly 0.98 when provided.');
  }
  if (request.stop_sequences !== undefined) {
    if (!Array.isArray(request.stop_sequences) || request.stop_sequences.length !== 0) {
      invalid('stop_sequences must be an empty array when provided.');
    }
  }

  const body: Record<string, unknown> = {
    model: modelId,
    input: mapMessages(request.messages, context),
    max_output_tokens: maxTokens,
    stream,
    store: false,
  };
  const instructions = mapSystem(request.system);
  if (instructions !== undefined) body.instructions = instructions;
  const metadata = mapMetadata(request.metadata);
  if (metadata !== undefined) body.metadata = metadata;
  const reasoning = mapOutputConfig(request.output_config, context.model);
  if (reasoning !== undefined) body.reasoning = reasoning;
  if (request.temperature !== undefined) body.temperature = 1;
  if (request.top_p !== undefined) body.top_p = 0.98;
  mapTools(request.tools, request.tool_choice, context.model, body);
  return { body, stream };
}

function mapMessages(value: unknown, context: MappingContext): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) invalid('messages must be a non-empty array.');
  const output: unknown[] = [];
  let open: OpenContinuation | undefined;
  const closedGroupIds = new Set<string>();
  let imageCount = 0;

  for (const messageValue of value) {
    const message = requireRecord(messageValue, 'message');
    rejectUnknownFields(message, new Set(['role', 'content']), 'message');
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      invalid('Message role must be user, assistant, or system.');
    }
    if (role === 'system' && message.content === '') {
      invalid('System message content must not be empty.');
    }
    const blocks = normalizeContent(message.content);
    if (role === 'system' && blocks.some((block) => block.type !== 'text')) {
      invalid('System messages support only text blocks.');
    }
    const toolUseBlocks = blocks.filter((block) => block.type === 'tool_use');

    if (toolUseBlocks.length > 0) {
      if (role !== 'assistant' || open) invalid('Tool-use groups are out of order.');
      const ids = toolUseBlocks.map((block) => requireNonEmptyString(block.id, 'tool_use.id'));
      const group = context.registry.resolve(ids, context.model.id);
      if (closedGroupIds.has(group.groupId)) {
        invalid(`Continuation group "${group.groupId}" may not be reopened.`);
      }
      for (const block of toolUseBlocks) validateHistoricalToolUse(block, group);
      open = { group, remaining: new Set(ids) };
    }

    let continuationInserted = false;
    for (const block of blocks) {
      if (block.type === 'text') {
        rejectUnknownFields(block, new Set(['type', 'text', 'cache_control']), 'text block');
        validateCacheControl(block.cache_control);
        const textType = role === 'assistant' ? 'output_text' : 'input_text';
        output.push({
          role,
          content: [
            {
              type: textType,
              text: requireString(block.text, 'text'),
            },
          ],
        });
        continue;
      }
      if (block.type === 'image') {
        if (role !== 'user') invalid('Images are accepted only in user messages.');
        imageCount += 1;
        if (imageCount > 1) invalid('At most one image is supported.');
        output.push({ role: 'user', content: [mapImage(block, context.model)] });
        continue;
      }
      if (block.type === 'tool_use') {
        if (!open) invalid('Tool use could not be resolved.');
        if (!continuationInserted) {
          output.push(
            ...[...open.group.items]
              .sort((left, right) => left.outputIndex - right.outputIndex)
              .map((entry) => entry.item),
          );
          continuationInserted = true;
        }
        continue;
      }
      if (block.type === 'tool_result') {
        rejectUnknownFields(
          block,
          new Set(['type', 'tool_use_id', 'content', 'is_error', 'cache_control']),
          'tool_result',
        );
        validateCacheControl(block.cache_control);
        if (role !== 'user' || !open) invalid('Tool result appears before its tool use.');
        const toolUseId = requireNonEmptyString(block.tool_use_id, 'tool_result.tool_use_id');
        if (!open.remaining.delete(toolUseId)) invalid(`Duplicate tool result "${toolUseId}".`);
        const call = open.group.calls.get(toolUseId);
        if (!call) invalid(`Tool result "${toolUseId}" is unavailable.`);
        if (block.is_error !== undefined && typeof block.is_error !== 'boolean') {
          invalid('tool_result.is_error must be boolean when provided.');
        }
        output.push({
          type: 'function_call_output',
          call_id: call.callId,
          output: mapToolResultContent(block.content),
        });
        if (open.remaining.size === 0) {
          closedGroupIds.add(open.group.groupId);
          open = undefined;
        }
        continue;
      }
      invalid(`Unsupported content block type "${String(block.type)}".`);
    }
  }
  if (open) invalid('A continuation group is missing tool results.');
  return output;
}

function normalizeContent(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value) || value.length === 0) invalid('Message content must be non-empty.');
  return value.map((block) => requireRecord(block, 'content block'));
}

function validateHistoricalToolUse(
  block: Readonly<Record<string, unknown>>,
  group: ContinuationGroup,
): void {
  rejectUnknownFields(block, new Set(['type', 'id', 'name', 'input', 'cache_control']), 'tool_use');
  validateCacheControl(block.cache_control);
  const id = requireNonEmptyString(block.id, 'tool_use.id');
  const call = group.calls.get(id);
  if (!call) invalid(`Tool use "${id}" does not belong to its continuation group.`);
  const name = requireNonEmptyString(block.name, 'tool_use.name');
  const toolInput = requireRecord(block.input, 'tool_use.input');
  if (name !== call.name || !isAllowedHistoricalInput(toolInput, call.input)) {
    invalid(`Tool use "${id}" does not match the authoritative continuation.`);
  }
}

function isAllowedHistoricalInput(
  historical: Readonly<Record<string, unknown>>,
  authoritative: Readonly<Record<string, unknown>>,
): boolean {
  if (Object.keys(historical).some((key) => !(key in authoritative))) return false;
  return Object.entries(authoritative).every(([key, value]) =>
    key in historical ? jsonEqual(historical[key], value) : value === false,
  );
}

function mapToolResultContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalid('tool_result.content must be text.');
  return value
    .map((entry) => {
      const block = requireRecord(entry, 'tool result content');
      rejectUnknownFields(block, new Set(['type', 'text', 'cache_control']), 'tool result text');
      if (block.type !== 'text') invalid('Tool result content supports only text blocks.');
      validateCacheControl(block.cache_control);
      return requireString(block.text, 'tool result text');
    })
    .join('');
}

function mapSystem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalid('system must be a string or text-block array.');
  return value
    .map((entry) => {
      const block = requireRecord(entry, 'system block');
      rejectUnknownFields(block, new Set(['type', 'text', 'cache_control']), 'system block');
      if (block.type !== 'text') invalid('system supports only text blocks.');
      validateCacheControl(block.cache_control);
      return requireString(block.text, 'system text');
    })
    .join('\n\n');
}

function mapTools(
  toolsValue: unknown,
  choiceValue: unknown,
  model: ModelRecord,
  output: Record<string, unknown>,
): void {
  if (toolsValue === undefined || (Array.isArray(toolsValue) && toolsValue.length === 0)) {
    if (choiceValue !== undefined) invalid('tool_choice requires tools.');
    return;
  }
  if (!Array.isArray(toolsValue)) invalid('tools must be an array.');
  requireModelSupport(model, 'tool_calls');
  const names = new Set<string>();
  output.tools = toolsValue.map((entry) => {
    const tool = requireRecord(entry, 'tool');
    rejectUnknownFields(tool, new Set(['name', 'description', 'input_schema']), 'tool');
    const name = requireNonEmptyString(tool.name, 'tool.name');
    if (names.has(name)) invalid(`Tool name "${name}" is duplicated.`);
    names.add(name);
    const mapped: Record<string, unknown> = {
      type: 'function',
      name,
      parameters: requireRecord(tool.input_schema, 'tool.input_schema'),
    };
    if (tool.description !== undefined) {
      mapped.description = requireString(tool.description, 'tool.description');
    }
    return mapped;
  });

  const choice = choiceValue === undefined ? { type: 'auto' } : requireRecord(choiceValue, 'tool_choice');
  rejectUnknownFields(choice, new Set(['type', 'name', 'disable_parallel_tool_use']), 'tool_choice');
  if (choice.type === 'auto') output.tool_choice = 'auto';
  else if (choice.type === 'any') output.tool_choice = 'required';
  else if (choice.type === 'none') output.tool_choice = 'none';
  else if (choice.type === 'tool') {
    const name = requireNonEmptyString(choice.name, 'tool_choice.name');
    if (!names.has(name)) invalid(`Unknown tool choice "${name}".`);
    output.tool_choice = { type: 'function', name };
  } else invalid('Unsupported tool_choice.type.');

  const disableParallel = choice.disable_parallel_tool_use;
  if (disableParallel !== undefined && typeof disableParallel !== 'boolean') {
    invalid('disable_parallel_tool_use must be boolean.');
  }
  output.parallel_tool_calls = disableParallel === true ? false : modelSupport(model, 'parallel_tool_calls');
}

function mapMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const metadata = requireRecord(value, 'metadata');
  rejectUnknownFields(metadata, new Set(['user_id']), 'metadata');
  return { user_id: requireString(metadata.user_id, 'metadata.user_id') };
}

function mapOutputConfig(
  value: unknown,
  model: ModelRecord,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const outputConfig = requireRecord(value, 'output_config');
  rejectUnknownFields(outputConfig, new Set(['effort']), 'output_config');
  const effort = requireNonEmptyString(outputConfig.effort, 'output_config.effort');
  const supportedEfforts = model.capabilities?.supports?.reasoning_effort;
  if (
    !Array.isArray(supportedEfforts) ||
    !supportedEfforts.every((entry) => typeof entry === 'string')
  ) {
    upstream('Model reasoning-effort metadata is unavailable.');
  }
  if (!supportedEfforts.includes(effort)) {
    invalid(`Model does not support reasoning effort "${effort}".`);
  }
  return { effort };
}

function validateCacheControl(value: unknown): void {
  if (value === undefined) return;
  const cacheControl = requireRecord(value, 'cache_control');
  rejectUnknownFields(cacheControl, new Set(['type']), 'cache_control');
  if (cacheControl.type !== 'ephemeral') {
    invalid('cache_control.type must be "ephemeral".');
  }
}

function mapImage(block: Record<string, unknown>, model: ModelRecord): Record<string, unknown> {
  rejectUnknownFields(block, new Set(['type', 'source']), 'image');
  requireModelSupport(model, 'vision');
  const source = requireRecord(block.source, 'image.source');
  rejectUnknownFields(source, new Set(['type', 'media_type', 'data']), 'image.source');
  if (source.type !== 'base64') invalid('Only base64 image sources are supported.');
  const mediaType = requireNonEmptyString(source.media_type, 'image.source.media_type');
  const data = requireNonEmptyString(source.data, 'image.source.data');
  if (!isCanonicalBase64(data)) invalid('Image data must be canonical base64.');
  const limits = requireRecord(model.capabilities?.limits, 'model vision limits', true);
  const vision = requireRecord(limits.vision, 'model vision limits', true);
  if (
    !Array.isArray(vision.supported_media_types) ||
    !vision.supported_media_types.every((entry) => typeof entry === 'string') ||
    !vision.supported_media_types.includes(mediaType) ||
    mediaType === 'application/pdf'
  ) {
    invalid(`Image media type "${mediaType}" is not supported.`);
  }
  if (typeof vision.max_prompt_images !== 'number' || vision.max_prompt_images < 1) {
    upstream('Model image-count metadata is unavailable.');
  }
  if (typeof vision.max_prompt_image_size !== 'number' || vision.max_prompt_image_size < 0) {
    upstream('Model image-size metadata is unavailable.');
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const decodedSize = 3 * Math.floor(data.length / 4) - padding;
  if (decodedSize > vision.max_prompt_image_size) invalid('Image exceeds the model size limit.');
  return {
    type: 'input_image',
    image_url: `data:${mediaType};base64,${data}`,
    detail: 'auto',
  };
}

function requireModelLimit(model: ModelRecord, name: string): number {
  const value = model.capabilities?.limits?.[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    upstream(`Model limit metadata "${name}" is unavailable.`);
  }
  return value;
}

function requireModelSupport(model: ModelRecord, name: string): void {
  if (!modelSupport(model, name)) invalid(`Model does not support ${name}.`);
}

function modelSupport(model: ModelRecord, name: string): boolean {
  const supports = model.capabilities?.supports;
  if (!supports) upstream('Model capability metadata is unavailable.');
  return supports[name] === true;
}

function isCanonicalBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => jsonEqual(entry, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]))
    );
  }
  return false;
}

function rejectUnknownFields(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalid(`Unknown ${label} field "${unknown}".`);
}

function requireRecord(value: unknown, label: string, metadata = false): Record<string, unknown> {
  if (!isRecord(value)) {
    if (metadata) upstream(`${label} is unavailable.`);
    invalid(`${label} must be an object.`);
  }
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