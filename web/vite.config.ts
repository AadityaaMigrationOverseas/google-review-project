import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const PAGES = ['review', 'complaint', 'privacy', 'admin', 'link-invalid', '404'] as const;

/** Inlines shared HTML fragments (`<!--partial:name-->`) at build time: no runtime cost. */
function htmlPartials(): Plugin {
  return {
    name: 'html-partials',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html.replace(/<!--\s*partial:([\w-]+)\s*-->/g, (_, name: string) =>
          readFileSync(here(`./partials/${name}.html`), 'utf8'),
        ),
    },
  };
}

/** Mirrors the server's clean URLs while running the Vite dev server. */
function devRewrites(): Plugin {
  const routes: Array<[RegExp, string]> = [
    [/^\/(review)?(\?.*)?$/, '/review.html'],
    [/^\/r\/[A-Za-z0-9]+(\?.*)?$/, '/review.html'],
    [/^\/complaint(\?.*)?$/, '/complaint.html'],
    [/^\/privacy(\?.*)?$/, '/privacy.html'],
    [/^\/admin(\?.*)?$/, '/admin.html'],
  ];
  return {
    name: 'dev-rewrites',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const match = routes.find(([re]) => re.test(req.url ?? ''));
        if (match) req.url = match[1];
        next();
      });
    },
  };
}

export default defineConfig({
  root: here('.'),
  resolve: { conditions: ['source'] },
  plugins: [htmlPartials(), devRewrites()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: true,
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
    rollupOptions: {
      input: Object.fromEntries(PAGES.map((p) => [p, here(`./${p}.html`)])),
    },
  },
});
