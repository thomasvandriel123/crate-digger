import { createReadStream, existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';

const DATA_DIR = resolve(__dirname, process.env.CRATE_DATA_DIR ?? 'data');

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

/**
 * Serves the gitignored `data/` folder (library.json + covers) at `/data/` in dev and preview,
 * mirroring how Caddy serves the mounted volume in production. Data never enters the bundle.
 */
function serveLibraryData(): Plugin {
  const middleware = (req: { url?: string }, res: ServerResponse, next: () => void) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/data/')) return next();
    const rel = normalize(decodeURIComponent(url.slice('/data/'.length)));
    const file = join(DATA_DIR, rel);
    if (!file.startsWith(DATA_DIR) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', url.endsWith('.json') ? 'no-cache' : 'public, max-age=3600');
    createReadStream(file).pipe(res);
  };
  return {
    name: 'crate-digger:serve-data',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [preact(), serveLibraryData()],
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
    reportCompressedSize: false,
    // three.js alone is ~500 KB minified; the real budget is enforced gzipped by scripts/check-bundle-size.mjs.
    chunkSizeWarningLimit: 800,
  },
  // 127.0.0.1, not localhost: Spotify only accepts loopback IP literals as plain-http redirect URIs.
  server: { host: '127.0.0.1', port: 5173 },
  preview: { port: 4173 },
});
