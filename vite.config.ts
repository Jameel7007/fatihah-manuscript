import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022' },
  // three ships many subpath entries (three, three/webgpu, three/tsl); letting the dep
  // optimizer prebundle them separately creates duplicate module instances (broken node
  // graphs, stale HMR mixes). Serve three from source, deduped.
  resolve: { dedupe: ['three'] },
  optimizeDeps: { exclude: ['three'] },
  server: {
    // same-origin route to the qa/review capture sink (receiver.mjs), so capture pages
    // can save review PNGs without cross-origin fetches
    proxy: { '/qa-save': { target: 'http://localhost:4599', rewrite: (p) => p.replace(/^\/qa-save/, '/save') } },
  },
});
