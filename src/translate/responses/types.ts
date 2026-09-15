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

export interface MappedRequest {
  body: Readonly<Record<string, unknown>>;
  stream: boolean;
}

export interface MappedMessage {
  message: Readonly<Record<string, unknown>>;
}