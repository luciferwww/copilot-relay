import type { AuthState } from '../auth/copilot.js';
import type { AppConfig } from '../config.js';

export function buildOpenAiForward(
  auth: AuthState,
  cfg: AppConfig,
  reqHeaders: Record<string, string>,
): { url: string; headers: Record<string, string> } {
  const base = auth.copilotApiBase ?? 'https://api.githubcopilot.com';
  const url = `${base}/chat/completions`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.copilotToken}`,
    'Content-Type': 'application/json',
    'User-Agent': cfg.userAgent,
    'Editor-Version': cfg.editorVersion,
    'Editor-Plugin-Version': cfg.editorPluginVersion,
    'Copilot-Integration-Id': cfg.copilotIntegrationId,
    'Openai-Intent': 'conversation-panel',
  };

  const accept = reqHeaders['accept'];
  if (accept) headers['Accept'] = accept;

  return { url, headers };
}
