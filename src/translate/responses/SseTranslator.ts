import type {
  ContinuationStage,
  MappingContext,
  ResponsesFunctionCallItem,
  ResponsesOpaqueItem,
  ResponsesReasoningItem,
} from './types.js';
import { logger } from '../../logger.js';
import {
  SSE_FRAME_MAX_BYTES,
  STREAM_TEXT_MAX_BYTES,
  TOOL_ARGUMENTS_MAX_BYTES,
  TranslationError,
} from './types.js';

export type SseWriter = (frame: string) => Promise<void>;

interface ActiveItem {
  itemId: string;
  outputIndex: number;
  type: 'message' | 'function_call' | 'reasoning' | 'opaque';
  sourceType: string;
  blockIndex?: number;
  toolId?: string;
  name?: string;
  callId?: string;
  text: string;
  partText: string;
  arguments: string;
  partOpen: boolean;
  ignoredPartOpen: boolean;
  sawTextPart: boolean;
  textDone: boolean;
  argumentsDone: boolean;
}

/** Incrementally translates a strict Responses SSE stream into Anthropic SSE frames. */
export class SseTranslator {
  private readonly context: MappingContext;
  private readonly writer: SseWriter;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly stage: ContinuationStage;
  private readonly itemIds = new Set<string>();
  private pending = '';
  private responseId?: string;
  private active?: ActiveItem;
  private nextOutputIndex = 0;
  private nextBlockIndex = 0;
  private created = false;
  private terminal = false;
  private aborted = false;
  private hasFunctionCall = false;
  private published = false;

  constructor(context: MappingContext, writer: SseWriter) {
    this.context = context;
    this.writer = writer;
    this.stage = context.registry.createStage(context.model.id);
  }

  async push(chunk: Uint8Array): Promise<void> {
    this.assertActive();
    try {
      this.pending += this.decoder.decode(chunk, { stream: true });
    } catch {
      protocol('Responses stream contains malformed UTF-8.');
    }
    await this.consumeFrames();
    if (Buffer.byteLength(this.pending, 'utf8') > SSE_FRAME_MAX_BYTES) {
      protocol('Responses SSE frame exceeds its size limit.');
    }
  }

  async finish(): Promise<void> {
    if (this.aborted) protocol('Responses translator was aborted.');
    try {
      this.pending += this.decoder.decode();
    } catch {
      protocol('Responses stream contains malformed UTF-8.');
    }
    if (!this.terminal) await this.consumeFrames();
    if (this.pending.length > 0 || !this.terminal) {
      protocol('Responses stream ended before a valid terminal event.', 'responses_stream_incomplete');
    }
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    if (!this.published) this.context.registry.discard(this.stage);
  }

  private async consumeFrames(): Promise<void> {
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match || match.index === undefined) return;
      const frame = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (Buffer.byteLength(frame, 'utf8') > SSE_FRAME_MAX_BYTES) {
        protocol('Responses SSE frame exceeds its size limit.');
      }
      if (frame.length > 0) await this.processFrame(frame);
    }
  }

  private async processFrame(frame: string): Promise<void> {
    if (this.terminal) protocol('Responses stream continued after its terminal event.');
    let eventName: string | undefined;
    const data: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (rawLine.startsWith(':')) continue;
      const separator = rawLine.indexOf(':');
      const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
      let value = separator < 0 ? '' : rawLine.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') eventName = value;
      else if (field === 'id' || field === 'retry') continue;
      else logger.translationFieldsIgnored({ context: 'sse-transport', fields: [field] });
    }
    if (data.length === 0) return;
    const dataText = data.join('\n');
    if (dataText === '[DONE]') protocol('Responses stream ended with an unexpected DONE marker.');
    let value: unknown;
    try {
      value = JSON.parse(dataText);
    } catch {
      protocol('Responses SSE data is not valid JSON.');
    }
    const event = requireRecord(value, 'event');
    const type = requireString(event.type, 'event.type');
    if (eventName !== undefined && eventName !== type) {
      protocol('Responses SSE event name does not match its JSON type.');
    }
    await this.processEvent(type, event);
  }

  private async processEvent(type: string, event: Record<string, unknown>): Promise<void> {
    if (!this.created && type !== 'response.created') {
      protocol('response.created must be the first Responses event.');
    }
    switch (type) {
      case 'response.created':
        await this.onCreated(event);
        return;
      case 'response.in_progress':
        this.validateResponseIdentity(event.response);
        return;
      case 'response.output_item.added':
        await this.onItemAdded(event);
        return;
      case 'response.content_part.added':
        await this.onContentPartAdded(event);
        return;
      case 'response.output_text.delta':
        await this.onTextDelta(event);
        return;
      case 'response.output_text.done':
        this.onTextDone(event);
        return;
      case 'response.content_part.done':
        await this.onContentPartDone(event);
        return;
      case 'response.function_call_arguments.delta':
        await this.onArgumentsDelta(event);
        return;
      case 'response.function_call_arguments.done':
        this.onArgumentsDone(event);
        return;
      case 'response.output_item.done':
        await this.onItemDone(event);
        return;
      case 'response.completed':
        await this.onTerminal(event, false);
        return;
      case 'response.incomplete':
        await this.onTerminal(event, true);
        return;
      case 'response.failed':
      case 'error':
        protocol('Responses stream reported an upstream failure.', 'responses_stream_upstream_failure');
      default:
        logger.translationComponentIgnored({ context: 'responses-event' });
    }
  }

  private async onCreated(event: Record<string, unknown>): Promise<void> {
    if (this.created) protocol('response.created was duplicated.');
    const response = this.validateResponseIdentity(event.response, true);
    if (response.status !== 'in_progress') protocol('Created response status is invalid.');
    if (response.usage !== null) protocol('Created response usage must be null.');
    this.created = true;
    await this.emit('message_start', {
      type: 'message_start',
      message: {
        id: this.responseId,
        type: 'message',
        role: 'assistant',
        model: this.context.model.id,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private async onItemAdded(event: Record<string, unknown>): Promise<void> {
    if (this.active) protocol('Responses output items may not interleave.');
    const outputIndex = this.validateOutputIndex(event.output_index);
    const item = requireRecord(event.item, 'output item');
    const itemId = requireNonEmptyString(item.id, 'output item id');
    if (this.itemIds.has(itemId)) protocol('Responses output item id was duplicated.');
    this.itemIds.add(itemId);
    const sourceType = requireNonEmptyString(item.type, 'output item type');
    const type = sourceType === 'message' || sourceType === 'function_call' || sourceType === 'reasoning'
      ? sourceType
      : 'opaque';
    if (type === 'opaque') logger.translationComponentIgnored({ context: 'response-output' });
    this.active = {
      itemId,
      outputIndex,
      type,
      sourceType,
      text: '',
      partText: '',
      arguments: '',
      partOpen: false,
      ignoredPartOpen: false,
      sawTextPart: false,
      textDone: false,
      argumentsDone: false,
    };
    if (type === 'function_call') {
      const name = requireNonEmptyString(item.name, 'function name');
      const callId = requireNonEmptyString(item.call_id, 'function call id');
      const toolId = this.context.registry.allocateToolId(this.stage);
      const blockIndex = this.nextBlockIndex++;
      Object.assign(this.active, { name, callId, toolId, blockIndex });
      this.hasFunctionCall = true;
      await this.emit('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: toolId, name, input: {} },
      });
    }
  }

  private async onContentPartAdded(event: Record<string, unknown>): Promise<void> {
    const active = this.requireActive(event, 'message');
    if (active.partOpen || active.ignoredPartOpen) {
      protocol('Response message has multiple open content parts.');
    }
    const part = requireRecord(event.part, 'content part');
    if (part.type !== 'output_text') {
      active.ignoredPartOpen = true;
      logger.translationComponentIgnored({ context: 'response-content' });
      return;
    }
    if (part.text !== undefined && part.text !== '') {
      protocol('Response text content part is invalid.');
    }
    const blockIndex = this.nextBlockIndex++;
    active.blockIndex = blockIndex;
    active.partOpen = true;
    active.sawTextPart = true;
    active.partText = '';
    active.textDone = false;
    await this.emit('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });
  }

  private async onTextDelta(event: Record<string, unknown>): Promise<void> {
    const active = this.requireActive(event, 'message');
    if (!active.partOpen || active.textDone || active.blockIndex === undefined) {
      protocol('Response text delta arrived outside an open content part.');
    }
    const delta = requireString(event.delta, 'text delta');
    if (Buffer.byteLength(active.text + delta, 'utf8') > STREAM_TEXT_MAX_BYTES) {
      protocol('Response text exceeds its size limit.');
    }
    active.text += delta;
    active.partText += delta;
    await this.emit('content_block_delta', {
      type: 'content_block_delta',
      index: active.blockIndex,
      delta: { type: 'text_delta', text: delta },
    });
  }

  private onTextDone(event: Record<string, unknown>): void {
    const active = this.requireActive(event, 'message');
    if (!active.partOpen || active.textDone) protocol('Response text completion is out of order.');
    if (requireString(event.text, 'completed text') !== active.partText) {
      protocol('Completed response text does not match its deltas.');
    }
    active.textDone = true;
  }

  private async onContentPartDone(event: Record<string, unknown>): Promise<void> {
    const active = this.requireActive(event, 'message');
    if (active.ignoredPartOpen) {
      active.ignoredPartOpen = false;
      return;
    }
    if (!active.partOpen || !active.textDone || active.blockIndex === undefined) {
      protocol('Response content part completed out of order.');
    }
    const part = requireRecord(event.part, 'completed content part');
    if (part.type !== 'output_text' || part.text !== active.partText) {
      protocol('Completed response content part does not match its deltas.');
    }
    active.partOpen = false;
    await this.emit('content_block_stop', {
      type: 'content_block_stop',
      index: active.blockIndex,
    });
  }

  private async onArgumentsDelta(event: Record<string, unknown>): Promise<void> {
    const active = this.requireActive(event, 'function_call');
    if (active.argumentsDone || active.blockIndex === undefined) {
      protocol('Function arguments delta arrived after completion.');
    }
    const delta = requireString(event.delta, 'function arguments delta');
    if (Buffer.byteLength(active.arguments + delta, 'utf8') > TOOL_ARGUMENTS_MAX_BYTES) {
      protocol('Function arguments exceed their size limit.');
    }
    active.arguments += delta;
    await this.emit('content_block_delta', {
      type: 'content_block_delta',
      index: active.blockIndex,
      delta: { type: 'input_json_delta', partial_json: delta },
    });
  }

  private onArgumentsDone(event: Record<string, unknown>): void {
    const active = this.requireActive(event, 'function_call');
    if (active.argumentsDone) protocol('Function arguments completion was duplicated.');
    if (requireString(event.arguments, 'completed function arguments') !== active.arguments) {
      protocol('Completed function arguments do not match their deltas.');
    }
    parseArguments(active.arguments);
    active.argumentsDone = true;
  }

  private async onItemDone(event: Record<string, unknown>): Promise<void> {
    const active = this.requireActive(event);
    const item = requireRecord(event.item, 'completed output item');
    requireNonEmptyString(item.id, 'completed output item id');
    if (item.type !== active.sourceType) {
      protocol('Completed output item does not match its added item.');
    }
    if (active.type !== 'reasoning' && item.status !== 'completed') {
      protocol('Response output item is not completed.');
    }
    if (active.type === 'message') {
      if (
        active.partOpen ||
        active.ignoredPartOpen ||
        (active.sawTextPart && !active.textDone)
      ) {
        protocol('Message item completed before its content.');
      }
      if (item.role !== 'assistant' || !Array.isArray(item.content)) {
        protocol('Completed message item is invalid.');
      }
      const completedText = item.content
        .map((partValue) => {
          const part = requireRecord(partValue, 'completed message content');
          if (part.type !== 'output_text') {
            logger.translationComponentIgnored({ context: 'response-content' });
            return '';
          }
          return requireString(part.text, 'completed message text');
        })
        .join('');
      if (completedText !== active.text) protocol('Completed message item does not match its deltas.');
    } else if (active.type === 'function_call') {
      if (!active.argumentsDone || active.blockIndex === undefined || !active.toolId) {
        protocol('Function call item completed before its arguments.');
      }
      if (item.call_id !== active.callId || item.name !== active.name || item.arguments !== active.arguments) {
        protocol('Completed function call does not match its deltas.');
      }
      const parsed = parseArguments(active.arguments);
      const authoritative = item as unknown as ResponsesFunctionCallItem;
      this.context.registry.addItem(this.stage, {
        outputIndex: active.outputIndex,
        item: authoritative,
      });
      this.context.registry.addCall(this.stage, active.toolId, {
        callId: active.callId as string,
        outputIndex: active.outputIndex,
        name: active.name as string,
        input: parsed,
      });
      await this.emit('content_block_stop', {
        type: 'content_block_stop',
        index: active.blockIndex,
      });
    } else if (active.type === 'reasoning') {
      if (item.status !== undefined && item.status !== 'completed') {
        protocol('Reasoning item is incomplete.');
      }
      this.context.registry.addItem(this.stage, {
        outputIndex: active.outputIndex,
        item: item as unknown as ResponsesReasoningItem,
      });
    } else {
      this.context.registry.addItem(this.stage, {
        outputIndex: active.outputIndex,
        item: item as unknown as ResponsesOpaqueItem,
      });
    }
    this.active = undefined;
    this.nextOutputIndex += 1;
  }

  private async onTerminal(event: Record<string, unknown>, incomplete: boolean): Promise<void> {
    if (this.active) protocol('Response terminated before every output item completed.');
    const response = this.validateResponseIdentity(event.response);
    const usage = requireRecord(response.usage, 'terminal usage');
    const inputTokens = requireTokenCount(usage.input_tokens, 'input_tokens');
    const outputTokens = requireTokenCount(usage.output_tokens, 'output_tokens');
    if (incomplete) {
      const details = requireRecord(response.incomplete_details, 'incomplete details');
      if (
        response.status !== 'incomplete' ||
        details.reason !== 'max_output_tokens' ||
        this.hasFunctionCall
      ) {
        protocol('Incomplete response cannot complete this stream.');
      }
      this.context.registry.discard(this.stage);
    } else if (response.status !== 'completed') {
      protocol('Completed response status is invalid.');
    } else if (this.hasFunctionCall) {
      this.context.registry.publish(this.stage);
      this.published = true;
    } else {
      this.context.registry.discard(this.stage);
    }
    const stopReason = incomplete ? 'max_tokens' : this.hasFunctionCall ? 'tool_use' : 'end_turn';
    await this.emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
    await this.emit('message_stop', { type: 'message_stop' });
    this.terminal = true;
  }

  private validateResponseIdentity(value: unknown, initialize = false): Record<string, unknown> {
    const response = requireRecord(value, 'response');
    const id = requireNonEmptyString(response.id, 'response id');
    if (response.model !== this.context.model.id) protocol('Response model does not match the request.');
    if (initialize) this.responseId = id;
    return response;
  }

  private validateOutputIndex(value: unknown): number {
    if (!Number.isInteger(value) || value !== this.nextOutputIndex) {
      protocol('Responses output items are out of order.');
    }
    return value as number;
  }

  private requireActive(
    event: Record<string, unknown>,
    expectedType?: ActiveItem['type'],
  ): ActiveItem {
    if (!this.active) protocol('Responses item event arrived before item creation.');
    if (event.output_index !== this.active.outputIndex) protocol('Responses output index changed.');
    if (event.item_id !== undefined) requireNonEmptyString(event.item_id, 'event item id');
    if (expectedType && this.active.type !== expectedType) {
      protocol(`Responses event does not apply to ${this.active.type}.`);
    }
    return this.active;
  }

  private async emit(event: string, value: Record<string, unknown>): Promise<void> {
    await this.writer(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  }

  private assertActive(): void {
    if (this.aborted) protocol('Responses translator was aborted.');
    if (this.terminal) protocol('Responses translator already completed.');
  }
}

function parseArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    protocol('Function arguments are not valid JSON.');
  }
  if (!isRecord(parsed)) protocol('Function arguments must be a JSON object.');
  return parsed;
}

function requireTokenCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    protocol(`Response usage ${label} is invalid.`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) protocol(`Responses ${label} is invalid.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') protocol(`Responses ${label} is invalid.`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (result.length === 0) protocol(`Responses ${label} is empty.`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocol(
  message: string,
  code:
    | 'responses_stream_upstream_failure'
    | 'responses_stream_incomplete'
    | 'responses_stream_unsupported_event'
    | 'responses_stream_protocol' = 'responses_stream_protocol',
): never {
  throw new TranslationError({ status: 502, type: 'api_error', message, code });
}