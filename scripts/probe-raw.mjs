/** Raw-bytes probe: dump what the host sends to the client for one shell session. */
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:3081/ssh/ws');
let seq = 0;
const pending = new Map();
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const events = [];
ws.on('message', (data) => {
  const message = JSON.parse(String(data));
  if (message.id !== undefined && message.id !== null) {
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      message.error !== undefined ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
    }
    return;
  }
  events.push(message);
});
ws.on('open', async () => {
  try {
    const NAME = 'probe-box';
    await request('deleteRecord', { name: NAME }).catch(() => {});
    await request('createRecord', { name: NAME, host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123' });
    await request('connect', { name: NAME });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    events.length = 0;
    await request('input', { name: NAME, data: 'cd apps 2>/dev/null; mkdir -p apps && cd apps && pwd\r' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const snap = await request('terminalSnapshot', { name: NAME, since: 0 });
    console.log('=== RAW ENTRIES (escaped) ===');
    for (const entry of snap.entries) {
      console.log(`[${entry.kind}/${entry.source}] ` + JSON.stringify(entry.text));
    }
    console.log('=== events ===');
    console.log(JSON.stringify(events.slice(0, 6).map((e) => ({ event: e.event, name: e.name, n: e.entries?.length }))));
    await request('deleteRecord', { name: NAME }).catch(() => {});
    ws.close();
    process.exit(0);
  } catch (error) {
    console.error('FAIL', error.message);
    process.exit(1);
  }
});
