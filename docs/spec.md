# copilot-relay — Specification (v0.1)

> 精确契约。所有实现必须与本文件一致;若代码与本文件不符视为 bug。

## 1. CLI 命令契约

所有命令的通用行为:
- 退出码 `0` 表示成功;`1` 表示未预期错误;`2` 表示"功能未实现"。
- 日志与命令结构化输出统一走 stdout(不落盘、不轮转);参见 §9。

### 1.1 `copilot-relay login [--no-open]`

- **参数**
  - `--no-open`(可选):不自动打开浏览器。
- **前置**:`config.githubClientId` 非空。
- **行为**
  1. `POST https://github.com/login/device/code` 换取 device_code。
  2. 在 stdout 打印 `verification_uri` 和 `user_code`。
  3. 默认调用 `open(verification_uri)`。
  4. 每 `interval` 秒轮询 `POST https://github.com/login/oauth/access_token`。
  5. 拿到 `access_token` 后,`GET https://api.github.com/copilot_internal/v2/token`
     换取 Copilot token,写入 [auth.json](#4-authjson)。
- **失败退出码**:1(device flow 超时、被拒等)。

### 1.2 `copilot-relay logout`

- 删除 `auth.json`。文件不存在时静默返回 0。

### 1.3 `copilot-relay status`

- stdout 输出:
  ```
  Config file: <path>
  {...cfg as JSON...}

  Auth file: <path>            # 未登录时打印 "Auth: not logged in" 并退出
    github access token: <8 chars>...(hidden)
    copilot token expires: <ISO8601 | "none (...)">
    copilot api base: <url | "(default)">
    auth valid: <yes | no – <reason,如 "access_token revoked, please re-login">>
  ```
- `auth valid` 在上次刷新尝试失败(长期 access_token 被 revoke 等)时为 `no`,
  否则为 `yes`。
- 退出码始终为 0。

### 1.4 `copilot-relay start [--port N] [--log-level L]`

- **参数**
  - `-p, --port <int>`:覆盖 `config.port`。
  - `-l, --log-level <debug|info|warn|error>`:覆盖 `config.logLevel`。
- **前置**:auth.json 存在(否则 exit 1,错误消息 `Not logged in.`)。
- **行为**:前台运行,监听 `127.0.0.1:<port>`;`SIGINT`/`SIGTERM` 时关闭
  server、删除 pid 文件、exit 0。写入 [server.pid](#6-serverpid)。

### 1.5 `copilot-relay stop`

- 读 pid 文件 → `process.kill(pid, 'SIGTERM')` → 删除 pid 文件。
- 文件不存在时 stdout 打印 `No pid file; server not tracked as running.`,
  退出 0。

### 1.6 `copilot-relay config-show`

- 命令内部强制将 logger 降至 `error` 级,以保证 stdout 只含路径 + JSON,
  不会被 info/debug 日志夹杂(`config-show | jq` 可安全使用)。
- 载入 config,若 `config.json` 不存在则用默认值 create 之。
- stdout 打印路径 + 当前配置 JSON。退出 0。

### 1.7 `copilot-relay configure claude [--port N]`

- **参数**
  - `-p, --port <int>`(可选):缺省时读 `config.port`,默认 `5000`。
- **副作用**:合并写入 `~/.claude/settings.json`。
- **写入内容**(与已有 keys 合并,不覆盖同层其他字段):
  ```json
  {
    "env": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:<port>",
      "ANTHROPIC_AUTH_TOKEN": "copilot-relay-dummy"
    }
  }
  ```
- 若已有 `ANTHROPIC_AUTH_TOKEN` 则保留原值。

### 1.8 `copilot-relay configure codex`

- v0.1:打印错误 `Codex configuration is not implemented yet in v0.1.`,
  退出码 `2`。

## 2. HTTP 路由契约

服务器 bind `127.0.0.1:<port>`(不绑 0.0.0.0)。`host` 无对外配置入口
(config.json / 环境变量 / CLI flag 均不可覆盖),仅为代码常量。

### 2.1 `GET /health`

- Response: `200 application/json` body `{"ok": true}`。

### 2.2 `GET /v1/models`

- Response: `200 application/json`,body:
  ```json
  {
    "object": "list",
    "data": [
      { "id": "gpt-4o",             "object": "model", "owned_by": "github-copilot" },
      { "id": "gpt-4o-mini",        "object": "model", "owned_by": "github-copilot" },
      { "id": "claude-3.5-sonnet",  "object": "model", "owned_by": "github-copilot" },
      { "id": "claude-sonnet-4",    "object": "model", "owned_by": "github-copilot" }
    ]
  }
  ```
- 列表**硬编码**,不代表 Copilot 实际支持,仅供客户端探测。

> [!NOTE]
> 这 4 个 id 是探测性占位。真跑通首次请求后,请把 Copilot 后端**实际接受**的 model slug 回写到本节和 [src/server.ts](../src/server.ts) 中 `/v1/models` 的返回值,保持文档与代码一致。

### 2.3 `POST /v1/chat/completions` (亦接受 `POST /chat/completions`)

> 兼容无 `/v1/` 前缀的写法,以适配部分直接拼 `/chat/completions` 的
> OpenAI-兼容客户端。两条路由行为完全一致。

- 请求体透传给 `<copilotApiBase>/chat/completions`。
- 上游请求头(见 §5)。
- 支持 `stream: true`(SSE),响应流经 `Readable.fromWeb` 管道输出,不缓冲。
- **上游非 2xx 处理**——严禁原样透传上游 body。按 §2.6/§2.7 重写为
  OpenAI shape。

### 2.4 `POST /v1/messages`

- 请求体透传给 `<copilotApiBase>/v1/messages`。
- 转发头额外包含从入站请求继承的 `anthropic-version`(缺省 `2023-06-01`)和
  `anthropic-beta`(若存在)。
- 其余行为同 §2.3。

### 2.5 未匹配路由

- Response: `404 application/json` body
  `{"error": {"message": "No route for <METHOD> <PATH>"}}`。

### 2.6 错误响应形状 (FR5)

上游 Copilot 非 2xx 或本地异常按路由目标协议 shape 重写:

- OpenAI 端(`/v1/chat/completions`、`/chat/completions`、`/v1/models`):

  ```json
  { "error": { "type": "<class>", "message": "<...>", "code": "<upstream-code | null>" } }
  ```

- Anthropic 端(`/v1/messages`):

  ```json
  { "type": "error", "error": { "type": "<class>", "message": "<...>" } }
  ```

HTTP 状态码:
- 上游能分类(4xx/5xx)时尽量透传;无法分类或代理侧本地异常统一为 `502`。

`type` 取值参照 OpenAI 官方错误分类:`invalid_request_error` /
`authentication_error` / `permission_error` / `rate_limit_error` / `api_error`;
无法判定时统一用 `api_error`。Anthropic 端同样以上错误类型作
`error.type`。

未匹配路由(§2.5) 仍采用简化的 OpenAI shape 回 `404`。

### 2.7 上游 401 重试契约 (FR3 + FR5)

1. 代理向 Copilot 发请求后若上游返回 `401`(且尚未开始向客户端输出
   首个响应字节):
   - 调用 `ensureCopilotToken({ force: true })` 强制刷新一次 Copilot token;
   - 以新 token 重试同一上游请求一次。
2. 重试后若仍为 `401`,按 §2.6 shape 将 401 回给客户端,同时向 stdout
   日志提示重跑 `copilot-relay login`。
3. 若刷新本身失败(长期 access_token 被 revoke 等):当前请求回 `401`,
   `auth.json` 中 refreshed 字段不覆写,后续 `copilot-relay status` 的
   `auth valid` 为 `no`。

### 2.8 流式中途终止序列 (FR6)

SSE 中途上游报错时按对应协议写入一个错误帧后关流。字节级格式:

- **OpenAI 端** —— 写入

  ```
  data: {"error":{"type":"<class>","message":"<...>","code":"<...>"}}\n\n
  ```

  后 `res.end()`。**不发 `data: [DONE]`**——SDK 会把 `[DONE]` 当成正常结束
  而吞错。

- **Anthropic 端** —— 写入

  ```
  event: error\ndata: {"type":"error","error":{"type":"<class>","message":"<...>"}}\n\n
  ```

  后 `res.end()`。

### 2.9 客户端断开 (FR6)

- 监听 `req.on("close")`。若上游 fetch 尚未完成,调用对应的
  `AbortController.abort()`,避免白烧 Copilot 额度。
- 已发完完整响应时 close 事件不触发额外动作。

## 3. 目录/文件路径

| 路径 | 用途 |
|---|---|
| `~/.copilot-relay/` | 数据根目录,自动创建 |
| `~/.copilot-relay/config.json` | 用户配置(可选) |
| `~/.copilot-relay/auth.json` | 认证态,chmod 0600 |
| `~/.copilot-relay/server.pid` | `start` 命令的 pid,`stop` 使用 |

Windows 下 `~` = `%USERPROFILE%`。不额外调用 `icacls`,依赖
`%USERPROFILE%` 目录本身的 ACL(与 requirement FR4、design §7 对应)。

## 4. `auth.json` schema

```typescript
interface AuthState {
  accessToken: string;         // GitHub OAuth token (long-lived)
  copilotToken?: string;       // 短期 Copilot token
  copilotExpiresAt?: number;   // epoch 秒
  copilotApiBase?: string;     // e.g. "https://api.githubcopilot.com"
}
```

刷新策略:当 `copilotExpiresAt * 1000 - Date.now() ≤ 5 * 60 * 1000` 时刷新。

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

缺失字段 fallback 到默认;非法 JSON 视为空文件,不抛异常。

## 6. `server.pid`

- 内容:进程 PID(十进制,无换行强制)。
- 生命周期:`start` 写入 → 进程正常退出/收到 SIGTERM 时删除 → `stop` 兜底删除。
- 陈旧 pid(进程已死)导致 `stop` 收到 `ESRCH` 时,打印 warn 后删除文件,
  退出 0。
- **`start` 遇到已存在的 pid 文件**:
  - 若 `process.kill(pid, 0)` 不抛(进程仍存活) → stdout 提示
    `Another copilot-relay instance appears to be running (pid=<N>). Use "copilot-relay stop" first.`,
    exit 1;
  - 若抛 `ESRCH`(陈旧) → 打印 warn 后覆写,继续启动。

## 7. 上游请求头

> [!NOTE]
> 本节所列 `Editor-Version` / `Editor-Plugin-Version` / `Copilot-Integration-Id` / `User-Agent` 的**默认值**(见 [src/config.ts](../src/config.ts) `DEFAULT_CONFIG`)是按公开 Copilot 客户端的常见值填的合理猜测,未与 GitHub 官方核对。若上游返回 4xx(尤其 401/403/415),优先按上游响应中的提示调整这几个字段,通过用户级 `~/.copilot-relay/config.json` 覆盖即可,不必改代码。首次调通后,请把最终生效的值同步回 `DEFAULT_CONFIG` 和本节。
>
> 另外:§7.1(换 token)与 §7.2(调 Copilot API)列出的 header 集合不完全相同(§7.1 未列 `Copilot-Integration-Id`),未与官方核对;首次调通后以实际成功集合为准回填。

### 7.1 换 Copilot token (`GET api.github.com/copilot_internal/v2/token`)

| Header | Value |
|---|---|
| `Authorization` | `token <accessToken>` |
| `Accept` | `application/json` |
| `User-Agent` | `<cfg.userAgent>` |
| `Editor-Version` | `<cfg.editorVersion>` |
| `Editor-Plugin-Version` | `<cfg.editorPluginVersion>` |

### 7.2 调用 Copilot API (`<copilotApiBase>/...`)

| Header | Value |
|---|---|
| `Authorization` | `Bearer <copilotToken>` |
| `Content-Type` | `application/json` |
| `User-Agent` | `<cfg.userAgent>` |
| `Editor-Version` | `<cfg.editorVersion>` |
| `Editor-Plugin-Version` | `<cfg.editorPluginVersion>` |
| `Copilot-Integration-Id` | `<cfg.copilotIntegrationId>` |
| `Openai-Intent` | `conversation-panel` (仅 OpenAI 路径) |
| `anthropic-version` | 继承入站或 `2023-06-01`(仅 Anthropic 路径) |
| `anthropic-beta` | 继承入站(可选,仅 Anthropic 路径) |
| `Accept` | 继承入站 `Accept`(若存在) |

## 8. GitHub Device-Code 参数

| 参数 | 值 |
|---|---|
| device_code endpoint | `POST https://github.com/login/device/code` |
| access_token endpoint | `POST https://github.com/login/oauth/access_token` |
| grant_type | `urn:ietf:params:oauth:grant-type:device_code` |
| scope | `read:user` |
| `slow_down` 退避 | `interval += 5s` |

轮询超过 `expires_in` 秒仍未拿到 token 视为失败。

## 9. 日志格式

`[<ISO8601 timestamp>] [<LEVEL>] <message> <...args>`

所有 level 写 **stdout**(与 requirement NFR5 对应,不落盘、不轮转)。
Token 相关字段最多输出前 8 字符 + `...(hidden)`。

## 10. 兼容矩阵

| Node.js | 状态 |
|---|---|
| < 18 | 不支持(缺 `fetch` / `Readable.fromWeb`) |
| 18.x, 20.x, 22.x | 支持 |

平台: Windows 10+, macOS 12+, Linux (glibc)。

## 11. 内部 API 契约

跨模块的稳定接口。规格层只定义签名与语义,实现文件位置见
[design.md](./design.md) §2。凡是本节列出的名字,任何模块均不得改签名而不
同步更新本节。

### 11.1 `auth/copilot.ts`

```typescript
interface EnsureOptions {
  force?: boolean;  // true: 无视 5 min 阈值,立即向上游换新 token
}

function ensureCopilotToken(cfg: AppConfig, opts?: EnsureOptions): Promise<AuthState>;
function loadAuth(): AuthState | null;
function saveAuth(state: AuthState): void;
function clearAuth(): void;
function isAuthValid(state: AuthState | null): boolean;
```

- `ensureCopilotToken`
  - 若 `loadAuth() == null` → 抛 `Error("Not logged in")`。
  - 若 `opts?.force !== true` 且 `copilotExpiresAt * 1000 - Date.now() > 5 * 60 * 1000`
    → 返回缓存 state。
  - 否则按 §7.1 换新 Copilot token,`saveAuth`,返回更新后的 state。
  - 换 token 失败(长期 access_token 被 revoke) → 抛
    `Error("access_token revoked")`,**`auth.json` 不覆写**,后续 `isAuthValid` 应为 `false`。
- `loadAuth`:文件不存在或 JSON 非法 → `null`(不抛)。
- `saveAuth`:写 `auth.json`,类 Unix 上 `chmod 0600`;Windows 不额外调
  `icacls`(§3)。
- `clearAuth`:删除 `auth.json`,不存在时静默。
- `isAuthValid`:供 §1.3 `status` 的 `auth valid` 字段使用;
  当且仅当 `state != null && state.accessToken` 存在且**上一次刷新未标记失败**
  时返回 `true`。

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

- `loadConfig`:读 `CONFIG_FILE`;缺失字段合并 `DEFAULT_CONFIG`(§5);
  非法 JSON 视为空,不抛。
- `saveConfigDefaults`:若 `CONFIG_FILE` 不存在则以 `DEFAULT_CONFIG` 创建
  (供 §1.6 `config-show` 使用)。

### 11.3 `server.ts`

```typescript
function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: AppConfig
): Promise<void>;
```

- 路由分发入口。捕获所有异常并按 §2.6 shape 写响应。
- `res.headersSent === true` 时:若为流式则按 §2.8 写终止帧后 `res.end()`;
  否则仅日志记录、不再写入。
- 上游 401 处理见 §2.7;客户端断开处理见 §2.9。
- 内部调用 `ensureCopilotToken(cfg)`,失败按 §2.6 回错。

### 11.4 `translate/{openai,anthropic}.ts`

每个 translator 导出同名符号(签名一致,行为按各自协议):

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
  errClass: string,   // §2.6 允许的 OpenAI 分类字符串
  message: string,
  code?: string | null
): object;             // 未 stringify;shape 按各自协议(§2.6)

function writeStreamErrorFrame(
  res: http.ServerResponse,
  err: { class: string; message: string; code?: string | null }
): void;                // 按 §2.8 字节格式写入,内部调用 res.end()
```

- `buildUpstreamRequest`:仅装配 URL + header,不发起 fetch。header 集合
  按 §7.2。
- `formatError`:返回 JSON body 对象。
- `writeStreamErrorFrame`:幂等——首次调用后 `res.writableEnded` 为 true,
  后续调用直接返回。

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

- 单例导出。所有 level 写 **stdout**(§9);格式见 §9。
- Token 脱敏(前 8 字符 + `...(hidden)`)由调用方保证,logger 不做正则扫描。
