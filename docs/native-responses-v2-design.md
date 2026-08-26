# Native Responses v2 Design

> Status: approved 2026-08-26. Tracks [issue #3](https://github.com/luciferwww/copilot-relay/issues/3).

> [!IMPORTANT]
> Native inbound `POST /v1/responses` was proposed and first implemented by [@xlight](https://github.com/xlight) in [PR #1](https://github.com/luciferwww/copilot-relay/pull/1). [PR #2](https://github.com/luciferwww/copilot-relay/pull/2) subsequently added Messages-to-Responses translation and replaced the monolithic request path with the current HTTP server, model catalog, transport, and lifecycle boundaries. The original implementation therefore cannot be merged mechanically. This design preserves @xlight's proposal while integrating it with the post-PR #2 architecture.

## 1. Scope

Add exact inbound `POST /v1/responses` as a native Responses passthrough route. It is a sibling of the existing Messages translation route:

```text
POST /v1/messages  -> Messages mapper -> upstream /responses
POST /v1/responses -> raw passthrough -> upstream /responses
```

The native route does not call the Messages request mapper, response mapper, SSE translator, or `ContinuationRegistry`. It does not translate Responses to another protocol or introduce a canonical request model.

Only `/v1/responses` is in scope. A `/responses` alias, WebSocket transport, and configurable or remote host binding are excluded. Host binding needs a separate security decision because the relay has no inbound authentication.

## 2. Integration With The Current Architecture

Add a `handleResponses` branch beside `handleMessages` in the existing HTTP dispatcher. Reuse:

- `parseRequestBody` for bounded JSON admission and original body bytes;
- `ModelCatalog.resolve` for model and endpoint capability checks;
- the existing request-owned abort controller and invocation context;
- `CopilotTransport.invoke` for authentication, deadlines, and the pre-output 401 retry;
- `pipePassthrough(..., 'openai', ...)` for JSON and SSE responses.

Add `responses-passthrough` to `RequestRoute` and `/v1/responses` to inbound path normalization. No new mapper, continuation state, transport class, or route-planning abstraction is expected.

## 3. Route Semantics

The shared POST parser retains ownership of content-type, encoding, UTF-8, JSON object, and 8 MiB body-limit validation. The native handler additionally requires a non-empty string `model` and reads `stream` only to choose upstream `Accept`.

Resolve the exact client-supplied model and require exact HTTP `/responses` in `supported_endpoints`; `ws:/responses` is insufficient. An unknown model is an OpenAI `400 invalid_request_error`, invalid catalog metadata is an OpenAI `502 api_error`, and a valid model without HTTP `/responses` is an OpenAI `400 invalid_request_error` with a locally constructed safe message. Do not substitute a model or fall back to Messages translation.

Send the admitted original body bytes and query string to upstream `/responses`. Use `text/event-stream` only when `stream === true`, otherwise `application/json`, plus the existing transport headers and `Openai-Intent: conversation-panel`. Do not interpret or change other native Responses fields.

Successful JSON and SSE bytes use the existing passthrough path without parsing, translation, or reserialization. Non-2xx bodies are not passthrough: use the existing bounded error-body reader only to recognize allowlisted machine codes, then return a locally constructed safe OpenAI error.

`CopilotTransport` owns only the pre-output 401 auth retry. `handleResponses` owns endpoint rejection handling: exact HTTP 400 code `unsupported_api_for_model` invalidates the current catalog generation, resolves the same model with `allowStale:false`, and rechecks exact HTTP `/responses`. If the new metadata still advertises `/responses`, retry that endpoint once; otherwise terminate locally with OpenAI `400 invalid_request_error`. A plain 400, a repeated endpoint rejection, or any failure after downstream output starts is terminal.

## 4. Focused Verification

Tests beside the existing HTTP server tests must prove:

1. Exact `POST /v1/responses` dispatches to upstream `/responses`.
2. Original request bytes, query string, JSON response bytes, and SSE bytes are preserved.
3. The model must advertise exact HTTP `/responses`, not only `ws:/responses`; a valid unsupported model produces OpenAI `400 invalid_request_error`.
4. Unknown models and invalid catalog metadata produce the specified safe OpenAI errors.
5. Exact 400 `unsupported_api_for_model` refreshes without stale fallback and retries `/responses` at most once; a plain 400 does not retry. If the new generation no longer advertises `/responses`, the handler returns local OpenAI `400 invalid_request_error` and the original invocation remains the only upstream `/responses` call.
6. Non-2xx upstream bodies are safely rewritten rather than passed through.
7. The native route does not enter Messages translation or continuation handling.
8. Existing lifecycle tests and the full project test suite remain passing.

Shared parser, retry, backpressure, cancellation, and error behavior should be reused rather than reimplemented or exhaustively duplicated in route-specific tests. Add route-level regression coverage only where needed to prove the native handler uses an existing shared path.

## 5. Documentation On Acceptance

This design change updates `requirement.md`, `design.md`, and `spec.md` before implementation begins so they form one authoritative contract. `README.md` remains a description of released behavior and is updated when implementation is accepted.