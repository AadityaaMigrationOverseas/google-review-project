#!/usr/bin/env node
// Speaks the sentiment_server line protocol with scripted misbehaviour, so the
// Node process manager can be tested against failure modes deterministically.
import { createInterface } from 'node:readline';

const mode = process.argv[process.argv.indexOf('--mode') + 1] ?? 'normal';

if (mode === 'fatal') {
  process.stderr.write('FATAL\tcould not load model\n');
  process.exit(2);
}
if (mode === 'no-ready') {
  setInterval(() => {}, 1000);
} else if (mode === 'bad-handshake') {
  process.stdout.write('HELLO\n');
} else {
  setTimeout(() => process.stdout.write('READY\t1\n'), mode === 'slow-ready' ? 300 : 0);
}

let count = 0;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const tab = line.indexOf('\t');
  const id = line.slice(0, tab);
  const text = line.slice(tab + 1);
  count++;

  if (text.includes('__hang__')) return;
  if (text.includes('__crash__')) process.exit(1);
  if (text.includes('__garbage__')) return void process.stdout.write('not a valid response\n');
  if (text.includes('__wrong_id__')) return void process.stdout.write(`999999\tOK\tPOSITIVE\t0.9\t0.9\t3\t10\n`);
  if (text.includes('__err__')) return void process.stdout.write(`${id}\tERR\tINFERENCE\n`);
  if (text.includes('__echo__')) {
    // Reports the exact received text length/content via the tokens field for assertions.
    process.stderr.write(`ECHO:${text}\n`);
  }
  const delay = text.includes('__slow__') ? 150 : 0;
  const positive = /good|great|love|excellent/i.test(text);
  const confidence = text.includes('__uncertain__') ? 0.65 : text.includes('__coinflip__') ? 0.52 : 0.97;
  setTimeout(() => {
    process.stdout.write(
      `${id}\tOK\t${positive ? 'POSITIVE' : 'NEGATIVE'}\t${confidence.toFixed(6)}\t${(positive ? confidence : 1 - confidence).toFixed(6)}\t${count}\t1500\n`,
    );
  }, delay);
});
rl.on('close', () => process.exit(0));
