import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContinuationStore, type PersistedContinuationGroupV1 } from './ContinuationStore.js';

const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const TOOL_ID = '22222222-2222-4222-8222-222222222222';

function record(groupId = GROUP_ID): PersistedContinuationGroupV1 {
  return {
    version: 1,
    groupId,
    modelId: 'model',
    createdAt: 10,
    lastAccessedAt: 20,
    expiresAt: 30,
    items: [{
      outputIndex: 0,
      item: {
        type: 'function_call',
        call_id: 'call-test',
        name: 'test',
        arguments: '{}',
        status: 'completed',
      },
    }],
    calls: [[TOOL_ID, {
      callId: 'call-test',
      outputIndex: 0,
      name: 'test',
      input: {},
    }]],
  };
}

test('continuation store atomically replaces and loads one group record', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-store-'));
  try {
    const store = new ContinuationStore(directory);
    store.write(record());
    store.write({ ...record(), lastAccessedAt: 25, expiresAt: 35 });

    assert.deepEqual(store.load(), [{ ...record(), lastAccessedAt: 25, expiresAt: 35 }]);
    assert.equal(
      JSON.parse(readFileSync(join(directory, `${GROUP_ID}.json`), 'utf8')).version,
      1,
    );
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation store removes malformed and filename-mismatched records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-store-'));
  try {
    const malformedPath = join(directory, '33333333-3333-4333-8333-333333333333.json');
    const mismatchedPath = join(directory, '44444444-4444-4444-8444-444444444444.json');
    writeFileSync(malformedPath, '{', 'utf8');
    writeFileSync(mismatchedPath, JSON.stringify(record()), 'utf8');

    const store = new ContinuationStore(directory);
    assert.deepEqual(store.load(), []);
    assert.equal(existsSync(malformedPath), false);
    assert.equal(existsSync(mismatchedPath), false);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation store rejects a second live owner and permits it after release', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-store-'));
  const ownerIds = [
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777',
  ];
  try {
    const first = new ContinuationStore(directory, {
      processId: 100,
      randomId: () => ownerIds.shift() as string,
      isProcessAlive: (pid) => pid === 100,
    });
    assert.throws(() => new ContinuationStore(directory, {
      processId: 200,
      randomId: () => ownerIds.shift() as string,
      isProcessAlive: (pid) => pid === 100,
    }), /already owned/u);

    first.close();
    const second = new ContinuationStore(directory, {
      processId: 200,
      randomId: () => ownerIds.shift() as string,
      isProcessAlive: () => true,
    });
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation store reclaims a verified stale owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-store-'));
  const staleOwner = {
    version: 1,
    pid: 100,
    nonce: '55555555-5555-4555-8555-555555555555',
  };
  try {
    writeFileSync(join(directory, '.owner'), JSON.stringify(staleOwner), 'utf8');
    const store = new ContinuationStore(directory, {
      processId: 200,
      randomId: () => '66666666-6666-4666-8666-666666666666',
      isProcessAlive: () => false,
    });
    const current = JSON.parse(readFileSync(join(directory, '.owner'), 'utf8')) as {
      pid: number;
      nonce: string;
    };
    assert.equal(current.pid, 200);
    assert.equal(current.nonce, '66666666-6666-4666-8666-666666666666');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation store fails closed for a malformed owner record', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-store-'));
  const ownerPath = join(directory, '.owner');
  try {
    writeFileSync(ownerPath, '{', 'utf8');
    assert.throws(() => new ContinuationStore(directory), /ownership record is invalid/u);
    assert.equal(readFileSync(ownerPath, 'utf8'), '{');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation store release never removes a replaced owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-store-'));
  const replacement = {
    version: 1,
    pid: 200,
    nonce: '66666666-6666-4666-8666-666666666666',
  };
  try {
    const store = new ContinuationStore(directory, {
      processId: 100,
      randomId: () => '55555555-5555-4555-8555-555555555555',
    });
    writeFileSync(join(directory, '.owner'), JSON.stringify(replacement), 'utf8');

    store.close();

    assert.deepEqual(JSON.parse(readFileSync(join(directory, '.owner'), 'utf8')), replacement);
    assert.throws(() => store.load(), /ownership is unavailable/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation store removes unknown schemas, oversized records, and temporary files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-store-'));
  try {
    const unknownVersionPath = join(directory, '33333333-3333-4333-8333-333333333333.json');
    const extraFieldPath = join(directory, '44444444-4444-4444-8444-444444444444.json');
    const oversizedPath = join(directory, '88888888-8888-4888-8888-888888888888.json');
    const temporaryPath = join(directory, '.tmp-abandoned');
    writeFileSync(unknownVersionPath, JSON.stringify({ ...record(), version: 2 }), 'utf8');
    writeFileSync(extraFieldPath, JSON.stringify({
      ...record('44444444-4444-4444-8444-444444444444'),
      unexpected: true,
    }), 'utf8');
    writeFileSync(oversizedPath, 'x'.repeat(200), 'utf8');
    writeFileSync(temporaryPath, 'temporary', 'utf8');

    const store = new ContinuationStore(directory, { recordMaxBytes: 100 });
    assert.deepEqual(store.load(), []);
    assert.equal(existsSync(unknownVersionPath), false);
    assert.equal(existsSync(extraFieldPath), false);
    assert.equal(existsSync(oversizedPath), false);
    assert.equal(existsSync(temporaryPath), false);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation store rejects inconsistent call mappings and timestamps', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-store-'));
  try {
    const invalidTimestampId = '33333333-3333-4333-8333-333333333333';
    const mismatchedCallId = '44444444-4444-4444-8444-444444444444';
    const mismatchedArgumentsId = '55555555-5555-4555-8555-555555555555';
    writeFileSync(join(directory, `${invalidTimestampId}.json`), JSON.stringify({
      ...record(invalidTimestampId),
      lastAccessedAt: 31,
      expiresAt: 30,
    }), 'utf8');
    writeFileSync(join(directory, `${mismatchedCallId}.json`), JSON.stringify({
      ...record(mismatchedCallId),
      calls: [[TOOL_ID, {
        callId: 'different-call',
        outputIndex: 0,
        name: 'test',
        input: {},
      }]],
    }), 'utf8');
    writeFileSync(join(directory, `${mismatchedArgumentsId}.json`), JSON.stringify({
      ...record(mismatchedArgumentsId),
      items: [{
        ...record().items[0],
        item: { ...record().items[0].item, arguments: '{"tampered":true}' },
      }],
    }), 'utf8');

    const store = new ContinuationStore(directory);
    assert.deepEqual(store.load(), []);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation store rejects an over-limit startup directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-store-'));
  try {
    writeFileSync(join(directory, 'unrelated-a'), '', 'utf8');
    writeFileSync(join(directory, 'unrelated-b'), '', 'utf8');
    const store = new ContinuationStore(directory, { directoryEntryMax: 2 });
    assert.throws(() => store.load(), /too many directory entries/u);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation store enforces user-only Unix permissions', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-store-'));
  try {
    chmodSync(directory, 0o777);
    const store = new ContinuationStore(directory);
    store.write(record());

    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, `${GROUP_ID}.json`)).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, '.owner')).mode & 0o777, 0o600);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation store preserves opaque completed response items', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-store-'));
  const value: PersistedContinuationGroupV1 = {
    ...record(),
    items: [
      {
        outputIndex: 0,
        item: {
          id: 'search-item',
          type: 'web_search_call',
          status: 'completed',
          action: { type: 'search' },
        },
      },
      { ...record().items[0], outputIndex: 1 },
    ],
    calls: [[TOOL_ID, { ...record().calls[0][1], outputIndex: 1 }]],
  };
  try {
    const store = new ContinuationStore(directory);
    store.write(value);
    assert.deepEqual(store.load(), [value]);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});