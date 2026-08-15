/** CDP final: capture the new terminal + tab "+" menu. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9241',
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-final2',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await new Promise((resolve) => setTimeout(resolve, 9000));
const targets = await fetch('http://127.0.0.1:9241/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('3081'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => {
  const cid = ++id;
  pending.set(cid, resolve);
  ws.send(JSON.stringify({ id: cid, method, params }));
});
ws.on('message', (data) => {
  const message = JSON.parse(String(data));
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
await new Promise((resolve) => ws.on('open', resolve));
await send('Runtime.enable');
const ev = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (result.result?.exceptionDetails) return 'EXC';
  return result.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const host = new WebSocket('ws://127.0.0.1:3081/ssh/ws');
let hid = 0;
const hpending = new Map();
const hreq = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++hid;
  hpending.set(callId, { resolve, reject });
  host.send(JSON.stringify({ id: callId, method, params }));
});
host.on('message', (data) => {
  const m = JSON.parse(String(data));
  if (m.id !== undefined && m.id !== null) {
    const entry = hpending.get(m.id);
    if (entry) {
      hpending.delete(m.id);
      m.error !== undefined ? entry.reject(new Error(m.error)) : entry.resolve(m.result);
    }
  }
});
await new Promise((resolve) => host.on('open', resolve));
await hreq('createRecord', { name: 'final-box', host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123' });
await hreq('exec', { name: 'final-box', command: 'echo hello-terminal; cd /tmp; pwd; printf "\\033[32mgreen\\033[0m \\033[1;34mblue\\033[0m\\n"' });
await new Promise((resolve) => setTimeout(resolve, 1500));

await ev(`(() => { const rows = [...document.querySelectorAll('[class*="Row" i], li')]; const wsRow = rows.find((el) => { const t = (el.textContent || '').trim(); return /^(dsh-ssh|dsh-agent-tool-manager|DgxSpark|LApp|qa_collector|astral-hub)$/.test(t); }); if (wsRow) wsRow.click(); })()`);
await sleep(2000);
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="sessionRow" i]')]; if (rows.length) rows[0].click(); })()`);
await sleep(3000);
for (let attempt = 0; attempt < 4; attempt++) {
  await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) rail.click(); })()`);
  await sleep(2000);
  if ((await ev(`!!document.querySelector('.ssh-panel')`)) === true) break;
}
// focus the live terminal's invisible catcher and type a partial command
// (the remote shell echoes it right after the prompt, like a real terminal)
await ev(`(() => { const i = document.querySelector('.ssh-terminal-catcher'); if (i) i.focus(); return !!i; })()`);
await send('Input.insertText', { text: 'ls -la' });
await sleep(400);
// open the "+" menu
await ev(`(() => { const b = document.querySelector('.ssh-tab-add'); if (b) b.click(); })()`);
await sleep(600);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('E:/Creative/dsh-ssh/test/shots/final-v2.png', Buffer.from(shot.result.data, 'base64'));
console.log('screenshot saved');
await hreq('deleteRecord', { name: 'final-box' });
ws.close();
host.close();
edge.kill();
process.exit(0);
