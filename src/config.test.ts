import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, resolveConfig } from './config.js';

test('config resolution keeps only approved fields and valid types', () => {
  const resolved = resolveConfig({
    port: 5100,
    logLevel: 'debug',
    userAgent: 'custom-agent',
    accessToken: 'must-not-survive',
    nested: { secret: 'must-not-survive' },
  });

  assert.equal(resolved.port, 5100);
  assert.equal(resolved.logLevel, 'debug');
  assert.equal(resolved.userAgent, 'custom-agent');
  assert.equal('accessToken' in resolved, false);
  assert.equal('nested' in resolved, false);
  assert.equal(resolved.githubClientId, DEFAULT_CONFIG.githubClientId);
});