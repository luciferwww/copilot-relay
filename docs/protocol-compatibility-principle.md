# Protocol Compatibility Principle

> Status: accepted 2026-08-27. This decision applies to every protocol boundary in `copilot-relay`.

## Context

The relay, its clients, and GitHub Copilot are released independently. A client may add fields, version a tool discriminator, or emit a new content variant before the relay is updated. Copilot may likewise add Responses output items or SSE events between relay releases.

Treating the relay as a closed-schema validator makes otherwise usable requests fail whenever either peer evolves. That is a design failure for an interoperability relay: the relay should translate what it understands without unnecessarily becoming the compatibility bottleneck.

## Decision

Protocol boundaries are **tolerant by default and strict only where continuation is impossible**.

For every field, component, discriminator, item, or event, use this order:

1. **Map** it when the relay has a verified semantic equivalent.
2. **Pass it through** when the target protocol can carry the structure without reinterpretation.
3. **Warn and omit** it when it is optional, has no verified equivalent, and cannot be passed through safely.
4. **Reject** only when required target data is absent or invalid, identity or ordering is inconsistent, a resource boundary is exceeded, or continuing would require inventing semantics or associations.

The first three outcomes are successful compatibility handling. An upstream service may still reject a passed-through feature; that upstream response is more authoritative than a relay-side guess about a newer protocol version.

## Version and extension handling

- Match versioned features by stable family when their required translation is unchanged. For example, Anthropic `web_search_*` maps to Responses `web_search`; the relay does not bind support to one date suffix.
- Ignore additive object fields with a structured warning unless they have a known mapping.
- Pass through unknown target-shaped tools and tool choices after removing source-only controls already translated elsewhere.
- Skip unknown optional content components when other translatable content remains.
- Treat unknown Responses output items as client-invisible opaque items. Preserve completed opaque items only when exact continuation replay requires them.
- Ignore unknown auxiliary SSE events and transport fields while the enclosing translated item can still close coherently.

## Strict boundaries

Tolerance does not permit the relay to manufacture a valid-looking exchange. These conditions remain failures:

- malformed HTTP framing, UTF-8, JSON, or required top-level request data;
- no translatable input remains after optional components are omitted;
- response identity, model identity, item ordering, or translated delta/done state is inconsistent;
- function calls lack the ids, names, object arguments, or result association needed for translation;
- continuation ids, authoritative inputs, persisted arguments, model binding, or replay ordering do not match;
- authentication, ownership, size, count, timeout, or other resource and security invariants fail.

These are protocol-integrity failures, not unknown-extension failures.

## Diagnostics and privacy

Every lossy omission or compatibility passthrough is observable at warn level. Compatibility logs may contain only:

- sorted field names; or
- a fixed, allowlisted context such as `tool`, `response-output`, or `responses-event`.

They must never contain field values, discriminator values, prompts, tool inputs or results, response content, opaque items, raw bodies, headers, errors, or credentials.

## Examples

| Input or upstream change | Relay behavior |
|---|---|
| New optional request field | Warn with its field name, omit it, continue |
| `web_search_20990101` | Map the `web_search_*` family to Responses `web_search` |
| Invalid optional `allowed_domains` shape | Warn, omit the filter, continue |
| Unknown tool type | Pass through with a fixed-context warning; let Copilot decide |
| Unknown response output item | Hide from the Anthropic client; preserve if continuation replay needs it |
| Unknown auxiliary SSE event | Warn and ignore while item closure remains valid |
| Malformed function-call arguments | Reject because no trustworthy Anthropic `tool_use` can be constructed |
| Mismatched continuation input or call id | Reject because replay association cannot be guessed |

## Testing requirement

Every translated boundary must test both sides of this decision:

- additive unknown fields and future versioned discriminators continue;
- unknown optional components, items, and auxiliary events degrade observably;
- warnings contain no dynamic values;
- malformed required data, inconsistent identity/order, continuation mismatches, and resource violations still fail.

## Consequences

This policy reduces release coupling and keeps old relay versions useful as peers evolve. It also means some unsupported features reach the upstream service and may receive an upstream error, or may be omitted with a visible warning. That tradeoff is intentional: a relay-side compatibility guess must not prevent an upstream version that already understands the feature from handling it.

The policy does not allow silent model substitution, fabricated tool state, heuristic continuation reconstruction, or hidden lossy behavior.