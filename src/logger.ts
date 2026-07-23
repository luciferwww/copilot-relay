export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let current: LogLevel = 'info';

export function setLevel(level: LogLevel): void {
  current = level;
}

function log(level: LogLevel, ...args: unknown[]): void {
  if (order[level] < order[current]) return;
  const stamp = new Date().toISOString();
  const line = `[${stamp}] [${level.toUpperCase()}]`;
  // Per spec §9 / requirement NFR5: all levels go to stdout (no file, no rotation).
  // Command output that must stay pipe-friendly (config-show) lowers the level
  // to `error` to keep stdout clean; see spec §1.6.
  console.log(line, ...args);
}

export const logger = {
  debug: (...a: unknown[]) => log('debug', ...a),
  info: (...a: unknown[]) => log('info', ...a),
  warn: (...a: unknown[]) => log('warn', ...a),
  error: (...a: unknown[]) => log('error', ...a),
};
