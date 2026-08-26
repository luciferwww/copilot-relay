import type { AppConfig } from './config.js';
import { startHttpServer } from './http-server.js';

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startServer(cfg: AppConfig): Promise<ServerHandle> {
  return await startHttpServer(cfg);
}