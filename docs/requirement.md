# copilot-relay — Requirements (v0.2)

> Status: approved 2026-08-21; amended 2026-09-15. v0.1 behavior remains supported unless this document explicitly changes it.

> Decision record: [Stateless Messages Translation](./stateless-messages-translation-decision.md) replaces translated-Messages continuation persistence with direct tool-id preservation and request-local translation state.

> Cross-cutting requirement: [Protocol Compatibility](./protocol-compatibility-principle.md) defines the mandatory map, passthrough, warn-and-omit, and reject decision order for every protocol boundary.

## 1. Background

A growing number of third-party AI agents (Claude Code, Codex CLI, in-house agents, and so on) use the OpenAI (`/v1/chat/completions`) or Anthropic (`/v1/messages`) HTTP APIs as their model-access protocol. To let these agents reuse the models behind a GitHub Copilot subscription, we need a local proxy that translates OpenAI / Anthropic requests to Copilot's upstream protocol and handles GitHub authentication plus short-lived Copilot token refresh.

Existing solutions leave a gap:

- GitHub does not officially provide a standalone Copilot model proxy for third-party agents.
- Extensions such as Copilot Chat bind this capability to the editor process, so CLIs and background services cannot use it directly.

This project provides a **standalone, VS Code-independent** local CLI proxy so any agent that speaks OpenAI or Anthropic APIs can use the user's own GitHub Copilot subscription. The focus is personal use. Implementation relies on the public GitHub Copilot HTTP protocol only.

v0.1 forwards each client protocol to the matching Copilot endpoint. This fails when a model is available only through another endpoint; for example, Claude Code sends Anthropic Messages requests while a selected model may advertise only an OpenAI endpoint. The current design closes this gap with capability-based routing and stateless Anthropic Messages translation, preferring Chat Completions and retaining a deterministic best-effort Responses path for Responses-only models.

## 2. Goals

- **G1.** Provide a local HTTP service exposing OpenAI-compatible (`/v1/chat/completions`, `/v1/responses`) and Anthropic-compatible (`/v1/messages`) APIs, backed by GitHub Copilot.
- **G2.** Run independently of VS Code: no dependency on the `vscode` module or the Copilot Chat extension. Pure Node.js CLI.
- **G3.** Support streaming responses (SSE).
- **G4.** Support the GitHub device-code login flow; own and auto-refresh the short-lived Copilot token.
- **G5.** Provide one-command configuration of Claude Code as the target client.
- **G6.** Let Anthropic Messages clients use models that expose an implemented OpenAI endpoint without relay-owned cross-request state, while preserving text and standard client function-tool associations; incompatible request semantics fail explicitly.

## 3. Non-Goals

- **N1.** The project targets the GitHub Copilot backend only; no other providers.
- **N2.** No telemetry or usage reporting.
- **N3.** No automatic version check or auto-update.
- **N4.** No graphical UI.
- **N5.** No inbound authentication (API key / mTLS / etc.). Loopback isolation remains the default; a user who explicitly enables remote access accepts responsibility for protecting the exposed listener (see NFR7).
- **N6.** No general-purpose protocol conversion matrix. Only inbound Anthropic Messages may be translated to Chat Completions or Responses; Chat and Responses client requests are not translated to another protocol.
- **N7.** No automatic model substitution. Endpoint routing may change the protocol used to invoke the requested model, but never changes the requested model id.
- **N8.** The stateless baseline does not translate opaque reasoning state, Anthropic thinking or redacted-thinking blocks, hosted/server-tool state, PDF/document blocks, images embedded in tool results, prompt-caching semantics, `top_k`, or non-empty `stop_sequences`.

### 3.1 Stateless Translation Boundary

Translated Messages requests must not depend on state retained from an earlier HTTP request. The relay preserves client-visible function-call ids directly across Anthropic, Chat Completions, and Responses representations. It does not allocate relay-owned tool ids, persist translated conversation items, or require a continuation data directory.

Chat Completions is the preferred translated target because standard function-call identity is fully represented by `tool_calls[].id` and `tool_call_id` in ordinary message history. For a Responses-only model, the relay may reconstruct a standard `function_call` and `function_call_output` from the Anthropic history using the preserved `call_id`. This path is intentionally best-effort: opaque reasoning items, encrypted content, target-specific item ids, and hosted-tool state that have no Anthropic carrier are omitted rather than stored or fabricated.

If an upstream Responses model requires omitted opaque state for a later tool-result turn, the upstream rejection is terminal and is rewritten into an actionable Anthropic error. The relay must not reintroduce local persistence, switch models, guess an association, or silently retry another endpoint after an ambiguous failure.

Request-local SSE framing and tool-argument assembly are allowed within existing byte and time limits. That state is destroyed when the request completes, fails, times out, or disconnects.

## 4. User Stories

- **US1.** As a Copilot subscriber, I want Claude Code CLI to access Claude models through my Copilot subscription without buying a separate Anthropic API key.
- **US2.** As a developer, I want to start a local proxy and point any OpenAI-compatible SDK at `http://127.0.0.1:5000` to use Copilot models.
- **US3.** As an end user, I want the first-time login to use the device-code flow so I never paste tokens by hand.
- **US4.** I want the proxy to refresh the token automatically before it expires, without interrupting my requests.
- **US5.** I want `copilot-relay status` to quickly show the current auth state and token expiry.
- **US6.** As a Claude Code user, I want to select a Copilot model with an implemented native or OpenAI endpoint and use it without changing Claude Code's Anthropic API configuration or depending on relay continuation files.
- **US7.** As a user, I want additive protocol changes to degrade visibly and continue whenever possible, without silently changing the requested model or inventing required semantics.
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
| `copilot-relay configure codex [--port] [--model]` | ✅ |

> Default listen port is `5000`, overridable with `--port`. The default listen address is `127.0.0.1`. A non-loopback `host` additionally requires `--allow-remote-access` on every start (see NFR7).

Every CLI port argument must be a complete decimal integer from `1` through `65535`. `configure codex` must preserve unrelated settings and an existing model unless explicitly overridden, reject known-dangerous unsupported TOML before writing, and replace the target only after a complete same-directory temporary write. A rejected merge or failed replacement must leave the existing file unchanged.

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
6. Otherwise, if the model advertises `/chat/completions`, translate the request to Chat Completions and translate the response back to Anthropic Messages.
7. Otherwise, if the model advertises `/responses`, use the stateless best-effort Responses translation defined in FR8.
8. Otherwise, return an Anthropic `400 invalid_request_error` that names the model and its advertised endpoints. An advertised WebSocket endpoint such as `ws:/responses` does not imply support for HTTP `/responses`.

The first lookup loads metadata from Copilot. Concurrent requests must share an in-progress refresh under the control-plane lifecycle in FR6. An ordinary refresh failure may use bounded-stale cached metadata and must record that stale data was used without logging credentials; without cached metadata, the request fails with an Anthropic `502 api_error`. A refresh forced by verified endpoint rejection must publish a new generation and must not reuse the rejected generation as stale data. Publishing a new snapshot generation invalidates all negative results from earlier generations. Detailed cache duration, maximum staleness, generation, synchronization, waiter cancellation, last-waiter abort, and operation-deadline contracts belong in `spec.md`.

Routing must never replace the requested model id. In v0.2, only HTTP 400 with machine-readable code `unsupported_api_for_model` is verified to mean endpoint rejection before model execution; that exact pair may invalidate the metadata cache and retry capability resolution once. A 400 without that code, timeout, connection reset, premature EOF, and any 5xx response must not trigger replay. Re-planning must not cause an unbounded retry or silent model fallback.

Feature preflight must also use the selected model's live metadata. A feature is available only when its corresponding `capabilities.supports` value explicitly declares support and the relay implements the required translation. Applicable limits, including token and vision limits, come from `capabilities.limits`; absent or malformed limits required to validate a requested feature cause an explicit error rather than a guessed default. Fields such as `model_picker_enabled`, `preview`, model family, and vendor must not be used to infer protocol or feature support.

### FR8. Stateless Anthropic Messages Translation

Both translated targets must support streaming and non-streaming text plus standard client-defined function tools. The shared required behavior is:

- top-level system instructions;
- user and assistant text content, including multi-turn history;
- client function-tool definitions and supported tool-choice modes;
- Anthropic `tool_use` and text-only `tool_result` blocks;
- text and client function-call output;
- maximum output tokens and sampling controls where the selected target has a verified equivalent;
- input/output token usage and completion stop reasons;
- upstream HTTP errors and mid-stream errors in Anthropic error shapes.

On the Chat path, `tool_use.id`, `tool_calls[].id`, `tool_result.tool_use_id`, and `tool_call_id` are the same value. On the Responses path, `tool_use.id`, `function_call.call_id`, `tool_result.tool_use_id`, and `function_call_output.call_id` are the same value. The relay must not allocate a replacement tool id.

For a later tool-result turn, the complete Anthropic history is mapped again. Chat uses ordinary assistant tool-call and tool messages. Responses reconstructs explicit function-call and function-call-output items from the historical id, name, input, and result text. Neither path reads or writes cross-request translation state.

For streaming responses, the relay incrementally emits a valid Anthropic event sequence. It may retain one bounded incomplete SSE frame plus request-local text, index, usage, and tool-argument assembly state. Tool argument fragments may span arbitrary transport chunks and must remain valid JSON objects after reassembly. All such state is discarded at the end of the HTTP request.

The translator follows the protocol compatibility principle: map verified equivalents, pass through target-shaped optional structures when safe, otherwise warn and omit. Opaque Responses reasoning items, encrypted content, target-specific item ids, Anthropic thinking blocks and signatures, hosted-tool state, cache hints, `tool_result.is_error` metadata, and unsupported optional controls are not persisted or fabricated. Omission must not rewrite retained text or add synthetic markers to tool results.

Required tool identity remains strict. Missing, duplicate, ambiguous, conflicting, or out-of-order tool ids; a result without one preceding matching call; or invalid function arguments fail before model invocation. Association must never be guessed from a tool name, text value, or position alone.

The Responses path is best-effort. If an upstream model requires reasoning, encrypted content, server-side conversation state, or another value absent from Anthropic history, that rejection is terminal and is returned as an actionable Anthropic error. It does not trigger local persistence, model substitution, or an unverified endpoint fallback.

### FR9. Translated Endpoint Compatibility Evidence

Before release, one representative model for each translated target must be probed for buffered and streaming text and one standard function call followed by its tool-result turn. Record only the accepted request fields and response, usage, terminal, tool-call, and error shapes needed by those paths. A Responses model that rejects reconstructed tool history remains usable for text but is documented as not supporting translated tool continuation.

Optional features are probed and implemented only when an actual supported use case requires them. Public OpenAI documentation and third-party adapters are useful baselines but do not establish Copilot acceptance.

### FR10. Native OpenAI Responses Passthrough

Exact inbound `POST /v1/responses` is a bounded thin passthrough to upstream `/responses`. It requires a non-empty model id but does not consult `ModelCatalog`: the client has already selected the protocol and endpoint, so upstream remains authoritative for whether that model accepts `/responses`. Successful request and response bodies are passed through without protocol translation. Non-2xx upstream bodies are bounded and safely rewritten rather than forwarded.

`CopilotTransport` owns the single pre-output 401 auth retry. Native Responses never performs capability re-planning, switches model or endpoint, or retries an upstream 400.

## 6. Non-Functional Requirements

- **NFR1 — Platform:** Windows / macOS / Linux fully supported, Node.js ≥ 18 (for native `fetch`).
- **NFR2 — Dependencies:** Keep runtime dependencies minimal (currently `commander`, `open`). The authoritative list is the `dependencies` field of `package.json`.
- **NFR3 — Startup latency:** No specific threshold is defined. Egregious regressions block release; otherwise treated case-by-case.
- **NFR4 — Proxy overhead and resource bounds:** Passthrough routes must not buffer streaming responses. Translation routes must process SSE incrementally and must not buffer the complete response or complete event stream. Buffering one incomplete SSE frame, one partial tool-argument value, and bounded request-local parser state is allowed. Request bodies, non-streaming responses, SSE frames, tool arguments, model metadata, and error bodies must have explicit limits and timeout behavior in `spec.md`. Streaming writes must respect downstream backpressure. No specific time-to-first-byte threshold is defined.
- **NFR5 — Security & logging:** `auth.json` has restrictive permissions. Access tokens, Copilot tokens, authorization headers, every token substring, prompt text, system text, tool input/result values, image data, raw request/response bodies, and raw errors must never appear in logs, CLI output, or client-facing errors at any log level. Authentication status may expose only non-secret state and expiry metadata. Default info logs record an allowlisted request lifecycle summary including request id, method/path, model id when available, route/endpoint, status, duration, and failure phase. Debug logs may additionally record only structural counts and enums such as message roles/content kinds/block counts, stream/tools counts, and retry/re-plan state. Logs go to stdout only — no file, no rotation.
- **NFR6 — Portability:** 100% TypeScript. A single `tsc` build produces artifacts runnable via `node dist/cli.js`; no loader or bundler is used.
- **NFR7 — Bind address:** Listen on `127.0.0.1` by default. `host` may be set in `config.json` or with `--host` for Docker, virtual-machine, and similar networking. Starting with any non-loopback host, including `0.0.0.0` or `::`, must fail unless that same invocation includes `--allow-remote-access`. The acknowledgement is CLI-only, is never persisted, and must be supplied on every remote start because the listener has no inbound authentication.

## 7. Constraints and Assumptions

- **A1.** The Copilot HTTP protocol (`api.githubcopilot.com`) request-header format is assumed stable within the project's development window. If upstream changes, header values (`Editor-Version`, etc.) are configurable and require no code changes.
- **A2.** The default `githubClientId` uses the widely-used public value found in existing community open-source Copilot clients. Users can substitute their own OAuth App id.
- **A3.** When the relay makes a routing or translated-feature decision, the live Copilot models response is the sole runtime source of truth for model existence, endpoint routing, declared feature support, and advertised limits. Effective support is the intersection of that metadata and relay functionality. Missing or malformed required metadata is handled as specified in FR7; no model-name, family, vendor, preview-state, or bundled-snapshot inference is allowed. Native passthrough routes leave endpoint acceptance to upstream.
- **A4.** Copilot's translated Chat and Responses endpoints are expected to be sufficiently compatible with their public OpenAI shapes for the narrow FR8 baseline. FR9 verifies only the behavior needed by that baseline.
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
- **AC7.** A model advertising `/chat/completions` but not `/v1/messages` receives translated Anthropic text through Chat; when both Chat and Responses are advertised, Chat is selected.
- **AC8.** A model advertising `/responses` but neither higher-priority endpoint receives a stateless translated text request. Buffered and streaming responses produce valid Anthropic output without waiting for the complete upstream stream.
- **AC9.** On each translated target, one standard client function call preserves its upstream id as the Anthropic `tool_use.id`, and the following request maps the matching `tool_result` back to that same id without reading or writing cross-request state. Missing or ambiguous ids fail before model invocation.
- **AC10.** Unsupported optional content and controls are warned and omitted when usable text or standard client tools remain. Opaque reasoning and hosted-tool state are never persisted, encoded into tool ids, or fabricated.
- **AC11.** A model that advertises `/v1/messages` continues to use passthrough behavior, byte-for-byte for successful response bodies and streams.
- **AC12.** Unknown models and requests missing data required to construct a target request return Anthropic 400 errors; malformed required model metadata and unavailable metadata without a cache return Anthropic 502 errors. No request silently changes the model id, invents a tool association, or recreates continuation state.
- **AC13.** Focused tests cover route priority, one request/response mapping fixture per translated target, one complete id-preserving tool round trip, SSE framing and tool arguments split across transport chunks, representative malformed required ids or arguments, and one mid-stream failure. Additional tests require a distinct public contract, observed upstream variant, or reproduced regression.
- **AC14.** Automated tests use sentinel credentials and verify that no complete credential or credential substring appears in `status` output, persisted diagnostic state, logs at any level, HTTP errors, or thrown-error messages.
- **AC15.** With the default info level, each HTTP request produces a correlated terminal log containing only the allowlisted lifecycle fields from NFR5. Debug mode additionally exposes enough structural metadata to distinguish message-role/content-shape failures without logging any content value. Tests cover success, local validation failure, upstream failure, and credential/content sentinels.
- **AC16.** Native `POST /v1/responses` preserves the admitted request bytes, query string, and successful JSON/SSE response bytes; invokes upstream `/responses` without catalog access or capability re-planning; returns the FR10 OpenAI errors; and safely rewrites non-2xx upstream bodies.
- **AC17.** `start` binds to `127.0.0.1` by default. A loopback `--host` starts without acknowledgement; a non-loopback host from either `config.json` or `--host` fails before listening unless the same command includes `--allow-remote-access`. The acknowledgement is not a config field and is not persisted.
- **AC18.** Translated conversations behave the same after relay restart because all required standard client-tool association comes from the submitted history. Starting the server does not create, open, recover, or own a continuation store.
- **AC19.** `configure codex` creates or conservatively merges the native Responses provider, is idempotent, preserves unrelated settings and file permissions, and leaves no temporary file after success or failure. Tests reject partial, signed, fractional, whitespace-padded, zero, and out-of-range port arguments for every port-taking command. Known-dangerous unsupported TOML is rejected without changing the original file.
