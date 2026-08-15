/**
 * @jmcc-guo/dsh-ssh — WebSocket panel channel.
 *
 * One JSON request/response + push-event channel at `/ssh/ws`. The route
 * replicates the harness browser-trust fence (loopback / trustedHosts Host
 * check, same-origin Origin, cross-site fetch-metadata rejection) so the
 * high-privilege command channel is not exposed to arbitrary network clients.
 *
 * Client → server: {id, method, params} with methods snapshot / connect (by
 * tab key or record name) / openNewSession (a fresh tab+connection for a
 * saved record) / disconnect / closeTab (by tab key) / input (raw keystrokes
 * into a session's shell) / exec (alias: types a command line into the
 * primary shell) / resize / killCommand / createRecord / updateRecord /
 * deleteRecord / transferToAi / terminalSnapshot.
 * Server → client: {event:'state', state} and {event:'terminal', name, entries}.
 * @module @jmcc-guo/dsh-ssh/ws
 */
import { WebSocketServer } from 'ws';

/** WHATWG-normalized URL of a Host-header authority, or undefined. */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

/** Loopback classification (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Canonical authority form (hostname, or hostname:port). */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

/** The harness browser-trust decision (mirror of dsh-client-connection). */
function isTrustedRequest(req, trustedHosts) {
  const host = req.headers.host;
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * Install the panel channel on the web server.
 * @param ctx - plugin context (for logger).
 * @param webServer - the webServer service.
 * @param manager - SshManager instance.
 * @param trustedHosts - extra trusted authorities (webStartup), optional.
 * @returns disposer.
 */
export function installWs(ctx, webServer, manager, trustedHosts = []) {
  const wss = new WebSocketServer({ noServer: true });
  const logger = ctx.logger;

  webServer.registerUpgrade({
    path: '/ssh/ws',
    handler: (req, socket, head) => {
      if (!isTrustedRequest(req, trustedHosts)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    },
  });

  wss.on('connection', (ws) => {
    const detach = manager.attachClient(ws);
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        reply(ws, { error: 'invalid JSON' });
        return;
      }
      if (!message || typeof message.method !== 'string') {
        reply(ws, { error: 'invalid request' });
        return;
      }
      void handle(manager, message).then((result) => {
        reply(ws, message, result);
      }).catch((error) => {
        logger.error('dsh-ssh: panel method %s failed: %s', message.method, error instanceof Error ? error.message : String(error));
        reply(ws, message, { error: error instanceof Error ? error.message : String(error) });
      });
    });
    ws.on('close', () => detach());
    ws.on('error', () => detach());
  });

  return () => {
    wss.close();
    for (const client of wss.clients) {
      try {
        client.close();
      } catch { /* ignore */ }
    }
  };
}

function reply(ws, message, result) {
  if (ws.readyState !== 1) return;
  const id = message && typeof message.id === 'number' ? message.id : null;
  ws.send(JSON.stringify({ id, ...result }));
}

/** Route one panel method. */
async function handle(manager, message) {
  const params = message.params ?? {};
  switch (message.method) {
    case 'snapshot':
      return { result: manager.stateSnapshot() };
    case 'connect':
      // {tab} → reconnect a specific session (panel header); {name} → the
      // record's primary session (settings page, first tab).
      if (params.tab !== undefined && params.tab !== null && String(params.tab) !== '') {
        return { result: await manager.connectKey(String(params.tab)) };
      }
      return { result: await manager.connect(String(params.name ?? '')) };
    case 'openNewSession':
      return { result: await manager.openNewSession(String(params.name ?? '')) };
    case 'disconnect':
      return { result: await manager.disconnect(String(params.name ?? '')) };
    case 'closeTab':
      return { result: await manager.closeTab(String(params.tab ?? params.name ?? '')) };
    case 'input':
      return { result: manager.input(String(params.tab ?? params.name ?? ''), String(params.data ?? '')) };
    case 'exec':
      // Compatibility alias: type a command line into the primary shell.
      return { result: manager.input(String(params.name ?? ''), String(params.command ?? '') + '\r') };
    case 'resize':
      return { result: manager.resize(String(params.tab ?? params.name ?? ''), Number(params.cols), Number(params.rows)) };
    case 'killCommand':
      return { result: manager.killCommand(String(params.tab ?? params.name ?? '')) };
    case 'createRecord':
      return { result: await manager.createRecordWithSecrets(params) };
    case 'updateRecord':
      return { result: await manager.updateRecordWithSecrets(String(params.name ?? ''), params) };
    case 'deleteRecord':
      return { result: await manager.deleteRecord(String(params.name ?? '')) };
    case 'transferToAi':
      return { result: await manager.transferToAi(String(params.name ?? '')) };
    case 'terminalSnapshot':
      return { result: manager.terminalSnapshot(String(params.tab ?? params.name ?? ''), Number(params.since ?? 0)) };
    default:
      return { error: `unknown method "${message.method}"` };
  }
}
