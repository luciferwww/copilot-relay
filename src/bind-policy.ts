import { isIP } from 'node:net';

export class RemoteAccessRequiredError extends Error {
  constructor() {
    super('A non-loopback host requires --allow-remote-access.');
    this.name = 'RemoteAccessRequiredError';
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (/^(?:0{1,4}:){7}0*1$/u.test(normalized)) return true;
  return isIP(normalized) === 4 && normalized.split('.')[0] === '127';
}

export function requireRemoteAccessOptIn(host: string, allowRemoteAccess: boolean): void {
  if (!isLoopbackHost(host) && !allowRemoteAccess) {
    throw new RemoteAccessRequiredError();
  }
}