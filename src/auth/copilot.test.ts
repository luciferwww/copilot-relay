import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('account replacement and logout preserve continuation files', () => {
  const profile = mkdtempSync(join(tmpdir(), 'copilot-relay-auth-'));
  const dataDirectory = join(profile, '.copilot-relay');
  const continuationDirectory = join(dataDirectory, 'continuations');
  const continuationPath = join(continuationDirectory, 'continuation-sentinel');
  const authPath = join(dataDirectory, 'auth.json');
  const environment = { ...process.env, HOME: profile, USERPROFILE: profile };
  try {
    mkdirSync(continuationDirectory, { recursive: true });
    writeFileSync(continuationPath, 'preserve-me', 'utf8');
    writeFileSync(authPath, JSON.stringify({ accessToken: 'old-account' }), 'utf8');

    const authModule = new URL('./copilot.js', import.meta.url).href;
    const replacement = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { saveAuth } from ${JSON.stringify(authModule)}; ` +
        `saveAuth({ accessToken: 'new-account' });`,
    ], { env: environment, encoding: 'utf8' });
    assert.equal(replacement.status, 0, replacement.stderr);
    assert.equal(JSON.parse(readFileSync(authPath, 'utf8')).accessToken, 'new-account');
    assert.equal(readFileSync(continuationPath, 'utf8'), 'preserve-me');

    const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
    const logout = spawnSync(process.execPath, [cliPath, 'logout'], {
      env: environment,
      encoding: 'utf8',
    });
    assert.equal(logout.status, 0, logout.stderr);
    assert.equal(existsSync(authPath), false);
    assert.equal(readFileSync(continuationPath, 'utf8'), 'preserve-me');
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});