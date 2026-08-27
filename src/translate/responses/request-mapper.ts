import type { ModelRecord } from '../../models/ModelCatalog.js';
import { logger } from '../../logger.js';
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
  warnUnknownFields(request, TOP_LEVEL_FIELDS, 'request');
  if ('top_k' in request) {
    logger.translationFieldsIgnored({ context: 'request', fields: ['top_k'] });
  }

  const modelId = requireNonEmptyString(request.model, 'model');
  if (modelId !== context.model.id) upstream('Resolved model metadata does not match the request.');
  const maxTokens = requireInteger(request.max_tokens, 'max_tokens');
  const maxOutputTokens = requireModelLimit(context.model, 'max_output_tokens');
  if (maxTokens < 16 || maxTokens > maxOutputTokens) {
    invalid(`max_tokens must be between 16 and ${maxOutputTokens}.`);
  }
  const stream = request.stream === undefined ? false : requireBoolean(request.stream, 'stream');
  if (stream) requireModelSupport(context.model, 'streaming');

  if (request.stop_sequences !== undefined) {
    logger.translationFieldsIgnored({ context: 'request', fields: ['stop_sequences'] });
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
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.top_p !== undefined) body.top_p = request.top_p;
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
    warnUnknownFields(message, new Set(['role', 'content']), 'message');
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      logger.translationComponentIgnored({ context: 'message' });
      continue;
    }
    if (role === 'system' && message.content === '') {
      invalid('System message content must not be empty.');
    }
    const blocks = normalizeContent(message.content);
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
        warnUnknownFields(block, new Set(['type', 'text', 'cache_control']), 'text-block');
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
        if (role !== 'user') {
          logger.translationComponentIgnored({ context: 'content-block' });
          continue;
        }
        const image = mapImage(block, context.model);
        if (image) {
          imageCount += 1;
          if (imageCount > 1) invalid('At most one image is supported.');
          output.push({ role: 'user', content: [image] });
        }
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
        warnUnknownFields(
          block,
          new Set(['type', 'tool_use_id', 'content', 'is_error', 'cache_control']),
          'tool-result',
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
      logger.translationComponentIgnored({ context: 'content-block' });
    }
  }
  if (open) invalid('A continuation group is missing tool results.');
  if (output.length === 0) invalid('messages contain no translatable content.');
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
  warnUnknownFields(block, new Set(['type', 'id', 'name', 'input', 'cache_control']), 'tool-use');
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
      warnUnknownFields(block, new Set(['type', 'text', 'cache_control']), 'tool-result-text');
      if (block.type !== 'text') {
        logger.translationComponentIgnored({ context: 'content-block' });
        return '';
      }
      validateCacheControl(block.cache_control);
      return requireString(block.text, 'tool result text');
    })
    .join('');
}

function mapSystem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (!Array.isArray(value)) {
    logger.translationComponentIgnored({ context: 'content-block' });
    return undefined;
  }
  const parts = value.flatMap((entry) => {
      if (!isRecord(entry)) {
        logger.translationComponentIgnored({ context: 'content-block' });
        return [];
      }
      const block = entry;
      warnUnknownFields(block, new Set(['type', 'text', 'cache_control']), 'system-block');
      if (block.type !== 'text' || typeof block.text !== 'string') {
        logger.translationComponentIgnored({ context: 'content-block' });
        return [];
      }
      validateCacheControl(block.cache_control);
      return [block.text];
    });
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function mapTools(
  toolsValue: unknown,
  choiceValue: unknown,
  model: ModelRecord,
  output: Record<string, unknown>,
): void {
  if (toolsValue === undefined || (Array.isArray(toolsValue) && toolsValue.length === 0)) {
    if (choiceValue !== undefined) {
      logger.translationComponentIgnored({ context: 'tool-choice' });
    }
    return;
  }
  if (!Array.isArray(toolsValue)) {
    logger.translationComponentIgnored({ context: 'tool' });
    if (choiceValue !== undefined) logger.translationComponentIgnored({ context: 'tool-choice' });
    return;
  }
  const choices = new Map<string, Record<string, unknown>>();
  const ambiguousNames = new Set<string>();
  const mappedTools: Record<string, unknown>[] = [];
  for (const entry of toolsValue) {
    if (!isRecord(entry)) {
      logger.translationComponentIgnored({ context: 'tool' });
      continue;
    }
    const tool = entry;
    if (typeof tool.type === 'string' && tool.type.startsWith('web_search_')) {
      warnUnknownFields(
        tool,
        new Set(['type', 'name', 'allowed_domains']),
        'web-search-tool',
      );
      const mapped: Record<string, unknown> = { type: 'web_search' };
      registerToolChoice(tool.name, { type: 'web_search' }, choices, ambiguousNames);
      if (tool.allowed_domains !== undefined) {
        if (
          Array.isArray(tool.allowed_domains) &&
          tool.allowed_domains.length > 0 &&
          tool.allowed_domains.every((domain) => typeof domain === 'string' && domain.length > 0)
        ) {
          mapped.filters = { allowed_domains: tool.allowed_domains };
        } else {
          logger.translationFieldsIgnored({
            context: 'web-search-tool',
            fields: ['allowed_domains'],
          });
        }
      }
      mappedTools.push(mapped);
      continue;
    }
    if (tool.type !== undefined && tool.type !== 'custom') {
      logger.translationPassthrough({ context: 'tool' });
      if (typeof tool.type === 'string') {
        registerToolChoice(tool.name, { type: tool.type }, choices, ambiguousNames);
      }
      mappedTools.push({ ...tool });
      continue;
    }
    warnUnknownFields(
      tool,
      new Set(['type', 'name', 'description', 'input_schema']),
      'custom-tool',
    );
    if (
      typeof tool.name !== 'string' ||
      tool.name.length === 0 ||
      !isRecord(tool.input_schema)
    ) {
      logger.translationComponentIgnored({ context: 'tool' });
      continue;
    }
    const name = tool.name;
    const mapped: Record<string, unknown> = {
      type: 'function',
      name,
      parameters: tool.input_schema,
    };
    registerToolChoice(name, { type: 'function', name }, choices, ambiguousNames);
    if (tool.description !== undefined) {
      if (typeof tool.description === 'string') mapped.description = tool.description;
      else logger.translationFieldsIgnored({ context: 'custom-tool', fields: ['description'] });
    }
    mappedTools.push(mapped);
  }
  if (mappedTools.length === 0) {
    if (choiceValue !== undefined) logger.translationComponentIgnored({ context: 'tool-choice' });
    return;
  }
  output.tools = mappedTools;

  const choice = choiceValue === undefined
    ? { type: 'auto' }
    : isRecord(choiceValue)
      ? choiceValue
      : undefined;
  if (!choice) {
    logger.translationComponentIgnored({ context: 'tool-choice' });
    output.tool_choice = 'auto';
    output.parallel_tool_calls = model.capabilities?.supports?.parallel_tool_calls === true;
    return;
  }
  warnUnknownFields(
    choice,
    new Set(['type', 'name', 'disable_parallel_tool_use']),
    'tool-choice',
  );
  if (choice.type === 'auto') output.tool_choice = 'auto';
  else if (choice.type === 'any') output.tool_choice = 'required';
  else if (choice.type === 'none') output.tool_choice = 'none';
  else if (choice.type === 'tool') {
    const selected = typeof choice.name === 'string' && !ambiguousNames.has(choice.name)
      ? choices.get(choice.name)
      : undefined;
    if (selected) output.tool_choice = selected;
    else {
      logger.translationFieldsIgnored({ context: 'tool-choice', fields: ['name'] });
      output.tool_choice = 'auto';
    }
  } else {
    logger.translationPassthrough({ context: 'tool-choice' });
    output.tool_choice = Object.fromEntries(
      Object.entries(choice).filter(([key]) => key !== 'disable_parallel_tool_use'),
    );
  }

  const disableParallel = choice.disable_parallel_tool_use;
  if (disableParallel !== undefined && typeof disableParallel !== 'boolean') {
    logger.translationFieldsIgnored({
      context: 'tool-choice',
      fields: ['disable_parallel_tool_use'],
    });
  }
  output.parallel_tool_calls = disableParallel === true
    ? false
    : model.capabilities?.supports?.parallel_tool_calls === true;
}

function registerToolChoice(
  value: unknown,
  choice: Record<string, unknown>,
  choices: Map<string, Record<string, unknown>>,
  ambiguousNames: Set<string>,
): void {
  if (typeof value !== 'string' || value.length === 0 || ambiguousNames.has(value)) return;
  if (choices.has(value)) {
    choices.delete(value);
    ambiguousNames.add(value);
    return;
  }
  choices.set(value, choice);
}

function mapMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    logger.translationComponentIgnored({ context: 'content-block' });
    return undefined;
  }
  const metadata = value;
  warnUnknownFields(metadata, new Set(['user_id']), 'metadata');
  if (typeof metadata.user_id !== 'string') {
    logger.translationFieldsIgnored({ context: 'metadata', fields: ['user_id'] });
    return undefined;
  }
  return { user_id: metadata.user_id };
}

function mapOutputConfig(
  value: unknown,
  model: ModelRecord,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    logger.translationComponentIgnored({ context: 'content-block' });
    return undefined;
  }
  const outputConfig = value;
  warnUnknownFields(outputConfig, new Set(['effort']), 'output-config');
  if (typeof outputConfig.effort !== 'string' || outputConfig.effort.length === 0) {
    logger.translationFieldsIgnored({ context: 'output-config', fields: ['effort'] });
    return undefined;
  }
  const effort = outputConfig.effort;
  const supportedEfforts = model.capabilities?.supports?.reasoning_effort;
  if (
    !Array.isArray(supportedEfforts) ||
    !supportedEfforts.every((entry) => typeof entry === 'string')
  ) {
    logger.translationFieldsIgnored({ context: 'output-config', fields: ['effort'] });
    return undefined;
  }
  if (!supportedEfforts.includes(effort)) {
    logger.translationFieldsIgnored({ context: 'output-config', fields: ['effort'] });
    return undefined;
  }
  return { effort };
}

function validateCacheControl(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    logger.translationFieldsIgnored({ context: 'cache-control', fields: ['cache_control'] });
    return;
  }
  const cacheControl = value;
  warnUnknownFields(cacheControl, new Set(['type']), 'cache-control');
  if (cacheControl.type !== 'ephemeral') {
    logger.translationFieldsIgnored({ context: 'cache-control', fields: ['type'] });
  }
}

function mapImage(block: Record<string, unknown>, model: ModelRecord): Record<string, unknown> | undefined {
  warnUnknownFields(block, new Set(['type', 'source']), 'image');
  if (!isRecord(block.source)) {
    logger.translationComponentIgnored({ context: 'content-block' });
    return undefined;
  }
  const source = block.source;
  warnUnknownFields(source, new Set(['type', 'media_type', 'data']), 'image-source');
  if (source.type !== 'base64') {
    logger.translationComponentIgnored({ context: 'content-block' });
    return undefined;
  }
  requireModelSupport(model, 'vision');
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

function warnUnknownFields(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  context: Parameters<typeof logger.translationFieldsIgnored>[0]['context'],
): void {
  const fields = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (fields.length > 0) logger.translationFieldsIgnored({ context, fields });
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