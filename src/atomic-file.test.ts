import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTextFileAtomically } from './atomic-file.js';

test('atomic text replacement preserves the existing mode and leaves no temporary file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-atomic-'));
  const target = join(directory, 'config.toml');
  try {
    writeFileSync(target, 'before', { encoding: 'utf8', mode: 0o640 });
    if (process.platform !== 'win32') chmodSync(target, 0o640);

    writeTextFileAtomically(target, 'after');

    assert.equal(readFileSync(target, 'utf8'), 'after');
    if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(directory), ['config.toml']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('atomic text replacement cleans its temporary file when replacement fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-relay-atomic-'));
  const targetDirectory = join(directory, 'config.toml');
  try {
    mkdirSync(targetDirectory);
    writeFileSync(join(directory, 'sentinel'), 'preserved', 'utf8');
    assert.throws(() => writeTextFileAtomically(targetDirectory, 'after'));
    assert.deepEqual(readdirSync(directory).sort(), ['config.toml', 'sentinel']);
    assert.equal(statSync(targetDirectory).isDirectory(), true);
    assert.equal(readFileSync(join(directory, 'sentinel'), 'utf8'), 'preserved');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});