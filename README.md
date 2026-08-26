# copilot-relay

Local HTTP proxy that exposes **OpenAI-compatible** and **Anthropic-compatible** APIs, backed by GitHub Copilot. Lets tools like Claude Code, Codex CLI, etc. reuse your Copilot subscription.

> Status: v0.2. Claude Code can use Copilot models that expose either native
> Anthropic Messages or HTTP OpenAI Responses. OpenAI Responses clients can use
> native `/v1/responses` passthrough. Codex configuration remains a stub.

## Prerequisites

- **Node.js ≥ 18** (native `fetch` and Web Streams are required).
- **Git** for cloning.
- **Microsoft-internal note**: this repo ships an [.npmrc](.npmrc) pointing at
  `https://packagefeedproxy.microsoft.io/npm/` so `npm install` works from the
  corporate network. External users can delete the file or replace it with a
  registry they have access to (e.g. the public `https://registry.npmjs.org/`).

## Install

```powershell
git clone <this-repo> c:\dev\copilot-relay
cd c:\dev\copilot-relay
npm install
npm run build
npm link          # exposes `copilot-relay` as a global command
```

`npm link` creates a symlink to `dist/cli.js`, so subsequent `npm run build`
rebuilds are picked up automatically — no re-link needed.

### Alternative: run without `npm link`

If you prefer not to install a global command, invoke the built entry point
directly (works from any directory):

```powershell
node c:\dev\copilot-relay\dist\cli.js <subcommand>
```

## First-time setup

```powershell
copilot-relay login                     # GitHub device-code flow
copilot-relay status                    # verify `auth valid: yes`
copilot-relay start                     # foreground; defaults to port 5000
```

Then in another terminal, point your client at the proxy. For Claude Code:

```powershell
copilot-relay configure claude          # writes ~/.claude/settings.json
```

Fire up `claude` and it will route through the proxy to your Copilot
subscription. For each exact requested model, the relay reads the live Copilot
model catalog, prefers native `/v1/messages`, and otherwise uses the implemented
HTTP `/responses` translation path. It never substitutes a different model.

### Changing the port

The default port is `5000`. If something else is already using it, pass
`--port` on both `start` and `configure claude`:

```powershell
copilot-relay start --port 5001
copilot-relay configure claude --port 5001
```

Or set it once in `~/.copilot-relay/config.json` so every future run picks it
up (see [Config file](#config-file) below).

## Update / uninstall

```powershell
git pull
npm run build          # link stays valid — symlink follows the new dist/

npm unlink -g copilot-relay   # remove the global command when you're done
```

## Commands

| Command | Purpose |
|---|---|
| `copilot-relay login` | GitHub device-code flow; stores tokens under `~/.copilot-relay/` |
| `copilot-relay logout` | Delete stored credentials |
| `copilot-relay status` | Show current config + token state |
| `copilot-relay start [--port N] [--log-level L]` | Start proxy in foreground |
| `copilot-relay stop` | Send SIGTERM to a foreground server via pid file |
| `copilot-relay configure claude` | Write `~/.claude/settings.json` to point Claude Code at this proxy |
| `copilot-relay configure codex` | Unimplemented; exits with code `2` |
| `copilot-relay config-show` | Print resolved config |

## Routes served

| Route | Description |
|---|---|
| `POST /v1/chat/completions` | OpenAI chat completions (streams supported) |
| `POST /v1/responses` | Capability-checked native OpenAI Responses passthrough (streams supported) |
| `POST /v1/messages` | Capability-routed native Messages or Responses translation |
| `GET  /v1/models` | Passthrough to upstream Copilot models list |
| `GET  /health` | Liveness probe |

## Config file

Stored at `~/.copilot-relay/config.json`. Missing keys fall back to defaults defined in [src/config.ts](src/config.ts).

Notable fields:

- `githubClientId` — OAuth client id used for device flow. Default is a well-known community value; override with your own OAuth App id if desired.
- `editorVersion`, `editorPluginVersion`, `copilotIntegrationId`, `userAgent` — headers sent to `api.githubcopilot.com`. Adjust if Copilot backend rejects the request.

## Caveats & legal note

- This code is a **from-scratch reimplementation** of the public parts of the GitHub Copilot HTTP protocol, written for personal use.
- GitHub Copilot subscription terms apply. Do not redistribute your Copilot token.
