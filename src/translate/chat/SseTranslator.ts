import type { ModelRecord } from '../../models/ModelCatalog.js';
import { matchesRequestedModel } from '../shared.js';
import {
  SSE_FRAME_MAX_BYTES,
  STREAM_TEXT_MAX_BYTES,
  TOOL_ARGUMENTS_MAX_BYTES,
  TranslationError,
} from '../responses/types.js';

export type SseWriter = (frame: string) => Promise<void>;

interface ToolState {
  readonly index: number;
  readonly blockIndex: number;
  readonly id: string;
  readonly name: string;
  arguments: string;
}

/** Incrementally translates a Chat Completions SSE stream into Anthropic SSE frames. */
export class SseTranslator {
  private readonly context: { readonly model: ModelRecord };
  private readonly writer: SseWriter;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly tools = new Map<number, ToolState>();
  private readonly toolIds = new Set<string>();
  private pending = '';
  private started = false;
  private terminal = false;
  private aborted = false;
  private responseId?: string;
  private textBlockIndex?: number;
  private text = '';
  private nextBlockIndex = 0;
  private finishReason?: string;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(context: { readonly model: ModelRecord }, writer: SseWriter) {
    this.context = context;
    this.writer = writer;
  }

  async push(chunk: Uint8Array): Promise<void> {
    this.assertActive();
    try {
      this.pending += this.decoder.decode(chunk, { stream: true });
    } catch {
      protocol('Chat stream contains malformed UTF-8.');
    }
    await this.consumeFrames();
    if (Buffer.byteLength(this.pending, 'utf8') > SSE_FRAME_MAX_BYTES) {
      protocol('Chat SSE frame exceeds its size limit.');
    }
  }

  async finish(): Promise<void> {
    if (this.aborted) protocol('Chat translator was aborted.');
    try {
      this.pending += this.decoder.decode();
    } catch {
      protocol('Chat stream contains malformed UTF-8.');
    }
    if (!this.terminal) await this.consumeFrames();
    if (this.pending.length > 0 || !this.terminal) {
      protocol('Chat stream ended before a valid DONE marker.');
    }
  }

  abort(): void {
    this.aborted = true;
  }

  private async consumeFrames(): Promise<void> {
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match || match.index === undefined) return;
      const frame = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (Buffer.byteLength(frame, 'utf8') > SSE_FRAME_MAX_BYTES) {
        protocol('Chat SSE frame exceeds its size limit.');
      }
      if (frame.length > 0) await this.processFrame(frame);
    }
  }

  private async processFrame(frame: string): Promise<void> {
    if (this.terminal) protocol('Chat stream continued after its terminal marker.');
    const data: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (rawLine.startsWith(':')) continue;
      const separator = rawLine.indexOf(':');
      const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
      let value = separator < 0 ? '' : rawLine.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
    }
    if (data.length === 0) return;
    const dataText = data.join('\n');
    if (dataText === '[DONE]') {
      await this.complete();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(dataText);
    } catch {
      protocol('Chat SSE data is not valid JSON.');
    }
    const chunk = requireRecord(value, 'chunk');
    if (isRecord(chunk.error)) protocol('Chat stream reported an upstream failure.');
    if (chunk.object !== undefined && chunk.object !== 'chat.completion.chunk') {
      protocol('Chat stream object type is invalid.');
    }
    const id = requireNonEmptyString(chunk.id, 'response id');
    if (!matchesRequestedModel(chunk.model, this.context.model.id)) {
      protocol('Chat stream model does not match the request.');
    }
    if (this.responseId !== undefined && id !== this.responseId) {
      protocol('Chat stream response id changed.');
    }
    if (!this.started) {
      this.responseId = id;
      this.started = true;
      await this.emit('message_start', {
        type: 'message_start',
        message: {
          id,
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
    if (chunk.usage !== undefined && chunk.usage !== null) this.captureUsage(chunk.usage);
    if (!Array.isArray(chunk.choices)) protocol('Chat stream choices are invalid.');
    if (chunk.choices.length === 0) return;
    if (chunk.choices.length !== 1) protocol('Chat stream must contain one choice.');
    const choice = requireRecord(chunk.choices[0], 'choice');
    if (choice.index !== 0) protocol('Chat stream choice index is invalid.');
    const delta = requireRecord(choice.delta, 'choice delta');
    if (delta.role !== undefined && delta.role !== 'assistant') {
      protocol('Chat stream role is invalid.');
    }
    if (delta.content !== undefined && delta.content !== null) {
      await this.onText(requireString(delta.content, 'text delta'));
    }
    if (delta.tool_calls !== undefined) await this.onToolCalls(delta.tool_calls);
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      const reason = requireNonEmptyString(choice.finish_reason, 'finish reason');
      if (this.finishReason !== undefined) protocol('Chat finish reason was duplicated.');
      this.finishReason = reason;
    }
  }

  private async onText(delta: string): Promise<void> {
    if (this.tools.size > 0) protocol('Chat text cannot follow tool-call deltas.');
    if (Buffer.byteLength(this.text + delta, 'utf8') > STREAM_TEXT_MAX_BYTES) {
      protocol('Chat text exceeds its size limit.');
    }
    if (this.textBlockIndex === undefined) {
      this.textBlockIndex = this.nextBlockIndex++;
      await this.emit('content_block_start', {
        type: 'content_block_start',
        index: this.textBlockIndex,
        content_block: { type: 'text', text: '' },
      });
    }
    this.text += delta;
    await this.emit('content_block_delta', {
      type: 'content_block_delta',
      index: this.textBlockIndex,
      delta: { type: 'text_delta', text: delta },
    });
  }

  private async onToolCalls(value: unknown): Promise<void> {
    if (!Array.isArray(value)) protocol('Chat tool-call deltas are invalid.');
    if (this.textBlockIndex !== undefined) {
      await this.emit('content_block_stop', {
        type: 'content_block_stop',
        index: this.textBlockIndex,
      });
      this.textBlockIndex = undefined;
    }
    for (const entry of value) {
      const delta = requireRecord(entry, 'tool-call delta');
      if (!Number.isInteger(delta.index) || (delta.index as number) < 0) {
        protocol('Chat tool-call index is invalid.');
      }
      const index = delta.index as number;
      let tool = this.tools.get(index);
      if (!tool) {
        if (delta.type !== undefined && delta.type !== 'function') {
          protocol('Chat tool-call type is invalid.');
        }
        const fn = requireRecord(delta.function, 'tool function delta');
        const id = requireNonEmptyString(delta.id, 'tool-call id');
        if (this.toolIds.has(id)) protocol('Chat tool-call id is duplicated.');
        this.toolIds.add(id);
        tool = {
          index,
          blockIndex: this.nextBlockIndex++,
          id,
          name: requireNonEmptyString(fn.name, 'tool function name'),
          arguments: '',
        };
        this.tools.set(index, tool);
        await this.emit('content_block_start', {
          type: 'content_block_start',
          index: tool.blockIndex,
          content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
        });
        await this.appendArguments(tool, fn.arguments);
        continue;
      }
      if (delta.id !== undefined && delta.id !== tool.id) protocol('Chat tool-call id changed.');
      if (delta.type !== undefined && delta.type !== 'function') {
        protocol('Chat tool-call type changed.');
      }
      if (delta.function !== undefined) {
        const fn = requireRecord(delta.function, 'tool function delta');
        if (fn.name !== undefined && fn.name !== tool.name) protocol('Chat tool function name changed.');
        await this.appendArguments(tool, fn.arguments);
      }
    }
  }

  private async appendArguments(tool: ToolState, value: unknown): Promise<void> {
    if (value === undefined) return;
    const delta = requireString(value, 'tool arguments delta');
    if (Buffer.byteLength(tool.arguments + delta, 'utf8') > TOOL_ARGUMENTS_MAX_BYTES) {
      protocol('Chat tool arguments exceed their size limit.');
    }
    tool.arguments += delta;
    if (delta.length > 0) {
      await this.emit('content_block_delta', {
        type: 'content_block_delta',
        index: tool.blockIndex,
        delta: { type: 'input_json_delta', partial_json: delta },
      });
    }
  }

  private captureUsage(value: unknown): void {
    const usage = requireRecord(value, 'usage');
    this.inputTokens = requireTokenCount(usage.prompt_tokens, 'prompt_tokens');
    this.outputTokens = requireTokenCount(usage.completion_tokens, 'completion_tokens');
  }

  private async complete(): Promise<void> {
    if (!this.started || this.finishReason === undefined) {
      protocol('Chat stream ended without a finish reason.');
    }
    if (this.textBlockIndex !== undefined) {
      await this.emit('content_block_stop', {
        type: 'content_block_stop',
        index: this.textBlockIndex,
      });
      this.textBlockIndex = undefined;
    }
    for (const tool of [...this.tools.values()].sort((left, right) => left.index - right.index)) {
      parseArguments(tool.arguments);
      await this.emit('content_block_stop', {
        type: 'content_block_stop',
        index: tool.blockIndex,
      });
    }
    await this.emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapStopReason(this.finishReason, this.tools.size > 0), stop_sequence: null },
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
    });
    await this.emit('message_stop', { type: 'message_stop' });
    this.terminal = true;
  }

  private async emit(event: string, value: Record<string, unknown>): Promise<void> {
    await this.writer(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  }

  private assertActive(): void {
    if (this.aborted) protocol('Chat translator was aborted.');
    if (this.terminal) protocol('Chat translator already completed.');
  }
}

function mapStopReason(value: string, hasToolCalls: boolean): string {
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use';
  if (value === 'length') return 'max_tokens';
  if (value === 'stop') return hasToolCalls ? 'tool_use' : 'end_turn';
  if (value === 'content_filter') return 'end_turn';
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

function requireTokenCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    protocol(`Chat usage ${label} is invalid.`);
  }
  return value;
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