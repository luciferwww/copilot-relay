# copilot-relay — Requirements (v0.1)

> Status: draft, aligned with the v0.1 MVP agreed 2026-07-23.

## 1. 背景

越来越多第三方 AI Agent(如 Claude Code、Codex CLI、以及自研 agent)以
OpenAI (`/v1/chat/completions`) 或 Anthropic (`/v1/messages`) 兼容 API 作为
模型接入协议。要让这些 agent 复用 GitHub Copilot 订阅背后的模型能力,
需要一个能把 OpenAI / Anthropic 请求翻译到 Copilot 后端协议、并处理
GitHub 认证与短期 token 刷新的本地代理。

现有方案存在缺口:

- GitHub 官方未提供独立的、面向第三方 agent 的 Copilot 模型代理。
- Copilot Chat 等 VS Code 扩展把该能力绑死在编辑器进程内,无法给
  CLI / 后台服务直接使用。

本项目提供一个**独立、无 VS Code 依赖**的本地 CLI 代理,让任何支持
OpenAI / Anthropic API 的第三方 agent 都能通过用户自己的 GitHub Copilot
订阅调用模型,专注个人使用场景。实现基于公开的 GitHub Copilot HTTP
协议独立完成。

## 2. 目标 (Goals)

- G1. 以本地 HTTP 服务形式提供 OpenAI (`/v1/chat/completions`) 和
  Anthropic (`/v1/messages`) 兼容 API,后端为 GitHub Copilot。
- G2. 独立于 VS Code 运行:不依赖 `vscode` 模块、不依赖 Copilot Chat 扩展,
  纯 Node.js CLI。
- G3. 支持流式响应(SSE)。
- G4. 支持 GitHub device-code 登录流程,自持并自动刷新 Copilot 短期 token。
- G5. 提供一键配置目标客户端(v0.1 仅 Claude Code)。

## 3. 非目标 (Non-Goals)

- N1. v0.1 仅支持 GitHub Copilot 后端,不扩展到其他提供商。
- N2. 不实现遥测 / 使用量上报。
- N3. 不实现自动版本检查、自动更新。
- N4. 不提供图形界面。
- N5. 不实现入站鉴权(API key / mTLS 等);v0.1 依赖 loopback 隔离保证
  只有本机进程能调用代理(见 NFR7)。

## 4. 用户故事 (User Stories)

- **US1**:作为 Copilot 订阅用户,我想让 Claude Code CLI 通过我的 Copilot
  订阅访问 Claude 模型,无需另买 Anthropic API key。
- **US2**:作为开发者,我想在本机启动一个代理,把所有 OpenAI 兼容 SDK 指到
  `http://127.0.0.1:5000` 就能用上 Copilot 模型。
- **US3**:作为终端用户,我希望首次登录用 device-code 流程,不必手工粘贴
  token。
- **US4**:我希望 token 到期时代理自动刷新,不打断我的请求。
- **US5**:我希望能通过 `copilot-relay status` 快速知道当前认证状态和 token
  过期时间。

## 5. 功能需求 (Functional)

### FR1. CLI 命令

| 命令 | 必需 |
|---|---|
| `copilot-relay login` | ✅ |
| `copilot-relay logout` | ✅ |
| `copilot-relay status` | ✅ |
| `copilot-relay start [--port] [--log-level]` | ✅ |
| `copilot-relay stop` | ✅ |
| `copilot-relay config-show` | ✅ |
| `copilot-relay configure claude` | ✅ |
| `copilot-relay configure codex` | ⏳ v0.2 |

> 默认监听端口 `5000`,可用 `--port` 覆盖;监听地址固定 `127.0.0.1`(见 NFR7)。

### FR2. HTTP 路由

| 路由 | 必需 |
|---|---|
| `POST /v1/chat/completions` (OpenAI, 支持流式) | ✅ |
| `POST /v1/messages` (Anthropic, 支持流式) | ✅ |
| `GET  /v1/models` (硬编码列表,不回源) | ✅ |
| `GET  /health` | ✅ |

### FR3. 认证

- 使用 GitHub OAuth **device-code** flow 获取长期 access_token。
- 用 access_token 调用 `GET https://api.github.com/copilot_internal/v2/token`
  换取短期 Copilot token(`expires_at` 通常 30 分钟)。
- Copilot token 距过期 ≤ 5 分钟时自动刷新。
- 刷新失败(长期 access_token 被 revoke 等)时,请求返回 401,并在
  `copilot-relay status` 中标记认证失效,提示重跑 `copilot-relay login`。

### FR4. 持久化

- 配置: `~/.copilot-relay/config.json`
- 认证态: `~/.copilot-relay/auth.json`。类 Unix 上 `chmod 0600`;Windows 上不
  额外调用 `icacls`,依赖 `%USERPROFILE%` 目录本身的 ACL。
- PID 文件: `~/.copilot-relay/server.pid`

### FR5. 错误映射

上游 Copilot 返回的错误按客户端协议 shape 转换:

- OpenAI 端(`/v1/chat/completions`、`/v1/models`)返回
  `{ error: { type, message, code } }`。
- Anthropic 端(`/v1/messages`)返回
  `{ type: "error", error: { type, message } }`。

HTTP 状态码尽量透传;无法分类时统一为 `502`。

**上游 401 处理**:Copilot token 可能在未到刷新阈值前被上游作废(轮换 /
撤销)。遇到上游 401 时,代理强制刷新一次 Copilot token 并重试原请求;
二次仍 401 才按上述 shape 透传给客户端,同时在日志中提示重跑
`copilot-relay login`。重试仅允许在上游首个响应到达前发生;若 SSE 已开始转
发则不重试,直接按 FR6 终止流。

### FR6. 请求生命周期

- 客户端断开连接时代理应 abort 上游请求(避免白烧 Copilot 额度)。
- 流式响应中途上游报错时按对应协议终止:
  - OpenAI 端发一个 `data: {"error": {...}}\n\n` chunk 后直接关流,
    **不再发 `data: [DONE]`**(SDK 会将 `[DONE]` 视为正常结束并吞掉错误)。
  - Anthropic 端发 `event: error` 后关流。
- 实现前需实测 `openai` / `@anthropic-ai/sdk` 对上述终止序列的行为,避免
  SDK 静默吞错。

## 6. 非功能需求 (Non-Functional)

- **NFR1 - 平台**:Windows / macOS / Linux 全支持,Node.js ≥ 18(原生 `fetch`)。
- **NFR2 - 依赖**:runtime 依赖保持极小(当前仅 `commander`、`open`);
  权威清单以 `package.json` 的 `dependencies` 为准。
- **NFR3 - 启动时延**:`copilot-relay start` 定性目标“快”(近似普通 Node CLI),
  不作具体毫秒阈值承诺。
- **NFR4 - 代理开销**:代理层对流式响应不做缓冲,无额外拷贝;不对首字节
  延时作具体毫秒承诺。
- **NFR5 - 安全 与 日志**:auth.json 权限收窄;token 不进日志(即使
  `--log-level debug` 也只打印前 8 字符)。日志写 stdout,不落盘、不轮转。
- **NFR6 - 可移植性**:所有代码 100 % TypeScript,`tsc` 一次编译产出即可
  `node dist/cli.js` 运行,不使用 loader / bundler。
- **NFR7 - 绑定地址**:仅监听 `127.0.0.1`,不支持 `0.0.0.0` 或外网 IP;
  同局域网内其他主机应无法连接。`host` 不开放为可配项(config.json /
  环境变量 / CLI flag 均不可覆盖);需要 LAN 访问属 v0.1 外场景,自行 fork。

## 7. 约束与假设

- **A1**:Copilot HTTP 协议 (`api.githubcopilot.com`) 请求头格式在本项目
  开发周期内保持稳定。若上游变更,请求头(`Editor-Version` 等)通过
  配置文件可覆盖,无需改代码。
- **A2**:默认 `githubClientId` 采用社区已有 OSS Copilot 客户端普遍使用的
  公开值;用户可换成自己的 OAuth App id。
- **C1**:必须遵守 GitHub Copilot 订阅协议,不得共享 token、不得将本项目用于
  未授权的商用转售。

## 8. 验收标准 (Acceptance Criteria)

- AC1. `npm install && npm run build && node dist/cli.js --help` 能列出所有命令。
- AC2. `node dist/cli.js login` 引导用户完成 device-code 登录,并把 auth.json
       写盘。
- AC3. `node dist/cli.js start` 后,`curl http://127.0.0.1:<默认端口>/health` 返回
       `{"ok":true}`。
- AC4. 选一个 `/v1/models` 返回的 `id`(以下以 `<model-id>` 为占位),执行
       `curl -N -H 'Content-Type: application/json' \
         -d '{"model":"<model-id>","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
         http://127.0.0.1:<默认端口>/v1/chat/completions` 能逐块收到 SSE 响应。
- AC5. 将 auth.json 中 `copilot.expires_at` 手工回退到过去时间后,下一次
       向 `/v1/chat/completions` 发非流式请求应自动刷新 Copilot token 并返回
       200,不报 401。
