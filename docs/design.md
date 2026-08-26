# copilot-relay — Design (v0.2)

> Status: approved 2026-08-24; amended 2026-08-26. Aligned with the approved [requirement.md](./requirement.md); when the two conflict, `requirement.md` wins.

> Decision record: [Native Responses v2](./native-responses-v2-decision.md), originating from [@xlight](https://github.com/xlight)'s [PR #1](https://github.com/luciferwww/copilot-relay/pull/1), records why native inbound `POST /v1/responses` was integrated with the post-PR #2 Messages-to-Responses architecture.

> [!NOTE]
> Diagrams in this document use Mermaid syntax. Open the preview pane in VS Code (`Ctrl+Shift+V` or the button in the top-right) to view them rendered; the `bierner.markdown-mermaid` extension is required (installed in this workspace). GitHub renders Mermaid natively — no extra setup.

## 1. Architecture Overview

```mermaid
flowchart LR
    subgraph Client[Third-party clients]
        A[Claude Code / Codex / OpenAI SDK]
    end

    subgraph Proxy[copilot-relay local process]
        B[HTTP Server<br/>node:http]
        C[Auth Manager<br/>ensureCopilotToken]
        D[Copilot Transport<br/>attempts + auth + abort]
        I[Live Model Catalog<br/>cache + validation]
        J[Messages Route Planner]
        L[Responses Request Mapper]
        M[Responses Output Mapper]
        N[Responses SSE Translator]
        O[Continuation Registry<br/>bounded in-memory state]
        P[Safe Output Boundary<br/>allowlisted diagnostics]
        K[Config<br/>src/config.ts]
        E[(auth.json)]
        F[(config.json)]
    end

    subgraph GitHub[GitHub Copilot]
        G[api.githubcopilot.com]
        H[api.github.com<br/>copilot_internal/v2/token]
    end

    A -->|OpenAI/Anthropic format| B
    B -->|Messages routing| J
    B -->|Native Responses passthrough| D
    J --> I
    I --> D
    J -->|Messages passthrough| D
    J -->|Responses translation| L
    L <--> O
    L --> D
    D --> C
    C -- read/write --> E
    C -- refresh on expiry --> H
    D -->|Bearer + Copilot headers| G
    G -->|JSON or SSE| D
    D -->|passthrough| B
    D --> M
    D --> N
    M --> O
    N --> O
    M --> B
    N --> B
    B --> P
    C --> P
    B --> A
    F -.-> K
    K -.-> B
    K -.-> C
```

## 2. Component Responsibilities

| Module | File | Responsibility |
|---|---|---|
| CLI frontend | [src/cli.ts](../src/cli.ts) | commander parsing, process lifecycle, pid file |
| Config | [src/config.ts](../src/config.ts) | Default config + `config.json` read/write, path constants |
| Logger / safe output | [src/logger.ts](../src/logger.ts) | Leveled structured logging and safe diagnostic rendering; accepts allowlisted fields rather than arbitrary objects or raw errors; writes to stdout only |
| HTTP Server | `src/http-server.ts` | Route dispatch, native Responses handling, client disconnect handling, protocol response selection |
| Copilot Auth | [src/auth/copilot.ts](../src/auth/copilot.ts) | Copilot token exchange / refresh / expiry check / persistence |
| Device Code | [src/auth/deviceCode.ts](../src/auth/deviceCode.ts) | GitHub OAuth device-code flow |
| Copilot transport | `src/upstream/CopilotTransport.ts` | Authenticated attempt execution, request-scoped retry bounds, abort propagation, common headers |
| Model catalog | `src/models/ModelCatalog.ts` | Fetches and validates live `/models` metadata; bounded cache and shared refresh |
| Messages route planner | `src/routing/messages-route.ts` | Selects passthrough, Responses translation, or a typed local error without changing model id |
| OpenAI translator | [src/translate/openai.ts](../src/translate/openai.ts) | Chat Completions passthrough headers and OpenAI error shape |
| Anthropic translator | [src/translate/anthropic.ts](../src/translate/anthropic.ts) | Messages passthrough headers and Anthropic error/SSE shape |
| Responses request mapper | `src/translate/responses/request-mapper.ts` | Pure validated Anthropic Messages → Responses JSON mapping |
| Responses output mapper | `src/translate/responses/response-mapper.ts` | Pure non-streaming Responses → Anthropic Message mapping |
| Responses SSE translator | `src/translate/responses/SseTranslator.ts` | Incremental SSE parsing and Anthropic event sequencing |
| Continuation registry | `src/translate/responses/ContinuationRegistry.ts` | Bounded in-memory association between emitted Anthropic tool ids and authoritative completed Responses items needed for a following tool-result turn |
| Translation types | `src/translate/responses/types.ts` | Boundary types, mapping results, stream state, typed translation errors |

## 3. Key Flows

### 3.1 First-time login (device-code)

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant CLI as copilot-relay CLI
    participant GH as github.com
    participant API as api.github.com

    U->>CLI: copilot-relay login
    CLI->>GH: POST /login/device/code<br/>{client_id, scope}
    GH-->>CLI: {device_code, user_code,<br/>verification_uri, interval}
    CLI-->>U: print user_code, open browser
    U->>GH: enter user_code in browser, authorize
    loop every `interval` seconds
        CLI->>GH: POST /login/oauth/access_token
        alt user has authorized
            GH-->>CLI: {access_token}
        else not yet authorized
            GH-->>CLI: {error: authorization_pending}
        end
    end
    CLI->>API: GET /copilot_internal/v2/token<br/>Authorization: token <access>
    API-->>CLI: {token, expires_at, endpoints.api}
    CLI->>CLI: write ~/.copilot-relay/auth.json
```

### 3.2 Request forwarding (OpenAI example)

```mermaid
sequenceDiagram
    autonumber
    participant C as Client SDK
    participant S as copilot-relay Server
    participant A as Auth Manager
    participant U as api.githubcopilot.com

    C->>S: POST /v1/chat/completions<br/>{model, messages, stream:true}
    S->>A: ensureCopilotToken(cfg)
    alt token not expired
        A-->>S: cached AuthState
    else ≤ 5 minutes to expiry
        A->>U: GET copilot_internal/v2/token
        U-->>A: fresh Copilot token
        A->>A: write auth.json
        A-->>S: refreshed AuthState
    end
    S->>U: POST /chat/completions<br/>Bearer + Copilot headers
    alt upstream 200
        U-->>S: 200 SSE stream (chunked)
        Note over S: Readable.fromWeb, direct pipe
        S-->>C: SSE stream (chunk by chunk)
    else upstream 401 (token revoked/rotated, before first byte)
        U-->>S: 401
        S->>A: force refresh once
        A->>U: GET copilot_internal/v2/token
        U-->>A: fresh Copilot token
        A-->>S: refreshed AuthState
        S->>U: retry POST /chat/completions
        alt retry 200
            U-->>S: 200 SSE
            S-->>C: SSE stream
        else retry still 401
            U-->>S: 401
            S-->>C: error in OpenAI shape, hint to re-run login
        end
    end
```

### 3.3 Capability-routed Anthropic request

```mermaid
sequenceDiagram
    autonumber
    participant C as Anthropic client
    participant S as HTTP Server
    participant R as Messages Route Planner
    participant M as Model Catalog
    participant T as Copilot Transport
    participant U as Copilot API
    participant X as Responses Translator

    C->>S: POST /v1/messages
    S->>S: parse JSON and validate model
    S->>R: plan(request)
    R->>M: get(model id)
    alt catalog empty or model missing
        M->>T: GET /models
        T->>U: authenticated request
        U-->>T: live model metadata
        T-->>M: response
        M-->>R: validated model record
    else fresh or bounded-stale cache available
        M-->>R: cached model record
    end
    alt advertises /v1/messages
        R-->>S: passthrough plan
        S->>T: original body → /v1/messages
        T-->>S: upstream bytes
        S-->>C: byte-for-byte body passthrough
    else advertises /responses and translator exists
        R-->>S: responses plan
        S->>X: validate and map complete request
        X-->>S: Responses request or typed 400
        S->>T: mapped body → /responses
        T-->>S: JSON or Responses SSE
        S->>X: map output incrementally when streaming
        X-->>C: Anthropic Message or SSE events
    else metadata malformed
        R-->>C: Anthropic 502 api_error
    else no implemented route
        R-->>C: Anthropic 400 invalid_request_error
    end
```

The planner is deterministic and side-effect free after catalog lookup. Endpoint priority is `/v1/messages`, then HTTP `/responses`; `ws:/responses` is not an HTTP capability. No branch substitutes the requested model.

### 3.4 Translation stream lifecycle

The translation path validates and maps the complete inbound JSON body before opening `/responses`. After any successful upstream response body or downstream response begins, it never retries or switches routes; pre-body failures follow the restricted attempt-coordinator rules in §7.

For non-streaming calls, the output mapper reads one bounded JSON response and emits one Anthropic Message. For streaming calls, the SSE translator consumes arbitrary byte chunks, buffers only an incomplete SSE frame and bounded per-tool argument state, and emits Anthropic events as soon as their required source data is available.

```mermaid
stateDiagram-v2
    [*] --> AwaitCreated
    AwaitCreated --> Active: response.created
    Active --> Active: valid per-item event
    Active --> Completed: response.completed and every item done
    AwaitCreated --> Failed: any other protocol event / EOF
    Active --> Failed: error / invalid transition / EOF
    Completed --> [*]
    Failed --> [*]
```

The translator requires one valid `response.created` before emitting `message_start`; it does not synthesize response identity or model metadata from later events. The exact initial-usage representation is defined from the probed `response.created` shape in `spec.md`, and a missing required field is a 502 protocol failure.

The global response state owns Anthropic content-block indexes and a bounded item state keyed by sequential `output_index`. Each item has an independent type-specific state for added, content/argument deltas, and done. Live FR9 streams rotate opaque `item_id` and embedded item `id` values between snapshots, so each observed id is validated as non-empty but is not a cross-event correlation key. A conflicting `output_index`, delta before add, duplicate terminal event, or `response.completed` while any item is incomplete is a 502 protocol failure. FR9 observed multiple output items completing sequentially by `output_index`, not interleaving. v0.2 therefore emits admitted items in that observed order and rejects a new item or delta that interleaves with an unfinished item; it does not implement speculative reordering.

The state machine guarantees exactly one `message_start`, ordered start/delta/stop events for each block, one terminal `message_delta`, and one `message_stop` on success. A failure emits one Anthropic `error` event and closes without a success terminator.

### 3.5 Tool-use continuation

The selected v0.2 strategy is **local stateless replay**, not reliance on an upstream stored conversation. Responses requests use `store: false`, do not use `previous_response_id`, and explicitly send the completed prior items required by the verified Copilot contract. FR9 must verify these controls and the required encrypted-reasoning request fields; if Copilot cannot support this mode, the design must be revised rather than silently switching to upstream conversation storage.

When a Responses result contains one or more function calls, the mapper emits relay-generated opaque Anthropic `tool_use.id` values. Completed output items are first collected in a request-local staging group: for a stream, data from `response.output_item.added` or deltas remains provisional until the corresponding `response.output_item.done` event, and an item-level done does not publish registry state. Non-streaming output requires a fully validated `status: completed`; streaming output requires a valid `response.completed` after every staged item is done.

After upstream completion and successful translation, the final capacity check and publication execute as one synchronous atomic registry operation before any client-visible success commit. For non-streaming output, that operation runs immediately before writing the complete Anthropic response. For streaming output, it runs after every corresponding `tool_use` block has been written successfully and immediately before the Anthropic success terminator. Failure, malformed events, premature EOF, abort, or client disconnect before that commit point discards the staging group. A disconnect after publication does not roll the group back because the client may already have received the tool ids. Capacity failure is therefore a translation failure, never a partial publication or a successful response containing unusable tool ids. The exact atomic API and capacity limits belong in `spec.md`.

The published group contains the model id, each external tool id and upstream `call_id`, completed function-call items, and any completed reasoning items or encrypted reasoning content needed for replay. Multiple parallel tool calls from one response point to the same response group so a later request can validate and replay the group coherently.

On a following request, the mapper scans complete history in order and may resolve multiple previously published groups. Each assistant tool-use set opens exactly its original group, its later user results close that group, and a later group is validated independently after the earlier group closes. Every `tool_result.tool_use_id` must resolve to an unexpired group, match the requested model and historical tool-use block, and map to exactly one upstream `function_call_output.call_id`; mixed groups within one parallel call set, missing results, expired or duplicated ids, cross-model references, out-of-order reuse, and unclosed groups fail with Anthropic 400 before transport. Each valid group is replayed once at its original history position. Published groups are immutable and may be read repeatedly until eviction; they are not reserved or consumed by one request because Anthropic clients resend complete history, retries may replay it, and conversations may branch. Preventing duplicate model execution is an independent request-idempotency concern and is not inferred from continuation lookup.

Entries are process-local, size- and age-bounded, never persisted, and evicted deterministically. Successful lookup renews a 24-hour idle deadline but never extends the 7-day absolute lifetime. An oversized new group fails publication; group-count or aggregate-byte pressure atomically evicts the least recently accessed groups before inserting the new one, as defined in `spec.md`. A process restart therefore makes outstanding tool continuations explicitly unavailable rather than reconstructing hidden state from names or text.

This restart sensitivity is a known architectural limitation. Anthropic history preserves the relay-issued tool id but does not preserve the complete authoritative Responses replay group: the upstream `call_id`, completed function-call item, and model-dependent reasoning or encrypted reasoning item may all be required. Using only client-normalized tool input would weaken continuation identity and could send a result to the wrong or incomplete upstream call.

The post-v0.2 target is **finite statelessness at the process boundary**. Protocol translation may retain the minimum bounded continuation state, but correctness for an unexpired published group must not depend on a particular relay process remaining alive. The preferred architecture adds a recoverable store behind `ContinuationRegistry`: an in-memory index remains the fast path, while successful publication, access-time renewal, and eviction are mirrored atomically to a versioned encrypted local snapshot or journal. Startup loads only authenticated, schema-valid, unexpired records and enforces the same per-group, total-byte, count, renewable idle-TTL, absolute-lifetime, and least-recently-used eviction limits before exposing them to lookup.

The future store must not turn continuation into a long-term conversation database. It persists only authoritative replay fields already required by the translator, never arbitrary message history; plaintext tool input or reasoning content must not be written to disk; encryption keys must not be embedded in the continuation data; corruption, incompatible versions, decryption failure, model mismatch, or expiry must fail closed and remove the unusable record. Exact key management, file locking, crash recovery, logout cleanup, and multi-process ownership require a separate security design before implementation.

## 4. Technical Choices & Tradeoffs

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Language | TypeScript + `tsc` compile | ts-node / bun | Zero runtime loader; `node dist/*.js` runs directly |
| Module system | ESM (`"type":"module"`) | CJS | `open@10` is ESM-only, forcing the whole package to be ESM |
| HTTP client | Built-in `fetch` (undici) | axios / node-fetch | Zero dependencies + native streams |
| HTTP server | Built-in `node:http` | express / fastify | Small fixed route surface; explicit dispatch remains clearer |
| CLI parsing | `commander` | Hand-rolled argv parsing | Auto-generated `--help` and subcommand tree; saves ~120 LOC of hand-rolled parsing |
| Open browser | `open` | Hand-rolled `spawn` | Cross-platform edge cases (macOS `open` / Linux `xdg-open` / Windows `start`) are easy to get wrong |
| Logging | Structured safe-output boundary over stdout | Free-form logger / pino / winston | A small allowlisted schema prevents credential-bearing objects and raw errors from reaching output surfaces |
| Config | JSON | TOML / YAML | No external parser needed; `JSON.stringify` is built in |
| Capability source | Live Copilot `/models` only | Static model table / name heuristics | Honors account-specific and changing upstream capabilities |
| Routing | Explicit route plan | Endpoint trial-and-error | Deterministic errors; client requests never become capability probes |
| Translation model | Direct Messages ↔ Responses mappers | General canonical protocol | v0.2 has one conversion pair; avoids a premature abstraction |
| SSE parsing | Incremental state machine | Buffer full response / regex replacement | Preserves time-to-first-event and handles arbitrary transport chunking |
| Mapper shape | Pure functions + typed errors | Translation inside HTTP handler | Enables exhaustive fixture tests without sockets or credentials |

## 5. Model Catalog and Routing

### 5.1 Source of truth

When the relay chooses a route or validates a translated feature, the live Copilot `/models` response is the sole runtime authority. `1.json` and other captures are test fixtures only and are never loaded by production code. Routing uses only exact entries from `supported_endpoints`; feature preflight uses explicit values from `capabilities.supports` and required bounds from `capabilities.limits`. Model id, family, vendor, picker state, and preview state are not capability signals. Native passthrough routes do not make capability decisions and leave endpoint acceptance to upstream.

Effective support is the intersection of upstream metadata and relay implementation. For example, a model declaring vision is insufficient until the selected translation path implements and validates image mapping.

### 5.2 Cache state

`ModelCatalog` keeps one immutable validated snapshot with a monotonically increasing generation, its fetch time, a generation-scoped negative-result map, and at most one in-progress refresh operation. The manager owns that operation's controller, deadline, promise, and waiter count; no client request owns or lends its deadline to the shared operation. Cache limits and deadlines are constants specified in `spec.md`; they are not user configuration in v0.2.

| State | Behavior |
|---|---|
| Fresh snapshot | Resolve without network access |
| Empty cache | Start a manager-owned refresh with its own deadline; concurrent callers await the same promise as independent waiters |
| Model absent | Reuse a negative result only for `(modelId, currentGeneration)`; otherwise force one shared refresh and record absence against the resulting generation |
| Refresh fails with bounded-stale snapshot | Use stale snapshot and log only age/status metadata |
| Refresh fails without usable snapshot | Return a 502 in the calling route's protocol shape |
| Response exceeds byte, record-count, or validated-cache limits | Abort the refresh; use bounded-stale data or return a route-shaped 502 |
| Required metadata malformed | Return a route-shaped 502; do not infer or probe |
| Verified pre-execution endpoint rejection | Invalidate, require a new generation without stale fallback, and re-plan once through the request attempt coordinator |

The cache stores the complete model records needed for endpoint and feature decisions. It does not mutate or enrich records with guessed defaults. Parsing uses a bounded body reader before JSON decoding, and a candidate snapshot is published atomically only after the complete response passes schema, record-count, and aggregate-size validation. A failed refresh never replaces a usable snapshot. Publishing a new generation atomically clears all earlier negative results. A request finding a refresh already in progress registers as a waiter and awaits that same promise before testing or recording its model-specific result. Client disconnect or request deadline removes only that waiter; it does not settle or reject the shared promise for other waiters. Because v0.2 has no background refresh, the manager aborts the operation when its own deadline expires or its waiter count reaches zero. Completion, last-waiter cancellation, abort, and generation publication race through one manager-owned terminal state so no result commits after cancellation. Normal snapshot expiry still triggers refresh, so a generation-scoped negative result cannot hide a newly published catalog indefinitely. Exact waiter bookkeeping and race rules belong in `spec.md`.

### 5.3 Route plans

The planner returns a discriminated union rather than performing network I/O:

- `messages-passthrough`: original bytes and Anthropic headers go to `/v1/messages`;
- `responses-translation`: validated mapping is required before `/responses` is called;
- `client-error`: known model/request with no supported implemented route, HTTP 400;
- `upstream-metadata-error`: missing or malformed required metadata, HTTP 502.

This union is the boundary that prevents fallback from becoming model substitution or endpoint guessing.

### 5.4 Native Responses route

Native inbound `POST /v1/responses` is handled beside, not inside, the Messages route planner. Because the client has already selected the Responses protocol, the handler validates the bounded request and non-empty model id, then invokes upstream `/responses` through `CopilotTransport` with the original admitted body and query. It does not consult `ModelCatalog`. Successful JSON and SSE use the OpenAI passthrough writer; Messages mappers and continuation state are not involved.

The transport owns one pre-output 401 retry. Native Responses does not capability-replan or retry an upstream 400; non-2xx upstream bodies are safely rewritten rather than passed through.

### 5.5 External models route

Client-facing `GET /v1/models` is an independent request-owned passthrough through `CopilotTransport`. On success it pipes the upstream body byte-for-byte; it never serializes a validated `ModelCatalog` snapshot. Client disconnect or request deadline aborts only this passthrough operation.

The external route does not join an internal catalog refresh, share its response body, or publish a catalog generation. Conversely, `ModelCatalog` refreshes never borrow the external request's controller or deadline. Both paths may share the Auth Manager, but concurrent external and internal lookups may intentionally issue two upstream `/models` requests to keep body ownership, validation, caching, and cancellation independent. External-route error rewriting and its one 401 retry remain route-local contracts defined in `spec.md`; they do not consume a model invocation attempt.

## 6. Translation Pipeline

### 6.1 Request validation

The request mapper parses unknown JSON into boundary types and applies the closed mapping matrix defined in `spec.md`. Each field and content-block variant has one disposition: exact mapping, documented transformation, or rejection. Validation completes before any upstream `/responses` call.

Validation combines protocol rules with the selected model record. Unsupported semantics such as non-empty `stop_sequences`, `top_k`, and URL image sources produce typed `invalid_request_error` results. A boolean `tool_result.is_error` is accepted and consumed while its text content maps to `function_call_output`, because Responses has no equivalent error flag. One base64 image receives local declared-media-type, encoding, encoded-size, count, and vision-capability checks without decoding, then maps to a Responses `input_image.image_url` data URL. The verified Copilot endpoint rejects external image URLs, so the relay never resolves or fetches them.

Claude Code CLI 2.1.39 and official VS Code extension 2.1.233 through 2.1.234 compatibility remain inside the closed mapper rather than adding client-specific preprocessing layers. The mapper accepts only `{user_id:string}` as top-level metadata and maps it to Responses metadata, normalizes an empty tools array to absent tools, and recognizes only `{type:'ephemeral'}` as a cache hint on `text`, `tool_use`, and `tool_result` blocks. Cache hints are validated and consumed but not forwarded because the verified Copilot Responses contract exposes no equivalent. A VS Code `messages` entry with `role:'system'` accepts a non-empty string or a non-empty array whose every content block is text, maps in place to Responses system `input_text`, and remains distinct from top-level Anthropic `system` instructions. VS Code `output_config` is accepted only as `{effort:string}`. The mapper requires live `capabilities.supports.reasoning_effort` to be an array of strings containing that exact effort, then maps it to Responses `reasoning:{effort}`. Missing or malformed required support metadata is an upstream-metadata error; an unadvertised effort is a client error. No other unknown field is discarded.

When tool results are present, validation resolves the continuation group before constructing Responses input. The historical block must preserve the emitted tool id and name. Its input must be a projection of the authoritative input with identical retained values; only top-level authoritative fields whose value is exactly `false` may be absent, matching Claude Code's observed removal of explicit tool defaults. Added fields, changed values, nested normalization, and omission of any other value are rejected. The mapper replays the authoritative completed function-call and reasoning items followed by `function_call_output` items keyed by the stored `call_id`; client-visible assistant text or normalized input is never substituted for opaque Responses state.

### 6.2 Non-streaming output

The output mapper accepts only observed and documented Copilot Responses shapes. It maps text, function calls, usage, and completion reason into one Anthropic Message. Unknown output item types or structurally invalid payloads produce an Anthropic 502 because the upstream contract, not the client request, was violated.

### 6.3 Streaming output

The SSE translator has two layers:

1. A transport parser converts arbitrary UTF-8 byte chunks into complete SSE events while preserving split code points and multi-line `data` fields.
2. A protocol state machine converts documented Responses events into ordered Anthropic events and accumulates only bounded tool-argument fragments until the relevant content block closes.

Unknown ignorable transport fields may be ignored only when `spec.md` explicitly permits them. Unknown Responses event types, invalid transitions, malformed JSON, excessive buffered state, and premature EOF are upstream protocol failures and terminate with an Anthropic stream error.

## 7. Transport Boundary

`CopilotTransport` centralizes behavior currently embedded in `server.proxy()` and `proxyModels()`: proactive token acquisition, common headers, execution of an invocation plan, request deadlines, abort propagation, and returning the upstream `Response` before client headers are committed. It does not parse provider payloads, choose routes, or make a request-scoped controller own shared control-plane work.

One request-scoped attempt coordinator owns retry state and records `authRetryUsed`, `replanUsed`, the auth generation, catalog generation when applicable, route, and terminal state for every model invocation attempt. A model invocation is a call to `/chat/completions`, `/v1/messages`, or `/responses` made to generate a client result. No invocation retry is allowed after downstream output starts. Before output starts, an upstream 401 may consume the one auth retry. For capability-routed Messages only, HTTP 400 with machine-readable code `unsupported_api_for_model` may consume the one capability re-plan because FR9 verified that exact pair as pre-execution endpoint rejection. Native Responses and Chat Completions never capability-replan. A 400 without an applicable re-plan, timeout, connection reset, premature EOF, and any 5xx response are terminal and never replayed.

Each retry reason may be consumed at most once, and an attempt may transition to only one next attempt. The original call plus at most one auth-triggered invocation retry and one verified endpoint re-plan invocation gives a hard maximum of three model invocation attempts per client generation request, regardless of ordering. A repeated reason or any unclassified failure terminates the coordinator. “No downstream bytes” is therefore necessary but not sufficient for replay.

Token exchange and internal catalog refresh are control-plane operations, not model invocation attempts. Each manager gives those operations its own single-flight policy, deadline, waiter lifecycle, and call limit, all specified independently in `spec.md`. Route planning and re-planning also do not consume the invocation budget; only the resulting model endpoint call does. Client-facing `GET /v1/models` is neither a generation request nor a model invocation and uses its route-local retry bound from §5.4.

Passthrough success responses remain streamed byte-for-byte. Translation handlers copy only safe response headers and set the client protocol content type themselves. Body readers enforce byte limits while reading rather than after allocation. Translated streams propagate downstream backpressure to the upstream reader; they do not continue accumulating translated events while `ServerResponse.write()` is blocked. Abort, downstream close, writer failure, or translation failure cancels the unfinished upstream response body before its reader lock is released.

## 8. Directory Layout

See project root [README.md](../README.md) and [spec.md](./spec.md) §3.

## 9. Error Handling Strategy

Maps one-to-one to requirement FR3 / FR5 / FR6.

### 9.1 Layer responsibilities

| Layer | Strategy |
|---|---|
| CLI | Top-level catch converts a typed failure to a safe diagnostic code/message; it never passes an arbitrary `Error` or cause chain to the logger |
| HTTP handler | Selects the client protocol error formatter and renders only typed safe diagnostics, never raw thrown-error text |
| Auth | When `loadAuth() → null`, the `start` command reports "please run login first" and `exit(1)` |
| Model catalog / planner | Returns typed 400 or 502 failures; never writes an HTTP response directly |
| Request mapper | Returns typed 400 failures for unsupported or invalid client semantics |
| Output mapper / SSE translator | Returns or emits typed 502 failures for malformed upstream protocol |
| Transport | Reports typed HTTP, timeout, network, and auth outcomes without raw bodies or choosing a client error shape |

### 9.2 Upstream errors → client shape (FR5)

**Do not proxy Copilot's raw error body verbatim.** Rewrite to the target route's protocol:

- OpenAI endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/models`) →
  `{ error: { type, message, code } }`
- Anthropic endpoint (`/v1/messages`) →
  `{ type: "error", error: { type, message } }`

Pass the upstream HTTP status through where possible; when unclassifiable or when the error originates locally, use `502`.

Local capability errors are classified before transport: unknown model, unsupported valid route, and unsupported request semantics are 400; unavailable or malformed required model metadata is 502. Upstream error bodies may be read only through the bounded body reader and parsed solely to recognize machine-readable error codes explicitly allowlisted in `spec.md`; v0.2's endpoint re-plan allowlist contains only `unsupported_api_for_model` paired with HTTP 400. Client and log messages are locally constructed from the failure phase, HTTP status, allowlisted code, and an allowlisted request-id header when present; arbitrary upstream message text is never returned or logged.

### 9.3 401 and token refresh (FR3 + FR5)

- **Proactive refresh:** `ensureCopilotToken` fetches a new token when the Copilot token's remaining lifetime is ≤ 5 minutes.
- **Reactive refresh:** on upstream 401, force-refresh once and retry the original request (see the alt branch in §3.2). Retry is **only allowed before the first downstream response byte is written** and because the 401 establishes authentication rejection. If SSE forwarding has already begun, do not retry and terminate the stream per §9.4.
- **Second 401:** pass through to the client using the shape from §9.2, and hint on stdout to re-run `copilot-relay login`.
- **Definitive credential rejection:** a token-exchange status or documented error code that unambiguously means the long-lived access token is invalid maps to 401. Auth persistence records only a typed safe failure code and timestamp, leaves prior Copilot token fields as-is, and lets `status` report invalid auth without raw upstream text.
- **Transient or malformed refresh failure:** timeout, network failure, upstream 5xx, malformed success payload, and unrecognized failures map to 502. They preserve the prior auth-validity state, do not write a permanent invalid marker, and do not prompt for login. Unknown cases default to this non-credential class; `spec.md` defines the exact classification table.
- **Refresh concurrency:** the Auth Manager holds an immutable in-memory auth snapshot with a monotonically increasing generation and at most one manager-owned refresh operation for a source generation. The operation owns its controller, deadline, promise, and waiter count. Proactive callers from the same generation join as independent waiters. A reactive 401 records the generation of the token actually rejected: if a newer generation already exists, the request retries with it without another exchange; otherwise it starts or joins the refresh for the rejected generation. Client cancellation removes only that waiter; the operation continues for others and is aborted when its own deadline expires or its waiter count reaches zero. Exact terminal-race and call-limit rules belong in `spec.md`.
- **Generation-safe commit:** a refresh success, definitive rejection, or diagnostic state may commit only if its source generation is still current. Success atomically writes the new token state and advances the generation. A stale success or failure is discarded, so an older request cannot overwrite a newer token or mark it invalid. Transient failure never mutates persistent auth validity. Exact in-process initialization and persistence fields belong in `spec.md`.

### 9.4 Request lifecycle (FR6)

- **Invocation lifecycle owner:** each client request has one owner that combines `req.aborted`, a premature downstream response `close`, and the applicable request deadline into one controller for its model invocation or external passthrough. A normal request-stream `close` after the body is read is not by itself treated as client cancellation.
- **Control-plane waiters:** waiting for Auth Manager or `ModelCatalog` registers a request-local waiter cancellation hook rather than passing the invocation controller into the shared operation. Request cancellation stops that request from awaiting or starting a later invocation; manager-owned deadlines and last-waiter policy govern the shared operation itself.
- **Backpressure:** passthrough uses stream piping; translation awaits downstream `drain` whenever `write()` returns false before reading and translating more upstream bytes.
- **Single termination:** success, typed failure, timeout, upstream abort, and client disconnect race through one terminal state. Before headers, a local/upstream timeout returns the client protocol's 502 shape. After streaming starts, a timeout follows the mid-stream error rule when the socket remains writable. Client disconnect closes silently. No path writes an error after success or after socket closure.
- **Cleanup:** completion removes request/response listeners, clears deadline timers, releases stream readers, and aborts unfinished upstream work exactly once.
- **Error mid-SSE:**
  - OpenAI endpoint: write `data: {"error": {...}}\n\n` then `res.end()`. **Do not emit `data: [DONE]`** — the SDK treats `[DONE]` as success and would swallow the error.
  - Anthropic endpoint: write `event: error\ndata: {...}\n\n` then `res.end()`.
- These sequences assume the `openai` and `@anthropic-ai/sdk` clients treat `data: {"error": {...}}` (without a trailing `[DONE]`) as a stream error rather than success. Re-verify this invariant when upgrading either dependency.

## 10. Security

The HTTP boundary assigns a process-local request id and emits one terminal info event for every admitted request. Success and failure events use the same allowlisted schema: method, normalized path, model id when available, route/endpoint when selected, HTTP status, duration, and failure phase/code. Debug mode may add message-role/content-kind/block-count summaries, stream/tools counts, invocation count, and auth-retry/re-plan booleans. The logger API accepts these typed scalars and arrays of enums/counts only; call sites cannot pass request/response objects, headers, bodies, block values, tool values, `Error` instances, or cause chains.

- **Credentials never appear in output**: access tokens, Copilot tokens, authorization headers, image data, and credential substrings are excluded from logs, CLI output, client errors, and thrown-error messages at every log level. Status output includes only authentication state and expiry metadata.
- **Safe values are constructed, not scrubbed after formatting**: auth, transport, and protocol layers return typed diagnostic codes plus allowlisted scalar metadata such as HTTP status, model id, cache age, and failure phase. Raw headers, bodies, request payloads, token-exchange payloads, `Error` objects, cause chains, and auth-state objects are not accepted by logger or client-error APIs.
- **Defense-in-depth redaction**: the output boundary tracks current and replaced credential values and removes complete known values and authorization-header forms from any exceptional fallback string. This is not the primary guarantee: ordinary output paths never receive secret-derived text, so token prefixes and other value-derived fragments cannot be emitted. Persisted diagnostics use the same typed safe representation.
- **`auth.json` chmod 0600**: applied on Unix-like systems. On Windows no `icacls` call is made — permission relies on the `%USERPROFILE%` directory's own ACL.
- **Loopback by default; explicit remote opt-in**: bind `127.0.0.1` unless `host` is configured or supplied by CLI. A non-loopback host is rejected unless that same start command includes `--allow-remote-access`; this acknowledgement is never persisted. Remote listeners have no inbound authentication, so Docker/VM users must provide their own network isolation.
- **No CORS**: the proxy serves local developer tooling; the browser scenario is out of scope.
- **Bounded untrusted input**: request bodies, SSE frames, tool arguments, error bodies, and model metadata are subject to limits defined in `spec.md`; limits are checked before unbounded allocation or logging.

## 11. Extension Points

Reserved but **not implemented in v0.2**:

- **Multiple backends:** `config.provider` remains Copilot-only. A future backend must provide its own transport and capability source rather than weakening the live-metadata contract.
- **Additional protocol pairs:** Messages ↔ Chat Completions may be added as another explicit route-plan variant and closed mapping; v0.2 does not introduce a general canonical protocol.
- **Additional transports:** `ws:/responses` may be implemented separately; its advertisement never activates the HTTP Responses path.
- **Rate limiting / audit:** middleware slot reserved around request dispatch; not added in v0.2.

## 12. Test Strategy

- Pure mapper fixtures cover every accepted and rejected row in the spec mapping matrix, including base64 image mapping and local URL-image rejection.
- Continuation fixtures cover request-local staging, atomic publish only after response completion, discard before the commit point, repeated immutable lookup, non-streaming and streaming tool calls, completed reasoning-item capture, parallel calls, exact `call_id` reuse, expiry/eviction, restart loss, model mismatch, and cross-group rejection.
- Model catalog tests use captured `/models` fixtures plus malformed variants; production code never imports those fixtures.
- Route-planner table tests cover endpoint combinations, missing metadata, translator availability, and exact model-id preservation.
- SSE tests partition identical event bytes at every boundary, combine multiple frames per chunk, split UTF-8 code points, interleave multiple output items according to the probed event table, and reject missing `response.created`, conflicting item keys, incomplete items at response completion, and every undocumented transition.
- Transport tests use a local fake HTTP server to verify proactive auth, generation-scoped refresh single-flight and commit, per-waiter cancellation, independent manager deadlines, last-waiter abort, stale-result rejection, one 401 retry, definitive-versus-transient refresh classification, exact pre-execution re-plan signals, rejection of ambiguous replay, the three-model-invocation bound, deadline abort, and no downstream bytes before retry decisions complete.
- Models-route tests verify that external `GET /v1/models` remains byte-for-byte request-owned passthrough, does not join or publish `ModelCatalog` state, and can run concurrently with an independent catalog refresh.
- Native Responses route tests verify direct `/responses` invocation without catalog access, successful request/query/JSON/SSE byte preservation, safe non-2xx rewriting without 400 replay, and isolation from Messages translation and continuation state.
- Lifecycle tests force downstream backpressure and race success, timeout, upstream failure, and client disconnect while asserting one terminal action and complete listener/timer cleanup.
- End-to-end SDK tests verify observable success and error behavior through `@anthropic-ai/sdk`; live Copilot probes remain a separate acceptance gate and are recorded in `spec.md`.
- Security tests inject sentinel credentials into auth and upstream failures, then assert that no complete value or substring appears in output surfaces.

## 13. Known Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Copilot backend header format changes | Requests fail with 4xx | Header values live in `config.json`; users can override without code changes |
| Copilot API endpoint path changes (e.g., `/copilot_internal/v2/token`) | Requests fail with 404 / connection error | No config hook currently; requires a code change and release |
| device-code `client_id` revoked | Login fails | Allow users to configure their own OAuth App id |
| Windows chmod is a no-op | `auth.json` permissions relaxed | Documented; relies on the user profile directory ACL |
| Default `githubClientId` compliance | GitHub may restrict third-party use | Users can substitute their own OAuth App |
| `/models` metadata is missing or inconsistent | Valid models cannot be routed | One refresh, bounded-stale cache, explicit 502; never guess |
| Concurrent auth refreshes complete out of order | New token or validity state is overwritten | Generation-scoped single-flight and compare-before-commit |
| Copilot Responses differs from public OpenAI Responses | Translation fails or corrupts semantics | Live probes gate completion; observed shapes become spec fixtures |
| Required Responses continuation state is unavailable or expires | A tool-result turn cannot continue | Bounded local registry, authoritative completed items, explicit 400; never guess or depend silently on upstream storage |
| Unknown or reordered SSE events | Invalid Anthropic stream | Strict state machine, bounded buffers, fail closed with stream error |
| Slow or disconnected downstream accumulates translated output | Memory growth and wasted quota | Backpressure-aware writes, deadlines, bounded parser state, unified abort cleanup |
| Translation retry duplicates model execution | Duplicate model work or tool call | Retry only for 401 or probed pre-execution endpoint rejection; ambiguous failures are terminal; one coordinator caps total attempts |
