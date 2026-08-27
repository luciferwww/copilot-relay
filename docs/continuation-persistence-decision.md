# Continuation Persistence Decision

Status: accepted and implemented for the first post-v0.2 persistence release.

This record resolves the storage choices required by `requirement.md`, `design.md`, and `spec.md`. Those files remain authoritative for product behavior and the implementation contract.

## 1. Problem boundary

Messages-to-Responses translation emits relay-owned `tool_use.id` values. A later Anthropic request returns those ids, but not every opaque Responses value needed for stateless replay. The released v0.2 process-local `ContinuationRegistry` therefore lost valid continuations on restart; the implemented store closes that lifecycle gap.

Persistence belongs behind `ContinuationRegistry`; mapper-facing staging, publication, lookup, replay, and validation semantics do not change. Native `POST /v1/responses` remains outside this state.

Only a fully published continuation group is durable. Stages, deltas, partial items, arbitrary message history, tool results, response text, credentials, and model-catalog data are never continuation records.

## 2. Decision

Use a bounded directory of versioned plaintext JSON group records with an in-memory index as the read path.

- Each published group is one record. Publishing or renewing a group atomically replaces only that record; there is no database, append journal, or whole-registry rewrite.
- The record contains exactly the existing authoritative group fields: group id, model id, timestamps, completed replay items, and the external-tool-id map with `callId`, `outputIndex`, `name`, and authoritative `input`. The name and input are required to validate historical Anthropic `tool_use` blocks and are not optional metadata.
- The existing cryptographically random UUID `groupId` is filesystem-safe and names the record as `<groupId>.json`; there is no second storage id or filename index. Startup verifies that the filename and record `groupId` match.
- The existing group-count, per-group byte, aggregate-byte, model-match, and deterministic LRU rules remain unchanged. The idle TTL becomes a renewable seven days and there is no absolute lifetime limit.
- Capacity-driven LRU eviction emits one safe warning per eviction plan. The warning contains only the trigger, counts, byte totals, and age metadata; it never contains ids, model names, tool input, replay items, or other continuation content. Normal idle expiry is not a warning.
- The store supports one relay server process per data directory. Startup acquires exclusive ownership before loading records and releases it on orderly shutdown. A second live owner fails startup; stale ownership may be reclaimed only after verifying that its recorded process is not alive.

This layout keeps ordinary lookup in memory and bounds synchronous durability work to one group. A whole-registry snapshot was rejected because every idle-TTL renewal could synchronously rewrite up to the aggregate 32 MiB limit. An append journal was rejected because crash recovery and compaction add machinery without improving the bounded single-process contract.

## 3. Confidentiality boundary and permissions

Continuation records contain sensitive tool input and opaque reasoning state in plaintext. Protection relies on the operating-system user boundary:

- on Unix-like systems, the continuation directory is created with mode `0700` and record and temporary files with mode `0600`;
- on Windows, the store relies on the existing user-profile directory ACL assumption used by `auth.json`;
- permission setup failure is a startup or write failure rather than a silent fallback to broader access;
- record contents, record names, ids, model names, and tool input are never printed, logged, included in CLI output, or exposed in client errors.

Application-managed encryption with a key stored under the same OS user boundary was rejected for this phase. A process able to read the records could ordinarily read such a key as well, while key creation, rotation, loss recovery, and authentication failure would add substantial lifecycle and availability complexity. This decision does not claim protection from the same OS user, an administrator, malware running as that user, or copies made by backup and synchronization software.

Continuation lifetime is independent of the local authentication lifecycle. `login`, including replacement with another account, and `logout` do not remove or mutate continuation records. Records contain no access or Copilot token, and clearing them would make every retained Claude Code session fail deterministically after an account change. After a later login, the relay attempts normal replay; the new account's model access and any upstream account binding remain authoritative and may still reject the request. TTL and capacity-driven LRU provide bounded cleanup.

## 4. Record and validation contract

Each bounded JSON record has this closed schema:

```typescript
interface PersistedContinuationGroupV1 {
  version: 1;
  groupId: string;
  modelId: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  items: CompletedContinuationItem[];
  calls: Array<[string, ContinuationCall]>;
}
```

`byteSize` is recalculated from the same logical serialization used by the live registry; a stored byte count is not trusted. Startup validates the filename, exact record schema, finite integer timestamps, timestamp ordering, ids, item and call shapes, unique group/tool ids, call-to-item consistency, model association fields, and all configured bounds before exposing any group to lookup.

Startup processes only regular `<groupId>.json` record files and uses bounded file and directory-entry counts. It removes temporary files and rejects invalid or mismatched filenames, unknown versions, oversized or malformed JSON, invalid records, expired records, duplicate ids, and over-capacity records. Records participating in an id collision are all rejected rather than selecting one as authoritative. After validation, the normal LRU order selects the bounded live set and removes the rest.

## 5. Commit and recovery

All record writes use a temporary file in the record directory, user-only permissions, file flush, atomic rename in the same directory, and a best-effort directory flush where the platform supports it. Temporary names are random and startup removes abandoned temporary files without parsing them as records.

Publication proceeds as follows:

1. Build and validate the candidate group and the same expiry/eviction plan used by the in-memory registry.
2. Serialize and atomically install the new record. This durable rename is the publication commit point.
3. Apply the complete in-memory mutation synchronously.
4. Remove expired and evicted record files. Failure to remove an old file is reported safely but does not roll back the committed group; startup validation and LRU enforcement remove such leftovers.

A failure before the durable rename leaves the live registry unchanged and returns a translation 502 before the Anthropic success commit. Once the rename succeeds, publication is committed even if the process exits before the in-memory update or success terminator; restart recovery may expose that valid group. This is safe because streaming clients may already have received its relay-issued tool ids.

A successful `resolve` first atomically replaces that group's record with renewed timestamps, then updates the in-memory expiration state. A renewal write failure returns a translation 502 before upstream model execution; it does not silently claim a renewable lifetime that restart cannot recover.

Expiry and eviction remove the live id mappings and their record. Individual unlink is the atomic deletion primitive. A crash may leave a valid but expired or over-capacity old record, but startup always reapplies expiry and deterministic LRU limits before lookups are enabled, so it cannot resurrect usable state.

## 6. Startup and ownership

Store initialization completes before the HTTP listener accepts requests:

1. Acquire a same-directory exclusive owner record containing the process id and a random owner nonce.
2. Open or create the user-protected continuation directory.
3. Enumerate bounded candidate files and parse and validate each independently.
4. Build temporary group and tool-id indexes, reject cross-record collisions, and enforce expiry and LRU bounds.
5. Publish the complete recovered indexes together, then remove rejected and excess files.

An owner record whose process is alive blocks a second owner. One whose process is no longer alive may be reclaimed. PID reuse may conservatively block startup but must never permit two writers. Shutdown removes the owner record only if its nonce still matches. Shared-network filesystems and active-active relay processes are outside version 1.

Recoverable record failures discard only unusable continuation state and allow startup. Inability to establish exclusive ownership, create the protected record directory, or perform a required write fails startup or the publishing request rather than silently falling back to process-local publication.

## 7. Required proof

The implementation is complete only when tests prove:

- an unexpired published group resolves in a new registry using the same directory;
- completed function-call and reasoning items, tool ids, call ids, names, inputs, model id, and timestamps survive exactly;
- unpublished and discarded stages never create records;
- renewal survives another process replacement and extends expiry to seven days after the most recent successful lookup;
- publication and renewal write failures do not produce a falsely successful continuation;
- malformed JSON or schemas, mismatched filenames, unknown versions, expired records, collisions, and oversized records remain unavailable;
- startup enforces count, aggregate-byte, and deterministic LRU limits and removes temporary leftovers;
- a second live owner cannot open the store;
- account-changing login and logout preserve continuation state, and a later login can attempt to resume an unexpired group without exposing persisted content;
- Unix permissions are `0700` for the directory and `0600` for record and temporary files, while Windows records remain under the user-profile ACL boundary;
- no record content, record name, continuation id, model name, tool input, reasoning content, or credential appears in logs, CLI output, client errors, or thrown messages.

The cheapest acceptance check is a restart test: publish a group into a temporary data directory, close the first registry, construct a second registry from that directory, and resolve the original tool id with the original model. The same test must fail after expiry or invalid record modification.

## 8. Deferred choices

- Recovery policy for records whose creation or access timestamps are materially later than the current clock. This requires an explicit clock-rollback/skew contract and TTL relationship before validation can reject such records safely.
- Encryption at rest backed by an OS credential vault or an externally supplied key with a meaningfully separate security boundary.
- Shared or remote persistence.
- Multiple active relay processes over one store.
- Background asynchronous writes that would require changing mapper commit semantics.
- Journaling or compaction, unless measured per-record write cost proves the bounded design insufficient.