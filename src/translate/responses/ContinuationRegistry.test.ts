import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLevel, type ContinuationCapacityEvictionLog } from '../../logger.js';
import { CONTINUATION_TTL_MS, ContinuationRegistry } from './ContinuationRegistry.js';
import { ContinuationStore, type ContinuationStoreLike } from './ContinuationStore.js';
import { TranslationError, type ContinuationStage } from './types.js';

function addCall(registry: ContinuationRegistry, stage: ContinuationStage, name: string): string {
  const toolId = registry.allocateToolId(stage);
  const item = {
    type: 'function_call' as const,
    call_id: `call-${name}`,
    name,
    arguments: '{}',
    status: 'completed',
  };
  registry.addItem(stage, { outputIndex: 0, item });
  registry.addCall(stage, toolId, {
    callId: item.call_id,
    outputIndex: 0,
    name,
    input: {},
  });
  return toolId;
}

const RECOVERY_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
] as const;

test('failed oversized publication leaves an existing group unchanged', () => {
  let nextId = 0;
  const registry = new ContinuationRegistry({
    randomId: () => `id-${nextId++}`,
    groupMaxBytes: 700,
  });
  const first = registry.createStage('model');
  const firstTool = addCall(registry, first, 'first');
  const firstGroup = registry.publish(first);

  const oversized = registry.createStage('model');
  const oversizedTool = registry.allocateToolId(oversized);
  const largeArguments = JSON.stringify({ value: 'x'.repeat(1000) });
  registry.addItem(oversized, {
    outputIndex: 0,
    item: {
      type: 'function_call',
      call_id: 'large-call',
      name: 'large',
      arguments: largeArguments,
      status: 'completed',
    },
  });
  registry.addCall(oversized, oversizedTool, {
    callId: 'large-call',
    outputIndex: 0,
    name: 'large',
    input: { value: 'x'.repeat(1000) },
  });
  assert.throws(() => registry.publish(oversized), TranslationError);
  assert.equal(registry.resolve([firstTool], 'model'), firstGroup);
});

test('group-count pressure deterministically evicts the oldest published group', () => {
  let nextId = 0;
  let now = 1;
  const warnings: ContinuationCapacityEvictionLog[] = [];
  const registry = new ContinuationRegistry({
    randomId: () => `id-${nextId++}`,
    now: () => now++,
    maxGroups: 1,
    onCapacityEviction: (fields) => warnings.push(fields),
  });
  const first = registry.createStage('model');
  const firstTool = addCall(registry, first, 'first');
  registry.publish(first);
  const second = registry.createStage('model');
  const secondTool = addCall(registry, second, 'second');
  const secondGroup = registry.publish(second);

  assert.throws(() => registry.resolve([firstTool], 'model'), TranslationError);
  assert.equal(registry.resolve([secondTool], 'model'), secondGroup);
  assert.equal(warnings.length, 1);
  assert.deepEqual(Object.keys(warnings[0]).sort(), [
    'evictedGroupCount',
    'groupCountAfter',
    'groupCountBefore',
    'oldestEvictedIdleAgeMs',
    'totalBytesAfter',
    'totalBytesBefore',
    'trigger',
  ]);
  assert.equal(warnings[0].trigger, 'group-count');
  assert.equal(warnings[0].evictedGroupCount, 1);
  assert.equal(warnings[0].groupCountBefore, 2);
  assert.equal(warnings[0].groupCountAfter, 1);
  assert.ok(warnings[0].totalBytesBefore > warnings[0].totalBytesAfter);
  assert.equal(warnings[0].oldestEvictedIdleAgeMs, 1);
});

test('default lifetime accommodates long-running tool execution', () => {
  let now = 0;
  const registry = new ContinuationRegistry({ now: () => now });
  const stage = registry.createStage('model');
  const toolId = addCall(registry, stage, 'long-running');
  registry.publish(stage);

  now = 30 * 60 * 1000;
  assert.doesNotThrow(() => registry.resolve([toolId], 'model'));
  assert.equal(CONTINUATION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('successful lookup renews the idle expiry', () => {
  let now = 0;
  const registry = new ContinuationRegistry({ now: () => now, ttlMs: 100 });
  const stage = registry.createStage('model');
  const toolId = addCall(registry, stage, 'active');
  registry.publish(stage);

  now = 90;
  assert.equal(registry.resolve([toolId], 'model').expiresAt, 190);
  now = 150;
  assert.equal(registry.resolve([toolId], 'model').expiresAt, 250);
  now = 251;
  assert.throws(() => registry.resolve([toolId], 'model'), TranslationError);
});

test('successful lookup can renew beyond the original lifetime', () => {
  let now = 0;
  const registry = new ContinuationRegistry({ now: () => now, ttlMs: 100 });
  const stage = registry.createStage('model');
  const toolId = addCall(registry, stage, 'bounded');
  registry.publish(stage);

  now = 90;
  assert.equal(registry.resolve([toolId], 'model').expiresAt, 190);
  now = 180;
  assert.equal(registry.resolve([toolId], 'model').expiresAt, 280);
  now = 270;
  assert.equal(registry.resolve([toolId], 'model').expiresAt, 370);
});

test('capacity pressure evicts the least recently accessed group', () => {
  let nextId = 0;
  let now = 0;
  const registry = new ContinuationRegistry({
    randomId: () => `id-${nextId++}`,
    now: () => now,
    maxGroups: 2,
    onCapacityEviction: () => undefined,
  });
  const first = registry.createStage('model');
  const firstTool = addCall(registry, first, 'first');
  registry.publish(first);
  now = 10;
  const second = registry.createStage('model');
  const secondTool = addCall(registry, second, 'second');
  registry.publish(second);
  now = 20;
  registry.resolve([firstTool], 'model');
  now = 30;
  const third = registry.createStage('model');
  const thirdTool = addCall(registry, third, 'third');
  registry.publish(third);

  assert.doesNotThrow(() => registry.resolve([firstTool], 'model'));
  assert.throws(() => registry.resolve([secondTool], 'model'), TranslationError);
  assert.doesNotThrow(() => registry.resolve([thirdTool], 'model'));
});

test('published continuation and renewed expiry survive process replacement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-registry-'));
  let now = 0;
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  try {
    const first = new ContinuationRegistry({
      now: () => now,
      randomId: () => ids.shift() as string,
      ttlMs: 100,
      store: new ContinuationStore(directory),
    });
    const stage = first.createStage('model');
    const toolId = addCall(first, stage, 'persisted');
    first.publish(stage);
    first.close();

    now = 90;
    const second = new ContinuationRegistry({
      now: () => now,
      ttlMs: 100,
      store: new ContinuationStore(directory),
    });
    assert.equal(second.resolve([toolId], 'model').expiresAt, 190);
    second.close();

    now = 150;
    const third = new ContinuationRegistry({
      now: () => now,
      ttlMs: 100,
      store: new ContinuationStore(directory),
    });
    assert.equal(third.resolve([toolId], 'model').expiresAt, 250);
    third.close();

    now = 251;
    const expired = new ContinuationRegistry({
      now: () => now,
      ttlMs: 100,
      store: new ContinuationStore(directory),
    });
    assert.throws(() => expired.resolve([toolId], 'model'), TranslationError);
    expired.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed persistence leaves a staged group unpublished', () => {
  const store: ContinuationStoreLike = {
    load: () => [],
    write: () => { throw new Error('disk unavailable'); },
    remove: () => undefined,
  };
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const registry = new ContinuationRegistry({
    randomId: () => ids.shift() as string,
    store,
  });
  const stage = registry.createStage('model');
  const toolId = addCall(registry, stage, 'failed');

  assert.throws(() => registry.publish(stage), TranslationError);
  assert.equal(stage.published, false);
  assert.throws(() => registry.resolve([toolId], 'model'), TranslationError);
});

test('failed renewal persistence does not extend in-memory expiry', () => {
  let now = 0;
  let writes = 0;
  const store: ContinuationStoreLike = {
    load: () => [],
    write: () => {
      writes += 1;
      if (writes > 1) throw new Error('disk unavailable');
    },
    remove: () => undefined,
  };
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const registry = new ContinuationRegistry({
    now: () => now,
    randomId: () => ids.shift() as string,
    ttlMs: 100,
    store,
  });
  const stage = registry.createStage('model');
  const toolId = addCall(registry, stage, 'renewal');
  const group = registry.publish(stage);

  now = 90;
  assert.throws(() => registry.resolve([toolId], 'model'), TranslationError);
  assert.equal(group.lastAccessedAt, 0);
  assert.equal(group.expiresAt, 100);
});

test('capacity warning output excludes continuation identifiers and content', () => {
  const sentinels = {
    group: 'GROUP_SECRET_SENTINEL',
    tool: 'TOOL_SECRET_SENTINEL',
    model: 'MODEL_SECRET_SENTINEL',
    input: 'INPUT_SECRET_SENTINEL',
  };
  const ids = [sentinels.group, sentinels.tool, 'GROUP_TWO', 'TOOL_TWO'];
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.join(' ')); };
  setLevel('warn');
  try {
    const registry = new ContinuationRegistry({
      randomId: () => ids.shift() as string,
      maxGroups: 1,
    });
    const first = registry.createStage(sentinels.model);
    const firstTool = registry.allocateToolId(first);
    registry.addItem(first, { outputIndex: 0, item: {
      type: 'function_call',
      call_id: 'call-secret',
      name: 'secret-tool',
      arguments: JSON.stringify({ value: sentinels.input }),
      status: 'completed',
    } });
    registry.addCall(first, firstTool, {
      callId: 'call-secret',
      outputIndex: 0,
      name: 'secret-tool',
      input: { value: sentinels.input },
    });
    registry.publish(first);
    const second = registry.createStage('model-two');
    addCall(registry, second, 'second');
    registry.publish(second);
  } finally {
    setLevel('error');
    console.log = originalLog;
  }

  const output = lines.join('\n');
  assert.match(output, /continuation\.capacity_evicted/u);
  for (const sentinel of Object.values(sentinels)) assert.equal(output.includes(sentinel), false);
});

test('complete function-call and reasoning state survives process replacement exactly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-registry-'));
  const ids = [...RECOVERY_IDS];
  try {
    const first = new ContinuationRegistry({
      now: () => 10,
      randomId: () => ids.shift() as string,
      store: new ContinuationStore(directory),
    });
    const stage = first.createStage('model-exact');
    const toolId = first.allocateToolId(stage);
    first.addItem(stage, {
      outputIndex: 0,
      item: {
        id: 'reasoning-item',
        type: 'reasoning',
        encrypted_content: 'opaque-reasoning',
        summary: [{ type: 'summary_text', text: 'summary' }],
        status: 'completed',
      },
    });
    first.addItem(stage, {
      outputIndex: 1,
      item: {
        id: 'function-item',
        type: 'function_call',
        call_id: 'upstream-call',
        name: 'lookup',
        arguments: '{"path":"README.md"}',
        status: 'completed',
      },
    });
    first.addCall(stage, toolId, {
      callId: 'upstream-call',
      outputIndex: 1,
      name: 'lookup',
      input: { path: 'README.md' },
    });
    const published = first.publish(stage);
    first.close();

    const second = new ContinuationRegistry({
      now: () => 20,
      store: new ContinuationStore(directory),
    });
    const recovered = second.resolve([toolId], 'model-exact');
    assert.equal(recovered.groupId, published.groupId);
    assert.equal(recovered.createdAt, 10);
    assert.equal(recovered.lastAccessedAt, 20);
    assert.deepEqual(recovered.items, published.items);
    assert.deepEqual([...recovered.calls], [...published.calls]);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('startup removes expired records before exposing recovered indexes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-registry-'));
  const ids = [...RECOVERY_IDS];
  try {
    const first = new ContinuationRegistry({
      now: () => 0,
      randomId: () => ids.shift() as string,
      ttlMs: 100,
      store: new ContinuationStore(directory),
    });
    const stage = first.createStage('model');
    const toolId = addCall(first, stage, 'expired');
    const group = first.publish(stage);
    first.close();

    const second = new ContinuationRegistry({
      now: () => 100,
      ttlMs: 100,
      store: new ContinuationStore(directory),
    });
    assert.throws(() => second.resolve([toolId], 'model'), TranslationError);
    assert.equal(existsSync(join(directory, `${group.groupId}.json`)), false);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('startup deterministically evicts least-recently-used recovered groups', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-registry-'));
  const ids = [...RECOVERY_IDS];
  const warnings: ContinuationCapacityEvictionLog[] = [];
  try {
    const first = new ContinuationRegistry({
      now: () => 0,
      randomId: () => ids.shift() as string,
      store: new ContinuationStore(directory),
    });
    const oldest = first.createStage('model');
    const oldestTool = addCall(first, oldest, 'oldest');
    const oldestGroup = first.publish(oldest);
    const newest = first.createStage('model');
    const newestTool = addCall(first, newest, 'newest');
    first.publish(newest);
    first.close();

    const second = new ContinuationRegistry({
      now: () => 1,
      maxGroups: 1,
      onCapacityEviction: (fields) => warnings.push(fields),
      store: new ContinuationStore(directory),
    });
    assert.throws(() => second.resolve([oldestTool], 'model'), TranslationError);
    assert.doesNotThrow(() => second.resolve([newestTool], 'model'));
    assert.equal(existsSync(join(directory, `${oldestGroup.groupId}.json`)), false);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].trigger, 'group-count');
    assert.equal(warnings[0].evictedGroupCount, 1);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('startup enforces aggregate-byte capacity on recovered groups', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-registry-'));
  const ids = [...RECOVERY_IDS];
  const warnings: ContinuationCapacityEvictionLog[] = [];
  try {
    const first = new ContinuationRegistry({
      now: () => 0,
      randomId: () => ids.shift() as string,
      store: new ContinuationStore(directory),
    });
    const oldest = first.createStage('model');
    const oldestTool = addCall(first, oldest, 'oldest');
    first.publish(oldest);
    const newest = first.createStage('model');
    const newestTool = addCall(first, newest, 'newest');
    const newestGroup = first.publish(newest);
    first.close();

    const second = new ContinuationRegistry({
      now: () => 1,
      totalMaxBytes: newestGroup.byteSize,
      onCapacityEviction: (fields) => warnings.push(fields),
      store: new ContinuationStore(directory),
    });
    assert.throws(() => second.resolve([oldestTool], 'model'), TranslationError);
    assert.doesNotThrow(() => second.resolve([newestTool], 'model'));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].trigger, 'aggregate-bytes');
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('startup rejects every record participating in a cross-record tool-id collision', () => {
  const sharedToolId = RECOVERY_IDS[5];
  const firstGroupId = RECOVERY_IDS[0];
  const secondGroupId = RECOVERY_IDS[2];
  const records = [
    {
      version: 1 as const,
      groupId: firstGroupId,
      modelId: 'model',
      createdAt: 0,
      lastAccessedAt: 0,
      expiresAt: 100,
      items: [{ outputIndex: 0, item: {
        type: 'function_call' as const,
        call_id: 'call-first',
        name: 'first',
        arguments: '{}',
        status: 'completed',
      } }],
      calls: [[sharedToolId, {
        callId: 'call-first', outputIndex: 0, name: 'first', input: {},
      }]] as const,
    },
    {
      version: 1 as const,
      groupId: secondGroupId,
      modelId: 'model',
      createdAt: 0,
      lastAccessedAt: 0,
      expiresAt: 100,
      items: [{ outputIndex: 0, item: {
        type: 'function_call' as const,
        call_id: 'call-second',
        name: 'second',
        arguments: '{}',
        status: 'completed',
      } }],
      calls: [[sharedToolId, {
        callId: 'call-second', outputIndex: 0, name: 'second', input: {},
      }]] as const,
    },
  ];
  const removed: string[] = [];
  const store: ContinuationStoreLike = {
    load: () => records,
    write: () => undefined,
    remove: (groupId) => removed.push(groupId),
  };

  const registry = new ContinuationRegistry({ now: () => 1, store });
  assert.throws(() => registry.resolve([sharedToolId], 'model'), TranslationError);
  assert.deepEqual(removed.sort(), [firstGroupId, secondGroupId].sort());
});