/**
 * @dsh-external/dsh-ssh — model-facing tools.
 *
 * Tool surface: ssh_connect / ssh_exec / ssh_exec_read / ssh_exec_kill /
 * ssh_list / ssh_status / ssh_disconnect / ssh_delete.
 *
 * Security rules enforced here:
 *  - only `ai`-source connections are visible and addressable;
 *  - secrets must NEVER be passed inline in tool arguments (they are logged
 *    verbatim into the session trace): auth accepts credential references and
 *    key file paths only;
 *  - outputs never contain secret material (auth failures are re-read from
 *    the manager which scrubs them).
 * @module @dsh-external/dsh-ssh/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

const NO_INLINE_SECRETS = 'Never pass passwords or private key material inline — they are recorded verbatim in the session log and will be rejected. Use `auth.passwordRef` (a stored credential or environment variable name), `auth.privateKeyPath` (absolute path to a key file on this host), or `auth.privateKeyRef` (a stored credential holding the key).';

const AUTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    passwordRef: { type: 'string', description: 'Name of a stored credential / environment variable holding the password. ' + NO_INLINE_SECRETS },
    privateKeyPath: { type: 'string', description: 'Absolute path to a private key file on this host (PEM or OpenSSH format).' },
    privateKeyRef: { type: 'string', description: 'Name of a stored credential / environment variable holding the private key text.' },
    passphraseRef: { type: 'string', description: 'Name of a stored credential / environment variable holding the passphrase for an encrypted private key.' },
  },
};

const renderJson = (_args, value) => [{
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
}];

/** Strip undefined values (lossless JSON requires them absent, not undefined). */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = clean(item);
    }
    return out;
  }
  return value;
}

/**
 * Build the SSH tool set bound to one manager.
 * @param manager - SshManager instance.
 * @returns tool definitions.
 */
export function createTools(manager) {
  return [
    defineTool({
      name: 'ssh_connect',
      description: 'Establish an SSH connection managed by the SSH terminal panel. '
        + 'Creates a NEW saved connection record (source: AI) for this server — the same server (host+port+user) may have several independent connections, each with its own unique name. '
        + 'Pass an existing `connection` name to re-establish (or update the auth of) that saved AI connection. '
        + 'Credentials are stored safely by reference. ' + NO_INLINE_SECRETS + ' '
        + 'On failure (auth error, host unreachable, timeout) a readable reason is returned; you may retry with a different auth method.',
      parameters: {
        connection: { type: 'string', description: 'Name of an existing saved AI connection to re-establish (omit to create a new one).' },
        name: { type: 'string', description: 'Unique name for a NEW connection (required when not reusing `connection`). The name is saved and usable later (also after a DSH restart).' },
        host: { type: 'string', description: 'Server host or IP (required for a new connection).' },
        port: { type: 'integer', description: 'SSH port (default 22).' },
        user: { type: 'string', description: 'Login user (required for a new connection).' },
        auth: AUTH_SCHEMA,
        timeoutMs: { type: 'integer', description: 'Connection timeout in ms (default from plugin config, 15000).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            connection: { type: 'string' },
            status: { type: 'string', enum: ['connected', 'connecting', 'reconnecting', 'disconnected', 'error'] },
            host: { type: 'string' },
            port: { type: 'integer' },
            user: { type: 'string' },
            source: { type: 'string' },
            message: { type: 'string' },
          },
        },
        render: renderJson,
      },
      async execute(args, exec) {
        try {
          const result = await manager.connectWithParams({ ...args, signal: exec.signal });
          const record = result.record ?? (result.ok ? manager.store.get(result.connection) : undefined);
          return clean({
            ok: result.ok,
            connection: result.connection,
            status: result.status,
            host: record?.host,
            port: record?.port,
            user: record?.user,
            source: record?.source,
            message: result.ok ? `connected as ${record?.user}@${record?.host}:${record?.port}` : result.error,
          });
        } catch (error) {
          return clean({ ok: false, message: error instanceof Error ? error.message : String(error) });
        }
      },
    }),

    defineTool({
      name: 'ssh_exec',
      description: 'Execute a command on an AI-managed SSH connection, addressed by saved connection name. '
        + 'If the connection is offline it is automatically re-established from its saved settings first (no separate ssh_connect needed). '
        + 'If the connection is reconnecting, the call waits up to `waitForReconnectMs` for the reconnect to finish, then executes. '
        + 'If the connection is busy (a human command or another command is running on it), the call waits up to `waitForIdleMs`, then reports "busy" instead of interleaving output. '
        + 'Long commands: set `timeoutMs` to the time you are willing to wait; if the command is still running when it expires the result has status "running" plus an `execId` — poll with ssh_exec_read or stop with ssh_exec_kill. '
        + 'The result always carries the connection name so outputs never get mixed up between connections.',
      parameters: {
        connection: { type: 'string', required: true, description: 'Saved connection name (see ssh_list for the available AI connections).' },
        command: { type: 'string', required: true, description: 'The command line to run on the remote host.' },
        timeoutMs: { type: 'integer', description: 'Max time in ms to wait for completion before returning status "running" (default from config, 120000).' },
        waitForIdleMs: { type: 'integer', description: 'Max time in ms to wait while the connection is busy before returning status "busy" (default from config, 20000).' },
        waitForReconnectMs: { type: 'integer', description: 'Max time in ms to wait while the connection is reconnecting (default from config, 30000).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            connection: { type: 'string' },
            status: { type: 'string', enum: ['done', 'running', 'busy', 'reconnecting', 'killed', 'error', 'aborted'] },
            execId: { type: 'string' },
            exitCode: { type: 'integer' },
            output: { type: 'string' },
            truncated: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: renderJson,
      },
      async execute(args, exec) {
        const result = await manager.aiExec({ ...args, signal: exec.signal });
        return clean({
          ok: result.ok,
          connection: args.connection,
          status: result.status,
          execId: result.execId,
          exitCode: result.exitCode,
          output: result.output,
          truncated: result.truncated,
          message: result.error ?? result.message,
        });
      },
    }),

    defineTool({
      name: 'ssh_exec_read',
      description: 'Read the (incremental) output of a long-running command previously returned by ssh_exec with status "running". '
        + 'Pass the `execId`; returns the output produced so far, whether it is still running, and the exit code once finished.',
      parameters: {
        execId: { type: 'string', required: true, description: 'The execId returned by ssh_exec.' },
        tail: { type: 'integer', description: 'Return only the last N bytes of output (default: everything kept so far).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            connection: { type: 'string' },
            execId: { type: 'string' },
            running: { type: 'boolean' },
            exitCode: { type: 'integer' },
            output: { type: 'string' },
            truncated: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: renderJson,
      },
      execute(args) {
        const result = manager.execRead(args.execId, { tail: args.tail });
        return clean({
          ok: result.ok,
          connection: result.connection,
          execId: result.execId,
          running: result.running,
          exitCode: result.exitCode,
          output: result.output,
          truncated: result.truncated,
          message: result.message ?? result.error,
        });
      },
    }),

    defineTool({
      name: 'ssh_exec_kill',
      description: 'Terminate a long-running command previously started by ssh_exec (by its execId). The remote process is killed and the connection becomes idle again.',
      parameters: {
        execId: { type: 'string', required: true, description: 'The execId returned by ssh_exec.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            connection: { type: 'string' },
            execId: { type: 'string' },
            killed: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        const result = await manager.killExec(args.execId);
        return clean({
          ok: result.ok,
          connection: result.connection,
          execId: result.execId,
          killed: result.killed,
          message: result.error ?? (result.killed ? 'command killed' : 'command already finished'),
        });
      },
    }),

    defineTool({
      name: 'ssh_list',
      description: 'List all saved SSH connections the AI can access (source: ai) with their live status. '
        + 'User-created connections are never listed here. Multiple connections to the same server each appear as separate entries.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            connections: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  host: { type: 'string', required: true },
                  port: { type: 'integer', required: true },
                  user: { type: 'string', required: true },
                  source: { type: 'string', required: true },
                  status: { type: 'string', enum: ['connected', 'connecting', 'reconnecting', 'disconnected', 'error'], required: true },
                  busyBy: { type: 'string' },
                  lastError: { type: 'string' },
                  connectedAt: { type: 'integer' },
                },
              },
            },
            message: { type: 'string' },
          },
        },
        render: renderJson,
      },
      execute() {
        const connections = manager.store.list()
          .filter((record) => record.source === 'ai')
          .map((record) => {
            const session = manager.sessions.get(record.name);
            const item = {
              name: record.name,
              host: record.host,
              port: record.port,
              user: record.user,
              source: record.source,
              status: session?.status ?? 'disconnected',
            };
            const busyBy = session?.busyKind();
            if (busyBy !== null) item.busyBy = busyBy;
            const lastError = session?.lastError;
            if (lastError !== null) item.lastError = lastError;
            const connectedAt = session?.connectedAt;
            if (connectedAt !== null) item.connectedAt = connectedAt;
            return clean(item);
          });
        return clean({ ok: true, connections });
      },
    }),

    defineTool({
      name: 'ssh_status',
      description: 'Show the live status of one AI-managed SSH connection (connection state, busy state, last error, connected since).',
      parameters: {
        connection: { type: 'string', required: true, description: 'Saved connection name.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            connection: { type: 'string' },
            source: { type: 'string' },
            status: { type: 'string', enum: ['connected', 'connecting', 'reconnecting', 'disconnected', 'error'] },
            busyBy: { type: 'string' },
            lastError: { type: 'string' },
            connectedAt: { type: 'integer' },
            reconnectAttempts: { type: 'integer' },
            message: { type: 'string' },
          },
        },
        render: renderJson,
      },
      execute(args) {
        const name = String(args.connection ?? '').trim();
        const record = manager.store.get(name);
        if (!record) return clean({ ok: false, connection: name, message: `no saved connection named "${name}"` });
        if (record.source !== 'ai') {
          return clean({ ok: false, connection: name, message: `connection "${name}" was created by the user; AI cannot access it` });
        }
        const session = manager.sessions.get(name);
        const result = {
          ok: true,
          connection: name,
          source: record.source,
          status: session?.status ?? 'disconnected',
          reconnectAttempts: session?.reconnectAttempts ?? 0,
        };
        const busyBy = session?.busyKind();
        if (busyBy !== null) result.busyBy = busyBy;
        const lastError = session?.lastError;
        if (lastError !== null) result.lastError = lastError;
        const connectedAt = session?.connectedAt;
        if (connectedAt !== null) result.connectedAt = connectedAt;
        return clean(result);
      },
    }),

    defineTool({
      name: 'ssh_disconnect',
      description: 'Explicitly disconnect an AI-managed SSH connection. This is a deliberate disconnect: automatic reconnect is NOT triggered afterwards; the saved connection stays available and can be re-established with ssh_connect or ssh_exec. The panel tab (if any) stays open showing "disconnected". Optionally also delete the saved connection record.',
      parameters: {
        connection: { type: 'string', required: true, description: 'Saved connection name.' },
        delete: { type: 'boolean', description: 'Also delete the saved connection record (default false).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            connection: { type: 'string' },
            deleted: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        const name = String(args.connection ?? '').trim();
        const record = manager.store.get(name);
        if (!record) return { ok: false, connection: name, message: `no saved connection named "${name}"` };
        if (record.source !== 'ai') {
          return { ok: false, connection: name, message: `connection "${name}" was created by the user; AI cannot access it` };
        }
        await manager.disconnect(name);
        let deleted = false;
        if (args.delete === true) {
          await manager.deleteRecord(name);
          deleted = true;
        }
        return clean({ ok: true, connection: name, deleted, message: deleted ? 'disconnected and record deleted' : 'disconnected' });
      },
    }),

    defineTool({
      name: 'ssh_delete',
      description: 'Delete a saved AI-managed SSH connection record (disconnects it first if online). Other connections to the same server are unaffected.',
      parameters: {
        connection: { type: 'string', required: true, description: 'Saved connection name.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            connection: { type: 'string' },
            deleted: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        const name = String(args.connection ?? '').trim();
        const record = manager.store.get(name);
        if (!record) return { ok: false, connection: name, message: `no saved connection named "${name}"` };
        if (record.source !== 'ai') {
          return { ok: false, connection: name, message: `connection "${name}" was created by the user; AI cannot access it` };
        }
        await manager.deleteRecord(name);
        return clean({ ok: true, connection: name, deleted: true, message: 'connection record deleted' });
      },
    }),
  ];
}
