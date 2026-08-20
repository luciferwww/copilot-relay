# copilot-relay — Requirements (v0.1)

> Status: draft, aligned with the v0.1 MVP agreed 2026-07-23.

## 1. Background

A growing number of third-party AI agents (Claude Code, Codex CLI, in-house agents, and so on) use the OpenAI (`/v1/chat/completions`) or Anthropic (`/v1/messages`) HTTP APIs as their model-access protocol. To let these agents reuse the models behind a GitHub Copilot subscription, we need a local proxy that translates OpenAI / Anthropic requests to Copilot's upstream protocol and handles GitHub authentication plus short-lived Copilot token refresh.

Existing solutions leave a gap:

- GitHub does not officially provide a standalone Copilot model proxy for third-party agents.
- Extensions such as Copilot Chat bind this capability to the editor process, so CLIs and background services cannot use it directly.

This project provides a **standalone, VS Code-independent** local CLI proxy so any agent that speaks OpenAI or Anthropic APIs can use the user's own GitHub Copilot subscription. The focus is personal use. Implementation relies on the public GitHub Copilot HTTP protocol only.

## 2. Goals

- **G1.** Provide a local HTTP service exposing OpenAI-compatible (`/v1/chat/completions`) and Anthropic-compatible (`/v1/messages`) APIs, backed by GitHub Copilot.
- **G2.** Run independently of VS Code: no dependency on the `vscode` module or the Copilot Chat extension. Pure Node.js CLI.
- **G3.** Support streaming responses (SSE).
- **G4.** Support the GitHub device-code login flow; own and auto-refresh the short-lived Copilot token.
- **G5.** Provide one-command configuration of the target client (v0.1 supports Claude Code only).

## 3. Non-Goals

- **N1.** v0.1 targets the GitHub Copilot backend only; no other providers.
- **N2.** No telemetry or usage reporting.
- **N3.** No automatic version check or auto-update.
- **N4.** No graphical UI.
- **N5.** No inbound authentication (API key / mTLS / etc.); v0.1 relies on loopback isolation to guarantee that only local processes can reach the proxy (see NFR7).

## 4. User Stories

- **US1.** As a Copilot subscriber, I want Claude Code CLI to access Claude models through my Copilot subscription without buying a separate Anthropic API key.
- **US2.** As a developer, I want to start a local proxy and point any OpenAI-compatible SDK at `http://127.0.0.1:5000` to use Copilot models.
- **US3.** As an end user, I want the first-time login to use the device-code flow so I never paste tokens by hand.
- **US4.** I want the proxy to refresh the token automatically before it expires, without interrupting my requests.
- **US5.** I want `copilot-relay status` to quickly show the current auth state and token expiry.

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

> Default listen port is `5000`, overridable with `--port`. The listen host defaults to `127.0.0.1`, overridable with `--host` or the `host` config field (see NFR7).

### FR2. HTTP Routes

| Route | Required |
|---|---|
| `POST /v1/chat/completions` (OpenAI; streaming supported) | ✅ |
| `POST /v1/responses` (OpenAI Responses API; streaming supported) | ✅ |
| `POST /v1/messages` (Anthropic; streaming supported) | ✅ |
| `GET /v1/models` (proxied from upstream) | ✅ |
| `GET /health` | ✅ |

### FR3. Authentication

- Use the GitHub OAuth **device-code** flow to obtain a long-lived access token.
- Use that access token against `GET https://api.github.com/copilot_internal/v2/token` to obtain a short-lived Copilot token (`expires_at` is typically 30 minutes).
- Refresh the Copilot token automatically when its remaining lifetime is ≤ 5 minutes.
- If refresh fails (e.g., the long-lived access token has been revoked), respond to the current request with 401, mark auth as invalid in `copilot-relay status`, and prompt the user to re-run `copilot-relay login`.

### FR4. Persistence

- Config: `~/.copilot-relay/config.json`
- Auth state: `~/.copilot-relay/auth.json`. On Unix-like systems, `chmod 0600`. On Windows, no `icacls` call — the file relies on the `%USERPROFILE%` directory's own ACL.
- PID file: `~/.copilot-relay/server.pid`

### FR5. Error Mapping

Errors returned by upstream Copilot must be rewritten to match the client's protocol shape:

- OpenAI endpoints (`/v1/chat/completions`, `/chat/completions`, `/v1/models`) return
  `{ error: { type, message, code } }`.
- OpenAI Responses endpoint (`/v1/responses`) returns
  `{ error: { code, message, param, type } }` (`param` always `null`).
- Anthropic endpoint (`/v1/messages`) returns
  `{ type: "error", error: { type, message } }`.

Pass the upstream HTTP status through where possible; when unclassifiable, use `502`.

**Handling upstream 401:** the Copilot token may be invalidated by upstream (rotation or revocation) before its local expiry threshold triggers a refresh. On an upstream 401, the proxy force-refreshes the Copilot token once and retries the original request; a second 401 is then rewritten per the shapes above and passed to the client, and the log hints at re-running `copilot-relay login`. Retry is only allowed before the first upstream response byte arrives — if SSE forwarding has already begun, do not retry; terminate the stream per FR6.

### FR6. Request Lifecycle

- When the client disconnects, the proxy must abort the upstream request (to avoid wasting Copilot quota).
- If the upstream errors mid-stream, terminate the response per the client protocol:
  - OpenAI: emit a `data: {"error": {...}}\n\n` chunk then close the stream. **Do not emit `data: [DONE]`** — SDKs treat `[DONE]` as normal completion and would swallow the error.
  - OpenAI Responses: emit an `event: error\ndata: {"code":...,"message":...,"param":null,"type":...}\n\n` frame then close the stream.
  - Anthropic: emit `event: error\ndata: {"type":"error","error":{...}}\n\n` then close the stream.
- The termination sequences above must produce observable errors in the `openai` and `@anthropic-ai/sdk` clients — the error must not be silently swallowed as a normal end-of-stream.

## 6. Non-Functional Requirements

- **NFR1 — Platform:** Windows / macOS / Linux fully supported, Node.js ≥ 18 (for native `fetch`).
- **NFR2 — Dependencies:** Keep runtime dependencies minimal (currently `commander`, `open`). The authoritative list is the `dependencies` field of `package.json`.
- **NFR3 — Startup latency:** No specific threshold is defined for v0.1. Egregious regressions block release; otherwise treated case-by-case.
- **NFR4 — Proxy overhead:** The proxy layer must not buffer streaming responses and must not perform extra data copying. No specific time-to-first-byte threshold is defined for v0.1.
- **NFR5 — Security & logging:** `auth.json` has restrictive permissions; tokens must never appear in logs (even at `--log-level debug`, only the first 8 characters are printed). Logs go to stdout only — no file, no rotation.
- **NFR6 — Portability:** 100% TypeScript. A single `tsc` build produces artifacts runnable via `node dist/cli.js`; no loader or bundler is used.
- **NFR7 — Bind address:** Default to `127.0.0.1` only — no LAN exposure out of the box, so other hosts cannot use someone's token. The default is overridable via `config.json`'s `host` field or the `start --host` flag so users can bind `0.0.0.0` (or a specific interface) when they explicitly want LAN access; anyone doing so accepts that the proxy exposes the Copilot token to whoever can reach it. There is no inbound authentication or TLS (§N5); LAN use is not recommended.

## 7. Constraints and Assumptions

- **A1.** The Copilot HTTP protocol (`api.githubcopilot.com`) request-header format is assumed stable within the project's development window. If upstream changes, header values (`Editor-Version`, etc.) are configurable and require no code changes.
- **A2.** The default `githubClientId` uses the widely-used public value found in existing community open-source Copilot clients. Users can substitute their own OAuth App id.
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
