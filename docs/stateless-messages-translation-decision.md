# Stateless Messages Translation Decision

> Status: accepted and implemented 2026-09-15.

This decision replaces the translated-Messages continuation architecture described by [Continuation Persistence](./continuation-persistence-decision.md). Native inbound `POST /v1/responses` remains governed by [Native Responses v2](./native-responses-v2-decision.md) and is not changed by this decision.

## 1. Context

The current Anthropic Messages to OpenAI Responses path preserves function-call and opaque reasoning items in a relay-owned continuation registry. A later Anthropic request contains the emitted `tool_use.id`, but it does not necessarily contain every Responses item needed to reproduce the original upstream exchange. The registry therefore became persistent so those requests could survive relay restarts.

That architecture makes otherwise ordinary client tool use depend on relay-owned state. Imported conversations, expired or evicted records, a missing data directory, and process ownership all become externally visible failure modes. Persisting opaque tool input and reasoning data also adds security and lifecycle costs that are disproportionate to this relay's practical goal.

The product goal is usable model access rather than lossless preservation of every source and target protocol feature. Loss of optional internal metadata is acceptable. Incorrect tool-result association, silent model substitution, and fabricated continuation state are not acceptable because they can change observable model behavior.

Public protocol definitions and implementations establish a reliable stateless baseline for standard client tools:

- Anthropic `tool_use.id` can be preserved as OpenAI Chat Completions `tool_calls[].id`.
- Anthropic `tool_result.tool_use_id` can be preserved as the following Chat `tool_call_id`.
- GitHub's public `copilot-sdk` test adapter and LiteLLM use this structured mapping rather than requiring a relay-owned cross-request id registry.

OpenAI Responses also exposes `function_call.call_id` and `function_call_output.call_id`. Those fields permit a stateless best-effort reconstruction for standard client function calls, but they do not carry every optional reasoning or server-tool item that a Responses model may require.

## 2. Decision

Remove all cross-request state from Anthropic Messages translation. Do not persist, cache, encode, or reconstruct opaque continuation data.

For an exact requested model, select the first endpoint advertised by the live Copilot model catalog in this order:

1. Exact `/v1/messages`: native Anthropic Messages passthrough.
2. Exact `/chat/completions`: stateless structured Chat Completions translation.
3. Exact `/responses`: stateless deterministic best-effort Responses translation.
4. Otherwise: return an Anthropic `400 invalid_request_error` without changing the model.

`ws:/responses` is not an HTTP endpoint. Endpoint selection remains metadata-driven; a client generation request is not used as a speculative endpoint probe. A verified pre-execution `unsupported_api_for_model` response may refresh metadata and re-plan under the existing bounded invocation rules, but an attempted endpoint is never followed by an ad hoc fallback based on an ambiguous failure.

Native `POST /v1/chat/completions` and `POST /v1/responses` remain thin passthrough routes. This decision changes only capability-routed inbound `POST /v1/messages`.

## 3. Stateless Tool Contract

### 3.1 Chat Completions

The Chat path preserves standard client tool identity directly:

```text
Anthropic assistant tool_use.id
  = Chat assistant tool_calls[].id
  = Anthropic user tool_result.tool_use_id
  = Chat tool message tool_call_id
```

An assistant `tool_use` maps to one function tool call containing the same id and name and JSON-serialized input. A user `tool_result` maps to a `role: "tool"` message containing the same id and text result. It is never downgraded to an ordinary user-text message.

### 3.2 Responses

The Responses path uses the same client-visible id as `call_id`:

```text
Anthropic assistant tool_use.id
  = Responses function_call.call_id
  = Anthropic user tool_result.tool_use_id
  = Responses function_call_output.call_id
```

On output, a Responses function call with a non-empty `call_id`, name, and valid object arguments maps to an Anthropic `tool_use` using that `call_id`. The relay does not allocate a replacement id.

On a later request, the complete Anthropic history is mapped again. The historical assistant `tool_use` reconstructs an explicit Responses `function_call` from its id, name, and input. The matching user `tool_result` becomes a `function_call_output`. The relay does not claim that this is the original complete Responses output sequence.

If Copilot accepts that explicit history, the turn proceeds without relay state. If a model requires omitted reasoning, encrypted content, item identity, server-side conversation state, or another value absent from Anthropic history, the upstream rejection is terminal and is returned as an actionable Anthropic error. The relay does not restore a registry or fabricate the missing value.

### 3.3 Minimum integrity

Usability-first translation still requires trustworthy tool association:

- every tool id used for association is a non-empty string;
- every `tool_result` resolves unambiguously to one preceding `tool_use` in the submitted history;
- duplicate, missing, reused out-of-order, or conflicting ids fail before model invocation;
- a reconstructed call preserves the historical tool name and JSON input;
- tool arguments returned by the model must decode to a JSON object;
- parallel client function calls remain distinct by id and stream index;
- tool results are never associated by tool name, message position alone, or text matching.

These checks prevent an apparently successful request from attaching a result to the wrong operation. They do not require cross-request storage.

## 4. Lossy Compatibility Policy

The translation baseline supports:

- top-level system instructions and text message history;
- standard client-defined function tools;
- text tool results;
- supported tool-choice modes;
- non-streaming and streaming text and function-call output;
- model, maximum output tokens, supported sampling controls, usage, and completion reasons where the selected target has a verified equivalent.

The relay may warn and omit optional data that has no verified stateless carrier, including:

- Anthropic cache-control hints and `tool_result.is_error` as distinct metadata;
- Responses reasoning items, encrypted reasoning content, and opaque output items;
- Anthropic thinking and redacted-thinking blocks and signatures;
- target-specific item ids that are not function `call_id` values;
- optional sampling, output, or metadata fields without a verified target equivalent.

Omission must not alter retained text or prepend synthetic markers such as `ERROR:` to a tool result. Safe compatibility warnings contain field names or fixed contexts only, never values.

Hosted or server-executed tools are outside the standard client-function baseline. Their definitions may be passed through only when the target accepts the same structure without reinterpretation. Their opaque execution state is never represented as a client function call. A request that cannot retain any usable content after unsupported components are omitted fails explicitly.

## 5. Streaming Boundary

Streaming translation may keep only request-local bounded state:

- an incomplete SSE frame;
- active content-block indexes;
- text fragments for the active output block;
- function name, id, and argument fragments grouped by Chat `tool_calls[].index` or Responses output index;
- usage and terminal-reason fields needed to produce the final Anthropic events.

This state is destroyed when the request completes, fails, times out, or disconnects. It is not shared with another HTTP request and is not written to disk.

The translator emits one valid Anthropic event sequence. Malformed required deltas, conflicting indexes or ids, invalid final JSON arguments, premature EOF, and resource-limit violations are protocol failures. Unknown auxiliary events may be warned and ignored when the active translated blocks can still close coherently.

## 6. Evidence and Test Boundary

`supported_endpoints` selects an eligible protocol path; it does not prove that every optional feature is accepted by that endpoint. The live model capability record and relay implementation still form the effective feature set.

Copilot may invoke an exact catalog model alias but return that alias with an appended ISO date version, such as `gpt-5.4-mini-2026-03-17` for `gpt-5.4-mini`. Output validation accepts only the exact requested id or that narrow date-qualified form and continues to expose the requested id. An unrelated response model remains a protocol failure, so this compatibility rule does not permit model substitution.

The minimum authenticated evidence before release is:

- one text turn in each supported buffered and streaming target path;
- one standard client-function call followed by its tool-result turn in each translated target path;
- observation of the usage, terminal reason, and tool-argument shapes needed by those turns.

One representative model per selected protocol path is sufficient unless live evidence shows model-specific behavior. Images, documents, strict schemas, reasoning controls, hosted tools, and other extensions remain disabled until an actual use case justifies their implementation and probe. A failed reconstructed tool-result probe for a Responses model documents that the model's Responses path is text-only through this relay unless later evidence changes the result.

Automated tests cover only behavior whose failure would break routing, corrupt visible output, associate a tool result incorrectly, hide a stream failure, or reintroduce cross-request state. The initial focused set is:

- route priority and unsupported-route failure;
- one request and response mapping fixture per translated target;
- one complete tool-call and tool-result round trip that proves id preservation;
- one streaming fixture whose transport chunks split an SSE frame and tool arguments at inconvenient boundaries;
- representative malformed required ids or arguments and one mid-stream failure;
- a source-level or construction test proving no continuation store is opened, only if this is not already evident from the server dependency graph.

Do not create a model-by-field-by-error permutation matrix. Do not test private helper implementation, deleted registry behavior, equivalent field-order variations, or speculative protocol extensions. Add another case only for a distinct public contract, an observed upstream variant, or a reproduced regression.

Authenticated probes on 2026-09-15 established the release baseline available from that catalog snapshot:

- `gemini-3.5-flash` completed buffered and streaming text through Chat translation and completed a function-call/tool-result round trip with the same client-visible id;
- `gpt-5.4` rejected legacy Chat `max_tokens` but accepted `max_completion_tokens`, which is also accepted by the representative Gemini model and is therefore the Chat translation target field;
- `gpt-5.6-sol` completed buffered and streaming text through Responses translation and completed a function-call/tool-result round trip with the same `call_id`;
- `gpt-5.4-mini` returned the version-qualified model identity `gpt-5.4-mini-2026-03-17`, confirming the narrow response-identity rule above;
- the catalog advertised no native `/v1/messages` model, so native Messages remained covered by the passthrough integration tests rather than an authenticated probe.

## 7. Removed Architecture

Implementation of this decision removes:

- relay-generated Anthropic tool ids;
- `ContinuationRegistry` and `ContinuationStore`;
- continuation records, directory ownership, TTL, renewal, limits, and LRU behavior;
- continuation configuration paths and lifecycle logging;
- staging and publication from buffered and streaming response translation;
- persistence-related startup and shutdown failure modes.

No compatibility fallback may silently recreate cross-request state. The only retained mutable translation state is bounded to one active HTTP request.

## 8. Consequences

Benefits:

- relay restart and imported history no longer depend on local continuation files;
- standard client tools have direct, inspectable identity across protocols;
- no prompt, tool input, or opaque reasoning data is persisted by translation;
- the routing and failure model is smaller;
- Chat-capable models use the better-defined stateless path, while Responses-only models remain usable where explicit history is accepted.

Tradeoffs:

- a Responses-only model may complete text turns but reject a later tool-result turn if it requires omitted opaque state;
- reasoning continuity and hosted tools may be degraded or unavailable;
- translation is intentionally not a lossless representation of either protocol;
- model-specific support must be established by probes rather than inferred from endpoint names.

These tradeoffs are accepted. The relay prefers a stateless request that either works or fails visibly over a stateful request whose success depends on hidden local continuation data.

## 9. Documentation and Implementation Migration

The implementation phase must update the active requirements, design, specification, README, route planner, request and response mappers, streaming translator, logger, configuration, startup lifecycle, and tests as one coherent migration.

Use direct protocol mappers and the existing transport and server boundaries. Do not introduce a general canonical message model, endpoint plugin system, capability-rule engine, compatibility database, or configurable fallback policy for this migration. A small shared helper is justified only when both translated targets need the same validation or event framing and the helper removes real duplication.

The old continuation decision remains in the repository as a historical record but must be marked superseded. Existing requirements and specification clauses that require Responses replay groups or durable continuation records must be removed rather than reinterpreted as optional behavior.

The first implementation checkpoint is documentation consistency. Source deletion or mapper replacement begins only after the active requirement, design, and specification documents all express this decision without retaining contradictory continuation obligations.