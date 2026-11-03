#!/usr/bin/env node
/**
 * Writes web/vercel.json for an optional static-frontend deploy.
 *
 * The browser always calls same-origin `/api/*`. When BACKEND_ORIGIN is set
 * (https origin of the Docker/Caddy API host, no trailing slash), Vercel
 * rewrites those paths to the backend so cookies and CSP stay same-site.
 * Without BACKEND_ORIGIN, only the multi-page HTML routes are emitted.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'web', 'vercel.json');

const pages = [
  { source: '/', destination: '/review.html' },
  { source: '/review', destination: '/review.html' },
  { source: '/complaint', destination: '/complaint.html' },
  { source: '/privacy', destination: '/privacy.html' },
  { source: '/admin', destination: '/admin.html' },
  { source: '/r/:code', destination: '/review.html' },
];

const raw = process.env.BACKEND_ORIGIN?.trim().replace(/\/+$/, '') ?? '';
/** @type {Array<{ source: string, destination: string }>} */
const rewrites = [];

if (raw) {
  let origin;
  try {
    origin = new URL(raw);
  } catch {
    console.error('BACKEND_ORIGIN must be a valid absolute URL, e.g. https://reviews.stellardentalclinic.com');
    process.exit(1);
  }
  if (origin.protocol !== 'https:') {
    console.error('BACKEND_ORIGIN must use https in production.');
    process.exit(1);
  }
  const base = origin.origin;
  rewrites.push(
    { source: '/api/:path*', destination: `${base}/api/:path*` },
    { source: '/healthz', destination: `${base}/healthz` },
  );
}

rewrites.push(...pages);
writeFileSync(out, `${JSON.stringify({ rewrites }, null, 2)}\n`);
console.log(`wrote ${out}${raw ? ` (API proxy → ${raw})` : ' (static pages only; set BACKEND_ORIGIN to proxy /api)'}`);
