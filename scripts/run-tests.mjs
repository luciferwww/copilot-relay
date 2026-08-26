import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function findTests(directory) {
  const tests = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...await findTests(path));
    else if (entry.name.endsWith('.test.js')) tests.push(path);
  }
  return tests;
}

const tests = (await findTests('dist')).sort();
if (tests.length === 0) {
  console.error('No compiled test files found.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
process.exit(result.status ?? 1);