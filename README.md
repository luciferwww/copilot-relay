# copilot-relay

**Use your GitHub Copilot subscription with Claude Code, Codex CLI, and OpenAI- or Anthropic-compatible tools.**

`copilot-relay` is a lightweight local relay that exposes OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages APIs backed by GitHub Copilot.

- **Automatic protocol translation** — use Anthropic Messages clients with models that expose only Chat Completions or Responses
- **First-class Claude Code and Codex setup** — configure either client with one command
- **Streaming and tool calling** — supported across the implemented passthrough and translation paths
- **No model surprises** — the exact model you request is preserved; the relay never silently substitutes another model
- **Local by default** — listens on `127.0.0.1`, with no project-operated middleman between the relay and GitHub Copilot
- **Safe diagnostics** — prompts, tool contents, request bodies, and credentials are not written to logs

> [!IMPORTANT]
> `copilot-relay` is an unofficial project and is not affiliated with GitHub, Microsoft, Anthropic, or OpenAI. A valid GitHub Copilot subscription is required. GitHub's terms and usage limits still apply; do not share your credentials or use the project for unauthorized resale.

## Quick start

### 1. Install

Requirements: [Node.js](https://nodejs.org/) 18 or newer, Git, and access to npm.

```bash
git clone https://github.com/luciferwww/copilot-relay.git
cd copilot-relay
npm install
npm run build
npm link
```

`npm link` makes `copilot-relay` available as a global command. Later rebuilds are picked up without linking again.

### 2. Sign in and start the relay

```bash
copilot-relay login
copilot-relay status
copilot-relay start
```

The GitHub device-code flow opens in your browser. The relay then runs in the foreground at `http://127.0.0.1:5000`.

In another terminal, verify it:

```bash
curl http://127.0.0.1:5000/health
curl http://127.0.0.1:5000/v1/models
```

The models response contains the model IDs currently available to your Copilot account.

### 3. Connect a client

For Claude Code:

```bash
copilot-relay configure claude
claude
```

For Codex CLI, replace `<model-id>` with an ID returned by `/v1/models` that supports the Responses endpoint:

```bash
copilot-relay configure codex --model <model-id>
codex
```

That is all that is needed for the common setup. See [Client integrations](#client-integrations) for other tools and configuration details.

## Why copilot-relay?

### Use more Copilot models from Anthropic-compatible clients

A model available through Copilot does not always expose the API protocol expected by your client. `copilot-relay` bridges that gap for inbound Anthropic Messages requests:

```text
Anthropic-compatible client
            |
            | POST /v1/messages
            v
      copilot-relay
            |
            +-- native /v1/messages available --> pass through
            |
            +-- otherwise /chat/completions ---> translate request and response
            |
            +-- otherwise /responses ----------> best-effort stateless translation
            v
      GitHub Copilot
```

The relay checks the live Copilot model catalog, selects the implemented protocol path advertised for the **exact requested model**, and converts the response back to Anthropic Messages when translation is needed. Non-streaming responses, streaming text, and standard client function tools are supported on the implemented translation paths.

OpenAI Chat Completions and Responses requests received by their corresponding relay endpoints are native passthrough routes. `copilot-relay` does not claim arbitrary bidirectional conversion between every API protocol.

### Designed for local developer tools

The default listener is loopback-only. Authentication state stays under `~/.copilot-relay/`, and requests travel from the local relay to GitHub Copilot rather than through a service operated by this project.

The safe logging boundary excludes prompt and system text, tool inputs and results, image data, raw request and response bodies, raw upstream errors, and credentials—even at debug level.

## Client integrations

### Claude Code

```bash
copilot-relay configure claude
```

This updates `~/.claude/settings.json` with:

- `ANTHROPIC_BASE_URL=http://127.0.0.1:5000`
- a placeholder `ANTHROPIC_AUTH_TOKEN` if one is not already present

Other settings and an existing auth token are preserved when the file contains valid JSON. If the existing file is invalid JSON, the command warns before replacing it; back up a hand-edited file first if needed.

Use the same port on both commands when changing the default:

```bash
copilot-relay start --port 5001
copilot-relay configure claude --port 5001
```

### Codex CLI

```bash
copilot-relay configure codex
# Or select a model explicitly:
copilot-relay configure codex --model <model-id>
```

This selects the `copilot-relay` provider and conservatively merges its native Responses configuration into `~/.codex/config.toml`. It preserves unrelated settings and the existing model unless `--model` is provided, and replaces the file atomically.

Ambiguous TOML constructs in the managed section are rejected without changing the file. See [Troubleshooting](#troubleshooting) if the merge is refused.

### OpenAI-compatible clients

Point the client at:

```text
http://127.0.0.1:5000/v1
```

Use any non-empty placeholder API key if the client requires one; the local relay does not use it for Copilot authentication.

A minimal Chat Completions request looks like this:

```bash
curl http://127.0.0.1:5000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"Say hello in one sentence."}],"stream":false}'
```

On Windows PowerShell, use `curl.exe` for these curl examples or configure your preferred OpenAI-compatible client directly.

### Anthropic-compatible clients

Point the client at:

```text
http://127.0.0.1:5000
```

Use any non-empty placeholder API key if required. A minimal Messages request is:

```bash
curl http://127.0.0.1:5000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"<model-id>","max_tokens":256,"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

## Compatibility

Compatibility is endpoint- and feature-specific; it does not mean that every OpenAI or Anthropic API feature is implemented.

| Inbound endpoint | Behavior | Streaming | Tool calling |
|---|---|---:|---:|
| `POST /v1/messages` | Native Messages passthrough, or Messages ↔ Chat/Responses translation selected from live model capabilities | Yes | Standard client tools on implemented paths |
| `POST /v1/chat/completions` | Native Chat Completions passthrough | Yes | Upstream-dependent |
| `POST /chat/completions` | Alias of the native Chat Completions passthrough | Yes | Upstream-dependent |
| `POST /v1/responses` | Native Responses passthrough | Yes | Upstream-dependent |
| `GET /v1/models` | Live Copilot models passthrough | — | — |
| `GET /health` | Local liveness check | — | — |

### Translation limits

The translated Messages baseline focuses on text and standard client function tools. On translated paths, optional features without a verified equivalent may be omitted with a warning. Images, documents, thinking blocks, hosted tools, reasoning controls, `top_k`, non-empty `stop_sequences`, and provider-specific opaque state are not guaranteed to translate.

Responses-based Messages translation is stateless and best-effort: the relay preserves standard tool-call identity from the submitted history, but does not retain opaque reasoning or provider continuation state between requests. Native passthrough routes are not subject to these translation limits.

For the precise compatibility contract, see the [protocol compatibility principle](docs/protocol-compatibility-principle.md) and [specification](docs/spec.md).

## Installation options

### Run without `npm link`

After building, invoke the entry point directly from the repository:

```bash
node ./dist/cli.js <subcommand>
```

### Build a standalone executable

This repository can build a standalone executable for the **current** operating system and CPU architecture. Packaging requires Node.js 20 or newer; normal source builds and runtime use support Node.js 18 or newer.

```bash
npm install
npm run build:exe
```

The build writes the executable, its SHA-256 checksum, the license, and third-party notices under `release/`. For example, a Windows x64 build produces:

```text
release/copilot-relay-windows-x64.exe
release/copilot-relay-windows-x64.exe.sha256
release/LICENSE.txt
release/THIRD_PARTY_NOTICES.txt
```

The generated executable does not require Node.js, npm, the source tree, or `node_modules` on its destination machine. Build each target on its matching operating system. Locally built Windows executables are unsigned and may trigger a SmartScreen warning when shared.

## Configuration

Configuration is stored at `~/.copilot-relay/config.json`. Missing or invalid values fall back to the defaults in [src/config.ts](src/config.ts).

```json
{
  "host": "127.0.0.1",
  "port": 5000,
  "logLevel": "info",
  "githubClientId": "Iv1.b507a08c87ecfe98",
  "editorVersion": "vscode/1.98.0",
  "editorPluginVersion": "copilot-chat/0.20.0",
  "copilotIntegrationId": "vscode-chat",
  "userAgent": "GitHubCopilotChat/0.20.0"
}
```

Common fields:

- `host` — listen address; defaults to `127.0.0.1`
- `port` — listen port; defaults to `5000`
- `logLevel` — `debug`, `info`, `warn`, or `error`
- `githubClientId` — OAuth client ID used by the device flow; replace the community default with your own OAuth App ID if desired

The editor and integration fields control headers sent to `api.githubcopilot.com` and can be adjusted if the Copilot backend changes its requirements.

Use `copilot-relay config-show` to create the default file when missing and print the resolved configuration.

## Remote access

The relay binds to `127.0.0.1` by default and has **no inbound client authentication**. For a container, virtual machine, or trusted private network, choose a non-loopback address and explicitly acknowledge the exposure:

```bash
copilot-relay start --host 0.0.0.0 --allow-remote-access
```

`host` can be stored in the config file, but `--allow-remote-access` is deliberately never persisted and is required on every non-loopback start. Protect the port with firewall, container, private-network, and—where appropriate—authenticated reverse-proxy rules. Never expose it directly to an untrusted network.

## Commands

| Command | Purpose |
|---|---|
| `copilot-relay login [--no-open]` | Authenticate through the GitHub device-code flow |
| `copilot-relay logout` | Delete stored credentials |
| `copilot-relay status` | Show resolved config and safe authentication status |
| `copilot-relay start [--host H] [--port N] [--log-level L] [--allow-remote-access]` | Start the relay in the foreground |
| `copilot-relay stop` | Send `SIGTERM` to the server tracked by the PID file |
| `copilot-relay configure claude [--port N]` | Point Claude Code at the relay |
| `copilot-relay configure codex [--port N] [--model MODEL]` | Merge a native Responses provider into Codex config |
| `copilot-relay config-show` | Print the resolved configuration |

Port arguments must contain decimal digits only and be in the range `1..65535`.

## Troubleshooting

Start with these checks:

```bash
copilot-relay status
copilot-relay config-show
curl http://127.0.0.1:5000/health
curl http://127.0.0.1:5000/v1/models
```

For additional structural diagnostics, restart with:

```bash
copilot-relay start --log-level debug
```

Debug logging does not include prompt content, tool values, request or response bodies, or credentials.

Common cases:

- **`Not logged in` or `auth valid: no`** — run `copilot-relay login` again.
- **Port already in use** — choose another port for both `start` and the relevant `configure` command.
- **Requested model is unavailable or does not support the route** — use an exact model ID returned by `/v1/models`; availability depends on your account and current Copilot catalog.
- **Codex configuration merge refused** — simplify duplicate managed values, dotted `model_providers.copilot-relay` keys, managed array tables, or triple-quoted/multiline values before retrying. The command leaves the original file unchanged.
- **Remote bind rejected** — add `--allow-remote-access` to that specific `start` invocation and secure the network boundary.
- **Upstream behavior changed** — check or adjust the Copilot client header fields in `~/.copilot-relay/config.json`.

## Update and uninstall

Update a source installation:

```bash
git pull
npm install
npm run build
```

An existing `npm link` continues to point to the rebuilt `dist/` output.

Remove the global command:

```bash
npm unlink -g copilot-relay
```

This does not delete `~/.copilot-relay/` or undo Claude Code and Codex configuration. Run `copilot-relay logout` before unlinking if you want to remove stored credentials, then remove remaining configuration manually if desired.

## Documentation

- [Architecture and design](docs/design.md)
- [Protocol specification](docs/spec.md)
- [Protocol compatibility principle](docs/protocol-compatibility-principle.md)
- [Stateless Messages translation decision](docs/stateless-messages-translation-decision.md)
- [Native Responses decision](docs/native-responses-v2-decision.md)
- [Coding standards](docs/coding-standards.md)

## Development

```bash
npm install
npm run build
npm test
```

Contributions should preserve the project's exact-model, safe-output, bounded-resource, and protocol-compatibility guarantees. Read the [coding standards](docs/coding-standards.md) and relevant design documents before changing protocol behavior.

## License

Licensed under the [MIT License](LICENSE). This license covers `copilot-relay` itself; it does not grant rights to GitHub Copilot, GitHub or Microsoft services, or their trademarks.

## Contributors

- [@xlight](https://github.com/xlight) — proposed and first implemented native `POST /v1/responses` support in [PR #1](https://github.com/luciferwww/copilot-relay/pull/1).
