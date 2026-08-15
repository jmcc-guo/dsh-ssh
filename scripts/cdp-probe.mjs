/** CDP probe: inspect the live page state via Edge DevTools protocol. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9223;

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-profile',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await sleep(9000);

// find the page target
const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3081'));
if (!page) {
  console.error('no page target', targets.map((t) => `${t.type}:${t.url}`).join(' | '));
  edge.kill();
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => {
  const callId = ++id;
  pending.set(callId, resolve);
  ws.send(JSON.stringify({ id: callId, method, params }));
});
ws.on('message', (data) => {
  const message = JSON.parse(String(data));
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (/error|exception|failed/i.test(text)) console.log('PAGE LOG:', text.slice(0, 300));
  }
  if (message.method === 'Runtime.exceptionThrown') {
    console.log('PAGE EXCEPTION:', JSON.stringify(message.params.exceptionDetails).slice(0, 500));
  }
});

await new Promise((resolve) => ws.on('open', resolve));

await send('Runtime.enable');
await send('Log.enable');

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) {
    return { error: result.result.exceptionDetails.text, detail: (result.result.exceptionDetails.exception?.description ?? '').slice(0, 300) };
  }
  return { value: result.result?.result?.value };
};

console.log('rail present:', JSON.stringify(await evaluate(`!!document.querySelector('.ssh-rail')`)));
console.log('panel present:', JSON.stringify(await evaluate(`!!document.querySelector('.ssh-panel')`)));
console.log('hook type:', JSON.stringify(await evaluate(`typeof window.__dshSshStore`)));
console.log('store keys:', JSON.stringify(await evaluate(`window.__dshSshStore ? Object.keys(window.__dshSshStore) : null`)));
console.log('state panelOpen:', JSON.stringify(await evaluate(`window.__dshSshStore ? window.__dshSshStore.get().panelOpen : null`)));
console.log('state records:', JSON.stringify(await evaluate(`window.__dshSshStore ? window.__dshSshStore.get().records.length : null`)));
console.log('state tabs:', JSON.stringify(await evaluate(`window.__dshSshStore ? window.__dshSshStore.get().tabs : null`)));
console.log('state wsConnected:', JSON.stringify(await evaluate(`window.__dshSshStore ? window.__dshSshStore.get().wsConnected : null`)));
console.log('rail html:', JSON.stringify(await evaluate(`document.querySelector('.ssh-rail') ? document.querySelector('.ssh-rail').outerHTML.slice(0, 150) : null`)));
console.log('overlay entries:', JSON.stringify(await evaluate(`[...document.querySelectorAll('[class*=ssh]')].slice(0, 10).map(e => e.className)`)));
console.log('full store dump:', JSON.stringify(await evaluate(`JSON.stringify(window.__dshSshStore.get())`)));
console.log('styles present:', JSON.stringify(await evaluate(`!!document.querySelector('style[data-plugin-css="@dsh-external/dsh-ssh/client"]')`)));
console.log('panel stylesheet rule:', JSON.stringify(await evaluate(`(() => { const s = [...document.styleSheets].map(sh => { try { return [...sh.cssRules].filter(r => r.selectorText && r.selectorText.includes('ssh-panel')).length } catch { return 0 } }); return s; })()`)));

ws.close();
edge.kill();
process.exit(0);
