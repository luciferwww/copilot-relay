# Messages to Responses Compatibility Recommendations

> Status: recommendation only, 2026-09-15. No implementation change is made by this document.

This document records follow-up recommendations for Anthropic Messages to OpenAI Responses translation. [Stateless Messages Translation](./stateless-messages-translation-decision.md) remains the authoritative implemented design: complete-history reconstruction is the default correctness path, and translation does not currently depend on cross-request state.

## 1. Guiding Principle

Use the following compatibility policy:

> Parse input tolerantly, convert semantics conservatively, enforce critical invariants strictly, and keep the emitted Anthropic protocol stable.

The relay should not reject a deterministically translatable request merely because the current model catalog or one observed provider version does not advertise every requested capability. The provider should normally make capability and business-rule decisions.

The relay must still reject requests or responses when proceeding would require guessing identity, changing meaning, exceeding relay resource limits, or fabricating protocol data.

## 2. Options and Recommendations

| Topic | Options considered | Recommendation | Reason |
| --- | --- | --- | --- |
| Primary translation mode | Full-history stateless; stateful incremental; hybrid | Keep full-history stateless reconstruction as the default and correctness baseline. Evaluate a hybrid fast path only as an optional optimization. | Full replay works after restart and with imported conversations, does not depend on hidden relay state, and fails visibly when history is insufficient. |
| Continuation state | None; bounded memory; durable storage | If acceleration is tested, start with bounded, short-TTL, in-memory hints limited to tool continuations. Consider persistence only after measured benefit. | A cache miss is recoverable by replay; a wrong cache hit can silently attach a turn to the wrong upstream conversation. Durable state also adds privacy and operational costs. |
| Request validation | Strict current-schema enforcement; broad pass-through; semantic-invariant validation | Use semantic-invariant validation. Accept additive or irrelevant input, and delegate provider capabilities upstream when mapping is deterministic. | Both clients and providers evolve. Relay-side assumptions should not unnecessarily prevent otherwise valid use. Blind pass-through is still unsafe where protocols differ. |
| Provider capability authority | Model catalog as a hard gate; provider as final authority | Treat catalog metadata primarily as routing and safe-shaping information. Let the selected provider decide optional feature support where possible. | Catalog metadata can lag provider behavior and cannot describe every field combination. |
| Response validation | Best-effort repair; exact event choreography; semantic integrity | Enforce semantic integrity without requiring one exact harmless event sequence. | The relay must emit truthful Anthropic output, while tolerating equivalent provider lifecycle variants. |
| Unknown fields and events | Reject; blindly forward; classify and handle | Ignore harmless additions, explicitly map known equivalents, and pass through only verified protocol-compatible structures. Log names or contexts without values. | This tolerates upgrades without leaking data or silently changing semantics. |
| Streaming state machine | One rigid sequence; no ordering checks; semantic state keyed by output identity | Move toward a semantic state machine keyed by output index and call identity, while retaining consistency and terminal checks. | Providers may add optional events, omit redundant lifecycle events, or safely interleave items. Identity and completed content must nevertheless remain coherent. |
| Upstream storage | Always enable; never enable; explicit opt-in | Do not silently enable `store`. Require an explicit option for any continuation experiment. | `previous_response_id` generally requires provider-held response state and therefore changes retention and privacy behavior. |

## 3. What Should Be Relaxed

When deterministic translation remains possible, prefer forwarding the request and allowing the provider to accept or reject:

- sampling and reasoning controls;
- provider token limits and some catalog-derived minimums;
- streaming support claims that may be stale;
- image support, image count, and media-type capability claims, subject to local size and decoding limits;
- parallel-tool capability claims;
- provider-specific additive request fields, but only when their wire compatibility is verified;
- partial tool-result histories where association remains unambiguous and the provider can make the final decision.

Unknown additive request fields need not invalidate the entire request. They may be ignored when they have no required target equivalent, provided omission cannot alter the meaning of retained content.

## 4. What Must Remain Strict

The relay must fail rather than guess or fabricate when it encounters:

- empty, duplicated, conflicting, or ambiguously associated tool-call IDs;
- a `tool_result` that cannot be associated with exactly one call;
- tool arguments that are invalid JSON or cannot be represented as the required object;
- silent model substitution outside the documented narrow version-qualified identity rule;
- malformed UTF-8, oversized bodies, frames, text, images, or tool arguments;
- disagreement between streamed deltas and completed content;
- output after a terminal event;
- premature stream EOF or a missing real terminal state;
- fabricated response IDs, tool arguments, usage, completion reasons, or successful terminal events.

These checks protect semantic identity, relay resources, and the validity of the Anthropic response. They are not provider capability policy.

## 5. Optional Incremental Continuation Experiment

A future `previous_response_id` path may reduce relay-to-provider request size, especially in long conversations. It does not guarantee lower token billing, preserved inference cache, lower model computation, or indefinite continuation lifetime.

If implemented, it should obey all of the following constraints:

1. Full-history reconstruction remains authoritative and independently functional.
2. The feature is optional, disabled by default initially, and explicitly discloses upstream storage implications.
3. The first version is in-memory, bounded by entry count and bytes, uses a short TTL, and targets tool-result continuation only.
4. A hint is scoped at least by provider, account or project, endpoint scope, exact model, and a canonical transcript-prefix digest.
5. The record also binds the response ID and relevant tool call IDs, names, and input digests.
6. Assistant-content hashing alone is not sufficient identity; identical content can occur in unrelated conversations.
7. On a verified continuation-invalid response, evict the hint and retry full history at most once.
8. Fallback is allowed only before any downstream response content has been emitted.
9. Do not match failures using one provider's exact human-readable error sentence when a stable status or code is available.
10. Durable persistence requires measurements showing meaningful benefit and a separate review of schema versioning, permissions, atomic writes, ownership, capacity, expiry, and privacy.

A fallback repairs missing or expired continuation state. It cannot reliably detect a wrong response ID that the provider accepts, so preventing false cache hits is more important than maximizing hit rate.

## 6. Upgrade Compatibility

Compatibility should follow semantic dependencies rather than today's complete schemas:

- Validate fields required to perform the translation; tolerate unrelated additions.
- Accept known-equivalent usage layouts and completion representations.
- Ignore unknown auxiliary output items or SSE progress events when translated items can still finish coherently.
- Do not require optional lifecycle events solely because one provider version currently emits them.
- Permit final-only text or function data only when it can be converted without contradicting already emitted deltas.
- Keep a real terminal success or failure event mandatory.
- Record ignored field or event names through bounded structured logs, never their potentially sensitive values.
- Add compatibility from sanitized captured fixtures or reproduced failures rather than speculative schema permutations.

## 7. Candidate Features from the Compared Proxy

| Feature or technique | Recommendation | Reason |
| --- | --- | --- |
| Map reasoning effort | Probe first | It can improve feature compatibility, but field support and meaning vary by provider and model. |
| Support URL images | Add only with demand, capability evidence, and URL/security policy | URL fetching introduces behavior and security concerns beyond base64 translation. |
| Test consecutive assistant messages containing separate parallel tool calls | Adopt | It covers a realistic client history shape without introducing state. |
| Persist assistant-content hash to response-ID mappings | Reject | The key is not sufficiently scoped and a false hit can silently select the wrong conversation. |
| Convert invalid function arguments to `{}` | Reject | It fabricates model output and can invoke a tool with different semantics. |
| Fabricate successful completion after premature stream EOF | Reject | It hides upstream failure and may publish invalid continuation state. |

## 8. Suggested Order of Work

1. Relax only provider-capability checks that can be forwarded without semantic ambiguity; retain local resource limits.
2. Refactor streaming acceptance only when an observed provider variant requires it, preserving identity, consistency, and terminal invariants.
3. Measure full-history payload size, latency, provider token accounting, and failure rate on representative long and tool-heavy conversations.
4. Consider the bounded continuation experiment only if those measurements show a material problem.

This order improves compatibility without making correctness depend on relay-owned continuation state.