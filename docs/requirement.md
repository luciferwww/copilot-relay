# copilot-relay — Requirements (v0.2)

> Status: approved 2026-08-21; amended 2026-08-26. v0.1 behavior remains supported unless this document explicitly changes it.

## 1. Background

A growing number of third-party AI agents (Claude Code, Codex CLI, in-house agents, and so on) use the OpenAI (`/v1/chat/completions`) or Anthropic (`/v1/messages`) HTTP APIs as their model-access protocol. To let these agents reuse the models behind a GitHub Copilot subscription, we need a local proxy that translates OpenAI / Anthropic requests to Copilot's upstream protocol and handles GitHub authentication plus short-lived Copilot token refresh.

Existing solutions leave a gap:

- GitHub does not officially provide a standalone Copilot model proxy for third-party agents.
- Extensions such as Copilot Chat bind this capability to the editor process, so CLIs and background services cannot use it directly.

This project provides a **standalone, VS Code-independent** local CLI proxy so any agent that speaks OpenAI or Anthropic APIs can use the user's own GitHub Copilot subscription. The focus is personal use. Implementation relies on the public GitHub Copilot HTTP protocol only.

v0.1 forwards each client protocol to the matching Copilot endpoint. This fails when a model is available only through another endpoint; for example, Claude Code sends Anthropic Messages requests while GPT-5.6 models advertise only the OpenAI Responses endpoint. v0.2 closes this gap with capability-based routing and a narrowly scoped Anthropic Messages to OpenAI Responses translation path.

## 2. Goals

- **G1.** Provide a local HTTP service exposing OpenAI-compatible (`/v1/chat/completions`, `/v1/responses`) and Anthropic-compatible (`/v1/messages`) APIs, backed by GitHub Copilot.
- **G2.** Run independently of VS Code: no dependency on the `vscode` module or the Copilot Chat extension. Pure Node.js CLI.
- **G3.** Support streaming responses (SSE).
- **G4.** Support the GitHub device-code login flow; own and auto-refresh the short-lived Copilot token.
- **G5.** Provide one-command configuration of Claude Code as the target client.
- **G6.** Let Anthropic Messages clients use models that expose only the OpenAI Responses endpoint, while preserving text, supported tool use, supported image input, streaming, usage, and completion semantics; incompatible request semantics fail explicitly.

## 3. Non-Goals

- **N1.** The project targets the GitHub Copilot backend only; no other providers.
- **N2.** No telemetry or usage reporting.
- **N3.** No automatic version check or auto-update.
- **N4.** No graphical UI.
- **N5.** No inbound authentication (API key / mTLS / etc.). Loopback isolation remains the default; a user who explicitly enables remote access accepts responsibility for protecting the exposed listener (see NFR7).
- **N6.** No general-purpose protocol conversion matrix. v0.2 does not translate Chat Completions to Messages, Chat Completions to Responses, or Responses client requests to another protocol.
- **N7.** No automatic model substitution. Endpoint routing may change the protocol used to invoke the requested model, but never changes the requested model id.
- **N8.** v0.2 does not translate PDF/document blocks, URL image sources, images embedded in tool results, more than one base64 image block per request, Anthropic extended-thinking blocks, prompt-caching semantics, `top_k`, or non-empty `stop_sequences`.

### 3.1 Continuation Recovery

The released v0.2 implementation holds Messages-to-Responses tool continuation state only in the relay process. Restarting that implementation discards the state, so a Claude Code session whose retained history contains relay-issued `tool_use.id` values may fail its next tool-result turn with an actionable 400 and must start a new conversation.

This limitation is caused by a protocol mismatch rather than by LLM generation itself. The later Anthropic request returns the relay-issued `tool_use.id`, but does not carry every opaque Responses value required for stateless replay, including the upstream `call_id`, authoritative completed function-call items, and model-dependent reasoning or encrypted reasoning items. The relay must not guess or reconstruct those values from tool names, normalized arguments, or message text.

The next persistence phase must provide finite statelessness at the process boundary: correctness for an unexpired published continuation must not depend on one Node.js process remaining alive. A versioned, bounded plaintext JSON store protected by the operating-system user boundary must sit behind `ContinuationRegistry` while preserving its mapper-facing semantics. Only complete atomically published replay groups may be durable; stages, arbitrary message history, response text, tool results, credentials, native Responses traffic, and model-catalog state must not be stored there.

The persistent registry must use a renewable 7-day idle TTL with no absolute lifetime, while retaining the existing per-group and aggregate byte limits, group-count limit, model matching, and deterministic least-recently-used eviction. A successful lookup renews the complete group; invalid or failed lookups do not. This covers relay restarts, ordinary overnight or weekend pauses, and long-running sessions that continue to reference their retained tool history. It does not guarantee recovery after more than 7 days without a successful lookup, after capacity pressure evicts a group early, or across multiple relay processes sharing one store.

The capacity limits remain fixed for this phase rather than becoming user-configurable. Capacity-driven LRU eviction must emit a safe warning containing only the trigger and aggregate count, byte, and age metadata; normal idle expiry must not warn. Recovery must finish before listening and expose only schema-valid, unexpired records. Malformed JSON, corruption, unknown versions, filename/content mismatch, id collision, invalid timestamps, expiry, and capacity excess must fail closed without logging record names, ids, or content. Unix-like systems must protect the continuation directory with mode `0700` and record and temporary files with mode `0600`; Windows relies on the user-profile ACL boundary. Persistent continuation state is independent of authentication state: replacing or removing the local account must preserve records so retained local sessions can resume after login. The newly authenticated account's model access and any upstream account binding remain authoritative and may reject replay. Only one relay process may own a data directory; multi-process and remote stores are not requirements for this phase.

## 4. User Stories

- **US1.** As a Copilot subscriber, I want Claude Code CLI to access Claude models through my Copilot subscription without buying a separate Anthropic API key.
- **US2.** As a developer, I want to start a local proxy and point any OpenAI-compatible SDK at `http://127.0.0.1:5000` to use Copilot models.
- **US3.** As an end user, I want the first-time login to use the device-code flow so I never paste tokens by hand.
- **US4.** I want the proxy to refresh the token automatically before it expires, without interrupting my requests.
- **US5.** I want `copilot-relay status` to quickly show the current auth state and token expiry.
- **US6.** As a Claude Code user, I want to select a Copilot model that supports `/responses` and use it without changing Claude Code's Anthropic API configuration.
- **US7.** As a user, I want unsupported content or model capabilities to fail explicitly instead of being silently dropped or routed to a different model.
- **US8.** As an OpenAI Responses client, I want to call a Copilot model through native `/v1/responses` without protocol translation.
- **US9.** As a Docker or virtual-machine user, I want to bind the relay to a non-loopback interface only when I explicitly acknowledge that the unauthenticated listener will be remotely reachable.

## 5. Functional Requirements

### FR1. CLI Commands

| Command | Required |
|---|---|
| `copilot-relay login` | ✅ |
| `copilot-relay logout` | ✅ |
| `copilot-relay status` | ✅ |
| `copilot-relay start [--host] [--port] [--log-level] [--allow-remote-access]` | ✅ |
| `copilot-relay stop` | ✅ |
| `copilot-relay config-show` | ✅ |
| `copilot-relay configure claude` | ✅ |
| `copilot-relay configure codex` | ⏳ v0.2 |

> Default listen port is `5000`, overridable with `--port`. The default listen address is `127.0.0.1`. A non-loopback `host` additionally requires `--allow-remote-access` on every start (see NFR7).

### FR2. HTTP Routes

| Route | Required |
|---|---|
| `POST /v1/chat/completions` (OpenAI; streaming supported) | ✅ |
| `POST /v1/responses` (OpenAI Responses; native passthrough; streaming supported) | ✅ |
| `POST /v1/messages` (Anthropic; streaming supported; capability-routed in v0.2) | ✅ |
| `GET /v1/models` (proxied from upstream) | ✅ |
| `GET /health` | ✅ |

### FR3. Authentication

- Use the GitHub OAuth **device-code** flow to obtain a long-lived access token.
- Use that access token against `GET https://api.github.com/copilot_internal/v2/token` to obtain a short-lived Copilot token (`expires_at` is typically 30 minutes).
- Refresh the Copilot token automatically when its remaining lifetime is ≤ 5 minutes.
- If the token exchange definitively reports that the long-lived access token is invalid or revoked, respond to the current request with 401, mark auth as invalid in `copilot-relay status`, and prompt the user to re-run `copilot-relay login`.
- If token refresh fails because of a timeout, network failure, upstream 5xx, malformed success payload, or another failure that does not establish invalid credentials, respond with `502`, preserve the prior authentication state without a permanent invalid marker, and do not prompt the user to re-run login. The exact token-exchange classification table belongs in `spec.md`.

### FR4. Persistence

- Config: `~/.copilot-relay/config.json`
- Auth state: `~/.copilot-relay/auth.json`. On Unix-like systems, `chmod 0600`. On Windows, no `icacls` call — the file relies on the `%USERPROFILE%` directory's own ACL.
- PID file: `~/.copilot-relay/server.pid`

### FR5. Error Mapping

Errors returned by upstream Copilot must be rewritten to match the client's protocol shape:

- OpenAI endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/models`) return
  `{ error: { type, message, code } }`.
- Anthropic endpoint (`/v1/messages`) returns
  `{ type: "error", error: { type, message } }`.

Pass the upstream HTTP status through where possible; when unclassifiable, use `502`.

**Handling upstream 401:** the Copilot token may be invalidated by upstream (rotation or revocation) before its local expiry threshold triggers a refresh. On an upstream 401, the proxy force-refreshes the Copilot token once and retries the original request; a second 401 is then rewritten per the shapes above and passed to the client, and the log hints at re-running `copilot-relay login`. Retry is allowed only before the first downstream response byte is written and only because the 401 establishes that authentication was rejected; if SSE forwarding has already begun, do not retry and terminate the stream per FR6.

**Handling token-refresh failure:** classify the token exchange independently from the request that triggered it. A definitive invalid-credential result maps to 401 and invalid auth state as specified in FR3. Transient transport/upstream failures and malformed successful responses map to `502` and must not convert a potentially valid login into a persistent authentication failure.

### FR6. Request Lifecycle

- Each client request owns and must abort its model invocation or external passthrough operation when the client disconnects or its request deadline expires, to avoid wasting Copilot quota.
- A shared authentication or model-catalog refresh is a control-plane operation owned by its manager rather than by any one client request. Client disconnect or request deadline cancels only that request's wait for the shared operation. The shared operation uses its own deadline and is aborted when its last waiter leaves; one waiter must not cancel work still needed by another.
- If the upstream errors mid-stream, terminate the response per the client protocol:
  - OpenAI: emit a `data: {"error": {...}}\n\n` chunk then close the stream. **Do not emit `data: [DONE]`** — SDKs treat `[DONE]` as normal completion and would swallow the error.
  - Anthropic: emit `event: error\ndata: {"type":"error","error":{...}}\n\n` then close the stream.
- The termination sequences above must produce observable errors in the `openai` and `@anthropic-ai/sdk` clients — the error must not be silently swallowed as a normal end-of-stream.

### FR7. Model Capability Discovery and Routing

For every inbound `POST /v1/messages` request, the relay must route the requested model according to the model metadata returned by Copilot's models endpoint:

1. Read the exact `model` id from the request. A missing or non-string model is an Anthropic `400 invalid_request_error`.
2. Resolve that id against a bounded in-memory cache populated only from the live Copilot models endpoint. Runtime model metadata must not be hard-coded or loaded from a bundled snapshot; captured responses may be used only as test fixtures.
3. If the model is absent and the current snapshot generation has no completed negative result for that exact model id, refresh metadata once. If it remains absent, record that result for `(modelId, snapshotGeneration)` and return an Anthropic `400 invalid_request_error` for an unknown model. A later lookup may reuse that result only while the same snapshot generation remains current.
4. If the model exists but `supported_endpoints` is missing, not an array of strings, or otherwise malformed, return an Anthropic `502 api_error` identifying invalid upstream capability metadata. Do not guess or probe an endpoint as part of the client request.
5. If the model advertises `/v1/messages`, pass the request through to the upstream `/v1/messages` endpoint unchanged, preserving v0.1 behavior.
6. Otherwise, if the model advertises `/responses` and the relay has the required Messages-to-Responses translator, translate the request to OpenAI Responses, send it to the upstream `/responses` endpoint, and translate the response back to Anthropic Messages.
7. Otherwise, return an Anthropic `400 invalid_request_error` that names the model and its advertised endpoints. An advertised WebSocket endpoint such as `ws:/responses` does not imply support for HTTP `/responses`.

The first lookup loads metadata from Copilot. Concurrent requests must share an in-progress refresh under the control-plane lifecycle in FR6. An ordinary refresh failure may use bounded-stale cached metadata and must record that stale data was used without logging credentials; without cached metadata, the request fails with an Anthropic `502 api_error`. A refresh forced by verified endpoint rejection must publish a new generation and must not reuse the rejected generation as stale data. Publishing a new snapshot generation invalidates all negative results from earlier generations. Detailed cache duration, maximum staleness, generation, synchronization, waiter cancellation, last-waiter abort, and operation-deadline contracts belong in `spec.md`.

Routing must never replace the requested model id. In v0.2, only HTTP 400 with machine-readable code `unsupported_api_for_model` is verified to mean endpoint rejection before model execution; that exact pair may invalidate the metadata cache and retry capability resolution once. A 400 without that code, timeout, connection reset, premature EOF, and any 5xx response must not trigger replay. Re-planning must not cause an unbounded retry or silent model fallback.

Feature preflight must also use the selected model's live metadata. A feature is available only when its corresponding `capabilities.supports` value explicitly declares support and the relay implements the required translation. Applicable limits, including token and vision limits, come from `capabilities.limits`; absent or malformed limits required to validate a requested feature cause an explicit error rather than a guessed default. Fields such as `model_picker_enabled`, `preview`, model family, and vendor must not be used to infer protocol or feature support.

### FR8. Anthropic Messages to OpenAI Responses Translation

The `/responses` translation path must support both streaming and non-streaming requests and responses. v0.2 must translate:

- top-level system instructions;
- user and assistant text content, including multi-turn history;
- tool definitions, supported tool-choice modes, and the inverse mapping of `disable_parallel_tool_use` to Responses `parallel_tool_calls`;
- Anthropic `tool_use` and text-only `tool_result` content blocks, including error results;
- text and tool-call output from Responses;
- maximum output tokens and sampling controls only where the verified Copilot Responses contract has an equivalent;
- request-level reasoning effort when the selected live model advertises that exact effort and the verified Copilot Responses contract has an equivalent;
- input/output token usage and completion stop reasons;
- upstream HTTP errors and mid-stream errors into Anthropic error shapes;
- one user-message base64 image block when its locally verifiable properties comply with the selected model's advertised vision capability.

The supported image source is base64 data only. The relay validates the declared media type, encoding, encoded-size bound, single-image count, and selected model's advertised vision capability before the upstream call; it does not decode or transcode the image. It wraps the declared media type and base64 payload as a Responses `input_image.image_url` data URL. Anthropic URL image sources fail before the upstream call with an actionable 400 because the verified Copilot Responses endpoint rejects external image URLs.

For streaming responses, the relay must incrementally convert Responses SSE events into a valid Anthropic event sequence, including `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, and `message_stop`. Tool argument fragments may span arbitrary transport chunks and must remain valid after reassembly.

The translator must validate the complete inbound request before starting the upstream request. Any unsupported Anthropic content block or semantic feature, including the exclusions in N8, returns an actionable Anthropic `400 invalid_request_error`. Unsupported fields must not be silently discarded.

The field and content-block mapping is closed: `spec.md` must classify every accepted Anthropic Messages request field and content block as exact mapping, documented transformation, or explicit rejection. Fields or variants absent from that matrix are rejected. In particular, the public Responses Create contract has no direct equivalent for Anthropic `top_k` or non-empty `stop_sequences`, so v0.2 rejects those values. The Anthropic error flag on `tool_result` is accepted only as a boolean and consumed as a documented lossy transformation while its text content maps to Responses `function_call_output`. Base64 image sources are supported through a Responses `input_image` data URL subject to the validation above; URL image sources are explicitly rejected.

The closed matrix includes the request envelopes emitted by Claude Code CLI 2.1.39 and the official Claude Code VS Code extension 2.1.233 through 2.1.234. Top-level `metadata` is accepted only as `{user_id:string}` and maps to Responses `metadata`; `tools:[]` is equivalent to omitting tools; and `text`, `tool_use`, and `tool_result` blocks may carry exactly `cache_control:{type:'ephemeral'}`. The cache hint is a documented lossy transformation and is not sent upstream because the verified Responses contract has no equivalent. A `messages` entry with `role:'system'` is accepted with either a non-empty string or one or more text blocks and maps in place to a Responses system `input_text` message; it is not merged into top-level instructions. Top-level `output_config` is accepted only as `{effort:string}`; the exact effort must appear in the selected live model's `capabilities.supports.reasoning_effort` array and maps to Responses `reasoning:{effort}`. This request control does not enable Anthropic thinking content blocks, which remain excluded by N8. Empty system content, other message roles, metadata keys, metadata values, output-config fields, cache-control variants or placements, and unsupported fields remain explicit 400 errors.

Tool-use continuation must preserve the identity and opaque upstream context required to associate an emitted Anthropic `tool_use` block with a later `tool_result`. The relay may retain only the minimum continuation state required by the verified Copilot Responses contract, in a bounded in-memory index backed by versioned per-group records for cross-process recovery. A historical `tool_use` must retain the emitted id and name and must not add or change input fields; it may omit only top-level input fields whose authoritative value is exactly `false`, because Claude Code removes such explicit defaults after tool execution. The relay still replays its stored authoritative item and never reconstructs continuation state from the client-normalized input. Missing, expired, ambiguous, or otherwise inconsistent continuation state must fail explicitly before the upstream call; it must never be guessed from tool names, message text, or model ids.

The released v0.2 implementation was process-local. Persistence replaces only that lifecycle limit; the minimal-state, authoritative-replay, and fail-closed mapping properties remain unchanged as defined in §3.1. Login, account replacement, and logout do not delete or mutate continuation records.

### FR9. Upstream Responses Compatibility Gate

Before v0.2 implementation is considered complete, the Copilot `/responses` endpoint must be verified with the selected subscription using probes for non-streaming text, streaming text, request-level reasoning effort, streaming tool use, the following tool-result continuation turn, and base64 image input. The compatibility record must also preserve the observed rejection of external URL images. The probes must establish the accepted request-field names; observed completion, usage, tool-call, and error shapes; which exact endpoint-availability statuses or machine-readable codes guarantee rejection before model execution; and whether continuation requires response ids, function-call ids, completed output items, reasoning items or encrypted reasoning content, `previous_response_id`, `store`, or other opaque upstream state. For streaming output, state captured from an added/in-progress event must not be assumed complete unless the probe demonstrates it; completed item events must be tested separately. The observed payload and event shapes must be recorded in `spec.md`; implementation must follow observed Copilot behavior when it differs from the public OpenAI Responses shape. Public OpenAI documentation is a baseline, not evidence that Copilot accepts an unprobed field or event variant.

### FR10. Native OpenAI Responses Passthrough

Exact inbound `POST /v1/responses` is a bounded thin passthrough to upstream `/responses`. It requires a non-empty model id but does not consult `ModelCatalog`: the client has already selected the protocol and endpoint, so upstream remains authoritative for whether that model accepts `/responses`. Successful request and response bodies are passed through without protocol translation or participation in Messages continuation state. Non-2xx upstream bodies are bounded and safely rewritten rather than forwarded.

`CopilotTransport` owns the single pre-output 401 auth retry. Native Responses never performs capability re-planning, switches model or endpoint, or retries an upstream 400.

## 6. Non-Functional Requirements

- **NFR1 — Platform:** Windows / macOS / Linux fully supported, Node.js ≥ 18 (for native `fetch`).
- **NFR2 — Dependencies:** Keep runtime dependencies minimal (currently `commander`, `open`). The authoritative list is the `dependencies` field of `package.json`.
- **NFR3 — Startup latency:** No specific threshold is defined. Egregious regressions block release; otherwise treated case-by-case.
- **NFR4 — Proxy overhead and resource bounds:** Passthrough routes must not buffer streaming responses. Translation routes must process SSE incrementally and must not buffer the complete response or complete event stream. Buffering one incomplete SSE frame, one partial tool-argument value, bounded continuation state, and bounded parser state is allowed. Request bodies, non-streaming responses, SSE frames, tool arguments, model metadata, error bodies, and continuation entries must have explicit limits and timeout/expiry behavior in `spec.md`. Streaming writes must respect downstream backpressure. No specific time-to-first-byte threshold is defined.
- **NFR5 — Security & logging:** `auth.json` has restrictive permissions. Access tokens, Copilot tokens, authorization headers, every token substring, prompt text, system text, tool input/result values, image data, raw request/response bodies, and raw errors must never appear in logs, CLI output, or client-facing errors at any log level. Authentication status may expose only non-secret state and expiry metadata. Default info logs record an allowlisted request lifecycle summary including request id, method/path, model id when available, route/endpoint, status, duration, and failure phase. Debug logs may additionally record only structural counts and enums such as message roles/content kinds/block counts, stream/tools counts, and retry/re-plan state. Logs go to stdout only — no file, no rotation.
- **NFR6 — Portability:** 100% TypeScript. A single `tsc` build produces artifacts runnable via `node dist/cli.js`; no loader or bundler is used.
- **NFR7 — Bind address:** Listen on `127.0.0.1` by default. `host` may be set in `config.json` or with `--host` for Docker, virtual-machine, and similar networking. Starting with any non-loopback host, including `0.0.0.0` or `::`, must fail unless that same invocation includes `--allow-remote-access`. The acknowledgement is CLI-only, is never persisted, and must be supplied on every remote start because the listener has no inbound authentication.

## 7. Constraints and Assumptions

- **A1.** The Copilot HTTP protocol (`api.githubcopilot.com`) request-header format is assumed stable within the project's development window. If upstream changes, header values (`Editor-Version`, etc.) are configurable and require no code changes.
- **A2.** The default `githubClientId` uses the widely-used public value found in existing community open-source Copilot clients. Users can substitute their own OAuth App id.
- **A3.** When the relay makes a routing or translated-feature decision, the live Copilot models response is the sole runtime source of truth for model existence, endpoint routing, declared feature support, and advertised limits. Effective support is the intersection of that metadata and relay functionality. Missing or malformed required metadata is handled as specified in FR7; no model-name, family, vendor, preview-state, or bundled-snapshot inference is allowed. Native passthrough routes leave endpoint acceptance to upstream.
- **A4.** Copilot's `/responses` payload and SSE shapes are expected to be sufficiently compatible with the public OpenAI Responses API to support the mapping in FR8. FR9 must verify this assumption before implementation is accepted.
- **C1.** Users must comply with the GitHub Copilot subscription terms. Tokens must not be shared, and the project must not be used for unauthorized commercial resale. NFR7's loopback default and per-start remote-access acknowledgement reduce accidental exposure, but a user who enables remote access remains responsible for network isolation and overall compliance.

## 8. Acceptance Criteria

- **AC1.** `npm install && npm run build && node dist/cli.js --help` lists all commands.
- **AC2.** `node dist/cli.js login` guides the user through the device-code login and persists `auth.json`.
- **AC3.** After `node dist/cli.js start`, `curl http://127.0.0.1:<default-port>/health` returns `{"ok":true}`.
- **AC4.** Given an `id` from the `/v1/models` response (denoted `<model-id>` below):
  ```
  curl -N -H 'Content-Type: application/json' \
    -d '{"model":"<model-id>","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
    http://127.0.0.1:<default-port>/v1/chat/completions
  ```
  produces a streamed SSE response, chunk by chunk.
- **AC5.** After manually setting `copilotExpiresAt` in `auth.json` to a past epoch second, the next non-streaming request to `/v1/chat/completions` must auto-refresh the Copilot token and return 200 — not 401.
- **AC6.** After manually replacing `copilotToken` in `auth.json` with a value the upstream will reject (while `copilotExpiresAt` is still in the future), the next request to `/v1/chat/completions` must trigger the reactive refresh in FR5 (force-refresh once, retry) and ultimately return 200 — not 401 or 5xx.
- **AC7.** Given a model that advertises `/responses` but not `/v1/messages`, a non-streaming Anthropic text request to `/v1/messages` returns a valid Anthropic Message response from that same model.
- **AC8.** Given the same model and `stream: true`, the client receives a valid ordered Anthropic SSE sequence incrementally; the relay does not wait for the complete upstream response before emitting the first content event.
- **AC9.** Claude Code CLI 2.1.39 and the official Claude Code VS Code extension 2.1.233 through 2.1.234 complete their supported request envelopes end to end. Standard metadata, ephemeral cache hints, VS Code system-text messages in block-array or non-empty-string form, and VS Code `output_config:{effort}` are validated and mapped as specified. Tool definitions and supported tool-choice controls reach the model, the model's tool call becomes an Anthropic `tool_use` block, and a following Anthropic `tool_result`, including one with `is_error:true`, is associated with the exact upstream call and translated back with every continuation item required by the verified Copilot contract. The same flow works for streaming tool calls whose authoritative continuation state arrives only in completed item events. Missing, expired, or mismatched continuation state fails before the upstream call with an actionable Anthropic 400 error.
- **AC10.** One supported base64 user-message image reaches a vision-capable `/responses` model and produces a valid Anthropic response. A URL image source, more than one image, an unsupported declared base64 media type or encoding, an oversized base64 payload, or a non-vision model fails before the upstream call with an actionable Anthropic 400 error. The relay does not fetch, decode, transcode, persist, or log image content.
- **AC11.** A model that advertises `/v1/messages` continues to use passthrough behavior, byte-for-byte for successful response bodies and streams.
- **AC12.** Unknown models, models without a supported HTTP route or translator, fields absent from the closed mapping matrix, and excluded features return Anthropic 400 errors; malformed or incomplete required model metadata and unavailable metadata without a cache return Anthropic 502 errors. No request silently changes the model id, drops unsupported content, approximates unsupported semantics, or treats `ws:/responses` as HTTP `/responses`. The intentionally discarded accepted hints are the exact ephemeral `cache_control` shape and boolean `tool_result.is_error` flag documented by FR8. Tests specifically cover non-empty `stop_sequences`, `top_k`, unsupported metadata/cache-control variants, and `tool_result.is_error: true`.
- **AC13.** Unit tests cover request mapping, VS Code system-text message validation, request-level reasoning-effort validation against live model metadata, non-streaming response mapping, local URL-image rejection and base64-image validation, supported tool-choice and parallel-tool controls, continuation identity and expiry, completed reasoning/output-item capture, SSE frames split across arbitrary transport chunks, multiple frames in one chunk, tool-argument deltas, malformed upstream events, bounded buffers and metadata, downstream backpressure, abort/error/timeout races, external `/v1/models` passthrough isolation from catalog refresh, model lookup refresh, generation-scoped negative results, shared concurrent refresh with per-waiter cancellation, independent control-plane deadlines, last-waiter abort, bounded-stale cache use, the exact `400` plus `unsupported_api_for_model` pre-execution re-plan signal, rejection of ambiguous replay, missing or malformed `supported_endpoints`, missing required feature limits, token-refresh failure classification, and the intersection of model-declared and relay-implemented capabilities.
- **AC14.** Automated tests use sentinel credentials and verify that no complete credential or credential substring appears in `status` output, persisted diagnostic state, logs at any level, HTTP errors, or thrown-error messages.
- **AC15.** With the default info level, each HTTP request produces a correlated terminal log containing only the allowlisted lifecycle fields from NFR5. Debug mode additionally exposes enough structural metadata to distinguish message-role/content-shape failures without logging any content value. Tests cover success, local validation failure, upstream failure, and credential/content sentinels.
- **AC16.** Native `POST /v1/responses` preserves the admitted request bytes, query string, and successful JSON/SSE response bytes; invokes upstream `/responses` without catalog access or capability re-planning; returns the FR10 OpenAI errors; safely rewrites non-2xx upstream bodies; and never enters Messages translation or continuation handling.
- **AC17.** `start` binds to `127.0.0.1` by default. A loopback `--host` starts without acknowledgement; a non-loopback host from either `config.json` or `--host` fails before listening unless the same command includes `--allow-remote-access`. The acknowledgement is not a config field and is not persisted.
- **AC18.** After a translated response atomically publishes an unexpired tool continuation, stopping the first relay and starting a new relay with the same data directory allows the original tool id and model to resolve and replay exactly. Unpublished, expired, evicted, malformed, unknown-version, filename-mismatched, colliding, or cross-model state remains unavailable before upstream execution. Tests also prove user-only permissions where supported; that record content, record names, continuation ids, model ids, tool input, reasoning content, and credentials never appear in logs, CLI output, or client errors; and that account-changing login and logout preserve all unexpired, unevicted continuation state for a later authenticated replay attempt.
