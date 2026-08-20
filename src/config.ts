import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { LogLevel } from './logger.js';

export const DATA_DIR = join(homedir(), '.copilot-relay');
export const AUTH_FILE = join(DATA_DIR, 'auth.json');
export const CONFIG_FILE = join(DATA_DIR, 'config.json');
export const PID_FILE = join(DATA_DIR, 'server.pid');

export interface AppConfig {
  port: number;
  host: string;
  logLevel: LogLevel;
  githubClientId: string;
  editorVersion: string;
  editorPluginVersion: string;
  copilotIntegrationId: string;
  userAgent: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  port: 5000,
  host: '127.0.0.1',
  logLevel: 'info',
  // Well-known community client_id used by open-source Copilot integrations
  // (copilot.vim, neovim copilot.lua, etc.). Override in config.json if you
  // want to use your own registered GitHub OAuth App.
  githubClientId: 'Iv1.b507a08c87ecfe98',
  editorVersion: 'vscode/1.98.0',
  editorPluginVersion: 'copilot-chat/0.20.0',
  copilotIntegrationId: 'vscode-chat',
  userAgent: 'GitHubCopilotChat/0.20.0',
};

export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadConfig(): AppConfig {
  ensureDataDir();
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<AppConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfigDefaults(): void {
  ensureDataDir();
  if (existsSync(CONFIG_FILE)) return;
  writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
}
