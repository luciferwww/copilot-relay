# Coding Standards

> Created: 2026-04-07  
> Scope: template for TypeScript projects. Copy into a new codebase and adapt as needed.

These conventions are the recommended starting point for any TypeScript project. When adopting this template, review each rule and revise your project's copy for any rule that does not fit — but do so intentionally, not by omission.

### Rule Tiers

Each section (or bullet, when mixed) is tagged with one of:

- **(Rule)** — Must follow. Deviations require explicit justification in code review or a comment.
- **(Default)** — Recommended starting point. Override in your project's copy if a listed exception applies.
- **(Guidance)** — Patterns to consider; author judgment applies.

---

## 1. File Naming *(Rule)*

| Kind | Style | Example |
|------|-------|---------|
| Class / main module | PascalCase | `OrderService.ts`, `UserRepository.ts` |
| Utility / helper | kebab-case | `parse-input.ts`, `format-date.ts`, `retry-policy.ts` |
| Type definitions | `types.ts` | One per module, or a `types/` subdirectory |
| Module entry | `index.ts` | Re-exports only, no implementation |
| Tests | Same name as source + `.test.ts` | `OrderService.test.ts`, `parse-input.test.ts` |

---

## 2. Directory Naming *(Rule)*

Directory names are always **kebab-case**. This rule applies to folder names only; individual files follow Section 1.

```
user-service/    order-store/    report-builder/    http-client/    utils/
```

---

## 3. Formatting *(Rule)*

| Setting | Value |
|---------|-------|
| Indentation | 2 spaces, no tabs |
| Quotes | Single quotes (`'…'`); use backticks only for template literals |
| Semicolons | Required at the end of every statement |

Anything not listed here is at the author's discretion.

---

## 4. Naming Rules

*(Rule)* — the main table below.

| Category | Style | Example |
|----------|-------|---------|
| Class | PascalCase, no pre/suffix | `OrderService`, `UserRepository` |
| Interface | PascalCase, no `I` prefix | `QueryParams`, `FetchResult`, `UserEntry` |
| Function | camelCase | `loadConfig()`, `parseInput()`, `createCache()` |
| Variable | camelCase | `userRepo`, `currentValue`, `outputDir` |
| Constant | UPPER_SNAKE_CASE | `DEFAULT_TIMEOUT_MS`, `CACHE_DIR` |
| Private member | `private` keyword + camelCase | `private httpClient`, `private cache` |

Note: `static readonly` class fields representing constants may use UPPER_SNAKE_CASE (like module-level constants). The `readonly` modifier on instance fields does not change the case — instance fields remain camelCase.

### Interface Suffix Conventions *(Default)*

| Suffix | Purpose | Example |
|--------|---------|---------|
| `Config` / `Options` | Constructor params, configuration | `OrderServiceConfig`, `LoadUsersOptions` |
| `Params` / `Input` | Method parameters | `QueryParams`, `SearchParams`, `LoginInput` |
| `Result` / `Response` | Return values | `QueryResult`, `SearchResponse`, `FetchResult` |
| `Entry` / `Record` | Data records | `UserEntry`, `EventRecord` |
| `Event` | Events | `OrderEvent`, `StreamEvent` |
| `Definition` | Definitions / descriptors | `RouteDefinition`, `PluginDefinition` |

---

## 5. Type-Level Conventions *(Default)*

### `null` vs `undefined`

**Prefer `undefined` throughout the codebase.** Use `null` only at boundaries where an external contract (JSON API, database column) requires it as a distinct value.

Rationale:
- TypeScript's optional syntax (`x?: T`) produces `undefined`; using one sentinel avoids branching on both.
- `JSON.stringify` drops `undefined`, and default parameters / destructuring defaults only trigger on `undefined`.
- One sentinel means one type of null-check, not two.

**Override when:** the domain requires distinguishing "explicitly cleared" from "never set" (e.g., form fields, PATCH-style APIs). In that case, use `null` for the "explicit empty" state and document the distinction on the relevant type. Do not allow both in the same field — choose `T | undefined` or `T | null`, not `T | null | undefined`.

### Literal unions over `enum`

**Prefer string-literal unions:**

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
```

When runtime iteration is needed, derive the type from a `readonly` tuple:

```typescript
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = typeof LOG_LEVELS[number];
```

Rationale: zero runtime cost, tree-shakeable, JSON-friendly, no surprising numeric reverse mapping.

**Override when:** interop with a third-party API demands an `enum` value.

### `readonly` by default

- Mark class fields `readonly` unless mutation is required. Constructor-injected dependencies are always `readonly`.
- Type collection parameters as `readonly T[]` (or `ReadonlyMap` / `ReadonlySet`) when the function does not mutate them.
- Do not adopt deep-immutability libraries (Immer, Immutable.js); shallow `readonly` is sufficient for compile-time safety.

Rationale: zero runtime cost; documents intent; prevents accidental mutation bugs.

---

## 6. Module Structure *(Guidance)*

A typical module layout:

```
module-name/
├── ClassName.ts           # Main class (PascalCase)
├── helper-name.ts         # Helper functions (kebab-case)
├── types.ts               # Interfaces and types
├── index.ts               # Re-export public API
├── ClassName.test.ts      # Main class tests
└── helper-name.test.ts    # Helper function tests
```

- Keep interfaces in `types.ts` (or a `types/` subdirectory); do not create a file per interface.
- `index.ts` only re-exports; no implementation logic.
- Helper files use kebab-case (e.g., `token-parser.ts`, `response-cache.ts`, `input-validator.ts`).

---

## 7. Imports & Exports *(Rule)*

### Imports

```typescript
// Value imports
import { OrderService } from './OrderService.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Type imports (separate `import type`)
import type { UserEntry, EventRecord } from './types.js';
import type { HttpClient, ApiMessage } from '../http-client/types.js';
```

- Relative paths always carry the `.js` suffix (required by ESM resolution).
- Use `import type` for type-only imports.
- Always use the `node:` prefix for Node.js built-in imports (e.g., `node:path`, `node:fs/promises`).

### Exports

```typescript
// Classes and functions: named exports
export class OrderService { }
export function loadConfig() { }

// Re-exports in index.ts
export { OrderService } from './OrderService.js';
export type { QueryParams, QueryResult, OrderEvent } from './types.js';
```

- Prefer named exports; avoid `default` export.
- Use `export type` for pure type re-exports.

---

## 8. Comments

### JSDoc — public API *(Rule)*

Format: a one-line summary, a blank line, then any additional detail.

```typescript
/**
 * Processes an incoming order and returns a receipt.
 *
 * Retries transient upstream failures up to `maxRetries` times.
 */
export function processOrder(order: Order): Receipt { }
```

### Inline comments *(Guidance)*

```typescript
// Load history from the store and convert to ApiMessage[]
const history = this.loadHistory(params.userId);
```

### Section dividers *(Guidance)*

```typescript
// ── Section 1: user-auth ──────────────────────────────
// ── Internal methods ──────────────────────────────────
```

### Language & content *(Rule)*

- Write all comments in English.
- Do not add redundant `@param` / `@returns`; TypeScript types already express them.

---

## 9. Error Handling *(Rule)*

```typescript
// Throwing: use an explicit, actionable message
throw new Error(`User "${id}" not found`);

// Rethrowing: attach context via `cause`
try {
  await syncUser(id);
} catch (err) {
  const cause = err instanceof Error ? err : new Error(String(err));
  throw new Error(`Failed to sync user "${id}"`, { cause });
}

// Expected errors (e.g., missing file): skip silently
try {
  rawContent = await readFile(filePath, 'utf-8'); // from node:fs/promises
} catch {
  continue; // File does not exist; skip
}
```

- Every thrown `Error` message should include the relevant identifier or path.
- Only swallow an error when the absence of a resource is a normal, expected state.
- When rethrowing, add context via `new Error(msg, { cause })`; do not rethrow unchanged.

---

## 10. Async Patterns *(Guidance)*

```typescript
// Standard: async/await
async search(params: QueryParams): Promise<QueryResult> {
  const result = await this.callApi(params);
  return result;
}

// Streaming: AsyncGenerator
async *watchEvents(params: WatchParams): AsyncGenerator<StreamEvent> {
  const stream = await this.openStream(params);
  for await (const event of stream) {
    yield event;
  }
}

// Callback: optional callback for simple cases
onEvent?: (event: OrderEvent) => void;
```

---

## 11. Testing

**Framework: Vitest** *(Default — Jest or another Vitest-compatible framework may be substituted.)*

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserRepository } from './UserRepository.js';

describe('UserRepository', () => {
  let outputDir: string;
  let repo: UserRepository;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'test-'));
    repo = new UserRepository(outputDir);
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  describe('createUser', () => {
    it('creates a user with a UUID and JSON record', async () => {
      const entry = await repo.createUser('alice');
      expect(entry.userId).toBeDefined();
    });
  });
});
```

*(Rule)*
- Use `mkdtemp()` for temporary directories; clean up in `afterEach`.
- Group by feature with `describe`; describe behavior with `it`.
- Keep each test independent; do not share mutable state.
- Create mocks inline within the test file (in `it` or `beforeEach`); avoid shared mock factories across test files.

---

## 12. Other Conventions

| Convention | Notes | Tier |
|------------|-------|------|
| File encoding | UTF-8; pass `'utf-8'` explicitly on read/write | Rule |
| Module system | ES Modules (`"type": "module"`) | Rule |
| TypeScript `strict` | `strict: true` | Rule |
| TypeScript `target` | Pick the newest ECMAScript version compatible with your minimum runtime (Node LTS or browser baseline) | Default |
| Logging | Centralize logging behind a single module; keep call sites decoupled from the library choice | Guidance |
| Platform | Detect via `process.platform`; avoid hard-coded path separators | Rule |
| In-memory state | Prefer `Map` over plain objects for keyed collections (e.g., `Map<string, CacheEntry>`) | Default |

---

## 13. Protocol Compatibility *(Rule)*

The repository-wide rationale and decision matrix are defined by [Protocol Compatibility](./protocol-compatibility-principle.md). Protocol adapters are not released in lockstep with either peer, so boundary handling must be tolerant by default:

- Map fields and variants with a verified equivalent.
- Pass through unknown structures when the target protocol can carry them without reinterpretation.
- When passthrough is impossible, omit optional unknown fields or components, emit a structured warning containing names or fixed contexts only, and continue.
- Never log unknown values, request content, response content, or opaque payloads while reporting compatibility degradation.
- Reject only when required target data is absent or invalid, identity/order/continuation state is inconsistent, input is malformed, a resource bound is exceeded, or continuing would require inventing data or associations.

Tests for a protocol boundary must include additive unknown fields, future versioned discriminators, unknown auxiliary events/items, and the strict invariants that still prevent continuation.
