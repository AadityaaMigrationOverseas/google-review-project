// Writes .br and .gz siblings for text assets so the server can serve them
// pre-compressed (no per-request compression CPU).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = path.resolve(process.argv[2] ?? 'dist');
const TEXT = /\.(html|js|css|svg|json|txt|webmanifest)$/;

let count = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (TEXT.test(name)) {
      const data = readFileSync(file);
      if (data.length < 512) continue;
      writeFileSync(`${file}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
      writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
      count++;
    }
  }
}
walk(root);
console.log(`precompressed ${count} files in ${root}`);
