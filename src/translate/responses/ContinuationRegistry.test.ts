import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTINUATION_ABSOLUTE_TTL_MS,
  CONTINUATION_TTL_MS,
  ContinuationRegistry,
} from './ContinuationRegistry.js';
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
  const registry = new ContinuationRegistry({
    randomId: () => `id-${nextId++}`,
    now: () => now++,
    maxGroups: 1,
  });
  const first = registry.createStage('model');
  const firstTool = addCall(registry, first, 'first');
  registry.publish(first);
  const second = registry.createStage('model');
  const secondTool = addCall(registry, second, 'second');
  const secondGroup = registry.publish(second);

  assert.throws(() => registry.resolve([firstTool], 'model'), TranslationError);
  assert.equal(registry.resolve([secondTool], 'model'), secondGroup);
});

test('default lifetime accommodates long-running tool execution', () => {
  let now = 0;
  const registry = new ContinuationRegistry({ now: () => now });
  const stage = registry.createStage('model');
  const toolId = addCall(registry, stage, 'long-running');
  registry.publish(stage);

  now = 30 * 60 * 1000;
  assert.doesNotThrow(() => registry.resolve([toolId], 'model'));
  assert.equal(CONTINUATION_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(CONTINUATION_ABSOLUTE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
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

test('successful lookup cannot renew beyond the absolute lifetime', () => {
  let now = 0;
  const registry = new ContinuationRegistry({
    now: () => now,
    ttlMs: 100,
    absoluteTtlMs: 250,
  });
  const stage = registry.createStage('model');
  const toolId = addCall(registry, stage, 'bounded');
  registry.publish(stage);

  now = 90;
  assert.equal(registry.resolve([toolId], 'model').expiresAt, 190);
  now = 180;
  assert.equal(registry.resolve([toolId], 'model').expiresAt, 250);
  now = 249;
  assert.equal(registry.resolve([toolId], 'model').expiresAt, 250);
  now = 250;
  assert.throws(() => registry.resolve([toolId], 'model'), TranslationError);
});

test('capacity pressure evicts the least recently accessed group', () => {
  let nextId = 0;
  let now = 0;
  const registry = new ContinuationRegistry({
    randomId: () => `id-${nextId++}`,
    now: () => now,
    maxGroups: 2,
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