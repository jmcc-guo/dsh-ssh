/** Drive the panel WebSocket channel of the test web instance (port 3081). */
import WebSocket from 'ws';

const WS_URL = 'ws://127.0.0.1:3081/ssh/ws';
const ws = new WebSocket(WS_URL);
let seq = 0;
const pending = new Map();
const events = [];

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.on('message', (data) => {
  const message = JSON.parse(String(data));
  if (message.id !== undefined && message.id !== null) {
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    }
    return;
  }
  events.push(message);
  console.log(`EVENT ${message.event}:`, JSON.stringify(message.event === 'state' ? { records: message.state.records.map((r) => ({ name: r.name, source: r.source, status: r.status, busyBy: r.busyBy })), tabs: message.state.tabs } : message).slice(0, 260));
});

ws.on('open', async () => {
  try {
    const snap = await request('snapshot');
    console.log('snapshot records:', snap.records.length, 'tabs:', JSON.stringify(snap.tabs));

    // Simulate the panel form: create a user-source connection with a password
    const created = await request('createRecord', {
      name: 'panel-box', host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123',
    });
    console.log('createRecord:', JSON.stringify(created).slice(0, 200));

    // Human command via the panel input bar
    const exec = await request('exec', { name: 'panel-box', command: 'echo PANEL-HELLO; whoami' });
    console.log('exec:', JSON.stringify(exec).slice(0, 160));

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const term = await request('terminalSnapshot', { name: 'panel-box', since: 0 });
    console.log('terminal entries:');
    for (const entry of term.entries) console.log(`  [${entry.kind}/${entry.source}] ${entry.text.replace(/\r?\n/g, '\\n').slice(0, 100)}`);

    // Transfer to AI (simulates the panel button)
    const transfer = await request('transferToAi', { name: 'panel-box' });
    console.log('transferToAi:', JSON.stringify(transfer).slice(0, 120));

    const snap2 = await request('snapshot');
    console.log('after transfer:', JSON.stringify(snap2.records.map((r) => ({ name: r.name, source: r.source, status: r.status }))));

    // Delete the record (cleanup)
    await request('deleteRecord', { name: 'panel-box' });
    console.log('deleted');
  } catch (error) {
    console.error('FAIL:', error.message);
  } finally {
    setTimeout(() => { ws.close(); process.exit(0); }, 500);
  }
});

ws.on('error', (error) => {
  console.error('WS error:', error.message);
  process.exit(1);
});
