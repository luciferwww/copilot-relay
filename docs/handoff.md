# copilot-relay Development Handoff

> Updated: 2026-08-21
> Branch: `feature/translate`
> Remote: `origin` (`https://github.com/luciferwww/copilot-relay.git`)
> Base commit before this documentation work: `9b79d16`

> [!IMPORTANT]
> This is a temporary machine-transfer artifact. After the new machine is set up and this context has been consumed, delete this file and commit the deletion; it is not intended to remain as permanent project documentation.

## 1. Objective

The active v0.2 objective is to make Claude Code's Anthropic Messages requests work with Copilot models, such as GPT-5.6, that advertise only the OpenAI Responses endpoint. The relay must choose the endpoint from live Copilot `/models` metadata and translate Anthropic Messages to OpenAI Responses without changing the requested model id.

The original `400 no model endpoints available given user constraints` failure was traced to an endpoint mismatch: Claude Code called `/v1/messages`, while the selected model supported `/responses` but not `/v1/messages`.

## 2. Document Status

| Document | Status | Meaning |
|---|---|---|
| [requirement.md](./requirement.md) | Approved and amended on 2026-08-21 | Authoritative v0.2 requirements baseline |
| [design.md](./design.md) | Draft, awaiting explicit approval | Architecture has completed two evidence-based review revisions but is not approved yet |
| [spec.md](./spec.md) | v0.1 and stale | Must be rewritten for v0.2 after design approval and before implementation |
| [coding-standards.md](./coding-standards.md) | Active | Required TypeScript conventions for implementation |

When documents conflict, `requirement.md` wins. Do not treat the current v0.1 `spec.md` as authoritative for v0.2 behavior.

## 3. Decisions Already Settled

- Live Copilot `/models` metadata is the only runtime authority for model existence, endpoint support, feature declarations, and limits.
- Endpoint matching is exact. `/v1/messages`, `/responses`, and `ws:/responses` are distinct capabilities.
- Routing never substitutes another model and never infers support from model names, families, vendors, preview flags, or bundled snapshots.
- Effective feature support is the intersection of live model declarations and relay implementation.
- `/v1/messages` remains byte-for-byte passthrough when the requested model advertises that endpoint.
- Models that advertise only `/responses` use direct, typed Messages-to-Responses mappers. This is not a general protocol-conversion framework.
- Unsupported semantics fail explicitly. In particular, v0.2 rejects `top_k`, non-empty `stop_sequences`, `tool_result.is_error: true`, PDF/document blocks, images in tool results, extended thinking, and prompt-caching semantics.
- Base64 images receive bounded local validation without decoding. URL images receive only HTTP(S) syntax, count, and vision-capability validation; the relay does not fetch URL resources for preflight.
- Continuation uses bounded process-local replay state with `store: false` and no `previous_response_id`, subject to FR9 verification.
- Continuation output items stay request-local until the whole response completes. Publication is atomic; published groups are immutable and repeatedly readable until eviction.
- Model-catalog negative results are scoped to `(modelId, snapshotGeneration)`.
- Auth refresh is generation-scoped, single-flight, and compare-before-commit.
- One attempt coordinator owns auth retry and endpoint re-plan. The hard limit is three upstream attempts: the original attempt, at most one auth retry, and at most one verified endpoint re-plan.
- No retry is permitted after downstream output starts. Before output starts, only an upstream 401 or an FR9-proven pre-execution endpoint rejection may trigger replay. Timeouts, resets, premature EOF, ambiguous 5xx responses, and unclassified failures are terminal.
- Output surfaces accept locally constructed, allowlisted diagnostics. Raw upstream messages, bodies, headers, `Error` objects, auth objects, tokens, and token substrings must not reach logs, CLI output, HTTP errors, or persisted diagnostics.

## 4. Current Implementation State

No v0.2 implementation has been started. The TypeScript source remains the v0.1 relay:

- [src/server.ts](../src/server.ts) directly forwards `/v1/messages`; it has no capability router, Responses mapper, continuation registry, or unified attempt coordinator.
- [src/auth/copilot.ts](../src/auth/copilot.ts) has no generation-safe refresh single-flight and still allows raw upstream-derived error details.
- [src/logger.ts](../src/logger.ts) accepts arbitrary logging arguments.
- [src/cli.ts](../src/cli.ts) prints the first eight characters of the GitHub access token in `status` output.
- [src/translate/anthropic.ts](../src/translate/anthropic.ts) and [src/translate/openai.ts](../src/translate/openai.ts) contain v0.1 passthrough helpers only.
- The modules proposed in `design.md`, including `CopilotTransport`, `ModelCatalog`, the route planner, Responses mappers, SSE translator, and `ContinuationRegistry`, do not exist yet.
- There is no test runner or test script in [package.json](../package.json). The only current validation script is `npm run build` (`tsc`).

These gaps are expected. Do not patch them independently before the v0.2 spec fixes exact contracts and implementation order.

## 5. Mandatory Next Sequence

1. Review and explicitly approve `docs/design.md`. Keep its status as draft until approval is given.
2. Run the FR9 compatibility probes against the selected live Copilot subscription.
3. Record observed request fields, response objects, SSE event tables, continuation requirements, image behavior, and pre-execution endpoint-rejection signals in a rewritten v0.2 `docs/spec.md`.
4. Resolve any probe result that contradicts the current local-stateless-replay design before implementation.
5. Review and approve the v0.2 spec.
6. Implement in small, testable phases with tests added before or alongside each behavior slice.

Do not begin production implementation from public OpenAI documentation alone. Public Responses documentation is a baseline; observed Copilot behavior is the contract.

## 6. FR9 Probe Checklist

Use non-secret captured fixtures for tests, but never load captures in production code. Probe at least:

- non-streaming text;
- streaming text, including exact `response.created`, delta, completion, usage, and error shapes;
- streaming tool use, including authoritative `response.output_item.done` data;
- a following tool-result continuation turn;
- parallel tool calls and any interleaved output-item events;
- URL image input and delegated resource validation;
- base64 image input;
- `store: false` behavior and acceptance or rejection of `previous_response_id` omission;
- required function-call, reasoning-item, and encrypted-reasoning replay fields;
- exact statuses or machine-readable codes, if any, that guarantee endpoint rejection before model execution.

Never place access tokens, Copilot tokens, authorization headers, request bodies containing secrets, or raw credential-bearing errors in fixtures or documentation.

## 7. Spec Work Still Required

The v0.2 spec must make the design executable by defining exact values and tables, including:

- closed request-field and content-block mapping matrices;
- observed non-streaming Responses payloads and SSE event transition tables;
- model metadata schema, cache lifetime, bounded staleness, byte/record limits, and refresh deadline;
- request-body, response-body, SSE-frame, tool-argument, error-body, and continuation limits;
- continuation TTL, capacity, eviction, id format, replay ordering, and publication failure behavior;
- auth token-exchange classification table and persisted safe diagnostic fields;
- allowlisted endpoint-rejection statuses/codes and upstream request-id headers;
- attempt state transitions and all timeout values;
- safe client/log error templates and machine codes;
- abort, backpressure, cleanup, and single-termination contracts;
- complete unit, transport, SDK, and live-acceptance test fixtures.

The stale v0.1 spec currently conflicts with v0.2 in several places: it permits token-prefix output, arbitrary logger arguments, raw refresh details, all refresh failures becoming 401, and unconditional Messages passthrough.

## 8. Suggested Implementation Phases

1. Add the test framework and bounded parsing/error primitives.
2. Introduce the typed safe-output boundary and remove token-derived output.
3. Refactor auth into generation-safe refresh state and add its classification tests.
4. Extract `CopilotTransport` and the bounded attempt coordinator without changing passthrough behavior.
5. Add `ModelCatalog` and pure route planning.
6. Add pure request and non-streaming response mappers.
7. Add `ContinuationRegistry` with atomic staging/publication tests.
8. Add the incremental SSE parser and translator with arbitrary chunk-boundary tests.
9. Integrate `/v1/messages` capability routing while preserving exact passthrough behavior.
10. Run SDK end-to-end tests and repeat live FR9 acceptance probes.

Each phase should pass focused tests and `npm run build` before moving to the next phase.

## 9. Review and Change Policy

- Continue spec-driven development: requirements, design, and precise spec precede implementation.
- Discuss and obtain approval before changing an approved contract or beginning a new implementation phase.
- Treat reviewer comments as hypotheses. Verify each item, classify it as accept, reject, or modify with reasoning, and apply only accepted changes.
- Preserve existing behavior unless the approved v0.2 requirements explicitly change it.
- Do not commit credentials, local auth/config files, probe payloads containing secrets, generated build output, or unrelated workspace files.

## 10. Moving to the New Machine

```powershell
git clone https://github.com/luciferwww/copilot-relay.git c:\dev\copilot-relay
cd c:\dev\copilot-relay
git checkout feature/translate
git pull --ff-only origin feature/translate
npm install
npm run build
git status --short
```

Then read, in order:

1. `docs/requirement.md`
2. `docs/design.md`
3. `docs/handoff.md`
4. `docs/coding-standards.md`
5. `docs/spec.md`, remembering that it is still v0.1 and stale

Authentication is intentionally not transferred through Git. Run `npm link` if the global CLI command is needed, then run `copilot-relay login` on the new machine to create fresh local credentials.

After confirming that the new checkout builds and the context above is available, remove this temporary handoff in a separate commit:

```powershell
git rm docs/handoff.md
git commit -m "docs: remove completed development handoff"
git push
```

## 11. Local Files Excluded from This Commit

At handoff time, `1.json` and `design_diff.txt` are untracked local files. They are intentionally not staged or committed. `1.json` may contain captured model metadata and must remain a non-production fixture candidate until reviewed for secrets and sanitized.

## 12. Validation Completed Before Handoff

- `git diff --check -- docs/requirement.md docs/design.md`
- local Markdown-link validation for `requirement.md` and `design.md`
- VS Code diagnostics for both edited documents: no errors
- stale-contract phrase scan: no matches
- required cross-document contract scan: expected clauses present

Run the same checks for this handoff document and run `npm run build` before committing.