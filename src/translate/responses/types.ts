import type { ModelRecord } from '../../models/ModelCatalog.js';

export const REQUEST_BODY_MAX_BYTES = 8 * 1024 * 1024;
export const NON_STREAM_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const ERROR_BODY_MAX_BYTES = 64 * 1024;
export const SSE_FRAME_MAX_BYTES = 1024 * 1024;
export const STREAM_TEXT_MAX_BYTES = 1024 * 1024;
export const TOOL_ARGUMENTS_MAX_BYTES = 1024 * 1024;

export type FailureType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'api_error';

export interface SafeFailure {
  status: number;
  type: FailureType;
  message: string;
  code?: string;
}

export class TranslationError extends Error {
  readonly failure: SafeFailure;

  constructor(failure: SafeFailure) {
    super(failure.message);
    this.name = 'TranslationError';
    this.failure = failure;
  }
}

export interface ResponsesFunctionCallItem {
  id?: string;
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
}

export interface ResponsesReasoningItem {
  id?: string;
  type: 'reasoning';
  encrypted_content?: string;
  summary?: readonly unknown[];
  status?: string;
}

export interface CompletedContinuationItem {
  outputIndex: number;
  item: ResponsesFunctionCallItem | ResponsesReasoningItem;
}

export interface ContinuationCall {
  callId: string;
  outputIndex: number;
  name: string;
  input: Readonly<Record<string, unknown>>;
}

export interface ContinuationGroup {
  groupId: string;
  modelId: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  items: readonly CompletedContinuationItem[];
  calls: ReadonlyMap<string, ContinuationCall>;
  byteSize: number;
}

export interface ContinuationStage {
  readonly groupId: string;
  readonly modelId: string;
  readonly items: CompletedContinuationItem[];
  readonly calls: Map<string, ContinuationCall>;
  published: boolean;
  discarded: boolean;
}

export interface MappingContext {
  model: ModelRecord;
  registry: {
    createStage(modelId: string): ContinuationStage;
    allocateToolId(stage: ContinuationStage): string;
    addItem(stage: ContinuationStage, item: CompletedContinuationItem): void;
    addCall(stage: ContinuationStage, toolId: string, call: ContinuationCall): void;
    resolve(toolUseIds: readonly string[], modelId: string): ContinuationGroup;
    publish(stage: ContinuationStage): ContinuationGroup;
    discard(stage: ContinuationStage): void;
  };
}

export interface MappedRequest {
  body: Readonly<Record<string, unknown>>;
  stream: boolean;
}

export interface MappedMessage {
  message: Readonly<Record<string, unknown>>;
  stage?: ContinuationStage;
}