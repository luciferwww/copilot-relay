# copilot-relay — Specification (v0.2)

> Status: approved 2026-08-24; amended 2026-09-15; production implementation pending migration. This document is the implementation contract for the approved [requirement.md](./requirement.md) and [design.md](./design.md). When they conflict, `requirement.md` wins.

> Decision record: [Stateless Messages Translation](./stateless-messages-translation-decision.md) governs translated Messages routing and tool identity.

> Compatibility contract: [Protocol Compatibility](./protocol-compatibility-principle.md) governs unknown and additive protocol data throughout this specification.

## 1. Scope and invariants

The current contract preserves the CLI, OpenAI Chat Completions passthrough, native Anthropic Messages passthrough, models passthrough, device login, loopback-only server, and native OpenAI Responses passthrough. It routes inbound Anthropic Messages to native Messages, stateless Chat Completions translation, or stateless best-effort Responses translation.

The following invariants are mandatory:

- The exact inbound model id is used for every model invocation and for catalog lookup on capability-routed requests. The relay never substitutes a model.
- When the relay makes a capability decision, live Copilot `/models` metadata is the only runtime authority. Captures such as `1.json` are fixtures only; native passthrough routes do not make capability decisions.
- Endpoint priority for `POST /v1/messages` is exact `/v1/messages`, exact `/chat/completions`, then exact HTTP `/responses`. `ws:/responses` is not HTTP `/responses`.
- Every translated request is completely validated before the first model invocation.
- Translated Responses requests always set `store: false` and never send `previous_response_id`; native Responses requests preserve those client fields.
- Translation never allocates a replacement function-call id and never retains state across HTTP requests.
- No retry or re-plan occurs after the first downstream response byte.
- Raw upstream bodies, headers, errors, credentials, image data, and credential-derived substrings never reach logs, CLI output, persisted diagnostics, or client errors.
- Additive fields, variants, output items, and auxiliary events are mapped, passed through, or omitted with a safe warning whenever a useful target exchange remains possible. Required identity, tool association, framing, resource, and translated-state invariants fail closed.

## 2. Fixed limits and deadlines

These are code constants, not v0.2 configuration fields.

| Constant | Value | Applies to |
|---|---:|---|
| `REQUEST_BODY_MAX_BYTES` | 8 MiB | Any inbound POST body |
| `NON_STREAM_RESPONSE_MAX_BYTES` | 8 MiB | Translated non-streaming Chat or Responses JSON |
| `ERROR_BODY_MAX_BYTES` | 64 KiB | Upstream non-2xx body used for allowlisted classification |
| `SSE_FRAME_MAX_BYTES` | 1 MiB | One incomplete or complete upstream SSE frame |
| `STREAM_TEXT_MAX_BYTES` | 1 MiB | Reconstructed UTF-8 text for one streaming output item |
| `TOOL_ARGUMENTS_MAX_BYTES` | 1 MiB | Reassembled arguments for one function call |
| `MODEL_CATALOG_BODY_MAX_BYTES` | 4 MiB | Internal `/models` refresh body |
| `MODEL_CATALOG_MAX_RECORDS` | 512 | Validated records in one snapshot |
| `MODEL_CATALOG_FRESH_MS` | 5 minutes | Fresh snapshot lifetime |
| `MODEL_CATALOG_STALE_MS` | 60 minutes | Maximum stale age after refresh failure |
| `AUTH_REFRESH_TIMEOUT_MS` | 15 seconds | One token exchange operation |
| `MODEL_CATALOG_TIMEOUT_MS` | 15 seconds | One internal catalog refresh |
| `EXTERNAL_MODELS_TIMEOUT_MS` | 30 seconds | Client-facing `/v1/models` passthrough |
| `MODEL_INVOCATION_TIMEOUT_MS` | 10 minutes | One generation request including retries |

MiB means $1024^2$ bytes. Byte limits are enforced while reading or accumulating, before an additional chunk would cross the limit. JSON character counts are not substitutes for UTF-8 byte counts.

## 3. Persistent state and safe output

### 3.1 Paths

| Path | Purpose |
|---|---|
| `~/.copilot-relay/config.json` | User configuration |
| `~/.copilot-relay/auth.json` | Authentication state |
| `~/.copilot-relay/server.pid` | Foreground server PID |

On Windows, `~` is `%USERPROFILE%`. On Unix-like systems, `auth.json` is written with mode `0600`. Windows relies on the user-profile ACL.

### 3.2 Config schema

```typescript
interface AppConfig {
  host: string;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  githubClientId: string;
  editorVersion: string;
  editorPluginVersion: string;
  copilotIntegrationId: string;
  userAgent: string;
}
```

Defaults remain those in `src/config.ts`; `host` defaults to `127.0.0.1`. Configuration accepts a non-empty host without whitespace or control characters. The remote-access acknowledgement is deliberately absent from `AppConfig` and cannot be persisted.

### 3.3 Auth schema

```typescript
type AuthFailureCode = 'access_token_rejected';

interface AuthState {
  accessToken: string;
  copilotToken?: string;
  copilotExpiresAt?: number;
  copilotApiBase?: string;
  invalid?: {
    code: AuthFailureCode;
    at: string;
  };
}
```

The old free-form `lastRefreshError` field is not written by v0.2. Loading an existing file may ignore it. A successful login or token exchange clears `invalid`.

`status` prints paths, non-secret config, whether login exists, whether auth is invalid, Copilot expiry, and API base. It never prints any token, token prefix, authorization form, raw failure, or auth object.

### 3.4 Typed diagnostics

Logger and client-error functions accept a local diagnostic code plus allowlisted scalar metadata only: phase, HTTP status, method, normalized path, model id, route, endpoint, request id, duration, cache age, generation, invocation count, retry/re-plan booleans, and allowlisted machine code. Compatibility diagnostics contain only sorted field names or a fixed context enum; they never include field values, discriminator values, or opaque payloads. Debug request-shape metadata is limited to message-role/content-kind/block-count summaries plus stream/tools counts. They do not accept arbitrary objects, headers, bodies, content values, tool values, or `Error` instances. An exceptional fallback replaces complete known current and superseded credentials, but ordinary paths never format secret-derived input.

A value treated as a preconstructed safe HTTP failure at the request boundary must have an integer status from `400` through `599`, one of the defined failure types, a non-empty message, and an optional string code. Any failure-shaped thrown value outside that closed runtime contract is replaced by the local generic 502 response rather than being reflected to the client.

Every admitted HTTP request receives a monotonically increasing process-local request id. Info level emits a terminal `request.completed`, `request.failed`, or `request.canceled` event with the allowlisted lifecycle fields; startup remains an info event. Warn level emits `translation.fields_ignored`, `translation.component_ignored`, or `translation.passthrough` for observable compatibility degradation. Debug level additionally emits `request.received` after bounded JSON parsing and `request.planned` after route selection. No log event contains prompt/system text, tool input/result values, image data, request or response bodies, raw headers, upstream bodies, raw errors, or credential-derived strings.

## 4. CLI and HTTP routes

CLI exit code `0` means success and `1` means failure. All output uses stdout.

| Command | Exact retained behavior |
|---|---|
| `login [--no-open]` | Run GitHub device-code login, optionally open the verification URL, exchange the access token, and persist auth |
| `logout` | Delete `auth.json`; missing file is success |
| `status` | Print only the safe fields in §3.3; always exit `0` |
| `start [--host H] [--port N] [--log-level L] [--allow-remote-access]` | Require login, validate the bind policy before listening, run in the foreground, own the PID file, and clean up on `SIGINT`/`SIGTERM` |
| `stop` | Signal the recorded PID; missing/stale PID is cleaned up and treated as success |
| `config-show` | Create defaults when absent and print path plus config JSON without interleaved logs |
| `configure claude [--port N]` | Merge `ANTHROPIC_BASE_URL`; preserve an existing `ANTHROPIC_AUTH_TOKEN`, otherwise write the dummy value; preserve peer settings |
| `configure codex [--port N] [--model MODEL]` | Select the `copilot-relay` provider and conservatively merge its native Responses settings into `~/.codex/config.toml`; preserve unrelated settings and the existing model unless explicitly overridden; atomically replace the file only after a complete temporary write |

Every CLI `--port` value must consist entirely of decimal digits and represent an integer from `1` through `65535`; signs, whitespace, fractions, suffixes, zero, and larger values fail argument parsing. The Codex merger supports ordinary root assignments and regular provider tables while preserving unrelated lines. It fails without changing the target when it encounters triple-quoted or multiline values, dotted keys in the managed `model_providers.copilot-relay` namespace, a managed array-of-table, or duplicate managed definitions. It does not claim to parse or repair arbitrary TOML.

The HTTP server exposes:

| Inbound route | Behavior |
|---|---|
| `GET /health` | `200 application/json`, `{"ok":true}` |
| `GET /v1/models` | Independent request-owned byte-for-byte upstream passthrough |
| `POST /v1/chat/completions` and `/chat/completions` | Existing Chat Completions passthrough |
| `POST /v1/responses` | Bounded thin passthrough to upstream `/responses` |
| `POST /v1/messages` | Capability-routed native, Chat, or Responses path |
| Other | `404` local OpenAI-shaped error |

Successful native `/v1/responses`, native `/v1/messages`, Chat Completions, and external `/v1/models` bodies and streams remain byte-for-byte passthrough. Non-2xx bodies are never byte-for-byte passthrough. The external models route neither reads nor publishes `ModelCatalog` state and may run concurrently with a separate internal refresh.

`127.0.0.0/8`, `::1`, its full IPv6 spelling, and `localhost` are loopback hosts. Every other host is remote for policy purposes, including wildcard addresses, interface addresses, and non-local DNS names. `startHttpServer` rejects a remote host before creating a listener unless its invocation receives `allowRemoteAccess: true`; the CLI supplies that value only from the current `--allow-remote-access` flag. A remote start emits a warning that the listener has no inbound authentication. Invalid configured hosts fall back to the default; an invalid explicit `--host` fails startup.

Native Messages passthrough forwards inbound `anthropic-version` (default `2023-06-01`) and optional `anthropic-beta`. Translated Chat and Responses calls do not forward Anthropic headers; they send Bearer authorization, JSON content type, configured Copilot client headers, `Copilot-Integration-Id`, `Openai-Intent: conversation-panel`, and `Accept: application/json` or `text/event-stream` according to `stream`.

### 4.1 Inbound POST body contract

Every admitted POST route applies the following checks before auth, catalog lookup, or model invocation. Errors use the route's protocol shape from §11.1.

| Condition | HTTP result |
|---|---|
| Missing `Content-Type`, or media type other than case-insensitive `application/json`; parameters such as `charset=utf-8` are allowed | `415 invalid_request_error` |
| Non-identity `Content-Encoding` | `415 invalid_request_error` |
| Numeric `Content-Length` greater than `REQUEST_BODY_MAX_BYTES` | `413 invalid_request_error` without reading the body |
| Chunked or fixed-length body crosses `REQUEST_BODY_MAX_BYTES` while reading | Stop reading, destroy/drain the request as required by Node, and return `413 invalid_request_error` when the downstream socket remains writable |
| Empty body, malformed UTF-8, JSON syntax error, or top-level JSON value other than an object | `400 invalid_request_error` |
| Request stream error before complete body receipt while the client remains connected | `400 invalid_request_error` |
| `req.aborted` or socket close before complete body receipt | Client cancellation: stop reading and write no response |

Parsing validates but does not reserialize passthrough bodies; successful native requests still forward the original bytes. A `Content-Length` mismatch that surfaces as an abort follows the client-cancellation row; no attempt is made to write to a closed socket.

## 5. Authentication and transport

### 5.1 Token exchange classification

The token exchange is `GET https://api.github.com/copilot_internal/v2/token` with `Authorization: token <accessToken>` and configured Copilot client headers.

| Outcome | Request result | Persistent auth mutation |
|---|---|---|
| 2xx with string `token`, numeric `expires_at`, and string `endpoints.api` | Publish new auth generation | Replace short-lived fields; clear `invalid` |
| HTTP 401 | Anthropic/OpenAI 401 | Set `invalid: {code:'access_token_rejected', at}` if source generation is current |
| Timeout, network error, 403, 408, 429, 5xx, or other non-2xx | 502 | None |
| 2xx malformed JSON or missing required fields | 502 | None |

Unknown outcomes are transient 502, never permanent credential rejection. No response message or body is persisted.

### 5.2 Auth Manager operation

The manager owns one immutable snapshot and monotonically increasing generation. For a source generation, at most one refresh operation exists. It owns its `AbortController`, 15-second deadline, promise, waiter set, and terminal state.

- A waiter has an independent cancellation promise. Canceling it removes only that waiter.
- The operation aborts when its deadline fires or its waiter count becomes zero.
- Completion, deadline, and last-waiter cancellation enter one synchronous terminal section.
- A result commits only when the operation is not canceled and its source generation is still current.
- A reactive 401 from generation $g$ uses a newer generation if one already exists; otherwise it starts or joins the refresh for $g$.
- Remaining token lifetime of at most 5 minutes triggers proactive refresh.

### 5.3 Invocation attempt coordinator

One generation request has `authRetryUsed`, `replanUsed`, auth generation, catalog generation, route, downstream-started state, and invocation count. Only calls to `/chat/completions`, `/v1/messages`, or `/responses` count as model invocations.

1. Execute the planned invocation.
2. Before downstream output, HTTP 401 may consume the single auth retry and invoke again with the refreshed/current generation.
3. Before downstream output, only HTTP 400 with parsed `error.code === "unsupported_api_for_model"` may consume the single re-plan: invalidate the catalog, require a newly published generation without stale fallback, resolve the same model id, and invoke the new exact plan.
4. Each reason is consumed at most once. The original plus both distinct retries yields at most three model invocations.
5. Plain 400, timeout, reset, premature EOF, malformed error body, 5xx, repeated reason, or any failure after downstream output is terminal.

Step 3 applies only to capability-routed Messages. Native Responses does not use the catalog or capability re-plan; `CopilotTransport` may apply only step 2 to that route.

Token exchanges, catalog refreshes, route planning, and external `/v1/models` calls do not consume this count. External `/v1/models` has only its own one-401 retry.

## 6. Live ModelCatalog and route planning

### 6.1 Snapshot validation

An internal refresh reads a bounded `/models` response and validates `data` as an array with at most 512 records. A candidate snapshot is published atomically only after every stored record has:

- a non-empty string `id` unique within the snapshot;
- `supported_endpoints` as an array of strings;
- `capabilities.supports` as an object when a requested feature needs it;
- `capabilities.limits` and the exact required numeric/nested fields when a requested limit needs them.

Records with a valid id but no `supported_endpoints` field are retained in a generation-scoped invalid-id set rather than the routable-record map; requesting one therefore follows the invalid-metadata 502 path, while an id absent from both collections is an unknown-model 400. A present but non-array `supported_endpoints`, a non-string endpoint element, or any other malformed stored field fails the complete candidate. Unrelated metadata may be retained but is never a capability signal. A failed candidate never replaces the current snapshot. Publication increments generation and clears all earlier negative results.

### 6.2 Lookup and refresh

- A snapshot is fresh for 5 minutes.
- Empty or expired cache starts or joins one manager-owned refresh.
- A model miss may reuse only `(modelId, currentGeneration)`. Otherwise one refresh is attempted and the resulting miss is recorded for that generation.
- Ordinary refresh failure may use an existing snapshot no older than 60 minutes. The safe log records only age and status.
- Refresh forced by verified endpoint rejection must publish a generation newer than the rejected snapshot; failure returns a 502 in the calling route's protocol shape without stale fallback.
- Without bounded-stale data, refresh failure returns a 502 in the calling route's protocol shape.
- The catalog manager uses the same independent-waiter, last-waiter abort, one-terminal-section, and generation-safe commit rules as the Auth Manager.

### 6.3 Route plan

For the exact requested model:

1. Exact `/v1/messages` produces `messages-passthrough`.
2. Otherwise exact `/chat/completions` produces `chat-translation`.
3. Otherwise exact `/responses` produces `responses-translation`.
4. Otherwise a well-formed model produces Anthropic 400 naming only the safe model id and advertised endpoint strings.
5. Missing/malformed required metadata produces Anthropic 502.

Feature support is the intersection of explicit metadata and this spec. Tools require `supports.tool_calls === true`; parallel calls require `supports.parallel_tool_calls === true`; streaming requires `supports.streaming === true`.

### 6.4 Native Responses route

Exact inbound `POST /v1/responses` requires a string `model` containing at least one non-whitespace character and invokes upstream `/responses` directly without trimming or otherwise changing that value. It does not read or mutate `ModelCatalog`; upstream determines whether the model exists and accepts that endpoint. Upstream 400 responses are terminal and are not capability-replanned.

The request uses the original admitted body bytes and query string. `Accept` is `text/event-stream` only for `stream === true`, otherwise `application/json`. A present non-boolean `stream` remains byte-preserved and upstream-owned rather than causing local schema rejection. Successful upstream bytes use OpenAI passthrough. Non-2xx bodies follow §11.1: read at most `ERROR_BODY_MAX_BYTES`, inspect only allowlisted machine fields, and return a locally constructed safe error.

## 7. Stateless Messages request mapping

The tables define the implemented baseline, not a closed input schema. Additive fields are omitted with a safe warning, target-shaped optional structures may pass through when no reinterpretation is needed, and unsupported optional content is skipped. Return Anthropic `400 invalid_request_error` when required target data is missing or invalid, no usable input remains, or tool association is ambiguous.

### 7.1 Top-level fields

| Anthropic field | Chat mapping | Responses mapping |
|---|---|---|
| `model` | Required non-empty string; copied exactly | Same |
| `messages` | Required non-empty array; map by §7.2 | Same |
| `max_tokens` | `max_completion_tokens` | `max_output_tokens` |
| `system` | Prepend one system message | `instructions` |
| `stream` | Boolean; copied; default `false` | Same |
| `tools` | Function tools by §7.3 | Flat function tools by §7.3 |
| `tool_choice` | Map by §7.3 | Map by §7.3 |
| `temperature`, `top_p` | Copy for upstream validation | Same |
| Other optional fields | Pass through only with a verified target shape; otherwise warn and omit | Same |

Every translated Responses request sets `store:false` and does not send `previous_response_id`. The relay does not send a reasoning control in the baseline.

### 7.2 Message content and tool history

| Anthropic input | Chat mapping | Responses mapping |
|---|---|---|
| User text | User message content | User `input_text` |
| Assistant text | Assistant message content | Assistant `output_text` |
| System-role text | System message in the same history position | System `input_text` in the same position |
| Assistant `tool_use` | Assistant `tool_calls[]` using the same id | `function_call` using the same `call_id` |
| User text `tool_result` | `role:'tool'` using the same `tool_call_id` | `function_call_output` using the same `call_id` |

String content and adjacent text blocks are joined without changing their text. `tool_use.input` is JSON-serialized and must be an object. A tool result preserves its text; `is_error` and cache hints are omitted without adding markers to the content.

The mapper scans the complete submitted history in order. Each non-empty tool id may identify one historical call and one matching result. A result must follow its call, and parallel calls remain distinct by id. Missing, duplicate, conflicting, or reused out-of-order ids; a result without a preceding call; invalid tool names; and non-object inputs fail before transport. The mapper never associates tools by name, text, or position alone.

For Responses, the reconstructed `function_call` is explicitly best-effort and is not represented as the original complete output sequence. Opaque reasoning items, encrypted content, item ids other than `call_id`, thinking blocks, and hosted-tool state are omitted. An upstream rejection caused by missing opaque state is terminal.

Images, documents, non-text tool results, thinking blocks, hosted tools, reasoning controls, `top_k`, non-empty `stop_sequences`, and other unimplemented features are outside the baseline. They are warned and omitted when usable baseline content remains; otherwise the request fails locally.

### 7.3 Function tools and tool choice

Each valid Anthropic client tool `{name, description?, input_schema}` maps to:

- Chat: `{type:'function', function:{name, description?, parameters:input_schema}}`;
- Responses: `{type:'function', name, description?, parameters:input_schema}`.

Malformed tool definitions are omitted with a warning unless doing so leaves a tool choice that cannot be satisfied.

| Anthropic `tool_choice.type` | Target `tool_choice` |
|---|---|
| absent or `auto` | `auto` |
| `any` | `required` |
| `tool` with a valid declared name | Target's named-function form |
| `none` | `none` |

`disable_parallel_tool_use:true` maps to `parallel_tool_calls:false` where supported. Invalid or unavailable optional controls warn and are omitted. Hosted and unknown tool types are not converted into client function tools.

## 8. Translated output boundary

Buffered and streaming output mappers expose only Anthropic text and standard client `tool_use` blocks. Chat `tool_calls[].id` and Responses `function_call.call_id` become the Anthropic tool id unchanged. Function arguments must be valid JSON objects; the mapper does not substitute `{}` for malformed arguments.

Usage and terminal reasons map only where the target response supplies a verified equivalent. Unknown optional content and opaque Responses items warn and remain client-invisible. Opaque items are not retained for a later request.

Each translation invocation is independent. The output mapper returns no continuation token, stage, registry handle, or persistence side effect.

## 9. Non-streaming translated output

The bounded target JSON must provide a non-empty response id, the requested model or its version-qualified `<requested-model>-YYYY-MM-DD` form, a successful or supported incomplete terminal state, and the output collection required by that protocol. The version-qualified form is accepted only as an upstream response identity; every request invocation and Anthropic response continues to use the exact requested model id.

For Chat, the mapper uses the primary choice and maps assistant text plus function `tool_calls`. For Responses, it maps assistant `output_text` and `function_call` items and ignores reasoning or opaque items with a safe warning. A function call requires a non-empty id (`tool_calls[].id` for Chat or `call_id` for Responses), non-empty name, and arguments that parse as a JSON object.

The Anthropic response uses the target response id, exact requested model, mapped content blocks, available token usage, and one of:

| Target terminal reason | Anthropic `stop_reason` |
|---|---|
| normal stop/completed | `end_turn` |
| function or tool calls | `tool_use` |
| token/output limit | `max_tokens` |
| content filter/refusal | `refusal` when representable, otherwise `end_turn` with a safe warning |

Missing required structure, an unrelated model identity, invalid function arguments, or a failed/canceled target response is an Anthropic 502. Unknown optional output remains client-invisible and is not retained.

## 10. Streaming translated output

### 10.1 SSE transport parser

The parser uses streaming UTF-8 decoding, accepts CRLF or LF, joins multiple `data:` lines with LF, ignores comments and unrelated transport fields, and enforces `SSE_FRAME_MAX_BYTES`. Malformed UTF-8 or JSON, an oversized frame, a conflicting event type, or EOF with an incomplete translated block is a 502 stream error.

Chat accepts its normal `data: [DONE]` terminator. Responses requires a valid terminal response event; an early `[DONE]` is an error.

### 10.2 Translation state

The translator emits one `message_start`, ordered content block events, one terminal `message_delta`, and one `message_stop` on success.

- Text deltas open one Anthropic text block and stream `text_delta` values.
- Chat function fragments are grouped by `tool_calls[].index`; the upstream id and name are retained and argument fragments become `input_json_delta`.
- Responses function fragments are grouped by output index; `call_id` becomes the Anthropic tool id and argument fragments become `input_json_delta`.
- A function block closes only after its complete arguments parse as a JSON object.
- Usage and terminal reason come from the target's terminal chunk or event when supplied; missing optional usage is represented as zero rather than inferred.
- Responses reasoning and opaque items emit no Anthropic content and are not retained.

The request-local state is bounded by `STREAM_TEXT_MAX_BYTES` and `TOOL_ARGUMENTS_MAX_BYTES` and is discarded at the end of the request. Conflicting indexes or ids, required deltas before a start, malformed final arguments, duplicate terminal state, and premature EOF are protocol failures. Unknown auxiliary events warn and continue only when all visible translated blocks can still close coherently.

Every downstream frame is `event: <type>\ndata: <single-line JSON>\n\n`. A mid-stream failure follows §11.3 and never emits a success terminator.

## 11. Errors, lifecycle, and backpressure

### 11.1 Client error shapes

OpenAI routes use `{error:{type,message,code}}`. Anthropic uses `{type:'error',error:{type,message}}`. Messages local validation/capability errors are 400 `invalid_request_error`; unavailable/malformed upstream metadata or protocol is 502 `api_error`; auth rejection is 401 `authentication_error`; upstream 429 is `rate_limit_error`.

Non-2xx bodies are read only to the 64-KiB bound and parsed only for allowlisted machine fields. Client messages are locally constructed. Upstream message text is never forwarded.

### 11.2 Request ownership

One request controller combines request abort, premature response close, and its route deadline. A normal inbound request-stream close after complete body receipt is not cancellation. Waiting for auth/catalog registers a waiter hook instead of passing this controller to shared work.

Success, typed failure, timeout, abort, and disconnect race through one request terminal state. Cleanup removes listeners/timers, cancels unfinished upstream response bodies before releasing their readers, and aborts unfinished request-owned work once. Client disconnect is silent.

Translated streaming awaits downstream `drain` whenever `write()` returns false before reading another upstream chunk. The wait observes already-fired and subsequent request abort or response close and removes all listeners on its first terminal event. It never buffers translated output behind backpressure.

### 11.3 Mid-stream failure

Anthropic writes exactly one `event:error` frame with a local safe error and closes without `message_delta` or `message_stop`. OpenAI passthrough writes one `data:{"error":...}\n\n` frame and closes without `[DONE]`. No path writes after socket closure or after a terminal success.

## 12. Compatibility evidence

Live Responses probes on 2026-08-24 established the behavior needed by the best-effort baseline:

- Responses-only models advertised exact `['/responses','ws:/responses']` endpoint values.
- Buffered and streaming text succeeded with `store:false` and no `previous_response_id`.
- Flat function definitions, function calls, argument deltas, and a following explicit `function_call_output` succeeded.
- Replaying a completed function-call item and its output succeeded without relay or upstream conversation storage.
- Terminal events supplied usage; initial stream usage could be null.
- Stream output and function calls were correlated by output index; opaque response and item ids were not stable across snapshots.
- Reasoning with `encrypted_content` was observed, but its universal necessity was not established. The stateless baseline intentionally omits it and accepts a visible upstream rejection when a model requires it.
- Calling `/responses` for a model advertising only `/chat/completions` returned HTTP 400 with `error.code:'unsupported_api_for_model'`; an undeclared `/v1/messages` call returned an ambiguous 400 without a machine code. Only the first exact status/code pair permits capability re-planning.

An authenticated Chat translation probe covering text and one complete tool round trip is required before release. No broader model or optional-feature matrix is required unless observed behavior differs.

## 13. Internal module contracts

```typescript
type MessagesRoutePlan =
  | { kind: 'messages-passthrough'; modelId: string }
  | { kind: 'chat-translation'; modelId: string; model: ModelRecord }
  | { kind: 'responses-translation'; modelId: string; model: ModelRecord }
  | { kind: 'client-error'; error: SafeFailure }
  | { kind: 'upstream-metadata-error'; error: SafeFailure };

interface ModelCatalog {
  resolve(modelId: string, waiter: AbortSignal): Promise<ModelRecord>;
  invalidate(generation: number): void;
}

interface CopilotTransport {
  invoke(plan: InvocationPlan, signal: AbortSignal): Promise<Response>;
  proxyModels(signal: AbortSignal): Promise<Response>;
}
```

Each target owns direct request, buffered-output, and streaming-output mappers. The streaming translator is request-local and exposes `push(chunk)`, `finish()`, and `abort()`; translated events are delivered through an async writer that resolves only after downstream acceptance/drain. Mapper functions have no persistence or cross-request lookup dependency.

The implementation files and ownership boundaries are those listed in `design.md` §2. Public signatures may be refined during implementation only when this section is updated in the same change.

## 14. Required tests

- Route tests cover native, Chat, Responses, unsupported, and malformed-metadata outcomes with exact model preservation.
- Each translated target has one representative request/response fixture and one complete tool-call and tool-result round trip proving exact id preservation.
- One streaming fixture splits an SSE frame and function arguments across transport chunks and covers one mid-stream failure.
- Representative malformed required ids and arguments fail before a misleading success can be produced.
- Existing HTTP boundary, auth, catalog, transport, native-route, lifecycle, and security tests remain authoritative where this migration does not change their behavior.
- Continuation registry and store tests are deleted with their implementation; no replacement persistence suite is required.
- Add tests only for a distinct public contract, an observed upstream variant, or a reproduced regression. Do not test private helper structure or build field-permutation matrices.
