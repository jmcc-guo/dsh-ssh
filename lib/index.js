/**
 * @jmcc-guo/dsh-ssh — DeepSeek Harness SSH terminal plugin.
 *
 * Host half: mounts the SSH connection manager, the model-visible tool set
 * (ssh_connect / ssh_exec / ssh_exec_read / ssh_exec_kill / ssh_list /
 * ssh_status / ssh_disconnect / ssh_delete), the panel WebSocket channel, and
 * the `dsh-ssh` settings namespace. The client half (`./client`) renders the
 * right-side multi-tab terminal panel in the Web GUI.
 *
 * Row id: `dsh-ssh`. Profile overlays may override the config, e.g.:
 *
 *   - id: dsh-ssh
 *     config:
 *       heartbeatIntervalMs: 20000
 *       reconnectMaxAttempts: 8
 *       outputLimitBytes: 2097152
 * @module @jmcc-guo/dsh-ssh
 */
import z from '@deepseek-ai/schemastery';
import { SshManager } from './manager.js';
import { createTools } from './tools.js';
import { installWs } from './ws.js';

export const name = '@jmcc-guo/dsh-ssh';

/** Required host services. */
export const inject = ['tools', 'credentials', 'settings'];

/** Plugin config schema (settings namespace `dsh-ssh`). */
export const Config = z.object({
  /** ssh2 keepalive interval (ms); 0 disables application keepalive. */
  heartbeatIntervalMs: z.natural().default(30000),
  /** ssh2 keepalive failure count before the connection is considered dead. */
  keepaliveCountMax: z.natural().default(3),
  /** SSH handshake / TCP connect timeout (ms). */
  connectTimeoutMs: z.natural().default(15000),
  /** First auto-reconnect delay (ms); doubles per attempt. */
  reconnectBaseDelayMs: z.natural().default(2000),
  /** Cap on the reconnect backoff delay (ms). */
  reconnectMaxDelayMs: z.natural().default(60000),
  /** Max automatic reconnect attempts for an unexpected drop. */
  reconnectMaxAttempts: z.natural().default(5),
  /** Default ssh_exec completion wait (ms). */
  execTimeoutMs: z.natural().default(120000),
  /** Default ssh_exec mutex wait when the connection is busy (ms). */
  busyWaitTimeoutMs: z.natural().default(20000),
  /** The shared terminal shell must stay silent this long before AI may run (ms). */
  shellQuietWaitMs: z.natural().default(2000),
  /** Default ssh_exec wait while the connection is reconnecting (ms). */
  reconnectWaitTimeoutMs: z.natural().default(30000),
  /** Per-connection terminal buffer cap (bytes). */
  outputLimitBytes: z.natural().default(1048576),
  /** Cap on output returned to the model per command (bytes). */
  execOutputMaxBytes: z.natural().default(200000),
  /** Override the records file path (default $DSH_HOME/storages/dsh-ssh/connections.json). */
  recordsPath: z.string().default(''),
});

/**
 * Plugin entry.
 * @param ctx - plugin context.
 * @param config - composition config for the `dsh-ssh` row.
 */
export async function apply(ctx, config = {}) {
  const settings = ctx.settings.register('dsh-ssh', Config, {
    base: config,
    applies: 'live',
  });

  const manager = new SshManager(
    { credentials: ctx.credentials, logger: ctx.logger },
    settings.get(),
  );
  manager.initialize();
  ctx.logger.info('dsh-ssh: manager ready (%d saved connections)', manager.store.list().length);

  const disposers = [];
  try {
    for (const tool of createTools(manager)) disposers.push(ctx.tools.register(tool));
  } catch (error) {
    ctx.logger.error('dsh-ssh: tool registration failed: %s', error instanceof Error ? error.message : String(error));
    throw error;
  }

  disposers.push(settings.watch((next) => {
    manager.reconfigure(next);
    ctx.logger.info('dsh-ssh: config applied');
  }));

  const webServer = ctx.get('webServer');
  if (webServer !== undefined) {
    let trustedHosts = [];
    const startup = ctx.get('webStartup');
    if (startup !== undefined && Array.isArray(startup.trustedHosts)) trustedHosts = startup.trustedHosts;
    disposers.push(installWs(ctx, webServer, manager, trustedHosts));
    ctx.logger.info('dsh-ssh: panel channel mounted at /ssh/ws');
  }

  return async () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        ctx.logger.warn('dsh-ssh: disposer error: %s', error instanceof Error ? error.message : String(error));
      }
    }
    await manager.shutdown();
    ctx.logger.info('dsh-ssh: stopped; all connections closed');
  };
}
