import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCommandError, describeListenError } from './cli-error.js';

test('listen error describes an occupied port', () => {
  const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });

  assert.equal(
    describeListenError(error, '127.0.0.1', 5000),
    'Port 5000 is already in use on 127.0.0.1. '
      + 'Stop the process using it or choose another port with --port.',
  );
});

test('listen error ignores unrelated failures', () => {
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });

  assert.equal(describeListenError(error, '127.0.0.1', 5000), undefined);
});

test('command error preserves Error messages', () => {
  assert.equal(describeCommandError(new Error('permission denied')), 'permission denied');
  assert.equal(describeCommandError('unknown failure'), 'Command failed.');
});
