/**
 * Reproduce ssh_connect tool path: connectWithParams({...auth: {privateKeyPath}})
 * mirrors lib/tools.js execute -> manager.connectWithParams.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshManager } from '../lib/manager.js';

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ssh-repro-'));

const credentials = new Map();
const fakeCredentials = {
  async resolve(ref) { const v = credentials.get(String(ref)); return v ? { value: v, source: 'test' } : undefined; },
  async describe(ref) { return { configured: credentials.has(String(ref)), writable: true }; },
  async set(ref, value) { credentials.set(String(ref), value); },
  async unset(ref) { credentials.delete(String(ref)); },
};
const logger = { info: (...a) => console.log('INFO', ...a), warn: (...a) => console.log('WARN', ...a), error: (...a) => console.log('ERROR', ...a) };

const manager = new SshManager({ credentials: fakeCredentials, logger }, { heartbeatIntervalMs: 3000, reconnectBaseDelayMs: 1000 }, HOME);
manager.initialize();

const r = await manager.connectWithParams({
  name: 'serverA',
  host: '127.0.0.1',
  port: 2222,
  user: 'root',
  auth: { privateKeyPath: 'E:/Creative/dsh-ssh/test/id_test' },
});
console.log(JSON.stringify(r, null, 2));

await manager.shutdown();
process.exit(r.ok ? 0 : 1);
