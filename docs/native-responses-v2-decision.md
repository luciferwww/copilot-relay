# Native Responses v2 Decision Record

> Status: accepted 2026-08-26. Tracks [issue #3](https://github.com/luciferwww/copilot-relay/issues/3).

## Context

Native inbound `POST /v1/responses` was proposed and first implemented by [@xlight](https://github.com/xlight) in [PR #1](https://github.com/luciferwww/copilot-relay/pull/1). That contribution established the product need and supplied the first implementation.

[PR #2](https://github.com/luciferwww/copilot-relay/pull/2) subsequently added Messages-to-Responses translation and replaced the monolithic request path with the current HTTP server, model catalog, transport, lifecycle, and continuation boundaries. Merging the original implementation mechanically would have bypassed those boundaries.

## Decision

Preserve @xlight's native Responses proposal by integrating exact inbound `POST /v1/responses` as a sibling of Messages translation in the post-PR #2 architecture.

The native route uses the existing HTTP request owner, live `ModelCatalog`, `CopilotTransport`, OpenAI passthrough writer, safe errors, and logging. It does not enter the Messages mappers, SSE translator, or `ContinuationRegistry`, and it does not introduce another server, transport, mapper, canonical protocol, or route-planning abstraction.

## Consequences

- Native Responses and translated Messages may share upstream `/responses` while retaining separate client protocol paths.
- Successful native request and response semantics remain passthrough; translation-only continuation behavior remains isolated.
- A `/responses` alias, WebSocket transport, and configurable or remote host binding remain outside this decision. Remote binding requires a separate security decision because the relay has no inbound authentication.
- The authoritative requirements, architecture, protocol behavior, limits, errors, retries, and tests are maintained in [requirement.md](./requirement.md), [design.md](./design.md), and [spec.md](./spec.md). This record preserves provenance and rationale rather than duplicating those contracts.