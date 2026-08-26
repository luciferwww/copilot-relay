import type { AppConfig } from './config.js';
import { startHttpServer } from './http-server.js';

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

export interface StartServerOptions {
  allowRemoteAccess?: boolean;
}

export async function startServer(
  cfg: AppConfig,
  options: StartServerOptions = {},
): Promise<ServerHandle> {
  return await startHttpServer(cfg, options);
}