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
  // Send all log lines to stderr so stdout stays clean for CLI output.
  console.error(line, ...args);
}

export const logger = {
  debug: (...a: unknown[]) => log('debug', ...a),
  info: (...a: unknown[]) => log('info', ...a),
  warn: (...a: unknown[]) => log('warn', ...a),
  error: (...a: unknown[]) => log('error', ...a),
};
