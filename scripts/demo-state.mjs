/** Set up demo state on the test instance for screenshots. */
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
    // demo-web: user source, password auth
    await request('createRecord', { name: 'demo-web', host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123' });
    // demo-db: user source, key auth
    await request('createRecord', {
      name: 'demo-db', host: '127.0.0.1', port: 2222, user: 'root',
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nplaceholder\n-----END OPENSSH PRIVATE KEY-----",
    }).catch(() => {});
    // connect demo-web and run a colorful command
    await request('exec', { name: 'demo-web', command: 'echo "hello from the demo"; printf "\\033[32mgreen\\033[0m \\033[1;34mblue-bold\\033[0m\\n"; ls -la / | head -4; whoami' });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log('demo state ready');
  } catch (error) {
    console.error('FAIL', error.message);
  } finally {
    setTimeout(() => { ws.close(); process.exit(0); }, 300);
  }
});
