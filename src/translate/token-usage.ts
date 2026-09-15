import { TranslationError } from './responses/types.js';

interface UsageFields {
  readonly source: 'Response' | 'Chat';
  readonly input: string;
  readonly output: string;
  readonly details: string;
}

const RESPONSES_USAGE_FIELDS: UsageFields = {
  source: 'Response',
  input: 'input_tokens',
  output: 'output_tokens',
  details: 'input_tokens_details',
};

const CHAT_USAGE_FIELDS: UsageFields = {
  source: 'Chat',
  input: 'prompt_tokens',
  output: 'completion_tokens',
  details: 'prompt_tokens_details',
};

/** Maps inclusive Responses token usage into Anthropic's additive usage fields. */
export function mapResponsesUsage(value: unknown): Readonly<Record<string, number>> {
  return mapUsage(value, RESPONSES_USAGE_FIELDS);
}

/** Maps inclusive Chat token usage into Anthropic's additive usage fields. */
export function mapChatUsage(value: unknown): Readonly<Record<string, number>> {
  return mapUsage(value, CHAT_USAGE_FIELDS);
}

function mapUsage(value: unknown, fields: UsageFields): Readonly<Record<string, number>> {
  const usage = requireRecord(value, `${fields.source} usage is invalid.`);
  const inputTokens = requireTokenCount(usage[fields.input], fields.source, fields.input);
  const outputTokens = requireTokenCount(usage[fields.output], fields.source, fields.output);
  if (usage[fields.details] === undefined) {
    return { input_tokens: inputTokens, output_tokens: outputTokens };
  }

  const details = requireRecord(usage[fields.details], `${fields.source} usage ${fields.details} is invalid.`);
  const hasCacheRead = details.cached_tokens !== undefined;
  const hasCacheWrite = details.cache_write_tokens !== undefined;
  if (!hasCacheRead && !hasCacheWrite) {
    return { input_tokens: inputTokens, output_tokens: outputTokens };
  }

  const cacheReadTokens = hasCacheRead
    ? requireTokenCount(details.cached_tokens, fields.source, 'cached_tokens')
    : 0;
  const cacheWriteTokens = hasCacheWrite
    ? requireTokenCount(details.cache_write_tokens, fields.source, 'cache_write_tokens')
    : 0;
  if (cacheReadTokens + cacheWriteTokens > inputTokens) {
    protocol(`${fields.source} usage cache token counts exceed ${fields.input}.`);
  }

  return {
    input_tokens: inputTokens - cacheReadTokens - cacheWriteTokens,
    cache_creation_input_tokens: cacheWriteTokens,
    cache_read_input_tokens: cacheReadTokens,
    output_tokens: outputTokens,
  };
}

function requireTokenCount(value: unknown, source: string, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    protocol(`${source} usage ${name} is invalid.`);
  }
  return value as number;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) protocol(message);
  return value as Record<string, unknown>;
}

function protocol(message: string): never {
  throw new TranslationError({ status: 502, type: 'api_error', message });
}