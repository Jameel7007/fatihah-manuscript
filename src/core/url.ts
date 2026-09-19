// Base-aware asset URLs. The site can be served from a subpath (GitHub Pages:
// /fatihah-manuscript/), so every runtime fetch goes through here instead of a leading slash.
// Vite substitutes import.meta.env.BASE_URL at build time ('/' in dev).
export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return base.replace(/\/?$/, '/') + path.replace(/^\/+/, '');
}
