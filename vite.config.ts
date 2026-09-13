import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// QA runner pages (matrix, repeat, plates, accessibility, fallback) live in qa/pages/ and are
// served at /qa/<name>.html by the dev and preview servers ONLY — they never enter dist/.
// They carry inline module scripts and drive the app through same-origin iframes, so the
// raw file is all a browser needs.
function qaPages(): Plugin {
  const dir = resolve(fileURLToPath(new URL('.', import.meta.url)), 'qa/pages');
  const serve = (req: { url?: string }, res: { setHeader(n: string, v: string): void; end(b: Buffer): void }, next: () => void): void => {
    const m = /^\/qa\/([\w-]+\.html)(?:[?#].*)?$/.exec(req.url ?? '');
    const file = m ? resolve(dir, m[1]!) : '';
    if (!file || !existsSync(file)) return next();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(file));
  };
  return {
    name: 'fatihah-qa-pages',
    configureServer(server) { server.middlewares.use(serve); },
    configurePreviewServer(server) { server.middlewares.use(serve); },
  };
}

export default defineConfig({
  plugins: [qaPages()],
  build: { target: 'es2022' },
  // three ships many subpath entries (three, three/webgpu, three/tsl); letting the dep
  // optimizer prebundle them separately creates duplicate module instances (broken node
  // graphs, stale HMR mixes). Serve three from source, deduped.
  resolve: { dedupe: ['three'] },
  optimizeDeps: { exclude: ['three'] },
  server: {
    // same-origin route to the qa/review capture sink (receiver.mjs), so capture pages
    // can save review PNGs without cross-origin fetches (preview inherits server.proxy)
    proxy: { '/qa-save': { target: 'http://localhost:4599', rewrite: (p) => p.replace(/^\/qa-save/, '/save') } },
  },
});
