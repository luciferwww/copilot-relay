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
  logLevel: LogLevel;
  githubClientId: string;
  editorVersion: string;
  editorPluginVersion: string;
  copilotIntegrationId: string;
  userAgent: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  port: 5000,
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
    return resolveConfig(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Projects unknown JSON onto the exact public configuration schema. */
export function resolveConfig(value: unknown): AppConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = value as Record<string, unknown>;
  const logLevel = raw.logLevel;
  return {
    port: typeof raw.port === 'number' && Number.isInteger(raw.port) ? raw.port : DEFAULT_CONFIG.port,
    logLevel:
      logLevel === 'debug' || logLevel === 'info' || logLevel === 'warn' || logLevel === 'error'
        ? logLevel
        : DEFAULT_CONFIG.logLevel,
    githubClientId: stringOrDefault(raw.githubClientId, DEFAULT_CONFIG.githubClientId),
    editorVersion: stringOrDefault(raw.editorVersion, DEFAULT_CONFIG.editorVersion),
    editorPluginVersion: stringOrDefault(
      raw.editorPluginVersion,
      DEFAULT_CONFIG.editorPluginVersion,
    ),
    copilotIntegrationId: stringOrDefault(
      raw.copilotIntegrationId,
      DEFAULT_CONFIG.copilotIntegrationId,
    ),
    userAgent: stringOrDefault(raw.userAgent, DEFAULT_CONFIG.userAgent),
  };
}

export function saveConfigDefaults(): void {
  ensureDataDir();
  if (existsSync(CONFIG_FILE)) return;
  writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
