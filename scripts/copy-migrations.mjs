// Copies SQL migrations next to the compiled server (tsc only emits .js).
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../server/src/db/migrations/', import.meta.url));
const dest = fileURLToPath(new URL('../server/dist/db/migrations/', import.meta.url));
cpSync(src, dest, { recursive: true });
