/**
 * Simulate the client-side line assembly against the REAL captured DGX
 * entries (char-by-char echo, bracketed-paste sequences, 2004h/2004l) to
 * verify the stateful feedLines fix produces the sample-like rendering.
 */
const CSI_RE = /^\x1b\[[0-9;?]*[A-Za-z@`~]/;

function feedLines(lines, current, bytes, text) {
  const commit = () => { lines.push({ type: 'text', text: current }); bytes += current.length + 32; };
  let i = 0;
  const n = String(text).length;
  while (i < n) {
    const ch = text[i];
    if (ch === '\r') {
      if (text[i + 1] === '\n') { commit(); current = ''; i += 2; continue; }
      current = ''; i += 1; continue;
    }
    if (ch === '\n') { commit(); current = ''; i += 1; continue; }
    if (ch === '\b') { current = current.replace(/\x1b\[[0-9;?]*[A-Za-z@`~]$/, '').slice(0, -1); i += 1; continue; }
    if (ch === '\x1b') {
      const rest = text.slice(i);
      const e2k = rest.match(/^\x1b\[2K/);
      if (e2k) { current = ''; i += e2k[0].length; continue; }
      const ek = rest.match(/^\x1b\[K/);
      if (ek) { current = current.replace(/\x1b\[[0-9;?]*[A-Za-z@`~]$/, ''); i += ek[0].length; continue; }
      const csi = rest.match(CSI_RE);
      if (csi) { i += csi[0].length; continue; }
      const osc = rest.match(/^\x1b\][\s\S]*?(?:\x07|\x1b\\)/);
      if (osc) { i += osc[0].length; continue; }
      i += 1; continue;
    }
    if (ch < ' ' && ch !== '\t') { i += 1; continue; }
    current += ch; i += 1;
  }
  return { lines, currentLine: current, bytes };
}

function appendTerminal(entries) {
  const state = { lines: [], current: '', bytes: 0, seq: 0 };
  for (const entry of entries) {
    if (entry.kind === 'out') {
      ({ lines: state.lines, currentLine: state.current, bytes: state.bytes } = feedLines(state.lines, state.current, state.bytes, String(entry.text)));
    } else {
      if (state.current !== '') { state.lines.push({ type: 'text', text: state.current }); state.bytes += state.current.length + 32; state.current = ''; }
      state.lines.push({ type: entry.kind, text: String(entry.text) });
      state.bytes += String(entry.text).length + 32;
    }
  }
  return state;
}

// The exact entries captured from the user's real DGX session (session 2 part).
const entries = [
  { kind: 'notice', text: 'connected to jmcc@192.168.2.81:22' },
  { kind: 'out', text: 'Welcome to NVIDIA DGX Spark Version 7.5.0 (GNU/Linux 6.17.0-1026-nvidia aarch64)\r\n\r\n System information as of 2026年 08月 15日 星期六 12:52:48 CST\r\n\r\n  System load:             0.0\r\n  Usage of /:              28.9% of 3.67TB\r\n  Memory usage:            21%\r\n  Swap usage:              1%\r\n  Temperature:             50.5 C\r\n  Processes:               453\r\n  Users logged in:         0\r\n  IPv4 address for enP7s7: 192.168.2.81\r\n  IPv6 address for enP7s7: 240e:370:6d10:6550:6461:406b:8b2d:5\r\n  IPv6 address for enP7s7: 240e:370:6d10:6550:47c2:8892:9458:8c01\r\n  IPv6 address for enP7s7: 240e:370:6d10:6550:8396:84:c778:2412\r\nWeb console: https://spark-7abc:9091/\r\n\r\nLast login: Sat Aug 15 12:52:49 2026 from 192.168.2.22\r\r\n' },
  { kind: 'out', text: '\u001b[?2004h\u001b]0;jmcc@spark-7abc: ~\u0007\u001b[01;32mjmcc@spark-7abc\u001b[00m:\u001b[01;34m~\u001b[00m$ ' },
  { kind: 'out', text: 'c' },
  { kind: 'out', text: 'd' },
  { kind: 'out', text: ' ' },
  { kind: 'out', text: 'a' },
  { kind: 'out', text: 'p' },
  { kind: 'out', text: 'p' },
  { kind: 'out', text: 's' },
  { kind: 'out', text: '\r\n\u001b[?2004l\r\u001b[?2004h\u001b]0;jmcc@spark-7abc: ~/apps\u0007\u001b[01;32mjmcc@spark-7abc\u001b[00m:\u001b[01;34m~/apps\u001b[00m$ ' },
  { kind: 'out', text: 'l' },
  { kind: 'out', text: 's' },
  { kind: 'out', text: '\r\n\u001b[?2004l\r' },
  { kind: 'out', text: '\u001b[0m\u001b[01;34mComfyUI\u001b[0m  \u001b[01;34mollama\u001b[0m\r\n' },
  { kind: 'out', text: '\u001b[?2004h\u001b]0;jmcc@spark-7abc: ~/apps\u0007\u001b[01;32mjmcc@spark-7abc\u001b[00m:\u001b[01;34m~/apps\u001b[00m$ ' },
];

const { lines, current } = appendTerminal(entries);
console.log('=== COMMITTED LINES ===');
for (const line of lines) console.log(JSON.stringify(line.text));
console.log('=== LIVE LINE ===');
console.log(JSON.stringify(current));

// Expectation (sample-like):
const expected = [
  'connected to jmcc@192.168.2.81:22',
  'Welcome to NVIDIA DGX Spark Version 7.5.0 (GNU/Linux 6.17.0-1026-nvidia aarch64)',
  ' System information as of 2026年 08月 15日 星期六 12:52:48 CST',
  '  System load:             0.0',
  '  Usage of /:              28.9% of 3.67TB',
  '  Memory usage:            21%',
  '  Swap usage:              1%',
  '  Temperature:             50.5 C',
  '  Processes:               453',
  '  Users logged in:         0',
  '  IPv4 address for enP7s7: 192.168.2.81',
  '  IPv6 address for enP7s7: 240e:370:6d10:6550:6461:406b:8b2d:5',
  '  IPv6 address for enP7s7: 240e:370:6d10:6550:47c2:8892:9458:8c01',
  '  IPv6 address for enP7s7: 240e:370:6d10:6550:8396:84:c778:2412',
  'Web console: https://spark-7abc:9091/',
  'jmcc@spark-7abc:~$ cd apps',
  'jmcc@spark-7abc:~/apps$ ls',
  'ComfyUI  ollama',
];
const got = [...lines.map((l) => l.text), current];
let ok = true;
for (const exp of expected) {
  const found = got.some((g) => g.replace(/\x1b\[[0-9;?]*[A-Za-z@`~]/g, '').replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '') === exp);
  if (!found) { ok = false; console.log('MISSING:', JSON.stringify(exp)); }
}
// ensure no leftover garbage lines
const junk = got.filter((g) => /^[a-z ]{1,3}$/.test(g) && g.trim() !== '' && !expected.includes(g.replace(/\x1b\[[0-9;?]*[A-Za-z@`~]/g, '')));
console.log('junk single-char lines:', JSON.stringify(junk));
console.log(ok ? 'SIMULATION PASS' : 'SIMULATION FAIL');
process.exit(ok ? 0 : 1);
