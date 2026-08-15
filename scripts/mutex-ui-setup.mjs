/**
 * Mutex UI verification: transfer to AI, type a long command into the shared
 * shell (shell stays active → busy UI while an AI command would wait).
 */
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
    await request('createRecord', { name: 'mutex-box', host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123' });
    await request('transferToAi', { name: 'mutex-box' });
    // type a long command into the shared shell (it runs in the real shell)
    const exec = await request('exec', { name: 'mutex-box', command: 'sleep 60' });
    console.log('typed into shell:', JSON.stringify(exec).slice(0, 80));
    setTimeout(async () => {
      const snap = await request('snapshot');
      const record = snap.records.find((r) => r.name === 'mutex-box');
      console.log('busyBy during command:', record.busyBy, '| source:', record.source);
      console.log('ready for CDP check');
      process.exit(0);
    }, 1500);
  } catch (error) {
    console.error('FAIL', error.message);
    process.exit(1);
  }
});
