const PROVIDER_HEADER = '[model_providers.copilot-relay]';
const PROVIDER_HEADER_EXPRESSION = /^\s*\[\s*model_providers\s*\.\s*(?:copilot-relay|"copilot-relay"|'copilot-relay')\s*\]\s*(?:#.*)?$/;
const PROVIDER_ARRAY_HEADER_EXPRESSION = /^\s*\[\[\s*model_providers\s*\.\s*(?:copilot-relay|"copilot-relay"|'copilot-relay')\s*\]\]\s*(?:#.*)?$/m;
const MANAGED_DOTTED_KEY_EXPRESSION = /^\s*(?:model_providers|"model_providers"|'model_providers')\s*\.\s*(?:copilot-relay|"copilot-relay"|'copilot-relay')\s*(?:\.|=)/m;
const TABLE_HEADER_EXPRESSION = /^\s*(?:\[[^\[\]\r\n]+\]|\[\[[^\[\]\r\n]+\]\])\s*(?:#.*)?$/;
const MANAGED_PROVIDER_KEYS = new Set([
  'base_url',
  'name',
  'wire_api',
  'requires_openai_auth',
]);

export interface CodexConfigOptions {
  port: number;
  model?: string;
}

export function mergeCodexConfig(source: string, options: CodexConfigOptions): string {
  validateSupportedToml(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = source.endsWith('\n');
  const lines = source.length === 0 ? [] : source.replace(/\r?\n$/, '').split(/\r?\n/);
  const providerIndexes = lines
    .map((line, index) => PROVIDER_HEADER_EXPRESSION.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (providerIndexes.length > 1) {
    throw new Error('Codex config contains duplicate copilot-relay provider tables.');
  }

  setRootValue(lines, 'model_provider', '"copilot-relay"');
  if (options.model !== undefined) setRootValue(lines, 'model', tomlString(options.model));

  const providerValues = [
    `base_url = "http://127.0.0.1:${options.port}/v1"`,
    'name = "Local Copilot Relay"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
  ];
  const providerIndex = lines.findIndex((line) => PROVIDER_HEADER_EXPRESSION.test(line));
  if (providerIndex < 0) {
    if (lines.length > 0 && lines.at(-1)?.trim() !== '') lines.push('');
    lines.push(PROVIDER_HEADER, ...providerValues);
  } else {
    let providerEnd = lines.findIndex(
      (line, index) => index > providerIndex && TABLE_HEADER_EXPRESSION.test(line),
    );
    if (providerEnd < 0) providerEnd = lines.length;
    const managedKeys = lines
      .slice(providerIndex + 1, providerEnd)
      .map(managedProviderKey)
      .filter((key): key is string => key !== undefined);
    if (new Set(managedKeys).size !== managedKeys.length) {
      throw new Error('Codex config contains duplicate managed provider values.');
    }
    const retained = lines.slice(providerIndex + 1, providerEnd).filter((line) => {
      const key = managedProviderKey(line);
      return key === undefined || !MANAGED_PROVIDER_KEYS.has(key);
    });
    lines.splice(providerIndex + 1, providerEnd - providerIndex - 1, ...providerValues, ...retained);
  }

  const result = lines.join(newline);
  return result.length === 0 || hadFinalNewline ? result + newline : result;
}

function setRootValue(lines: string[], key: string, value: string): void {
  const firstTable = lines.findIndex((line) => TABLE_HEADER_EXPRESSION.test(line));
  const rootEnd = firstTable < 0 ? lines.length : firstTable;
  const expression = new RegExp(`^\\s*(?:${key}|"${key}"|'${key}')\\s*=`);
  const indexes = lines
    .slice(0, rootEnd)
    .map((line, index) => expression.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length > 1) throw new Error(`Codex config contains duplicate ${key} values.`);
  if (indexes.length === 1) {
    lines[indexes[0]] = `${key} = ${value}`;
    return;
  }
  lines.splice(rootEnd, 0, `${key} = ${value}`, ...(rootEnd > 0 ? [''] : []));
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function validateSupportedToml(source: string): void {
  if (source.includes('"""') || source.includes("'''")) {
    throw new Error('Codex config contains unsupported triple-quoted values.');
  }
  if (/=\s*\[\s*(?:#.*)?(?:\r?\n|$)/.test(source)) {
    throw new Error('Codex config contains unsupported multiline arrays.');
  }
  if (PROVIDER_ARRAY_HEADER_EXPRESSION.test(source)) {
    throw new Error('Codex config contains an unsupported copilot-relay array table.');
  }
  if (MANAGED_DOTTED_KEY_EXPRESSION.test(source)) {
    throw new Error('Codex config contains unsupported dotted copilot-relay values.');
  }
}

function managedProviderKey(line: string): string | undefined {
  const match = line.match(/^\s*(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')\s*=/);
  const key = match?.[1] ?? match?.[2] ?? match?.[3];
  return key !== undefined && MANAGED_PROVIDER_KEYS.has(key) ? key : undefined;
}