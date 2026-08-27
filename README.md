# copilot-relay

Local HTTP proxy that exposes **OpenAI-compatible** and **Anthropic-compatible** APIs, backed by GitHub Copilot. Lets tools like Claude Code, Codex CLI, etc. reuse your Copilot subscription.

> Status: v0.2. Claude Code can use Copilot models that expose either native
> Anthropic Messages or HTTP OpenAI Responses. OpenAI Responses clients can use
> native `/v1/responses` passthrough. Codex CLI is supported through that native
> Responses path and can be configured automatically.

Protocol translation follows the [protocol compatibility principle](docs/protocol-compatibility-principle.md): map verified equivalents, pass through what the target can carry, warn and omit optional unsupported extensions, and reject only when a trustworthy target exchange cannot be constructed.

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

For Codex CLI, choose a model whose live Copilot catalog entry exposes
`/responses`:

```powershell
copilot-relay configure codex                 # writes ~/.codex/config.toml
copilot-relay configure codex --model gpt-5.6-sol
```

The command selects the `copilot-relay` provider and merges its native Responses
settings into the existing TOML file. It preserves unrelated settings and the
current model unless `--model` is supplied. Replacement is atomic. Configurations
using triple-quoted or multiline values, dotted `model_providers.copilot-relay`
keys, managed array tables, or duplicate managed values are left unchanged with
an error because they cannot be edited safely by the conservative merger.

### Changing the port

The default port is `5000`. Port arguments must contain only decimal digits and
be in the range `1..65535`. If something else is already using it, pass `--port`
to `start` and the client configuration command:

```powershell
copilot-relay start --port 5001
copilot-relay configure claude --port 5001
copilot-relay configure codex --port 5001
```

Or set it once in `~/.copilot-relay/config.json` so every future run picks it
up (see [Config file](#config-file) below).

### Docker, virtual machines, and remote access

The relay binds to `127.0.0.1` by default. To expose it through a container or
virtual-machine network, choose a host and explicitly acknowledge that the
listener has no inbound authentication:

```powershell
copilot-relay start --host 0.0.0.0 --allow-remote-access
```

`host` may be stored in `~/.copilot-relay/config.json`, but
`--allow-remote-access` is never persisted and is required on every start that
uses a non-loopback host. Restrict the published port with container, firewall,
or virtual-network rules; do not expose it directly to an untrusted network.

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
| `copilot-relay start [--host H] [--port N] [--log-level L] [--allow-remote-access]` | Start proxy in foreground; non-loopback hosts require explicit acknowledgement |
| `copilot-relay stop` | Send SIGTERM to a foreground server via pid file |
| `copilot-relay configure claude` | Write `~/.claude/settings.json` to point Claude Code at this proxy |
| `copilot-relay configure codex [--port N] [--model MODEL]` | Merge a native Responses provider into `~/.codex/config.toml`; preserve unrelated settings and the existing model unless overridden |
| `copilot-relay config-show` | Print resolved config |

## Routes served

| Route | Description |
|---|---|
| `POST /v1/chat/completions` | OpenAI chat completions (streams supported) |
| `POST /v1/responses` | Native OpenAI Responses thin passthrough (streams supported) |
| `POST /v1/messages` | Capability-routed native Messages or Responses translation |
| `GET  /v1/models` | Passthrough to upstream Copilot models list |
| `GET  /health` | Liveness probe |

## Config file

Stored at `~/.copilot-relay/config.json`. Missing keys fall back to defaults defined in [src/config.ts](src/config.ts).

Notable fields:

- `host` — listen address, default `127.0.0.1`; a non-loopback value still requires `--allow-remote-access` on every start.
- `githubClientId` — OAuth client id used for device flow. Default is a well-known community value; override with your own OAuth App id if desired.
- `editorVersion`, `editorPluginVersion`, `copilotIntegrationId`, `userAgent` — headers sent to `api.githubcopilot.com`. Adjust if Copilot backend rejects the request.

## Caveats & legal note

- This code is a **from-scratch reimplementation** of the public parts of the GitHub Copilot HTTP protocol, written for personal use.
- GitHub Copilot subscription terms apply. Do not redistribute your Copilot token.

## Contributors

- [@xlight](https://github.com/xlight) — proposed and first implemented native
  `POST /v1/responses` support in [PR #1](https://github.com/luciferwww/copilot-relay/pull/1).
