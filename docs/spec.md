# copilot-relay — Specification (v0.2)

> Status: approved 2026-08-24; amended 2026-08-26; production implementation in progress. This document is the implementation contract for the approved [requirement.md](./requirement.md) and [design.md](./design.md). When they conflict, `requirement.md` wins.

## 1. Scope and invariants

v0.2 preserves the v0.1 CLI, OpenAI Chat Completions passthrough, native Anthropic Messages passthrough, models passthrough, device login, and loopback-only server. It adds inbound Anthropic Messages to Copilot HTTP `/responses` translation and native OpenAI Responses passthrough.

The following invariants are mandatory:

- The exact inbound model id is used for every model invocation and for catalog lookup on capability-routed requests. The relay never substitutes a model.
- When the relay makes a capability decision, live Copilot `/models` metadata is the only runtime authority. Captures such as `1.json` are fixtures only; native passthrough routes do not make capability decisions.
- Endpoint priority for `POST /v1/messages` is exact `/v1/messages`, then exact `/responses`. `ws:/responses` is not HTTP `/responses`.
- Every translated request is completely validated before the first model invocation.
- Translated Responses requests always set `store: false` and never send `previous_response_id`; native Responses requests preserve those client fields.
- No retry or re-plan occurs after the first downstream response byte.
- Raw upstream bodies, headers, errors, credentials, image data, and credential-derived substrings never reach logs, CLI output, persisted diagnostics, or client errors.
- Request fields, content variants, upstream items, and SSE events not admitted by this specification fail closed.

## 2. Fixed limits and deadlines

These are code constants, not v0.2 configuration fields.

| Constant | Value | Applies to |
|---|---:|---|
| `REQUEST_BODY_MAX_BYTES` | 8 MiB | Any inbound POST body |
| `NON_STREAM_RESPONSE_MAX_BYTES` | 8 MiB | Translated non-streaming `/responses` JSON |
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
| `CONTINUATION_TTL_MS` | 24 hours | Continuation group idle lifetime, renewed by successful lookup |
| `CONTINUATION_ABSOLUTE_TTL_MS` | 7 days | Maximum continuation group lifetime regardless of activity |
| `CONTINUATION_MAX_GROUPS` | 256 | Published groups per process |
| `CONTINUATION_GROUP_MAX_BYTES` | 2 MiB | Serialized items in one group |
| `CONTINUATION_TOTAL_MAX_BYTES` | 32 MiB | Serialized items across all groups |

MiB means $1024^2$ bytes. Byte limits are enforced while reading or accumulating, before an additional chunk would cross the limit. JSON character counts are not substitutes for UTF-8 byte counts.

## 3. Persistent state and safe output

### 3.1 Paths

| Path | Purpose |
|---|---|
| `~/.copilot-relay/config.json` | User configuration |
| `~/.copilot-relay/auth.json` | Authentication state |
| `~/.copilot-relay/server.pid` | Foreground server PID |

On Windows, `~` is `%USERPROFILE%`. On Unix-like systems, `auth.json` is written with mode `0600`; Windows relies on the user-profile ACL.

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

Logger and client-error functions accept a local diagnostic code plus allowlisted scalar metadata only: phase, HTTP status, method, normalized path, model id, route, endpoint, request id, duration, cache age, generation, invocation count, retry/re-plan booleans, and allowlisted machine code. Debug request-shape metadata is limited to message-role/content-kind/block-count summaries plus stream/tools counts. They do not accept arbitrary objects, headers, bodies, content values, tool values, or `Error` instances. An exceptional fallback replaces complete known current and superseded credentials, but ordinary paths never format secret-derived input.

Every admitted HTTP request receives a monotonically increasing process-local request id. Info level emits a terminal `request.completed`, `request.failed`, or `request.canceled` event with the allowlisted lifecycle fields; startup remains an info event. Debug level additionally emits `request.received` after bounded JSON parsing and `request.planned` after route selection. No log event contains prompt/system text, tool input/result values, image data, request or response bodies, raw headers, upstream bodies, raw errors, or credential-derived strings.

## 4. CLI and HTTP routes

CLI exit code `0` means success, `1` means failure, and `2` means unimplemented. All output uses stdout.

| Command | Exact retained behavior |
|---|---|
| `login [--no-open]` | Run GitHub device-code login, optionally open the verification URL, exchange the access token, and persist auth |
| `logout` | Delete `auth.json`; missing file is success |
| `status` | Print only the safe fields in §3.3; always exit `0` |
| `start [--host H] [--port N] [--log-level L] [--allow-remote-access]` | Require login, validate the bind policy before listening, run in the foreground, own the PID file, and clean up on `SIGINT`/`SIGTERM` |
| `stop` | Signal the recorded PID; missing/stale PID is cleaned up and treated as success |
| `config-show` | Create defaults when absent and print path plus config JSON without interleaved logs |
| `configure claude [--port N]` | Merge `ANTHROPIC_BASE_URL`; preserve an existing `ANTHROPIC_AUTH_TOKEN`, otherwise write the dummy value; preserve peer settings |
| `configure codex` | Print the unimplemented notice and exit `2` |

The HTTP server exposes:

| Inbound route | Behavior |
|---|---|
| `GET /health` | `200 application/json`, `{"ok":true}` |
| `GET /v1/models` | Independent request-owned byte-for-byte upstream passthrough |
| `POST /v1/chat/completions` and `/chat/completions` | Existing Chat Completions passthrough |
| `POST /v1/responses` | Bounded thin passthrough to upstream `/responses` |
| `POST /v1/messages` | Capability-routed native passthrough or Responses translation |
| Other | `404` local OpenAI-shaped error |

Successful native `/v1/responses`, native `/v1/messages`, Chat Completions, and external `/v1/models` bodies and streams remain byte-for-byte passthrough. Non-2xx bodies are never byte-for-byte passthrough. The external models route neither reads nor publishes `ModelCatalog` state and may run concurrently with a separate internal refresh.

`127.0.0.0/8`, `::1`, its full IPv6 spelling, and `localhost` are loopback hosts. Every other host is remote for policy purposes, including wildcard addresses, interface addresses, and non-local DNS names. `startHttpServer` rejects a remote host before creating a listener unless its invocation receives `allowRemoteAccess: true`; the CLI supplies that value only from the current `--allow-remote-access` flag. A remote start emits a warning that the listener has no inbound authentication. Invalid configured hosts fall back to the default; an invalid explicit `--host` fails startup.

Native Messages passthrough forwards inbound `anthropic-version` (default `2023-06-01`) and optional `anthropic-beta`. Translated and native `/responses` calls do not forward Anthropic headers; they send Bearer authorization, JSON content type, configured Copilot client headers, `Copilot-Integration-Id`, `Openai-Intent: conversation-panel`, and `Accept: application/json` or `text/event-stream` according to `stream`.

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
2. Otherwise exact `/responses` plus translator availability produces `responses-translation`.
3. Otherwise a well-formed model produces Anthropic 400 naming only the safe model id and advertised endpoint strings.
4. Missing/malformed required metadata produces Anthropic 502.

Feature support is the intersection of explicit metadata and this spec. Tools require `supports.tool_calls === true`; parallel calls require `supports.parallel_tool_calls === true`; streaming requires `supports.streaming === true`; images require `supports.vision === true` plus the vision limits in §7.4.

### 6.4 Native Responses route

Exact inbound `POST /v1/responses` requires a non-empty string `model` and invokes upstream `/responses` directly. It does not read or mutate `ModelCatalog`; upstream determines whether the model exists and accepts that endpoint. Upstream 400 responses are terminal and are not capability-replanned.

The request uses the original admitted body bytes and query string. `Accept` is `text/event-stream` only for `stream === true`, otherwise `application/json`. Successful upstream bytes use OpenAI passthrough. Non-2xx bodies follow §11.1: read at most `ERROR_BODY_MAX_BYTES`, inspect only allowlisted machine fields, and return a locally constructed safe error.

## 7. Closed Messages request mapping

Fields or variants absent from these tables are Anthropic `400 invalid_request_error` before transport.

### 7.1 Top-level fields

| Anthropic field | Responses mapping |
|---|---|
| `model` | Required non-empty string; copied exactly |
| `messages` | Required non-empty array; map by §7.2 |
| `max_tokens` | Required integer; `max_output_tokens`; must be at least 16 and no greater than metadata `limits.max_output_tokens` |
| `system` | String or text-block array joined with `\n\n`; `instructions` |
| `stream` | Boolean; copied; default `false` |
| `tools` | Absent or empty array means no tools; non-empty array maps by §7.3 and requires tool capability |
| `tool_choice` | Map by §7.3 |
| `temperature` | Absent or exactly `1`; explicit `1` maps to `temperature:1` |
| `top_p` | Absent or exactly `0.98`; explicit `0.98` maps to `top_p:0.98` |
| `top_k` | Rejected when present |
| `stop_sequences` | Absent or empty array; omitted upstream; non-empty rejected |
| `metadata` | Absent or exactly `{user_id:string}`; copy that object to Responses `metadata` |
| `output_config` | Absent or exactly `{effort:string}`; require the exact value in live `capabilities.supports.reasoning_effort`; map to Responses `reasoning:{effort}` |

Every Responses request also sets `store:false`. `previous_response_id` is never sent. Non-default sampling values are rejected because the selected live Copilot Responses contract rejected them during FR9. An absent `output_config` emits no `reasoning` field. A present `output_config` must contain exactly `effort`; `format`, extra keys, non-string values, and empty strings are rejected. If `reasoning_effort` is missing, not an array of strings, or otherwise malformed in live model metadata, return 502; if it is valid but omits the requested effort, return 400. Request-level reasoning effort does not permit Anthropic `thinking` or `redacted_thinking` content blocks.

### 7.2 Message content

| Anthropic input | Responses input |
|---|---|
| User string or `text` block | User `input_text`; a block may additionally carry exact `cache_control:{type:'ephemeral'}`, which is validated and omitted upstream |
| Assistant string or `text` block | Assistant `output_text`; the same exact ephemeral cache hint is validated and omitted upstream |
| System string or `text` block | System `input_text`, retained at the same message position; string content must be non-empty, while array content requires at least one text block; the same exact ephemeral cache hint is validated and omitted upstream |
| Assistant `tool_use` emitted by this relay | Resolve continuation; validate the historical input projection below; replay authoritative completed item, not client-provided `input`; the same exact ephemeral cache hint is validated and omitted upstream |
| User `tool_result` with string/text content | `function_call_output` using stored `call_id`; boolean `is_error` and the same exact ephemeral cache hint are validated and omitted upstream; output is concatenated text |
| User base64 `image` block | `input_image` with data URL, §7.4 |

System-role content must be either a non-empty string or a non-empty block array containing only text blocks. Empty strings, empty arrays, and every non-text block are rejected. Top-level `system` continues to map to Responses `instructions`, while a system-role message remains in its original input position. `tool_result.is_error` may be absent, `false`, or `true`; when present it must be boolean and is omitted upstream because Responses has no equivalent error flag, while the result text is preserved. The only accepted `cache_control` value is exactly `{type:'ephemeral'}` on a `text`, `tool_use`, or `tool_result` block; it is a documented lossy cache hint with no verified Responses equivalent. Extra cache-control keys, other types, and cache hints on other block variants are rejected. Tool results, tool uses, and plain text retain message/content order subject to replay grouping. PDF/document, thinking/redacted-thinking, image tool results, URL images, and unknown blocks are rejected.

The mapper scans the complete history in message and content-block order. A relay-issued assistant `tool_use` opens its resolved continuation group; parallel tool uses from the same response belong to that one group. The corresponding later user `tool_result` blocks close it. Once closed, that historical group no longer participates in validation of a later group, so one request may contain any number of ordered, closed groups such as `G1` followed by `G2`. At most one group may be open at a scan position, and no group may be reopened or appear out of order.

For each represented group, every tool id must resolve to that unexpired group, match the exact requested model and historical assistant block, occur once in the request, and have exactly one result for every function call in the group. The historical tool name must equal the authoritative name. Historical input keys must be a subset of the authoritative top-level keys; every retained value must be JSON-deep-equal, and every omitted authoritative value must be exactly `false`. Added keys, changed values, nested normalization, and omission of any other value fail before transport. This narrow projection accepts Claude Code's removal of explicit false defaults without treating client input as authoritative. The mapper inserts the group's original completed reasoning and function-call items once at its assistant position, then inserts the matching `function_call_output` items at the user result position. Missing results, a result before its tool use, mixed groups in one parallel call set, duplicated ids, cross-model references, or an unclosed group at end of history fail before transport with Anthropic 400.

### 7.3 Tools and tool choice

An absent or empty Anthropic tools array produces no Responses tool fields; `tool_choice` remains invalid without a non-empty tools array. Each entry of a non-empty array `{name, description?, input_schema}` maps to Responses `{type:'function', name, description?, parameters:input_schema}`. Names must be unique non-empty strings. Schemas are preserved as JSON values and bounded by the request limit.

| Anthropic `tool_choice.type` | Responses `tool_choice` |
|---|---|
| absent or `auto` | `auto` |
| `any` | `required` |
| `tool` with an existing `name` | `{type:'function', name}` |
| `none` | `none` |

`disable_parallel_tool_use:true` maps to `parallel_tool_calls:false`; `false` or absent maps to `true` only when live metadata declares parallel support, otherwise `false`. Tool choice without tools, unknown tool names, or parallel semantics unavailable to the model are rejected.

### 7.4 Base64 image

Exactly zero or one image is accepted, only in a user message with source `{type:'base64', media_type, data}`.

- `media_type` must appear in `capabilities.limits.vision.supported_media_types` and must not be `application/pdf`.
- `data` must be a non-empty canonical base64 string; whitespace, URL-safe alphabet, and padding errors are rejected without decoding the image.
- The decoded-size value is computed as $3\lfloor n/4\rfloor-p$, where $n$ is encoded length and $p$ is terminal padding count. It must not exceed `limits.vision.max_prompt_image_size`.
- `supports.vision` must be `true`; `limits.vision.max_prompt_images` must be numeric and at least 1.
- The upstream block is `{type:'input_image', image_url:'data:<media_type>;base64,<data>', detail:'auto'}`.

The relay does not fetch, decode, transcode, persist, or log image content. Any URL source is rejected locally.

## 8. Continuation registry

### 8.1 Data model

```typescript
interface CompletedContinuationItem {
  outputIndex: number;
  item: ResponsesFunctionCallItem | ResponsesReasoningItem;
}

interface ContinuationGroup {
  groupId: string;
  modelId: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  items: readonly CompletedContinuationItem[];
  calls: ReadonlyMap<string, { callId: string; outputIndex: number }>;
  byteSize: number;
}
```

Map keys are relay-generated cryptographically random Anthropic `tool_use.id` values. Group and tool ids are opaque and never derived from model text or tool names. Published groups are immutable and reusable until eviction. A successful lookup atomically updates `lastAccessedAt` and renews the idle deadline by `CONTINUATION_TTL_MS` without changing the group identity, capped by `absoluteExpiresAt`. Active conversations therefore survive ordinary pauses but cannot renew a group beyond `CONTINUATION_ABSOLUTE_TTL_MS`.

### 8.2 Staging and atomic publication

Each invocation owns an unpublished stage. A completed function-call item allocates its external tool id and adds both to the stage. A completed reasoning item, including observed `encrypted_content`, is retained exactly when present. Added/in-progress items and deltas are never authoritative continuation data.

`publish(stage)` runs synchronously without `await`:

1. Build a temporary live view and expiry-removal plan without mutating the registry.
2. Against that live view, reject duplicate ids or malformed/empty staged calls.
3. Compute the new group byte size from UTF-8 JSON serialization. If it exceeds `CONTINUATION_GROUP_MAX_BYTES`, throw without mutation.
4. In the temporary eviction plan, order live existing groups by `lastAccessedAt`, then `createdAt`, then `groupId`, and select the least recently used groups until adding the new group would satisfy both `CONTINUATION_MAX_GROUPS` and `CONTINUATION_TOTAL_MAX_BYTES`.
5. In one critical section, remove every expiry- or capacity-planned group and its id mappings, then insert the complete immutable group and all new id mappings. No observer may see an intermediate state. Any failure before this step leaves the registry unchanged.

For non-streaming output, publish occurs after complete validation and immediately before writing the Anthropic response. For streaming, it occurs after all tool blocks have been written and immediately before terminal `message_delta`. Failure or disconnect before publication discards the stage; disconnect after publication does not roll it back.

Group-count and total-byte pressure therefore evict old groups rather than reject the new one; only an oversized new group, malformed stage, or id collision causes publication failure. Restart loses all groups and unresolved results return 400. Because the client-visible tool id does not contain the opaque upstream call state, a Claude Code conversation with unresolved or retained tool history must be restarted after the relay process restarts.

### 8.3 Known restart limitation and future persistence contract

The current v0.2 registry is intentionally process-local. Its restart failure is observable because an Anthropic continuation request contains the relay-issued `tool_use.id` but not the complete Responses replay group. In particular, the upstream `call_id`, authoritative completed function-call item, and model-dependent reasoning or encrypted reasoning items cannot be reconstructed safely from the normalized Anthropic history. Unknown ids therefore remain a 400 rather than triggering heuristic reconstruction.

A future persistence implementation must preserve finite statelessness across relay process replacement without changing the wire mapping. It must satisfy all of the following before replacing the current process-local contract:

- persist only atomically published groups and atomically remove expired or evicted groups;
- use a versioned, authenticated, encrypted-at-rest format whose key is not embedded in the continuation data;
- retain the existing per-group, total-byte, group-count, model-match, and renewable idle-TTL bounds;
- validate schema, version, authentication, byte counts, ids, timestamps, and model association before inserting any recovered group into the live index;
- fail closed and delete or quarantine corrupted, incompatible, undecryptable, expired, or oversized records without logging their contents;
- never persist client message history beyond the authoritative Responses items and call metadata required for replay;
- define atomic replacement, crash recovery, file locking, logout cleanup, and concurrent-process ownership before implementation;
- prove with restart tests that an unexpired published tool continuation succeeds after process replacement and that expired or invalid state remains unavailable.

Until that contract is implemented, restart resilience is not an acceptance property of v0.2 and clients must begin a new conversation after relay restart when retained tool history is present.

## 9. Non-streaming Responses mapping

The bounded JSON must have matching `model`, a string response `id`, an output array, numeric non-negative `usage.input_tokens` and `usage.output_tokens`, and either:

- `status:'completed'`; or
- `status:'incomplete'` with `incomplete_details.reason:'max_output_tokens'` and no function-call output item.

Accepted output items are:

- `message` with assistant `content` containing only `output_text`; each becomes an Anthropic `text` block;
- `function_call` with string `call_id`, `name`, and JSON-object `arguments`; each becomes `tool_use` with the staged external id;
- `reasoning`, retained only for continuation and never emitted as Anthropic thinking.

Unknown types, mismatched model, malformed arguments, non-object arguments, failed/canceled status, missing usage, incomplete for another reason, or any incomplete response containing a function call are upstream protocol failures (502). An incomplete response never publishes continuation state or returns a successful Anthropic `tool_use` response.

The Anthropic Message is:

```json
{
  "id": "<upstream response id>",
  "type": "message",
  "role": "assistant",
  "model": "<exact requested model>",
  "content": [],
  "stop_reason": "end_turn | tool_use | max_tokens",
  "stop_sequence": null,
  "usage": {"input_tokens": 0, "output_tokens": 0}
}
```

Actual content and token counts replace placeholders. A completed response with function calls maps to `tool_use`; an admitted incomplete text-only response maps to `max_tokens`; otherwise completion maps to `end_turn`.

## 10. Streaming Responses mapping

### 10.1 SSE transport parser

The parser uses streaming UTF-8 decoding, accepts CRLF or LF, joins multiple `data:` lines with LF, ignores comment lines and the transport fields `id` and `retry`, and uses `event:` only to cross-check the JSON `type` when present. Malformed UTF-8, JSON, oversized frames, mismatched event type, or EOF with an incomplete frame is a 502 stream protocol error.

Copilot FR9 streams contained no `[DONE]`. `[DONE]` before a valid terminal event is an error; after a terminal event no more frame is accepted.

### 10.2 Event table

`response.created` is mandatory and first. Items must finish sequentially by `output_index`; any new item/delta while another item is unfinished is rejected.

| Responses event | Required action |
|---|---|
| `response.created` | Validate response id/model/status; emit `message_start` with empty content and zero usage |
| `response.in_progress` | Validate same response identity; emit nothing |
| `response.output_item.added` (`message`) | Open one provisional message item; emit nothing |
| `response.content_part.added` (`output_text`) | Emit text `content_block_start` with empty text |
| `response.output_text.delta` | Emit `content_block_delta` with `text_delta`; append reconstructed UTF-8 text up to `STREAM_TEXT_MAX_BYTES` |
| `response.output_text.done` | Validate reconstructed text; emit nothing |
| `response.content_part.done` | Validate part and emit `content_block_stop` |
| `response.output_item.added` (`function_call`) | Open provisional call, allocate tool id, emit `tool_use` `content_block_start` with empty input |
| `response.function_call_arguments.delta` | Emit `input_json_delta`; append bounded argument state |
| `response.function_call_arguments.done` | Validate reconstructed argument string; emit nothing |
| `response.output_item.done` | Validate complete item; stage only completed function-call or reasoning items; for function call emit `content_block_stop` |
| `response.output_item.added/done` (`reasoning`) | Emit nothing; only a completed item is staged, including `encrypted_content` when present |
| `response.completed` | Require every item done and terminal usage; atomically publish any staged tool group; emit terminal success by §10.3 |
| `response.incomplete` | Require every item done, reason `max_output_tokens`, usage, and no observed function call; discard any non-call stage and emit terminal success with `max_tokens`. If any function call was added or completed, emit a 502 stream error and no success terminator |
| `response.failed`, `error` | Emit one Anthropic error and close without success terminator |

Duplicate events, delta-before-add, conflicting `output_index`, missing or non-string ids, multiple open content parts, done-before-required-done, unknown item/event types, response model changes, text exceeding `STREAM_TEXT_MAX_BYTES`, or premature EOF are 502 protocol failures. Each response snapshot event must carry a non-empty response id, but the opaque id may rotate between snapshots as observed in FR9; the Anthropic message id remains the id from `response.created`. Item `id`/`item_id` values likewise may rotate and are validated only as non-empty strings; sequential `output_index` is the cross-event correlation key. If text crosses the limit after streaming has started, emit the single Anthropic mid-stream error from §11.3 and close without a success terminator.

### 10.3 Anthropic event bytes and usage

Every frame is `event: <type>\ndata: <single-line JSON>\n\n`.

`response.created.response.usage` was observed as `null`, so `message_start.message.usage` is the explicit placeholder:

```json
{"input_tokens":0,"output_tokens":0}
```

The terminal `response.completed` or `response.incomplete` supplies actual cumulative usage. Emit:

```json
{
  "type": "message_delta",
  "delta": {"stop_reason": "end_turn | tool_use | max_tokens", "stop_sequence": null},
  "usage": {"input_tokens": "<actual>", "output_tokens": "<actual>"}
}
```

Then emit `message_stop`. The current Anthropic schema permits cumulative `input_tokens` and `output_tokens` in terminal `message_delta.usage`; the relay does not invent an initial input-token count. Exactly one `message_start`, one terminal `message_delta`, and one `message_stop` are emitted on success.

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

## 12. FR9 compatibility record

Observed live on 2026-08-24 with the selected subscription. This record is evidence, not runtime configuration.

### 12.1 Model metadata

`gpt-5.6-luna` and `gpt-5.6-sol` advertised exact endpoints `['/responses','ws:/responses']`. Relevant metadata included:

- `supports.streaming`, `tool_calls`, `parallel_tool_calls`, and `vision`: `true`;
- `limits.max_output_tokens`: `128000`;
- `limits.vision.max_prompt_image_size`: `3145728`;
- `limits.vision.max_prompt_images`: `1`;
- supported image media types included JPEG, PNG, WebP, and GIF.
- `gpt-5.6-sol` advertised `supports.reasoning_effort` as `['none','low','medium','high','xhigh','max']`.

### 12.2 Accepted behavior

- Non-streaming and streaming text succeeded with `store:false`.
- On `gpt-5.6-sol`, non-streaming and streaming requests with `reasoning:{effort:'medium'}` succeeded. The non-streaming output contained `reasoning` followed by `message`; the stream used the already-supported `response.output_item.added/done` reasoning events and introduced no reasoning-summary delta event.
- `instructions` and assistant `output_text` history succeeded.
- Explicit default sampling `temperature:1` and `top_p:0.98` succeeded; tested non-default values were rejected.
- `max_output_tokens:15` was rejected; `16` was accepted and could return incomplete with reason `max_output_tokens`.
- Function choice, `none`, parallel calls, argument deltas, and stateless tool continuation succeeded.
- Continuation succeeded by replaying completed function-call items plus `function_call_output`, with no `previous_response_id` and no storage.
- A completed reasoning item with `encrypted_content` was observed nondeterministically under high reasoning. Full replay succeeded. Its universal necessity was not established; the relay preserves and replays it whenever observed.
- Multiple function-call items were observed completing sequentially by output index, not interleaving.
- A real PNG base64 data URL succeeded. External URL images returned `400 invalid_request_body` with a safe diagnostic that external image URLs are unsupported.
- Streaming `response.created.response.usage` was `null`; terminal `response.completed.response.usage` contained actual input, output, and total tokens.
- Opaque response ids differed across `response.created`, `response.in_progress`, and `response.completed` snapshots in a live stream; model identity remained stable. The relay therefore retains the created id for Anthropic output and validates later ids only as non-empty strings.
- Opaque item ids also differed between added, delta, and done events for one output item; sequential `output_index` remained stable. The relay correlates stream item state by output index and treats each opaque item id as independently validated metadata.
- Claude Code 2.1.39 removed top-level `dangerouslyDisableSandbox:false` and `run_in_background:false` from a Bash `tool_use` when echoing the executed call into the next Messages request. The emitted id, name, and remaining input were unchanged. Continuation validation therefore permits only omission of authoritative top-level `false` fields and still replays the stored completed item.
- The official Claude Code VS Code extension 2.1.233 bundled runtime sent `output_config:{effort:'medium'}` when configured with `effortLevel:'medium'`; it did not send a top-level `thinking` field in that probe. It also sent a `messages` entry with `role:'system'` containing one text block with the exact ephemeral cache hint. A live Responses probe preserving user-then-system input order and mapping both blocks to `input_text` completed with HTTP 200.
- In a 2.1.234 streamed Glob tool loop, the continuation request inserted an additional `role:'system'` message whose content was a non-empty 49-character string while retaining the original system text-block message later in history. The relay treats the string as opaque text, maps it in place to system `input_text`, and never logs its value.

Observed text stream order:

```text
response.created
response.in_progress
response.output_item.added(message)
response.content_part.added(output_text)
response.output_text.delta...
response.output_text.done
response.content_part.done
response.output_item.done(message)
response.completed
```

Observed tool stream order replaces the content-part/text events with `response.function_call_arguments.delta...`, `response.function_call_arguments.done`, and completed `response.output_item.done(function_call)` events. Completed item events, not added events, are authoritative continuation data.

### 12.3 Endpoint rejection signal

- Calling `/responses` with a model advertising only `/chat/completions` returned HTTP 400 with `error.code:'unsupported_api_for_model'`.
- Calling undeclared `/v1/messages` for the Responses-only model returned an ambiguous 400 without a machine code.

Therefore only the first exact status/code pair is replay-safe in v0.2.

## 13. Internal module contracts

```typescript
type MessagesRoutePlan =
  | { kind: 'messages-passthrough'; modelId: string }
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

interface ContinuationRegistry {
  createStage(modelId: string): ContinuationStage;
  resolve(toolUseIds: readonly string[], modelId: string): ContinuationGroup;
  publish(stage: ContinuationStage): ContinuationGroup;
  discard(stage: ContinuationStage): void;
}

function mapMessagesRequest(input: unknown, context: MappingContext): MappedRequest;
function mapResponsesResult(input: unknown, context: MappingContext): MappedMessage;
```

`SseTranslator` is request-local and exposes `push(chunk)`, `finish()`, and `abort()`; translated events are delivered through an async writer that resolves only after downstream acceptance/drain. Mapper functions are pure except for explicit continuation stage/lookup operations supplied through `MappingContext`.

The implementation files and ownership boundaries are those listed in `design.md` §2. Public signatures may be refined during implementation only when this section is updated in the same change.

## 14. Required tests

- Table tests cover every row and rejection in §7.
- HTTP boundary tests cover content type/encoding, declared and chunked body overflow, malformed UTF-8/JSON, non-object JSON, request read errors, and disconnect without a write attempt.
- Catalog tests cover schema/size/count bounds, negative results, stale use, generations, shared waiters, independent cancellation, deadline, and last-waiter races.
- Auth tests cover the classification table, proactive/reactive refresh, generation-safe commit, and safe persistence.
- Attempt tests cover both retry orders, repeated reasons, ambiguous failures, no retry after output, and the three-invocation ceiling.
- Continuation tests cover authoritative done items, reasoning preservation, atomic publication, oversized-group failure, deterministic count/byte eviction, immutable repeated lookup, multiple ordered history groups, complete parallel groups, expiry, mismatch, restart loss, and discard paths.
- Output tests reject non-streaming and streaming incomplete responses that contain any function call, and admit text-only `max_output_tokens` completion.
- SSE tests partition fixture bytes at every boundary, combine frames, split UTF-8 code points, enforce every transition in §10, reject interleaving and cumulative text overflow, verify backpressure, and assert exact terminal usage frames.
- Route tests prove external models passthrough isolation and successful native body/stream byte preservation.
- Native Responses route tests prove exact dispatch without catalog access, request/query and successful JSON/SSE byte preservation, safe non-2xx rewriting with no 400 retry, and no Messages translation or continuation access.
- Security tests inject sentinel credentials into every failure surface and assert that no complete credential or substring appears.
- SDK end-to-end tests verify translated non-streaming, streaming, tool continuation, max-token completion, and mid-stream errors with `@anthropic-ai/sdk`.
