/** CDP: dump the app's top-level DOM structure to find stable layout hooks. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9237',
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-dom1',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await new Promise((resolve) => setTimeout(resolve, 9000));
const targets = await fetch('http://127.0.0.1:9237/json').then((r) => r.json());
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

// top-level structure: body > ... > frame; show tags, classes, ids, data-attrs, inline grid styles
console.log(await ev(`(() => {
  const walk = (el, depth) => {
    if (depth > 5 || !el) return [];
    const out = [];
    const cls = (el.className && typeof el.className === 'string') ? el.className.split(' ').slice(0, 3).join('.') : '';
    const id = el.id ? '#' + el.id : '';
    const data = [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.name + '=' + a.value.slice(0, 20)).join(' ');
    const style = el.getAttribute('style') ? 'style=' + el.getAttribute('style').slice(0, 80) : '';
    if (depth <= 2 || /grid|frame|column/i.test(cls) || style.includes('grid')) {
      out.push('  '.repeat(depth) + el.tagName.toLowerCase() + id + '.' + cls + ' ' + data + ' ' + style);
    }
    for (const child of el.children) out.push(...walk(child, depth + 1));
    return out;
  };
  return walk(document.body, 0).join('\\n').slice(0, 4000);
})()`));
ws.close();
edge.kill();
process.exit(0);
