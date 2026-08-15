/** CDP e2e: activate session → open column → type a command → run it → screenshot. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9234',
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-col5',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await new Promise((resolve) => setTimeout(resolve, 9000));
const targets = await fetch('http://127.0.0.1:9234/json').then((r) => r.json());
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
  if (result.result?.exceptionDetails) return 'EXC: ' + (result.result.exceptionDetails.text ?? '');
  return result.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// activate workspace + session
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="Row" i], li')]; const ws = rows.find((el) => { const t = (el.textContent || '').trim(); return t === 'dsh-ssh' || t.startsWith('dsh-ssh '); }); if (ws) ws.click(); return !!ws; })()`);
await sleep(1500);
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="sessionRow" i]')]; if (rows.length) rows[0].click(); return rows.length; })()`);
await sleep(2500);

// open the column
await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) rail.click(); return !!rail; })()`);
await sleep(2000);

// focus the prompt input and type a command
const typed = await ev(`(() => {
  const input = document.querySelector('.ssh-prompt-input');
  if (!input) return 'no input';
  input.focus();
  return 'focused, disabled=' + input.disabled;
})()`);
console.log('input:', typed);
await send('Input.insertText', { text: 'echo typed-from-terminal; pwd' });
await sleep(300);
const val = await ev(`document.querySelector('.ssh-prompt-input')?.value`);
console.log('input value:', JSON.stringify(val));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sleep(2500);

// verify the command output appeared in the terminal
console.log('terminal text:', await ev(`(() => { const el = document.querySelector('.ssh-terminal-scroll'); return el ? el.textContent.slice(0, 300) : 'none'; })()`));
console.log('prompt after:', await ev(`document.querySelector('.ssh-prompt-str')?.textContent ?? null`));

// screenshot via CDP
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('E:/Creative/dsh-ssh/test/shots/column-e2e.png', Buffer.from(shot.result.data, 'base64'));
console.log('screenshot saved');
ws.close();
edge.kill();
process.exit(0);
