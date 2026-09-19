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

// Device runs (§20 M7): FATIHAH_LAN=1 serves the preview over HTTPS on every interface so phones
// and other Macs on the LAN get a secure context (WebGPU needs one off localhost). The
// self-signed cert lives outside the repo (FATIHAH_TLS_DIR, default ~/.fatihah-tls).
const lan = process.env.FATIHAH_LAN === '1';
const tlsDir = process.env.FATIHAH_TLS_DIR ?? resolve(process.env.HOME ?? '', '.fatihah-tls');
const lanServer = lan ? { host: true, https: { key: readFileSync(resolve(tlsDir, 'key.pem')), cert: readFileSync(resolve(tlsDir, 'cert.pem')) } } : {};

export default defineConfig({
  // GitHub Pages serves the site from /fatihah-manuscript/; the deploy workflow sets FATIHAH_BASE.
  base: process.env.FATIHAH_BASE ?? '/',
  plugins: [qaPages()],
  build: { target: 'es2022' },
  // three ships many subpath entries (three, three/webgpu, three/tsl); letting the dep
  // optimizer prebundle them separately creates duplicate module instances (broken node
  // graphs, stale HMR mixes). Serve three from source, deduped.
  resolve: { dedupe: ['three'] },
  optimizeDeps: { exclude: ['three'] },
  preview: { ...lanServer },
  server: {
    ...lanServer,
    // same-origin route to the qa/review capture sink (receiver.mjs), so capture pages
    // can save review PNGs without cross-origin fetches (preview inherits server.proxy)
    proxy: { '/qa-save': { target: 'http://localhost:4599', rewrite: (p) => p.replace(/^\/qa-save/, '/save') } },
  },
});
