# copilot-relay — Specification (v0.1)

> Precise contract. All implementations must conform to this document; any divergence between code and this document is treated as a bug.

## 1. CLI Command Contracts

Behavior common to every command:
- Exit code `0` means success; `1` means an unexpected error; `2` means "feature not implemented".
- Log output and command-structured output both go to stdout (no file, no rotation); see §9.

### 1.1 `copilot-relay login [--no-open]`

- **Arguments**
  - `--no-open` (optional): do not auto-launch the browser.
- **Preconditions:** `config.githubClientId` is non-empty.
- **Behavior**
  1. `POST https://github.com/login/device/code` to obtain a `device_code`.
  2. Print `verification_uri` and `user_code` to stdout.
  3. By default, call `open(verification_uri)`.
  4. Poll `POST https://github.com/login/oauth/access_token` every `interval` seconds.
  5. Once `access_token` is obtained, call `GET https://api.github.com/copilot_internal/v2/token` to exchange it for a Copilot token; persist to [auth.json](#4-authjson).
- **Failure exit code:** 1 (device flow timeout, denial, etc.).

### 1.2 `copilot-relay logout`

- Delete `auth.json`. If the file does not exist, return 0 silently.

### 1.3 `copilot-relay status`

- stdout format:
  ```
  Config file: <path>
  {...cfg as JSON...}

  Auth file: <path>            # If not logged in, print "Auth: not logged in" and exit.
    github access token: <8 chars>...(hidden)
    copilot token expires: <ISO8601 | "none (...)">
    copilot api base: <url | "(default)">
    auth valid: <yes | no – <reason, e.g. "Copilot token exchange failed: 401 …" or "access_token missing, please re-login">>
  ```
- `auth valid` is `no` when the last refresh attempt failed (e.g., long-lived `access_token` revoked); otherwise `yes`.
- Exit code is always 0.

### 1.4 `copilot-relay start [--port N] [--log-level L]`

- **Arguments**
  - `-p, --port <int>`: overrides `config.port`.
  - `-l, --log-level <debug|info|warn|error>`: overrides `config.logLevel`.
- **Preconditions:** `auth.json` exists (otherwise exit 1 with message `Not logged in.`).
- **Behavior:** run in the foreground, listening on `127.0.0.1:<port>`; on `SIGINT`/`SIGTERM`, close the server, delete the pid file, and `exit 0`. Writes [server.pid](#6-serverpid).

### 1.5 `copilot-relay stop`

- Read the pid file → `process.kill(pid, 'SIGTERM')` → delete the pid file.
- If the file does not exist, print `No pid file; server not tracked as running.` and exit 0.

### 1.6 `copilot-relay config-show`

- The command internally forces the logger to `error` level so that stdout contains only the path + JSON, never interleaved with info/debug logs (`config-show | jq` is safe).
- Load config; if `config.json` does not exist, create it with defaults.
- Print the path and the current config JSON to stdout. Exit 0.

### 1.7 `copilot-relay configure claude [--port N]`

- **Arguments**
  - `-p, --port <int>` (optional): defaults to `config.port` (falling back to `5000`).
- **Side effect:** merges into `~/.claude/settings.json`.
- **Payload** (merged with existing keys; peer fields at the same level are not overwritten):
  ```json
  {
    "env": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:<port>",
      "ANTHROPIC_AUTH_TOKEN": "copilot-relay-dummy"
    }
  }
  ```
- If `ANTHROPIC_AUTH_TOKEN` already exists, its previous value is preserved.

> **Merge policy:** `ANTHROPIC_BASE_URL` is always overwritten with the current proxy address. `ANTHROPIC_AUTH_TOKEN` is preserved if already set; otherwise the placeholder `copilot-relay-dummy` is written. Peer fields at the same nesting level (top-level or other `env.*` keys) are not touched.

### 1.8 `copilot-relay configure codex`

- v0.1: print `Codex configuration is not implemented yet in v0.1.` and exit with code `2`.

## 2. HTTP Route Contracts

The server binds `127.0.0.1:<port>` (never `0.0.0.0`). `host` has no user-facing configuration hook (no override via `config.json`, environment variable, or CLI flag); it is a code-level constant only.

### 2.1 `GET /health`

- Response: `200 application/json`, body `{"ok": true}`.

### 2.2 `GET /v1/models`

- The request is proxied to `GET <copilotApiBase>/models` using the headers in §7.2 (excluding `Content-Type`, since GET has no body).
- Upstream 2xx: pass the body through to the client verbatim (shape is dictated by Copilot; typically `{ "object": "list", "data": [...] }`).
- Upstream non-2xx / upstream 401: handled per §2.6 / §2.7 (error shape uses the OpenAI classification; upstream 401 triggers one force-refresh + retry).
- Client disconnect: abort the upstream per §2.9.

> [!NOTE]
> Earlier v0.1 implementations returned a hard-coded 4-item list, which caused clients to show falsely-available models (e.g., `claude-3.5-sonnet`) in their pickers and then be rejected by upstream on `POST /v1/chat/completions`. Proxying keeps the list in sync with the subscription's actual endpoint (personal / enterprise) and removes the need for manual backfill.

### 2.3 `POST /v1/chat/completions` (also accepts `POST /chat/completions`)

> The `/v1/`-less variant is accepted for compatibility with OpenAI-compatible clients that hand-build the URL with `/chat/completions`. Behavior is identical on both routes.

- The request body is passed through to `<copilotApiBase>/chat/completions`.
- Upstream request headers: see §5.
- Supports `stream: true` (SSE); the response is piped through `Readable.fromWeb` without buffering.
- **Upstream non-2xx handling** — the upstream body must not be proxied verbatim. Rewrite to the OpenAI shape per §2.6 / §2.7.

### 2.4 `POST /v1/messages`

- The request body is passed through to `<copilotApiBase>/v1/messages`.
- Forwarded headers additionally include `anthropic-version` (defaulting to `2023-06-01` if absent inbound) and `anthropic-beta` (if present inbound).
- Otherwise the behavior matches §2.3.

### 2.5 Unmatched Routes

- Response: `404 application/json`, body
  `{"error": {"message": "No route for <METHOD> <PATH>"}}`.

### 2.6 Error Response Shapes (FR5)

Upstream Copilot non-2xx responses and locally-thrown exceptions are rewritten to the target route's protocol shape:

- OpenAI endpoints (`/v1/chat/completions`, `/chat/completions`, `/v1/models`):

  ```json
  { "error": { "type": "<class>", "message": "<...>", "code": "<upstream-code | null>" } }
  ```

- Anthropic endpoint (`/v1/messages`):

  ```json
  { "type": "error", "error": { "type": "<class>", "message": "<...>" } }
  ```

HTTP status code:
- If the upstream status can be classified (4xx/5xx), pass it through; if it cannot be classified or the error originated locally, respond with `502`.

`type` values follow the OpenAI error taxonomy: `invalid_request_error` / `authentication_error` / `permission_error` / `rate_limit_error` / `api_error`; fall back to `api_error` when uncertain. The same set is used for the Anthropic endpoint's `error.type`.

Unmatched routes (§2.5) also use a simplified OpenAI shape with `404`.

### 2.7 Upstream 401 Retry Contract (FR3 + FR5)

1. After the proxy sends a request to Copilot, if upstream returns `401` (and the proxy has not yet written the first response byte to the client):
   - Call `ensureCopilotToken({ force: true })` to force-refresh the Copilot token;
   - Retry the same upstream request once, using the new token.
2. If the retry still returns `401`, rewrite it per §2.6 and pass the 401 back to the client; also log a stdout hint to re-run `copilot-relay login`.
3. If the refresh itself fails (e.g., the long-lived `access_token` has been revoked), the current request responds with `401`. Only `lastRefreshError` is written to `auth.json`; the previously stored Copilot token fields (`copilotToken`, `copilotExpiresAt`, `copilotApiBase`) are left as-is. Subsequent `copilot-relay status` calls will report `auth valid: no`.

### 2.8 Mid-Stream Termination Sequence (FR6)

When the upstream errors mid-SSE, write a single error frame in the target protocol, then close the stream. Byte-level format:

> Notation: in the snippets below, `\n` denotes a single LF byte (0x0A), not the two-character sequence `\` + `n`. Blank lines within a frame are two consecutive LF bytes.

- **OpenAI endpoint** — write

  ```
  data: {"error":{"type":"<class>","message":"<...>","code":"<...>"}}\n\n
  ```

  then call `res.end()`. **Do not emit `data: [DONE]`** — SDKs treat `[DONE]` as normal completion and would swallow the error.

- **Anthropic endpoint** — write

  ```
  event: error\ndata: {"type":"error","error":{"type":"<class>","message":"<...>"}}\n\n
  ```

  then call `res.end()`.

### 2.9 Client Disconnect (FR6)

- Listen on `req.on("close")`. If the upstream `fetch` has not yet completed, call the corresponding `AbortController.abort()` to avoid wasting Copilot quota.
- Once the full response has been sent, the `close` event triggers no additional action.

## 3. Directory / File Paths

| Path | Purpose |
|---|---|
| `~/.copilot-relay/` | Data root directory; auto-created |
| `~/.copilot-relay/config.json` | User config (optional) |
| `~/.copilot-relay/auth.json` | Auth state; `chmod 0600` |
| `~/.copilot-relay/server.pid` | pid written by `start`, consumed by `stop` |

On Windows `~` = `%USERPROFILE%`. No `icacls` call is made — the file relies on the `%USERPROFILE%` directory's own ACL (aligned with requirement FR4 and design §7).

## 4. `auth.json` schema

```typescript
interface AuthState {
  accessToken: string;         // GitHub OAuth token (long-lived)
  copilotToken?: string;       // Short-lived Copilot token
  copilotExpiresAt?: number;   // Epoch seconds
  copilotApiBase?: string;     // e.g. "https://api.githubcopilot.com"
  lastRefreshError?: string;   // Reason for the last failed Copilot token exchange;
                               // cleared on success. Consumed by §11.1 isAuthValid
                               // and §1.3 status.
}
```

Refresh policy: refresh when `copilotExpiresAt * 1000 - Date.now() ≤ 5 * 60 * 1000` (i.e., remaining lifetime ≤ 5 minutes).

## 5. `config.json` schema

```typescript
interface AppConfig {
  port: number;                    // default: 5000
  logLevel: 'debug'|'info'|'warn'|'error';  // default: "info"
  githubClientId: string;          // default: "Iv1.b507a08c87ecfe98" (community OSS default; see requirement A2)
  editorVersion: string;           // default: "vscode/1.98.0"
  editorPluginVersion: string;     // default: "copilot-chat/0.20.0"
  copilotIntegrationId: string;    // default: "vscode-chat"
  userAgent: string;               // default: "GitHubCopilotChat/0.20.0"
  // intentionally no 'host' field: loopback-only; see requirement NFR7 / design §7.
}
```

Missing fields fall back to defaults; malformed JSON is treated as an empty file (no exception is thrown).

## 6. `server.pid`

- Contents: the process PID (decimal, no trailing newline enforced).
- Lifecycle: `start` writes it → the process removes it on normal exit or on SIGTERM → `stop` removes it as a fallback.
- If a stale pid (process already dead) causes `stop` to receive `ESRCH`, log a warning, delete the file, and exit 0.
- **`start` encounters an existing pid file:**
  - If `process.kill(pid, 0)` does not throw (the process is still alive) → print `Another copilot-relay instance appears to be running (pid=<N>). Use "copilot-relay stop" first.` to stdout and exit 1;
  - If it throws `ESRCH` (stale) → log a warning, overwrite the file, and continue starting.
- **Abnormal termination (SIGKILL, crash):** the pid file is left on disk. The next `start` (via the `ESRCH` branch above) or `stop` (via ESRCH → warn + delete) cleans it up. `status` does not currently inspect the pid file, so it will not detect a stale pid.

## 7. Upstream Request Headers

> [!NOTE]
> The default values listed here for `Editor-Version` / `Editor-Plugin-Version` / `Copilot-Integration-Id` / `User-Agent` (see [src/config.ts](../src/config.ts) `DEFAULT_CONFIG`) are reasonable guesses based on values used by public Copilot clients; they have not been verified against GitHub official documentation. If upstream returns 4xx (particularly 401 / 403 / 415), adjust these fields per the upstream response hint via `~/.copilot-relay/config.json` — no code change required. Once the working set of values is confirmed, sync them back into `DEFAULT_CONFIG` and this section.
>
> Additionally: the header sets listed in §7.1 (token exchange) and §7.2 (Copilot API calls) are not identical (§7.1 omits `Copilot-Integration-Id`); this split has not been verified against official documentation. Once the working set is confirmed, backfill this section with the actual required headers.

### 7.1 Copilot Token Exchange (`GET api.github.com/copilot_internal/v2/token`)

| Header | Value |
|---|---|
| `Authorization` | `token <accessToken>` |
| `Accept` | `application/json` |
| `User-Agent` | `<cfg.userAgent>` |
| `Editor-Version` | `<cfg.editorVersion>` |
| `Editor-Plugin-Version` | `<cfg.editorPluginVersion>` |

### 7.2 Copilot API Calls (`<copilotApiBase>/...`)

| Header | Value |
|---|---|
| `Authorization` | `Bearer <copilotToken>` |
| `Content-Type` | `application/json` |
| `User-Agent` | `<cfg.userAgent>` |
| `Editor-Version` | `<cfg.editorVersion>` |
| `Editor-Plugin-Version` | `<cfg.editorPluginVersion>` |
| `Copilot-Integration-Id` | `<cfg.copilotIntegrationId>` |
| `Openai-Intent` | `conversation-panel` (OpenAI path only) |
| `anthropic-version` | Inherited from inbound, or `2023-06-01` (Anthropic path only) |
| `anthropic-beta` | Inherited from inbound, optional (Anthropic path only) |
| `Accept` | Inherited from inbound `Accept` if present |

## 8. GitHub Device-Code Parameters

| Parameter | Value |
|---|---|
| device_code endpoint | `POST https://github.com/login/device/code` |
| access_token endpoint | `POST https://github.com/login/oauth/access_token` |
| grant_type | `urn:ietf:params:oauth:grant-type:device_code` |
| scope | `read:user` |
| `slow_down` backoff | `interval += 5s` |

Polling for longer than `expires_in` seconds without receiving a token is treated as failure.

## 9. Log Format

`[<ISO8601 timestamp>] [<LEVEL>] <message> <...args>`

All levels write to **stdout** (aligned with requirement NFR5; no file, no rotation). Token-bearing fields are truncated to the first 8 characters followed by `...(hidden)`.

## 10. Compatibility Matrix

| Node.js | Status |
|---|---|
| < 18 | Unsupported (missing `fetch` / `Readable.fromWeb`) |
| 18.x, 20.x, 22.x | Supported |

Platforms: Windows 10+, macOS 12+, Linux (glibc).

Platform floors derive from the Node.js LTS official platform-support matrices for versions 18/20/22; the project is not independently tested below these floors.

## 11. Internal API Contracts

Cross-module stable interfaces. The spec layer defines only the signatures and semantics; implementation file locations are in [design.md](./design.md) §2. Any symbol listed here must not change its signature without a synchronous update to this section.

### 11.1 `auth/copilot.ts`

```typescript
interface EnsureOptions {
  force?: boolean;  // true: ignore the 5-minute threshold and exchange a new token immediately
}

function ensureCopilotToken(cfg: AppConfig, opts?: EnsureOptions): Promise<AuthState>;
function loadAuth(): AuthState | null;
function saveAuth(state: AuthState): void;
function clearAuth(): void;
function isAuthValid(state: AuthState | null): boolean;
```

- `ensureCopilotToken`
  - If `loadAuth() == null`, throw `Error("Not logged in")`.
  - If `opts?.force !== true` and the state does not yet meet the §4 refresh condition (i.e., remaining lifetime > 5 minutes), return the cached state.
  - Otherwise, exchange a new Copilot token per §7.1, `saveAuth`, and return the updated state.
  - On exchange failure (any non-2xx from `GET copilot_internal/v2/token`, network error, timeout, upstream 5xx, revoked `access_token`, etc.), throw `Error` with a message of the form `Copilot token exchange failed: <status> <body>`. Only `lastRefreshError` is written to `auth.json`; the previously stored Copilot token fields (`copilotToken`, `copilotExpiresAt`, `copilotApiBase`) are left as-is, so subsequent `isAuthValid` calls return `false`.
  - v0.1 does not distinguish transient failures (network, upstream 5xx, rate limit) from permanent ones (revoked). Callers (`server.ts`, §11.3) treat any throw from `ensureCopilotToken` uniformly as an auth failure — respond `401` per §2.6 and hint at `copilot-relay login`. Finer-grained error classification is a v0.2+ improvement.
- `loadAuth`: returns `null` (never throws) if the file is missing or the JSON is malformed.
- `saveAuth`: writes `auth.json`. On Unix-like systems, `chmod 0600`. On Windows, no `icacls` call (§3).
- `clearAuth`: deletes `auth.json`; silent if the file does not exist.
- `isAuthValid`: consumed by §1.3 `status` for the `auth valid` field. Returns `true` if and only if `state != null && state.accessToken` is present **and** the last refresh attempt is not marked as failed.

### 11.2 `config.ts`

```typescript
const DATA_DIR: string;      // ~/.copilot-relay
const CONFIG_FILE: string;   // <DATA_DIR>/config.json
const AUTH_FILE: string;     // <DATA_DIR>/auth.json
const PID_FILE: string;      // <DATA_DIR>/server.pid
const DEFAULT_CONFIG: AppConfig;

function loadConfig(): AppConfig;
function saveConfigDefaults(): void;
```

- `loadConfig`: reads `CONFIG_FILE`; missing fields are merged from `DEFAULT_CONFIG` (§5); malformed JSON is treated as empty (no exception thrown).
- `saveConfigDefaults`: if `CONFIG_FILE` does not exist, create it with `DEFAULT_CONFIG` (used by §1.6 `config-show`).

### 11.3 `server.ts`

```typescript
function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: AppConfig
): Promise<void>;
```

- The request-dispatch entry point. Catches all exceptions and writes responses in the shape from §2.6.
- When `res.headersSent === true`: if the response is streaming, write the termination frame per §2.8 then call `res.end()`; otherwise, only log the error and write nothing further.
- Upstream 401 handling is defined in §2.7; client-disconnect handling in §2.9.
- Internally calls `ensureCopilotToken(cfg)`; failures are surfaced per §2.6.

### 11.4 `translate/{openai,anthropic}.ts`

Both translators export the same symbols (identical signatures, protocol-specific behavior):

```typescript
interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
}

function buildUpstreamRequest(
  inbound: http.IncomingMessage,
  cfg: AppConfig,
  auth: AuthState
): UpstreamRequest;

function formatError(
  errClass: string,   // A string from the OpenAI classification allowed by §2.6
  message: string,
  code?: string | null
): object;             // Returns the JSON body shape from §2.6 for the respective protocol
                       // (OpenAI: `{error: {type, message, code}}`;
                       //  Anthropic: `{type: "error", error: {type, message}}`).
                       // Not JSON-stringified.

function writeStreamErrorFrame(
  res: http.ServerResponse,
  err: { class: string; message: string; code?: string | null }
): void;                // Writes the byte-level format from §2.8; internally calls res.end()
```

- `buildUpstreamRequest`: assembles the URL and headers only; does not initiate `fetch`. Header set per §7.2.
- `formatError`: returns the JSON body object.
- `writeStreamErrorFrame`: idempotent — after the first call, `res.writableEnded` is true and subsequent calls return immediately.

### 11.5 `logger.ts`

```typescript
type LogLevel = "debug" | "info" | "warn" | "error";

interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  setLevel(l: LogLevel): void;
}
```

- Exported as a singleton. All levels write to **stdout** (§9); format per §9.
- Token redaction (first 8 characters + `...(hidden)`) is the caller's responsibility; the logger does no regex scanning.
