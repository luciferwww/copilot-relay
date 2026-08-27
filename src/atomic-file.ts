import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export function writeTextFileAtomically(path: string, content: string): void {
  const directory = dirname(path);
  const temporary = join(directory, `.tmp-${basename(path)}-${randomUUID()}`);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    if (process.platform !== 'win32') chmodSync(temporary, mode);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    flushDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function flushDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } catch {
    // The file is durable; some filesystems do not support directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}