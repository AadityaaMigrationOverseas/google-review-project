// Runs the API (tsx watch) and the Vite dev server together.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npm, ['run', 'dev', '-w', 'server'], { stdio: 'inherit' }),
  spawn(npm, ['run', 'dev', '-w', 'web'], { stdio: 'inherit' }),
];

const stop = (code = 0) => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(code);
};
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
for (const c of children) c.on('exit', (code) => stop(code ?? 0));
