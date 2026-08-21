# copilot-relay — Requirements (v0.2)

> Status: approved 2026-08-21; amended 2026-08-21. v0.1 behavior remains supported unless this document explicitly changes it.

## 1. Background

A growing number of third-party AI agents (Claude Code, Codex CLI, in-house agents, and so on) use the OpenAI (`/v1/chat/completions`) or Anthropic (`/v1/messages`) HTTP APIs as their model-access protocol. To let these agents reuse the models behind a GitHub Copilot subscription, we need a local proxy that translates OpenAI / Anthropic requests to Copilot's upstream protocol and handles GitHub authentication plus short-lived Copilot token refresh.

Existing solutions leave a gap:

- GitHub does not officially provide a standalone Copilot model proxy for third-party agents.
- Extensions such as Copilot Chat bind this capability to the editor process, so CLIs and background services cannot use it directly.

This project provides a **standalone, VS Code-independent** local CLI proxy so any agent that speaks OpenAI or Anthropic APIs can use the user's own GitHub Copilot subscription. The focus is personal use. Implementation relies on the public GitHub Copilot HTTP protocol only.

v0.1 forwards each client protocol to the matching Copilot endpoint. This fails when a model is available only through another endpoint; for example, Claude Code sends Anthropic Messages requests while GPT-5.6 models advertise only the OpenAI Responses endpoint. v0.2 closes this gap with capability-based routing and a narrowly scoped Anthropic Messages to OpenAI Responses translation path.

## 2. Goals

- **G1.** Provide a local HTTP service exposing OpenAI-compatible (`/v1/chat/completions`) and Anthropic-compatible (`/v1/messages`) APIs, backed by GitHub Copilot.
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
- **N5.** No inbound authentication (API key / mTLS / etc.); the relay relies on loopback isolation to guarantee that only local processes can reach the proxy (see NFR7).
- **N6.** No general-purpose protocol conversion matrix. v0.2 does not translate Chat Completions to Messages, Chat Completions to Responses, or Responses client requests to another protocol.
- **N7.** No automatic model substitution. Endpoint routing may change the protocol used to invoke the requested model, but never changes the requested model id.
- **N8.** v0.2 does not translate PDF/document blocks, images embedded in tool results, multiple image blocks beyond the selected model's advertised limit, Anthropic extended-thinking blocks, prompt-caching semantics, `top_k`, non-empty `stop_sequences`, or `tool_result.is_error: true`.

## 4. User Stories

- **US1.** As a Copilot subscriber, I want Claude Code CLI to access Claude models through my Copilot subscription without buying a separate Anthropic API key.
- **US2.** As a developer, I want to start a local proxy and point any OpenAI-compatible SDK at `http://127.0.0.1:5000` to use Copilot models.
- **US3.** As an end user, I want the first-time login to use the device-code flow so I never paste tokens by hand.
- **US4.** I want the proxy to refresh the token automatically before it expires, without interrupting my requests.
- **US5.** I want `copilot-relay status` to quickly show the current auth state and token expiry.
- **US6.** As a Claude Code user, I want to select a Copilot model that supports `/responses` and use it without changing Claude Code's Anthropic API configuration.
- **US7.** As a user, I want unsupported content or model capabilities to fail explicitly instead of being silently dropped or routed to a different model.

## 5. Functional Requirements

### FR1. CLI Commands

| Command | Required |
|---|---|
| `copilot-relay login` | ✅ |
| `copilot-relay logout` | ✅ |
| `copilot-relay status` | ✅ |
| `copilot-relay start [--port] [--log-level]` | ✅ |
| `copilot-relay stop` | ✅ |
| `copilot-relay config-show` | ✅ |
| `copilot-relay configure claude` | ✅ |
| `copilot-relay configure codex` | ⏳ v0.2 |

> Default listen port is `5000`, overridable with `--port`. The listen address is fixed at `127.0.0.1` (see NFR7).

### FR2. HTTP Routes

| Route | Required |
|---|---|
| `POST /v1/chat/completions` (OpenAI; streaming supported) | ✅ |
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

- OpenAI endpoints (`/v1/chat/completions`, `/v1/models`) return
  `{ error: { type, message, code } }`.
- Anthropic endpoint (`/v1/messages`) returns
  `{ type: "error", error: { type, message } }`.

Pass the upstream HTTP status through where possible; when unclassifiable, use `502`.

**Handling upstream 401:** the Copilot token may be invalidated by upstream (rotation or revocation) before its local expiry threshold triggers a refresh. On an upstream 401, the proxy force-refreshes the Copilot token once and retries the original request; a second 401 is then rewritten per the shapes above and passed to the client, and the log hints at re-running `copilot-relay login`. Retry is allowed only before the first downstream response byte is written and only because the 401 establishes that authentication was rejected; if SSE forwarding has already begun, do not retry and terminate the stream per FR6.

**Handling token-refresh failure:** classify the token exchange independently from the request that triggered it. A definitive invalid-credential result maps to 401 and invalid auth state as specified in FR3. Transient transport/upstream failures and malformed successful responses map to `502` and must not convert a potentially valid login into a persistent authentication failure.

### FR6. Request Lifecycle

- When the client disconnects, the proxy must abort the upstream request (to avoid wasting Copilot quota).
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

The first lookup loads metadata from Copilot. Concurrent requests must share an in-progress refresh. A refresh failure may use bounded-stale cached metadata and must record that stale data was used without logging credentials; without cached metadata, the request fails with an Anthropic `502 api_error`. Publishing a new snapshot generation invalidates all negative results from earlier generations. Detailed cache duration, maximum staleness, generation, and synchronization contracts belong in `spec.md`.

Routing must never replace the requested model id. An upstream endpoint-availability result may invalidate the metadata cache and retry capability resolution once only when FR9 has verified that its exact HTTP status or machine-readable error code means the request was rejected before model execution. Timeout, connection reset, premature EOF, and ambiguous 5xx responses must not trigger replay. Re-planning must not cause an unbounded retry or silent model fallback.

Feature preflight must also use the selected model's live metadata. A feature is available only when its corresponding `capabilities.supports` value explicitly declares support and the relay implements the required translation. Applicable limits, including token and vision limits, come from `capabilities.limits`; absent or malformed limits required to validate a requested feature cause an explicit error rather than a guessed default. Fields such as `model_picker_enabled`, `preview`, model family, and vendor must not be used to infer protocol or feature support.

### FR8. Anthropic Messages to OpenAI Responses Translation

The `/responses` translation path must support both streaming and non-streaming requests and responses. v0.2 must translate:

- top-level system instructions;
- user and assistant text content, including multi-turn history;
- tool definitions, supported tool-choice modes, and the inverse mapping of `disable_parallel_tool_use` to Responses `parallel_tool_calls`;
- Anthropic `tool_use` and non-error `tool_result` content blocks;
- text and tool-call output from Responses;
- maximum output tokens and sampling controls only where the verified Copilot Responses contract has an equivalent;
- input/output token usage and completion stop reasons;
- upstream HTTP errors and mid-stream errors into Anthropic error shapes;
- a user-message image block when its locally verifiable properties comply with the selected model's advertised vision capability and limits.

Supported image sources are base64 data and HTTP(S) URLs. For base64 data, the relay validates the declared media type, encoding, encoded-size bound, image count, and selected model's advertised vision capability and limits before the upstream call; it does not decode or transcode the image. For URLs, the relay validates only HTTP(S) URL syntax, image count, and the selected model's advertised vision capability before the upstream call. It must not fetch, resolve, follow redirects, decode, persist, or log URL image content; the upstream endpoint validates the referenced resource's actual media type, byte size, accessibility, and image validity. Both source types are wrapped in the corresponding Responses input-image representation.

For streaming responses, the relay must incrementally convert Responses SSE events into a valid Anthropic event sequence, including `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, and `message_stop`. Tool argument fragments may span arbitrary transport chunks and must remain valid after reassembly.

The translator must validate the complete inbound request before starting the upstream request. Any unsupported Anthropic content block or semantic feature, including the exclusions in N8, returns an actionable Anthropic `400 invalid_request_error`. Unsupported fields must not be silently discarded.

The field and content-block mapping is closed: `spec.md` must classify every accepted Anthropic Messages request field and content block as exact mapping, documented transformation, or explicit rejection. Fields or variants absent from that matrix are rejected. In particular, the public Responses Create contract has no direct equivalent for Anthropic `top_k`, non-empty `stop_sequences`, or the error flag on `tool_result`; v0.2 rejects those values rather than dropping them or approximating their semantics. URL and base64 image sources are supported through their corresponding Responses `input_image` representations, subject to the validation above.

Tool-use continuation must preserve the identity and opaque upstream context required to associate an emitted Anthropic `tool_use` block with a later `tool_result`. The relay may retain only the minimum continuation state required by the verified Copilot Responses contract, in a bounded in-memory store with no cross-process persistence. Missing, expired, ambiguous, or inconsistent continuation state must fail explicitly before the upstream call; it must never be guessed from tool names, message text, or model ids.

### FR9. Upstream Responses Compatibility Gate

Before v0.2 implementation is considered complete, the Copilot `/responses` endpoint must be verified with the selected subscription using probes for non-streaming text, streaming text, streaming tool use, and the following tool-result continuation turn. URL and base64 image input must be verified separately. The probes must establish the accepted request-field names; observed completion, usage, tool-call, and error shapes; whether URL resource validation is delegated as specified in FR8; which exact endpoint-availability statuses or machine-readable codes, if any, guarantee rejection before model execution; and whether continuation requires response ids, function-call ids, completed output items, reasoning items or encrypted reasoning content, `previous_response_id`, `store`, or other opaque upstream state. For streaming output, state captured from an added/in-progress event must not be assumed complete unless the probe demonstrates it; completed item events must be tested separately. The observed payload and event shapes must be recorded in `spec.md`; implementation must follow observed Copilot behavior when it differs from the public OpenAI Responses shape. Public OpenAI documentation is a baseline, not evidence that Copilot accepts an unprobed field or event variant.

## 6. Non-Functional Requirements

- **NFR1 — Platform:** Windows / macOS / Linux fully supported, Node.js ≥ 18 (for native `fetch`).
- **NFR2 — Dependencies:** Keep runtime dependencies minimal (currently `commander`, `open`). The authoritative list is the `dependencies` field of `package.json`.
- **NFR3 — Startup latency:** No specific threshold is defined. Egregious regressions block release; otherwise treated case-by-case.
- **NFR4 — Proxy overhead and resource bounds:** Passthrough routes must not buffer streaming responses. Translation routes must process SSE incrementally and must not buffer the complete response or complete event stream. Buffering one incomplete SSE frame, one partial tool-argument value, bounded continuation state, and bounded parser state is allowed. Request bodies, non-streaming responses, SSE frames, tool arguments, model metadata, error bodies, and continuation entries must have explicit limits and timeout/expiry behavior in `spec.md`. Streaming writes must respect downstream backpressure. No specific time-to-first-byte threshold is defined.
- **NFR5 — Security & logging:** `auth.json` has restrictive permissions. Access tokens, Copilot tokens, authorization headers, and every token substring must never appear in logs, CLI output, or client-facing errors at any log level. Authentication status may expose only non-secret state and expiry metadata. Logs go to stdout only — no file, no rotation.
- **NFR6 — Portability:** 100% TypeScript. A single `tsc` build produces artifacts runnable via `node dist/cli.js`; no loader or bundler is used.
- **NFR7 — Bind address:** Listen on `127.0.0.1` only. `0.0.0.0` and external IPs are not supported; other hosts on the same LAN must be unable to connect. `host` is not exposed as a configurable field (no override via `config.json`, environment variable, or CLI flag). LAN access is out of scope; fork the project if needed.

## 7. Constraints and Assumptions

- **A1.** The Copilot HTTP protocol (`api.githubcopilot.com`) request-header format is assumed stable within the project's development window. If upstream changes, header values (`Editor-Version`, etc.) are configurable and require no code changes.
- **A2.** The default `githubClientId` uses the widely-used public value found in existing community open-source Copilot clients. Users can substitute their own OAuth App id.
- **A3.** The live Copilot models response is the sole runtime source of truth for model existence, endpoint routing, declared feature support, and advertised limits. Effective support is the intersection of that metadata and relay functionality. Missing or malformed required metadata is handled as specified in FR7; no model-name, family, vendor, preview-state, or bundled-snapshot inference is allowed.
- **A4.** Copilot's `/responses` payload and SSE shapes are expected to be sufficiently compatible with the public OpenAI Responses API to support the mapping in FR8. FR9 must verify this assumption before implementation is accepted.
- **C1.** Users must comply with the GitHub Copilot subscription terms. Tokens must not be shared, and the project must not be used for unauthorized commercial resale. NFR7's loopback-only binding is a technical safeguard against LAN-local token misuse, but overall compliance responsibility rests with the user.

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
- **AC9.** A Claude Code tool-use turn completes end to end: tool definitions and supported tool-choice controls reach the model, the model's tool call becomes an Anthropic `tool_use` block, and a following non-error Anthropic `tool_result` is associated with the exact upstream call and translated back with every continuation item required by the verified Copilot contract. The same flow works for streaming tool calls whose authoritative continuation state arrives only in completed item events. Missing, expired, or mismatched continuation state and `tool_result.is_error: true` fail before the upstream call with an actionable Anthropic 400 error.
- **AC10.** Supported URL and base64 user-message images reach a vision-capable `/responses` model and produce valid Anthropic responses. An excessive image count, a malformed or non-HTTP(S) URL, an unsupported declared base64 media type or encoding, an oversized base64 payload, or a non-vision model fails before the upstream call with an actionable Anthropic 400 error. A URL resource whose actual media type, byte size, accessibility, or image validity is unacceptable is rejected by upstream and returned in Anthropic error shape; the relay does not fetch it for preflight.
- **AC11.** A model that advertises `/v1/messages` continues to use passthrough behavior, byte-for-byte for successful response bodies and streams.
- **AC12.** Unknown models, models without a supported HTTP route or translator, fields absent from the closed mapping matrix, and excluded features return Anthropic 400 errors; malformed or incomplete required model metadata and unavailable metadata without a cache return Anthropic 502 errors. No request silently changes the model id, drops unsupported content, approximates unsupported semantics, or treats `ws:/responses` as HTTP `/responses`. Tests specifically cover non-empty `stop_sequences`, `top_k`, and `tool_result.is_error: true`.
- **AC13.** Unit tests cover request mapping, non-streaming response mapping, delegated URL-image validation and local base64-image validation, supported tool-choice and parallel-tool controls, continuation identity and expiry, completed reasoning/output-item capture, SSE frames split across arbitrary transport chunks, multiple frames in one chunk, tool-argument deltas, malformed upstream events, bounded buffers and metadata, downstream backpressure, abort/error/timeout races, model lookup refresh, generation-scoped negative results, shared concurrent refresh, bounded-stale cache use, verified pre-execution re-plan signals, rejection of ambiguous replay, missing or malformed `supported_endpoints`, missing required feature limits, token-refresh failure classification, and the intersection of model-declared and relay-implemented capabilities.
- **AC14.** Automated tests use sentinel credentials and verify that no complete credential or credential substring appears in `status` output, persisted diagnostic state, logs at any level, HTTP errors, or thrown-error messages.
