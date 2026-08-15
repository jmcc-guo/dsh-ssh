/** Dump the REAL dgx session entries from the user's live GUI (read-only). */
import WebSocket from 'ws';

const BASE = process.argv[2] ?? 'ws://127.0.0.1:3080/ssh/ws';
const NAME = process.argv[3] ?? 'dgx';
const ws = new WebSocket(BASE);
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
    const snap = await request('snapshot');
    console.log('=== records/tabs ===');
    console.log(JSON.stringify({ records: snap.records.map((r) => ({ name: r.name, source: r.source, host: r.host, status: r.status })), tabs: snap.tabs }));
    const term = await request('terminalSnapshot', { name: NAME, since: 0 });
    console.log(`=== ${NAME} RAW ENTRIES (escaped, ${term.entries.length}) ===`);
    for (const entry of term.entries) {
      console.log(`[${entry.kind}/${entry.source ?? ''}] ${JSON.stringify(entry.text)}`);
    }
    ws.close();
    process.exit(0);
  } catch (error) {
    console.error('FAIL', error.message);
    process.exit(1);
  }
});
ws.on('error', (error) => {
  console.error('WS error:', error.message);
  process.exit(1);
});
