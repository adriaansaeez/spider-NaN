import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Served at the root next to the presentation, exactly as the Dockerfile lays
// them out. Everything else at the root belongs to the repo, not to the site.
const ROOT_DIRS = ['captures', 'docs', 'reference-pack'];

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
};

/**
 * Dev-only mirror of the production layout: the presentation is the landing
 * page at '/', the game lives under the '/game/' base, and the media the
 * presentation links to (/captures, /docs, /reference-pack) sits at the root.
 * Without this the dev server would only expose things under '/game/' and the
 * presentation's absolute paths would 404 — dev and prod would disagree.
 */
function presentationDevServer(): Plugin {
  return {
    name: 'presentation-dev-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '/').split('?')[0]);

        if (url === '/' || url === '/index.html') {
          res.setHeader('Content-Type', 'text/html');
          res.end(fs.readFileSync(path.join(ROOT, 'presentacion/index.html')));
          return;
        }

        if (!ROOT_DIRS.includes(url.split('/')[1])) return next();

        const file = path.join(ROOT, url);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return next();
        }
        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.end(fs.readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  base: '/game/',
  plugins: [presentationDevServer()],
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
});
