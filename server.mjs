// Production-style server (not Vercel). Serves the built SPA from dist/ and
// mounts every api/**/*.js serverless-style handler at its path — the same
// (req, res) contract the Vite dev middleware uses, so handlers run unchanged
// here and (later) on any real host.
//
//   npm run build && npm start      # or: npm run serve
//
// Env comes from the process (a real host) or a local .env file.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env into process.env (only keys not already set by the host).
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const apiDir = path.join(__dirname, 'api');
const distDir = path.join(__dirname, 'dist');

const app = express();
app.disable('x-powered-by');

// Origin (scheme + host, no path) of the public R2 bucket the SOP tutorials stream from.
// Derived from the same env var the uploader writes into videos.json, so the CSP can never
// drift from where the videos actually live. Empty/unset simply omits it.
const r2MediaOrigin = (() => {
  try { return new URL(process.env.R2_PUBLIC_BASE_URL).origin; } catch { return ''; }
})();

// Security headers on every response (the Express host replaces Vercel's
// vercel.json headers). CSP allows: same-origin everything; images over https;
// blob workers + https fetch for the lazy Tesseract OCR fallback; camera for
// barcode scanning. HSTS only bites over HTTPS (harmless on plain http).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' https: data: blob:",
    "script-src 'self' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https:",
    // SOP tutorials stream from the R2 public bucket, so media must allow that origin —
    // without it the <video> is blocked by CSP, SopVideo's onError guard fires, and the
    // player renders NOTHING, which is indistinguishable from "no video was ever added".
    // Scoped to the configured host rather than a blanket `https:` (which is what img-src
    // uses) because media is the one thing here that comes from exactly one known origin.
    `media-src 'self' blob:${r2MediaOrigin ? ` ${r2MediaOrigin}` : ''}`,
    // Label printing builds the PDF in the browser and prints it from a hidden
    // `blob:` iframe (lib/labelPdf.js). `frame-src` falls back to `default-src`
    // when unset, so without this the frame is blocked, `.print()` throws a
    // SecurityError, and the Print button silently does NOTHING on desktop —
    // which reads as "stuck on the preview". `frame-ancestors 'none'` still
    // stops anyone embedding US; this only governs what WE embed.
    "frame-src 'self' blob:",
    "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'",
  ].join('; '));
  next();
});

app.use(express.json({ limit: '256kb' })); // handlers also fall back to raw-stream parsing

// Resolve a request path to an api handler file, guarding against traversal so a
// crafted path can never escape the api/ directory.
function resolveHandler(reqPath) {
  const route = reqPath.replace(/\/+$/, '').replace(/^\/api\//, '');
  if (!/^[A-Za-z0-9/_-]+$/.test(route)) return null;
  const file = path.join(apiDir, `${route}.js`);
  if (!file.startsWith(apiDir + path.sep)) return null;
  return fs.existsSync(file) ? file : null;
}

// RegExp route (Express 5 dropped bare "*" string wildcards).
app.all(/^\/api\//, async (req, res) => {
  const file = resolveHandler(req.path);
  if (!file) return res.status(404).json({ ok: false, error: 'Not found.' });
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.default !== 'function') return res.status(404).json({ ok: false, error: 'Not found.' });
    req.url = req.originalUrl; // handlers read query off req.url
    await mod.default(req, res);
  } catch (err) {
    console.error(`[api] ${req.path}:`, err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// Static SPA + history fallback (final middleware serves index.html).
app.use(express.static(distDir));
// A build asset that no longer exists must 404 — NOT get handed the HTML shell.
// Vite's lazy chunks are content-hashed and every deploy renames them, so a tab
// left open across a deploy imports a filename we no longer have. Falling back
// to index.html answered that import with `200 text/html`, and the browser
// rejected it as "'text/html' is not a valid JavaScript MIME type" — an error
// about MIME types that is really an error about a stale tab, reported from the
// warehouse as "labels won't print". A 404 says what actually happened, and the
// client turns it into a "reload the page" prompt (src/lib/labelPdf.js).
// Only /assets/ is treated this way: app ROUTES have no extension and must keep
// falling through to index.html for client-side routing to work.
app.use('/assets', (req, res) => res.status(404).type('text/plain').send('Not found'));
app.use((req, res) => res.sendFile(path.join(distDir, 'index.html')));

// --- Server start: HTTPS when TLS certs are provided, else plain HTTP --------
// Set TLS_CERT + TLS_KEY (paths to PEM files; optional TLS_CA for the chain) to
// terminate TLS in Node. When set, the app is served over HTTPS on HTTPS_PORT
// (default 443) and a tiny HTTP listener on PORT (default 80) 301-redirects all
// traffic to HTTPS. When unset — e.g. TLS is handled by a reverse proxy
// (Caddy/nginx/Cloudflare) or in local dev — the app runs over plain HTTP on
// PORT (default 3000), exactly as before. HSTS is already sent on every
// response, so it takes effect as soon as the app is reached over HTTPS.
const certPath = process.env.TLS_CERT;
const keyPath = process.env.TLS_KEY;

if (certPath && keyPath) {
  let creds;
  try {
    creds = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      ...(process.env.TLS_CA ? { ca: fs.readFileSync(process.env.TLS_CA) } : {}),
    };
  } catch (e) {
    console.error(`[tls] Could not read TLS_CERT/TLS_KEY: ${e.message}`);
    process.exit(1);
  }
  const httpsPort = Number(process.env.HTTPS_PORT) || 443;
  const httpPort = Number(process.env.PORT) || 80;

  https.createServer(creds, app).listen(httpsPort, () =>
    console.log(`Stickballman12 listening on https://localhost:${httpsPort}`));

  // Redirect every plain-HTTP request to HTTPS (preserve host + path).
  http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    const suffix = httpsPort === 443 ? '' : `:${httpsPort}`;
    res.writeHead(301, { Location: `https://${host}${suffix}${req.url}` });
    res.end();
  }).listen(httpPort, () => console.log(`HTTP→HTTPS redirect on :${httpPort}`));
} else {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Stickballman12 listening on http://localhost:${port}`));
}
