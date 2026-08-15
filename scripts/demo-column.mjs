/** Set up demo state for the new column UI: records + connect + commands. */
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:3081/ssh/ws');
let seq = 0;
const pending = new Map();
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.on('message', (data) => {
  const message = JSON.parse(String(data));
  if (message.id !== undefined && message.id !== null) {
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      message.error !== undefined ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
    }
  }
});
ws.on('open', async () => {
  try {
    // user-source (transfer strip test) + ai-source (busy test)
    await request('createRecord', { name: 'web-srv', host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123' });
    await request('createRecord', { name: 'db-srv', host: '127.0.0.1', port: 2222, user: 'root', privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nplaceholder\n-----END OPENSSH PRIVATE KEY-----" }).catch(() => {});
    // connect web-srv + run commands via the shared shell (real terminal)
    await request('exec', { name: 'web-srv', command: 'whoami; echo ---; cd /tmp && ls -d /tmp' });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const snap = await request('snapshot');
    const web = snap.records.find((r) => r.name === 'web-srv');
    console.log('web-srv:', JSON.stringify({ status: web.status, source: web.source, busyBy: web.busyBy }));
    const db = snap.records.find((r) => r.name === 'db-srv');
    console.log('db-srv:', JSON.stringify({ status: db.status, source: db.source }));
    // activate the db-srv tab (user-source) for the transfer strip — tabs come from connect; connect db with key fails, so use web-srv only
    console.log('tabs:', JSON.stringify(snap.tabs));
  } catch (error) {
    console.error('FAIL', error.message);
  } finally {
    setTimeout(() => { ws.close(); process.exit(0); }, 300);
  }
});
