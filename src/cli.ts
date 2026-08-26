#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { Command } from 'commander';
import {
  AUTH_FILE,
  CONFIG_FILE,
  PID_FILE,
  isValidHost,
  loadConfig,
  saveConfigDefaults,
} from './config.js';
import { RemoteAccessRequiredError, requireRemoteAccessOptIn } from './bind-policy.js';
import { logger, setLevel, type LogLevel } from './logger.js';
import { loginWithDeviceCode } from './auth/deviceCode.js';
import { AUTH_REFRESH_TIMEOUT_MS } from './auth/AuthManager.js';
import {
  clearAuth,
  isAuthValid,
  loadAuth,
  refreshCopilotToken,
  saveAuth,
} from './auth/copilot.js';
import { startServer } from './server.js';

const program = new Command();
program
  .name('copilot-relay')
  .description('Local proxy exposing OpenAI/Anthropic APIs backed by GitHub Copilot.')
  .version('0.2.0');

program
  .command('start')
  .description('Start the proxy server in the foreground.')
  .option('-H, --host <host>', 'Address to bind (default: 127.0.0.1)')
  .option('-p, --port <port>', 'Port to listen on', (v) => parseInt(v, 10))
  .option('-l, --log-level <level>', 'debug|info|warn|error')
  .option('--allow-remote-access', 'Acknowledge unauthenticated non-loopback access')
  .action(async (opts: {
    host?: string;
    port?: number;
    logLevel?: LogLevel;
    allowRemoteAccess?: boolean;
  }) => {
    const cfg = loadConfig();
    if (opts.host !== undefined) {
      if (!isValidHost(opts.host)) {
        logger.error('Invalid host. Use a non-empty address without whitespace.');
        process.exit(1);
      }
      cfg.host = opts.host;
    }
    if (opts.port) cfg.port = opts.port;
    if (opts.logLevel) cfg.logLevel = opts.logLevel;
    setLevel(cfg.logLevel);
    try {
      requireRemoteAccessOptIn(cfg.host, opts.allowRemoteAccess === true);
    } catch (error) {
      if (error instanceof RemoteAccessRequiredError) {
        logger.error(error.message);
        process.exit(1);
      }
      throw error;
    }
    if (!loadAuth()) {
      logger.error('Not logged in. Run `copilot-relay login` first.');
      process.exit(1);
    }
    // Spec §6 — existing pid file: exit if the process is alive; overwrite
    // (with a warning) if it is stale.
    if (existsSync(PID_FILE)) {
      const existing = parseInt(readFileSync(PID_FILE, 'utf8'), 10);
      if (Number.isFinite(existing)) {
        try {
          process.kill(existing, 0);
          console.log(
            `Another copilot-relay instance appears to be running (pid=${existing}). ` +
              'Use "copilot-relay stop" first.',
          );
          process.exit(1);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === 'ESRCH') {
            logger.warn(`Stale pid file (pid=${existing} not alive); overwriting.`);
          } else {
            console.log(
              `Cannot verify pid ${existing} (${code ?? 'unknown_error'}); ` +
                'refusing to overwrite. Remove the pid file manually if you are sure.',
            );
            process.exit(1);
          }
        }
      } else {
        logger.warn('Existing pid file is not a number; overwriting.');
      }
    }
    writeFileSync(PID_FILE, String(process.pid), 'utf8');
    let handle;
    try {
      handle = await startServer(cfg, { allowRemoteAccess: opts.allowRemoteAccess === true });
    } catch (error) {
      try {
        unlinkSync(PID_FILE);
      } catch {
        // The PID file may already have been removed by external cleanup.
      }
      throw error;
    }
    const shutdown = async () => {
      logger.info('Shutting down...');
      await handle.close();
      try {
        unlinkSync(PID_FILE);
      } catch {
        /* ignore */
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('stop')
  .description('Send SIGTERM to a foreground server tracked in the pid file.')
  .action(() => {
    if (!existsSync(PID_FILE)) {
      logger.info('No pid file; server not tracked as running.');
      return;
    }
    const pid = parseInt(readFileSync(PID_FILE, 'utf8'), 10);
    try {
      process.kill(pid);
      logger.info(`Sent SIGTERM to ${pid}`);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'unknown_error';
      logger.warn(`Could not signal pid ${pid}: ${code}`);
    }
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
  });

program
  .command('login')
  .description('Authenticate with GitHub via device-code flow.')
  .option('--no-open', 'Do not open a browser automatically')
  .action(async (opts: { open: boolean }) => {
    const cfg = loadConfig();
    setLevel(cfg.logLevel);
    const { accessToken } = await loginWithDeviceCode(cfg.githubClientId, {
      openBrowser: opts.open !== false,
    });
    const auth = { accessToken };
    saveAuth(auth);
    const refreshed = await refreshCopilotToken(
      auth,
      cfg,
      AbortSignal.timeout(AUTH_REFRESH_TIMEOUT_MS),
    );
    const until = refreshed.copilotExpiresAt
      ? new Date(refreshed.copilotExpiresAt * 1000).toISOString()
      : 'unknown';
    logger.info(`Login successful. Copilot token valid until ${until}`);
  });

program
  .command('logout')
  .description('Remove stored credentials.')
  .action(() => {
    if (existsSync(AUTH_FILE)) {
      clearAuth();
      logger.info('Removed auth file.');
    } else {
      logger.info('No auth file.');
    }
  });

program
  .command('status')
  .description('Show current auth and config state.')
  .action(() => {
    const cfg = loadConfig();
    setLevel(cfg.logLevel);
    const auth = loadAuth();
    console.log('Config file: ' + CONFIG_FILE);
    console.log(JSON.stringify(cfg, null, 2));
    console.log('');
    if (!auth) {
      console.log('Auth: not logged in');
      return;
    }
    console.log('Auth file: ' + AUTH_FILE);
    console.log('  github login: yes');
    if (auth.copilotToken && auth.copilotExpiresAt) {
      console.log(
        '  copilot token expires: ' + new Date(auth.copilotExpiresAt * 1000).toISOString(),
      );
    } else {
      console.log('  copilot token: none (will be fetched on first request)');
    }
    console.log('  copilot api base: ' + (auth.copilotApiBase ?? '(default)'));
    if (isAuthValid(auth)) {
      console.log('  auth valid: yes');
    } else {
      console.log('  auth valid: no');
      console.log('  auth status: access token rejected; run login again');
    }
  });

program
  .command('config-show')
  .description('Print the resolved config (creating the file if missing).')
  .action(() => {
    // Spec §1.6 — force logger to error so stdout stays pipe-friendly for `| jq`.
    setLevel('error');
    const cfg = loadConfig();
    saveConfigDefaults();
    console.log('Config file: ' + CONFIG_FILE);
    console.log(JSON.stringify(cfg, null, 2));
  });

const configureCmd = program
  .command('configure')
  .description('Write client-side settings pointing an external tool at this proxy.');

configureCmd
  .command('claude')
  .description('Write ~/.claude/settings.json to route Claude Code through this proxy.')
  .option('--port <port>', 'Proxy port', (v) => parseInt(v, 10))
  .action((opts: { port?: number }) => {
    const cfg = loadConfig();
    const port = opts.port ?? cfg.port;
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });
    let existing: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        existing = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      } catch {
        logger.warn('Existing settings.json is not valid JSON; it will be overwritten.');
      }
    }
    const env = { ...((existing.env as Record<string, string> | undefined) ?? {}) };
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN ?? 'copilot-relay-dummy';
    existing.env = env;
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf8');
    console.log('Wrote ' + settingsPath);
  });

configureCmd
  .command('codex')
  .description('(v0.2) Write Codex CLI settings.')
  .action(() => {
    logger.error(
      'Codex configuration is not implemented. ' +
        'A future release can add it after the Codex CLI config schema is confirmed.',
    );
    process.exit(2);
  });

program.parseAsync(process.argv).catch(() => {
  logger.error('Command failed.');
  process.exit(1);
});
