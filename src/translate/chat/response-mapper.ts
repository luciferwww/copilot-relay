import { logger } from '../../logger.js';
import type { ModelRecord } from '../../models/ModelCatalog.js';
import { matchesRequestedModel } from '../shared.js';
import { mapChatUsage } from '../token-usage.js';
import { TranslationError, type MappedMessage } from '../responses/types.js';

/** Maps one bounded Chat Completions response into an Anthropic Message. */
export function mapChatResult(
  input: unknown,
  context: { readonly model: ModelRecord },
): MappedMessage {
  const response = requireRecord(input, 'response');
  const id = requireNonEmptyString(response.id, 'response id');
  if (!matchesRequestedModel(response.model, context.model.id)) {
    protocol('Chat response model does not match the request.');
  }
  if (!Array.isArray(response.choices) || response.choices.length !== 1) {
    protocol('Chat response choices are invalid.');
  }
  const choice = requireRecord(response.choices[0], 'choice');
  if (choice.index !== 0) protocol('Chat response choice index is invalid.');
  const message = requireRecord(choice.message, 'message');
  if (message.role !== 'assistant') protocol('Chat response role is invalid.');
  const content: Record<string, unknown>[] = [];
  if (typeof message.content === 'string') {
    if (message.content.length > 0) content.push({ type: 'text', text: message.content });
  } else if (message.content !== null && message.content !== undefined) {
    protocol('Chat response content is invalid.');
  }
  let hasToolCalls = false;
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) protocol('Chat tool calls are invalid.');
    const ids = new Set<string>();
    for (const value of message.tool_calls) {
      const call = requireRecord(value, 'tool call');
      if (call.type !== 'function') protocol('Chat tool call type is invalid.');
      const callId = requireNonEmptyString(call.id, 'tool call id');
      if (ids.has(callId)) protocol('Chat tool call id is duplicated.');
      ids.add(callId);
      const fn = requireRecord(call.function, 'tool function');
      const name = requireNonEmptyString(fn.name, 'tool function name');
      const argumentsText = requireString(fn.arguments, 'tool function arguments');
      content.push({ type: 'tool_use', id: callId, name, input: parseArguments(argumentsText) });
      hasToolCalls = true;
    }
  }
  const finishReason = requireNonEmptyString(choice.finish_reason, 'finish reason');
  const stopReason = mapStopReason(finishReason, hasToolCalls);
  const usage = mapChatUsage(response.usage);
  return {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: context.model.id,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    },
  };
}

function mapStopReason(value: string, hasToolCalls: boolean): string {
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use';
  if (value === 'length') return 'max_tokens';
  if (value === 'stop') return hasToolCalls ? 'tool_use' : 'end_turn';
  if (value === 'content_filter') {
    logger.translationFieldsIgnored({ context: 'response-output', fields: ['finish_reason'] });
    return 'end_turn';
  }
  protocol('Chat finish reason is not supported.');
}

function parseArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    protocol('Chat tool arguments are invalid JSON.');
  }
  if (!isRecord(parsed)) protocol('Chat tool arguments must be a JSON object.');
  return parsed;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) protocol(`Chat ${label} is invalid.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') protocol(`Chat ${label} is invalid.`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (result.length === 0) protocol(`Chat ${label} is empty.`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocol(message: string): never {
  throw new TranslationError({ status: 502, type: 'api_error', message });
}