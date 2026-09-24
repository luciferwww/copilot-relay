export function describeListenError(error: unknown, host: string, port: number): string | undefined {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'EADDRINUSE'
  ) {
    return (
      `Port ${port} is already in use on ${host}. `
      + 'Stop the process using it or choose another port with --port.'
    );
  }
  return undefined;
}

export function describeCommandError(error: unknown): string {
  return error instanceof Error ? error.message : 'Command failed.';
}
