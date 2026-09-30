import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiRouter } from './api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolves the static frontend build output directory.
 *
 * The bundle (`function-build/index.js`) is deployed next to the `dist/`
 * folder on the function root, so the primary candidate is
 * `<bundle dir>/dist`. Some runtimes resolve `import.meta.url` to a
 * different location, so we also fall back to `process.cwd()/dist`.
 */
function resolveDistPath(): string {
  const candidates = [
    path.join(__dirname, 'dist'),
    path.resolve(process.cwd(), 'dist'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'index.html'))) {
        return candidate;
      }
    } catch {
      // ignore and try the next candidate
    }
  }
  return candidates[0];
}

export const DIST_PATH = resolveDistPath();

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Minimal static file middleware used in serverless mode.
 * Express.static relies on Node streams which are hard to emulate in a
 * plain request/response bridge, so we read files from disk and send them
 * with `res.send()` instead.
 */
function serveStaticFiles(distPath: string): express.RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return next();
    }

    if (urlPath.startsWith('/api/')) return next();

    const isAssetRequest = urlPath.startsWith('/assets/');

    const filePath = path.normalize(path.join(distPath, urlPath === '/' ? 'index.html' : urlPath));
    // Path traversal protection
    if (!filePath.startsWith(distPath)) {
      res.status(403).end('Forbidden');
      return;
    }

    const candidates = [filePath];
    if (!path.extname(filePath) && !isAssetRequest) {
      candidates.push(path.join(filePath, 'index.html'));
    }
    if (!isAssetRequest) {
      candidates.push(path.join(distPath, 'index.html'));
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const ext = path.extname(candidate).toLowerCase();
        res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
        res.send(fs.readFileSync(candidate));
        return;
      }
    }

    // Never substitute index.html for a missing static asset: browsers
    // refuse to execute HTML as JS/CSS due to strict MIME checking.
    if (isAssetRequest) {
      res.status(404).end('Not Found');
      return;
    }

    next();
  };
}

/**
 * Creates the Express application.
 *
 * In serverless mode (`options.serverless === true`) the body is parsed by
 * the serverless bridge before it reaches the app, and static files are
 * served via a stream-free middleware so that no Node stream emulation is
 * required in the Yandex Cloud Functions handler.
 */
export function createApp(options: { serverless?: boolean } = {}): express.Express {
  const app = express();

  if (!options.serverless) {
    app.use(express.json());
  }

  // API routes
  app.use('/api', apiRouter);

  // Serve static frontend files in production
  if (options.serverless) {
    app.use(serveStaticFiles(DIST_PATH));
  } else {
    app.use(express.static(DIST_PATH));
  }

  // SPA fallback
  app.get('*', (_req, res) => {
    const indexPath = path.join(DIST_PATH, 'index.html');
    if (options.serverless) {
      if (fs.existsSync(indexPath)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(fs.readFileSync(indexPath));
      } else {
        res.status(404).send('Not Found');
      }
    } else {
      res.sendFile(indexPath);
    }
  });

  return app;
}

export default createApp;