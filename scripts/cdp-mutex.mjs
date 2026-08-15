/** CDP check of the mutex input-disabled state. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9227',
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-profile5',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await new Promise((resolve) => setTimeout(resolve, 9000));

const targets = await fetch('http://127.0.0.1:9227/json').then((r) => r.json());
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
console.log('tabs:', await ev(`window.__dshSshStore ? JSON.stringify(window.__dshSshStore.get().tabs) : null`));
console.log('mutex-box record:', await ev(`window.__dshSshStore ? JSON.stringify(window.__dshSshStore.get().records.find(r => r.name === 'mutex-box')) : null`));
console.log('input element html:', await ev(`document.querySelector('.ssh-input')?.outerHTML?.slice(0, 300)`));
// activate the mutex-box tab by clicking it
console.log('click tab:', await ev(`(() => { const tabs = [...document.querySelectorAll('.ssh-tab')]; const t = tabs.find(x => x.textContent.includes('mutex-box')); if (t) { t.click(); return 'clicked'; } return 'not found'; })()`));
await new Promise((resolve) => setTimeout(resolve, 500));
console.log('input disabled after switch:', await ev(`document.querySelector('.ssh-input')?.disabled`));
console.log('hint after switch:', await ev(`(document.querySelector('.ssh-inputbar-hint-busy')?.textContent ?? document.querySelector('.ssh-inputbar-hint')?.textContent ?? '').trim()`));
console.log('active tab:', await ev(`document.querySelector('.ssh-tab-active .ssh-tab-name')?.textContent`));
ws.close();
edge.kill();
process.exit(0);
