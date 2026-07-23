# copilot-relay

Local HTTP proxy that exposes **OpenAI-compatible** and **Anthropic-compatible** APIs, backed by GitHub Copilot. Lets tools like Claude Code, Codex CLI, etc. reuse your Copilot subscription.

> Status: v0.1 skeleton. Copilot backend only. Codex configuration is a stub.

## Quick start

```powershell
cd c:\dev\copilot-relay
npm install
npm run build
node .\dist\cli.js login          # GitHub device-code login
node .\dist\cli.js start          # start proxy on http://127.0.0.1:5000
```

Or after `npm link`, use the `copilot-relay` command directly.

## Commands

| Command | Purpose |
|---|---|
| `copilot-relay login` | GitHub device-code flow; stores tokens under `~/.copilot-relay/` |
| `copilot-relay logout` | Delete stored credentials |
| `copilot-relay status` | Show current config + token state |
| `copilot-relay start [--port N] [--log-level L]` | Start proxy in foreground |
| `copilot-relay stop` | Send SIGTERM to a foreground server via pid file |
| `copilot-relay configure claude` | Write `~/.claude/settings.json` to point Claude Code at this proxy |
| `copilot-relay configure codex` | (v0.2) Write Codex CLI settings |
| `copilot-relay config-show` | Print resolved config |

## Routes served

| Route | Description |
|---|---|
| `POST /v1/chat/completions` | OpenAI chat completions (streams supported) |
| `POST /v1/messages` | Anthropic messages API |
| `GET  /v1/models` | Hard-coded model list |
| `GET  /health` | Liveness probe |

## Config file

Stored at `~/.copilot-relay/config.json`. Missing keys fall back to defaults defined in [src/config.ts](src/config.ts).

Notable fields:

- `githubClientId` — OAuth client id used for device flow. Default is a well-known community value; override with your own OAuth App id if desired.
- `editorVersion`, `editorPluginVersion`, `copilotIntegrationId`, `userAgent` — headers sent to `api.githubcopilot.com`. Adjust if Copilot backend rejects the request.

## Caveats & legal note

- This code is a **from-scratch reimplementation** of the public parts of the GitHub Copilot HTTP protocol, written for personal use.
- GitHub Copilot subscription terms apply. Do not redistribute your Copilot token.
