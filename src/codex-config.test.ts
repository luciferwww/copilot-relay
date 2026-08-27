import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeCodexConfig } from './codex-config.js';

test('Codex config merge creates a native Responses provider', () => {
  assert.equal(
    mergeCodexConfig('', { port: 5001, model: 'gpt-test' }),
    [
      'model_provider = "copilot-relay"',
      'model = "gpt-test"',
      '',
      '[model_providers.copilot-relay]',
      'base_url = "http://127.0.0.1:5001/v1"',
      'name = "Local Copilot Relay"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
    ].join('\n'),
  );
});

test('Codex config merge preserves unrelated settings and unknown provider keys', () => {
  const source = [
    '# user preference',
    'model_provider = "openai"',
    'model = "keep-me"',
    '',
    '[model_providers.copilot-relay]',
    'base_url = "http://old.invalid/v1"',
    'custom_extension = true',
    'wire_api = "chat"',
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
    "[projects.'c:\\dev\\copilot-relay']",
    'trust_level = "trusted"',
    '',
  ].join('\r\n');

  const merged = mergeCodexConfig(source, { port: 5000 });

  assert.match(merged, /^# user preference\r\nmodel_provider = "copilot-relay"/);
  assert.match(merged, /model = "keep-me"/);
  assert.match(merged, /base_url = "http:\/\/127\.0\.0\.1:5000\/v1"/);
  assert.match(merged, /custom_extension = true/);
  assert.match(merged, /\[windows\]\r\nsandbox = "elevated"/);
  assert.match(merged, /trust_level = "trusted"/);
  assert.equal(mergeCodexConfig(merged, { port: 5000 }), merged);
});

test('Codex config merge rejects duplicate managed tables', () => {
  const source = [
    '[model_providers.copilot-relay]',
    'wire_api = "responses"',
    '[model_providers.copilot-relay]',
    'wire_api = "responses"',
  ].join('\n');

  assert.throws(
    () => mergeCodexConfig(source, { port: 5000 }),
    /duplicate copilot-relay provider tables/,
  );
});

test('Codex config merge recognizes quoted provider tables and keys', () => {
  const source = [
    '"model_provider" = "old"',
    '',
    '[ model_providers . "copilot-relay" ] # retained style',
    '"base_url" = "http://old.invalid/v1"',
    "'wire_api' = 'chat'",
  ].join('\n');

  const merged = mergeCodexConfig(source, { port: 5000 });

  assert.equal((merged.match(/model_provider\s*=/g) ?? []).length, 1);
  assert.equal((merged.match(/model_providers/g) ?? []).length, 1);
  assert.match(merged, /\[ model_providers \. "copilot-relay" \] # retained style/);
  assert.match(merged, /base_url = "http:\/\/127\.0\.0\.1:5000\/v1"/);
  assert.match(merged, /wire_api = "responses"/);
});

test('Codex config merge rejects known-dangerous TOML constructs', () => {
  for (const source of [
    'notes = """multiline\n[value]\n"""',
    'values = [\n  "one",\n]',
    'model_providers.copilot-relay.base_url = "http://old.invalid/v1"',
    '[[model_providers.copilot-relay]]\nbase_url = "http://old.invalid/v1"',
    '[model_providers.copilot-relay]\nbase_url = "one"\nbase_url = "two"',
  ]) {
    assert.throws(() => mergeCodexConfig(source, { port: 5000 }), /Codex config contains/);
  }
});

test('configure codex preserves peer settings and is idempotent', () => {
  const profile = mkdtempSync(join(tmpdir(), 'copilot-relay-codex-'));
  const configDirectory = join(profile, '.codex');
  const configPath = join(configDirectory, 'config.toml');
  const environment = { ...process.env, HOME: profile, USERPROFILE: profile };
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  try {
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(configPath, '[windows]\nsandbox = "elevated"\n', 'utf8');
    const args = [cliPath, 'configure', 'codex', '--port', '5123', '--model', 'gpt-test'];

    const first = spawnSync(process.execPath, args, { env: environment, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const configured = readFileSync(configPath, 'utf8');
    assert.match(configured, /^model_provider = "copilot-relay"\nmodel = "gpt-test"/);
    assert.match(configured, /base_url = "http:\/\/127\.0\.0\.1:5123\/v1"/);
    assert.match(configured, /wire_api = "responses"/);
    assert.match(configured, /requires_openai_auth = false/);
    assert.match(configured, /\[windows\]\nsandbox = "elevated"/);

    const second = spawnSync(process.execPath, args, { env: environment, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(configPath, 'utf8'), configured);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('CLI port options reject partial, signed, whitespace, and out-of-range values', () => {
  const profile = mkdtempSync(join(tmpdir(), 'copilot-relay-port-'));
  const environment = { ...process.env, HOME: profile, USERPROFILE: profile };
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  try {
    for (const command of [
      ['start'],
      ['configure', 'claude'],
      ['configure', 'codex'],
    ]) {
      for (const port of ['0', '65536', '1.5', '5000junk', '+5000', ' 5000']) {
        const result = spawnSync(process.execPath, [cliPath, ...command, '--port', port], {
          env: environment,
          encoding: 'utf8',
        });
        assert.equal(result.status, 1, `${command.join(' ')} accepted ${JSON.stringify(port)}`);
      }
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('configure codex leaves unsupported TOML unchanged', () => {
  const profile = mkdtempSync(join(tmpdir(), 'copilot-relay-codex-'));
  const configDirectory = join(profile, '.codex');
  const configPath = join(configDirectory, 'config.toml');
  const source = 'model_providers.copilot-relay.base_url = "http://old.invalid/v1"\n';
  const environment = { ...process.env, HOME: profile, USERPROFILE: profile };
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  try {
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(configPath, source, 'utf8');
    const result = spawnSync(process.execPath, [cliPath, 'configure', 'codex'], {
      env: environment,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(readFileSync(configPath, 'utf8'), source);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});