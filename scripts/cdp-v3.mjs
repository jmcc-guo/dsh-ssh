/** CDP v3: type into the terminal prompt (mirror + cursor) and submit. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9240',
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-v3',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await new Promise((resolve) => setTimeout(resolve, 9000));
const targets = await fetch('http://127.0.0.1:9240/json').then((r) => r.json());
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

// test connection
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
await hreq('createRecord', { name: 'type-box', host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123' });
await hreq('exec', { name: 'type-box', command: 'echo CONNECTED' });
await new Promise((resolve) => setTimeout(resolve, 1200));

// session + panel (with retries)
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="Row" i], li')]; const wsRow = rows.find((el) => { const t = (el.textContent || '').trim(); return /^(dsh-ssh|dsh-agent-tool-manager|DgxSpark|LApp|qa_collector|astral-hub)$/.test(t); }); if (wsRow) wsRow.click(); })()`);
await sleep(2000);
for (let attempt = 0; attempt < 3; attempt++) {
  await ev(`(() => { const rows = [...document.querySelectorAll('[class*="sessionRow" i]')]; if (rows.length) rows[attempt > 0 ? 0 : 0].click(); })()`);
  await sleep(3000);
  const composer = await ev(`!!document.querySelector('[class*="composer" i]')`);
  if (composer === true) break;
}
for (let attempt = 0; attempt < 4; attempt++) {
  await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) rail.click(); })()`);
  await sleep(2000);
  const panel = await ev(`!!document.querySelector('.ssh-panel')`);
  if (panel === true) break;
}
console.log('panel:', await ev(`!!document.querySelector('.ssh-panel')`));

// focus + type
console.log('focus:', await ev(`(() => { const i = document.querySelector('.ssh-prompt-input'); if (!i) return 'no input'; i.focus(); return 'focused disabled=' + i.disabled; })()`));
await send('Input.insertText', { text: 'echo MIRROR-OK && pwd' });
await sleep(400);
console.log('mirror text:', await ev(`document.querySelector('.ssh-prompt-typed')?.textContent ?? null`));
console.log('cursor after typed:', await ev(`document.querySelector('.ssh-prompt-cursor') ? 'yes' : 'no'`));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sleep(2500);
console.log('terminal tail:', await ev(`(() => { const el = document.querySelector('.ssh-terminal-scroll'); return el ? el.textContent.slice(-160) : 'none'; })()`));
console.log('mirror after submit:', await ev(`document.querySelector('.ssh-prompt-typed')?.textContent ?? '(empty)'`));
// history: arrow up should restore the command
console.log('focus again:', await ev(`(() => { const i = document.querySelector('.ssh-prompt-input'); i.focus(); return true; })()`));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
await sleep(400);
console.log('history up:', await ev(`document.querySelector('.ssh-prompt-typed')?.textContent ?? '(empty)'`));
await hreq('deleteRecord', { name: 'type-box' });
ws.close();
host.close();
edge.kill();
process.exit(0);
