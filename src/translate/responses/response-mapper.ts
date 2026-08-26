import type {
  ContinuationStage,
  MappedMessage,
  MappingContext,
  ResponsesFunctionCallItem,
  ResponsesReasoningItem,
} from './types.js';
import { TranslationError } from './types.js';

/** Maps one bounded, complete Responses JSON payload into an Anthropic Message. */
export function mapResponsesResult(input: unknown, context: MappingContext): MappedMessage {
  const response = requireRecord(input, 'response');
  if (typeof response.id !== 'string' || response.id.length === 0) protocol('Response id is invalid.');
  if (response.model !== context.model.id) protocol('Response model does not match the request.');
  if (!Array.isArray(response.output)) protocol('Response output is invalid.');
  const usage = requireRecord(response.usage, 'usage');
  const inputTokens = requireTokenCount(usage.input_tokens, 'input_tokens');
  const outputTokens = requireTokenCount(usage.output_tokens, 'output_tokens');
  const incomplete = response.status === 'incomplete';
  if (response.status !== 'completed' && !incomplete) protocol('Response status is not supported.');
  if (incomplete) {
    const details = requireRecord(response.incomplete_details, 'incomplete_details');
    if (details.reason !== 'max_output_tokens') protocol('Incomplete response reason is invalid.');
  }

  const content: Record<string, unknown>[] = [];
  const stage = context.registry.createStage(context.model.id);
  let hasFunctionCall = false;
  try {
    response.output.forEach((itemValue, outputIndex) => {
      const item = requireRecord(itemValue, 'output item');
      if (item.type === 'message') {
        mapMessageItem(item, content);
        return;
      }
      if (item.type === 'function_call') {
        hasFunctionCall = true;
        mapFunctionCall(item, outputIndex, content, stage, context);
        return;
      }
      if (item.type === 'reasoning') {
        const reasoning = validateReasoning(item);
        context.registry.addItem(stage, { outputIndex, item: reasoning });
        return;
      }
      protocol(`Unsupported response output type "${String(item.type)}".`);
    });
    if (incomplete && hasFunctionCall) {
      protocol('Incomplete response contained a function call.');
    }
  } catch (error) {
    context.registry.discard(stage);
    throw error;
  }

  if (!hasFunctionCall) context.registry.discard(stage);
  const stopReason = incomplete ? 'max_tokens' : hasFunctionCall ? 'tool_use' : 'end_turn';
  return {
    message: {
      id: response.id,
      type: 'message',
      role: 'assistant',
      model: context.model.id,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
    stage: hasFunctionCall ? stage : undefined,
  };
}

function mapMessageItem(item: Record<string, unknown>, output: Record<string, unknown>[]): void {
  if (item.status !== 'completed' || item.role !== 'assistant' || !Array.isArray(item.content)) {
    protocol('Response message item is invalid.');
  }
  for (const partValue of item.content) {
    const part = requireRecord(partValue, 'message content');
    if (part.type !== 'output_text' || typeof part.text !== 'string') {
      protocol('Response message content is invalid.');
    }
    output.push({ type: 'text', text: part.text });
  }
}

function mapFunctionCall(
  item: Record<string, unknown>,
  outputIndex: number,
  output: Record<string, unknown>[],
  stage: ContinuationStage,
  context: MappingContext,
): void {
  if (
    item.status !== 'completed' ||
    typeof item.call_id !== 'string' ||
    item.call_id.length === 0 ||
    typeof item.name !== 'string' ||
    item.name.length === 0 ||
    typeof item.arguments !== 'string'
  ) {
    protocol('Response function call is invalid.');
  }
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(item.arguments);
  } catch {
    protocol('Response function arguments are invalid JSON.');
  }
  if (!isRecord(parsedArguments)) protocol('Response function arguments must be an object.');
  const authoritative: ResponsesFunctionCallItem = {
    ...(item as unknown as ResponsesFunctionCallItem),
    type: 'function_call',
    call_id: item.call_id,
    name: item.name,
    arguments: item.arguments,
  };
  const toolId = context.registry.allocateToolId(stage);
  context.registry.addItem(stage, { outputIndex, item: authoritative });
  context.registry.addCall(stage, toolId, {
    callId: item.call_id,
    outputIndex,
    name: item.name,
    input: parsedArguments,
  });
  output.push({ type: 'tool_use', id: toolId, name: item.name, input: parsedArguments });
}

function validateReasoning(item: Record<string, unknown>): ResponsesReasoningItem {
  if (item.status !== undefined && item.status !== 'completed') {
    protocol('Response reasoning item is incomplete.');
  }
  if (item.encrypted_content !== undefined && typeof item.encrypted_content !== 'string') {
    protocol('Response reasoning content is invalid.');
  }
  return { ...(item as unknown as ResponsesReasoningItem), type: 'reasoning' };
}

function requireTokenCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    protocol(`Response usage ${name} is invalid.`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) protocol(`Response ${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocol(message: string): never {
  throw new TranslationError({ status: 502, type: 'api_error', message });
}