export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type RequestRoute =
  | 'health'
  | 'models-passthrough'
  | 'chat-passthrough'
  | 'responses-passthrough'
  | 'messages-passthrough'
  | 'responses-translation'
  | 'not-found';
export type RequestEndpoint = '/models' | '/chat/completions' | '/v1/messages' | '/responses';
export type RequestPhase = 'routing' | 'request-body' | 'catalog' | 'mapping' | 'upstream' | 'response';
export type RequestFailureCode =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'api_error';
export type RequestDiagnosticCode =
  | 'route_not_found'
  | 'invalid_request_body'
  | 'model_catalog'
  | 'request_mapping'
  | 'upstream_http'
  | 'responses_stream_upstream_failure'
  | 'responses_stream_incomplete'
  | 'responses_stream_unsupported_event'
  | 'responses_stream_protocol'
  | 'response_processing'
  | 'client_canceled';
export type MessageRole = 'user' | 'assistant' | 'system' | 'unknown';
export type ContentKind = 'string' | 'array' | 'other';
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'image' | 'unknown';

export interface MessageShape {
  readonly role: MessageRole;
  readonly contentKind: ContentKind;
  readonly blockCount: number;
  readonly blockTypes: readonly ContentBlockType[];
}

interface RequestLogBase {
  readonly requestId: number;
  readonly method: string;
  readonly path: string;
}

export interface RequestReceivedLog extends RequestLogBase {
  readonly modelId?: string;
  readonly stream: boolean;
  readonly toolCount: number;
  readonly messageCount: number;
  readonly messages: readonly MessageShape[];
}

export interface RequestPlannedLog extends RequestLogBase {
  readonly modelId?: string;
  readonly route: RequestRoute;
  readonly endpoint: RequestEndpoint;
  readonly replanUsed: boolean;
}

export interface RequestTerminalLog extends RequestLogBase {
  readonly modelId?: string;
  readonly route?: RequestRoute;
  readonly endpoint?: RequestEndpoint;
  readonly status: number;
  readonly durationMs: number;
  readonly phase: RequestPhase;
  readonly failureCode?: RequestFailureCode;
  readonly diagnosticCode?: RequestDiagnosticCode;
  readonly invocationCount: number;
  readonly authRetryUsed: boolean;
  readonly replanUsed: boolean;
}

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let current: LogLevel = 'info';

export function setLevel(level: LogLevel): void {
  current = level;
}

function log(level: LogLevel, message: string): void {
  if (order[level] < order[current]) return;
  const stamp = new Date().toISOString();
  const line = `[${stamp}] [${level.toUpperCase()}]`;
  // Per spec §9 / requirement NFR5: all levels go to stdout (no file, no rotation).
  // Command output that must stay pipe-friendly (config-show) lowers the level
  // to `error` to keep stdout clean; see spec §1.6.
  console.log(line, message);
}

function logEvent(level: LogLevel, event: string, fields: object): void {
  if (order[level] < order[current]) return;
  const stamp = new Date().toISOString();
  const line = `[${stamp}] [${level.toUpperCase()}]`;
  console.log(line, event, JSON.stringify(fields));
}

export const logger = {
  debug: (message: string) => log('debug', message),
  info: (message: string) => log('info', message),
  warn: (message: string) => log('warn', message),
  error: (message: string) => log('error', message),
  requestReceived: (fields: RequestReceivedLog) => logEvent('debug', 'request.received', fields),
  requestPlanned: (fields: RequestPlannedLog) => logEvent('debug', 'request.planned', fields),
  requestTerminal: (
    event: 'request.completed' | 'request.failed' | 'request.canceled',
    fields: RequestTerminalLog,
  ) => logEvent('info', event, fields),
};
