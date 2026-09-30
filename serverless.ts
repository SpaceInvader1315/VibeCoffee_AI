import { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { createApp, DIST_PATH } from './server/app';

/**
 * Yandex Cloud Functions serverless adapter (manual bridge).
 *
 * Cloud Functions runtime for Node.js calls the exported `handler(event,
 * context, callback)` with an HTTP event in the form:
 *   {
 *     httpMethod: "GET",
 *     headers: {...},
 *     queryStringParameters: {...},
 *     path: "/api/...",
 *     body: "..." (for non-base64 bodies),
 *     isBase64Encoded: false,
 *     requestContext: {...}
 *   }
 *
 * There is no Node HTTP server (no req/res streams), so we emulate a
 * minimal IncomingMessage / ServerResponse pair and pass it to the Express
 * app. The response body is buffered and returned to Cloud Functions.
 */

const RESPONSE_TIMEOUT_MS = 55000;

const STATIC_MIME_TYPES: Record<string, string> = {
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

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
]);

/**
 * Determines whether the response body must be base64-encoded for
 * Cloud Functions (binary assets such as images and fonts).
 */
function shouldBase64Encode(requestedPath: string, body: Buffer): boolean {
  const cleanPath = requestedPath.split('?')[0].toLowerCase();
  const extMatch = cleanPath.match(/\.([a-z0-9]+)$/);
  if (extMatch && BINARY_EXTENSIONS.has(`.${extMatch[1]}`)) {
    return true;
  }
  // Fallback heuristic: binary data usually contains NUL bytes.
  return body.includes(0);
}

/**
 * Resolves the response Content-Type header.
 *
 * Cloud Functions/API Gateway sometimes drops or rewrites headers set by
 * Express in the emulated response, which results in `text/plain` for HTML
 * documents and static assets. This function re-derives the correct type
 * from (in priority order):
 *   1. an explicitly set non-default Content-Type header;
 *   2. the requested file extension (static assets);
 *   3. the body content (HTML document or JSON payload).
 */
function resolveContentType(
  headers: Record<string, string>,
  body: Buffer,
  requestedPath: string
): string {
  const existing = headers['content-type'];
  if (existing && !existing.toLowerCase().startsWith('text/plain')) {
    return existing;
  }

  // 1. Try to detect by the requested path extension.
  const cleanPath = requestedPath.split('?')[0].toLowerCase();
  const extMatch = cleanPath.match(/\.([a-z0-9]+)$/);
  if (extMatch) {
    const ext = `.${extMatch[1]}`;
    const mime = STATIC_MIME_TYPES[ext];
    if (mime) return mime;
  }

  // 2. Detect by body content.
  const text = body.toString('utf8').trimStart();
  if (text.startsWith('<!doctype html') || text.startsWith('<!DOCTYPE html') || text.startsWith('<html')) {
    return 'text/html; charset=utf-8';
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    return 'application/json; charset=utf-8';
  }

  return existing || 'text/plain; charset=utf-8';
}

function parseBody(event: any): Buffer {
  const raw = event.body ?? '';
  if (event.isBase64Encoded) {
    return Buffer.from(raw, 'base64');
  }
  return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
}

function collectHeaders(event: any): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};

  if (event.headers && typeof event.headers === 'object') {
    for (const [key, value] of Object.entries(event.headers)) {
      if (value !== undefined && value !== null) {
        headers[key.toLowerCase()] = String(value);
      }
    }
  }

  // Inject Content-Length for requests with a body
  const body = parseBody(event);
  if (body.length > 0 && !headers['content-length']) {
    headers['content-length'] = String(body.length);
  }

  return headers;
}

/**
 * Extracts the request path from the Cloud Functions event.
 *
 * Yandex API Gateway with the `cloud_functions` integration passes the
 * OpenAPI path template (e.g. `/{proxy+}`) in `event.path`, while the real
 * request path is available in `event.url`. Prefer concrete paths and skip
 * template placeholders.
 */
function extractRequestPath(event: any): string {
  const candidates = [
    event.url,
    event.rawPath,
    event.requestContext?.http?.path,
    event.requestContext?.path,
    event.path,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    // Skip OpenAPI path templates such as /{proxy+}
    if (candidate.includes('{') || candidate.includes('}')) continue;
    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
      try {
        const parsed = new URL(candidate);
        return parsed.pathname || '/';
      } catch {
        // fall through
      }
    }
    // Strip query string (event.url may end with `?` or `?query`)
    const withoutQuery = candidate.split('?')[0] || '/';
    return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  }
  return '/';
}

function createIncomingMessage(event: any): IncomingMessage {
  const body = parseBody(event);

  const queryString = event.queryStringParameters
    ? new URLSearchParams(
        Object.entries(event.queryStringParameters)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      ).toString()
    : '';

  const path = extractRequestPath(event);
  const url = queryString ? `${path}?${queryString}` : path;

  const req = new IncomingMessage(null as any) as IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string | string[]>;
  };

  req.method = (event.httpMethod || 'GET').toUpperCase();
  req.url = url;
  req.headers = collectHeaders(event);

  // Attach the raw body so the app can parse it
  (req as any).rawBody = body;
  (req as any).body = undefined;

  return req;
}

function createServerResponse(
  requestedPath: string,
  onEnd: (
    statusCode: number,
    headers: Record<string, string>,
    body: Buffer,
    isBase64Encoded: boolean
  ) => void
): ServerResponse {
  const res = new ServerResponse({ method: 'GET', url: '/' } as IncomingMessage) as ServerResponse & {
    statusCode: number;
    statusMessage: string;
    _headers: Record<string, string | string[] | number>;
  };

  res.statusCode = 200;
  res.statusMessage = 'OK';
  res._headers = {};

  const chunks: Buffer[] = [];
  let ended = false;

  res.writeHead = ((statusCode: number, reasonOrHeaders?: string | Record<string, string | string[]>, maybeHeaders?: Record<string, string | string[]>) => {
    if (typeof reasonOrHeaders === 'string') {
      res.statusMessage = reasonOrHeaders;
    } else if (reasonOrHeaders) {
      for (const [k, v] of Object.entries(reasonOrHeaders)) {
        res.setHeader(k, v);
      }
    }
    if (maybeHeaders) {
      for (const [k, v] of Object.entries(maybeHeaders)) {
        res.setHeader(k, v);
      }
    }
    res.statusCode = statusCode;
    return res;
  }) as any;

  res.setHeader = ((name: string, value: string | string[] | number) => {
    res._headers[name.toLowerCase()] = value;
    return res;
  }) as any;

  res.getHeader = ((name: string) => {
    return res._headers[name.toLowerCase()];
  }) as any;

  res.getHeaderNames = (() => {
    return Object.keys(res._headers);
  }) as any;

  res.hasHeader = ((name: string) => {
    return Object.prototype.hasOwnProperty.call(res._headers, name.toLowerCase());
  }) as any;

  res.removeHeader = ((name: string) => {
    delete res._headers[name.toLowerCase()];
  }) as any;

  res.write = ((chunk: any, encoding?: any, callback?: any) => {
    if (chunk === undefined || chunk === null) return true;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || 'utf8');
    chunks.push(buf);
    if (typeof encoding === 'function') callback = encoding;
    if (typeof callback === 'function') callback();
    return true;
  }) as any;

  res.end = ((chunk?: any, encoding?: any, callback?: any) => {
    if (!ended) {
      ended = true;
      if (chunk !== undefined && chunk !== null) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || 'utf8');
        chunks.push(buf);
      }
      const body = Buffer.concat(chunks);

      const headers: Record<string, string> = {};
      for (const name of Object.keys(res._headers)) {
        const value = res._headers[name];
        headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
      }

      // Ensure a correct Content-Type for HTML documents and static assets.
      headers['content-type'] = resolveContentType(headers, body, requestedPath);

      if (!headers['content-length'] && body.length > 0) {
        headers['content-length'] = String(body.length);
      }

      const isBase64Encoded = shouldBase64Encode(requestedPath, body);

      onEnd(res.statusCode, headers, body, isBase64Encoded);
    }
    if (typeof encoding === 'function') callback = encoding;
    if (typeof callback === 'function') callback();
    return res;
  }) as any;

  // No-op overrides for stream/event APIs that are not used by Express routes
  res.flushHeaders = (() => {}) as any;
  res.writeContinue = (() => {}) as any;
  res.setTimeout = (() => res) as any;
  res.pipe = (() => res) as any;
  res.on = (() => res) as any;
  res.once = (() => res) as any;
  res.addListener = (() => res) as any;
  res.removeListener = (() => res) as any;
  res.emit = (() => false) as any;

  return res;
}

let cachedApp: Express | null = null;
let debugLogged = false;

function getApp(): Express {
  if (!cachedApp) {
    cachedApp = createApp({ serverless: true });
  }
  if (!debugLogged) {
    debugLogged = true;
    console.log(
      `[serverless] DIST_PATH=${DIST_PATH}; cwd=${process.cwd()}; ` +
        `hasIndex=${fs.existsSync(path.join(DIST_PATH, 'index.html'))}; ` +
        `assetsExists=${fs.existsSync(path.join(DIST_PATH, 'assets'))}`
    );
  }
  return cachedApp;
}

/**
 * Cloud Functions entrypoint: `index.handler`.
 */
export async function handler(event: any, _context: any): Promise<any> {
  const app = getApp();
  const req = createIncomingMessage(event);
  const requestedPath = extractRequestPath(event);

  console.log(
    `[serverless] REQ method=${event.httpMethod || 'GET'} path=${requestedPath} ` +
      `rawPath=${event.rawPath} url=${event.url} ctxPath=${event.requestContext?.path} ` +
      `httpPath=${event.requestContext?.http?.path}`
  );

  let resolveResponse: (value: any) => void = () => {};
  const responsePromise = new Promise<any>((resolve) => {
    resolveResponse = resolve;
  });

  const res = createServerResponse(requestedPath, (statusCode, headers, body, isBase64Encoded) => {
    resolveResponse({
      statusCode,
      headers,
      body: isBase64Encoded ? body.toString('base64') : body.toString('utf8'),
      isBase64Encoded,
    });
  });

  try {
    // Parse JSON body manually (serverless mode skips express.json())
    const contentType = req.headers['content-type'] ? String(req.headers['content-type']) : '';
    if (contentType.includes('application/json')) {
      const raw = (req as any).rawBody as Buffer | undefined;
      if (raw && raw.length > 0) {
        try {
          (req as any).body = JSON.parse(raw.toString('utf8'));
        } catch {
          (req as any).body = {};
        }
      }
    }

    app(req as any, res as any);
  } catch (err) {
    console.error('[serverless] Unhandled error:', err);
    resolveResponse({
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Internal Server Error' }),
      isBase64Encoded: false,
    });
  }

  // Wait for Express to finish the response (or timeout)
  const timeout = new Promise<any>((resolve) => {
    setTimeout(() => resolve(null), RESPONSE_TIMEOUT_MS);
  });

  const response = await Promise.race([responsePromise, timeout]);

  if (!response) {
    // Express did not finish in time — force a generic error response
    console.error('[serverless] Response timeout exceeded');
    return {
      statusCode: 504,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Gateway Timeout' }),
      isBase64Encoded: false,
    };
  }

  return response;
}