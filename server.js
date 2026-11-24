'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers));
  res.end(body);
}

// Health endpoint. /healthz is the canonical path, but the hosting ingress reserves
// GET /healthz, so the same payload is also served on non-reserved aliases.
const HEALTH_PATHS = new Set(['/healthz', '/health', '/api/health']);

function pathnameOf(rawUrl) {
  try {
    const pathname = new URL(rawUrl, 'http://localhost').pathname.replace(/\/+$/, '');
    return pathname === '' ? '/' : pathname;
  } catch (err) {
    return '/';
  }
}

function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  // Prevent path traversal outside the public directory.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return null;
  }
  return target;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }

  const pathname = pathnameOf(req.url || '/');

  if (HEALTH_PATHS.has(pathname)) {
    send(res, 200, JSON.stringify({ status: 'ok' }), { 'Content-Type': 'application/json' });
    return;
  }

  const filePath = resolveFile(pathname);
  if (!filePath) {
    send(res, 400, 'Bad Request');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        send(res, 404, 'Not Found');
      } else {
        send(res, 500, 'Internal Server Error');
      }
      return;
    }
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=300'
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(data);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Sai Health Hub listening on http://${HOST}:${PORT}`);
});
