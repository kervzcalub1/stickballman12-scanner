#!/usr/bin/env node
// Serve the app to a real phone.
//
//   npm run mobile            # this Wi-Fi only:  http://<lan-ip>:3000
//   npm run mobile:https      # this Wi-Fi, HTTPS: https://<lan-ip>:8443  ← camera works
//   npm run mobile -- --watch # …and rebuild dist/ on every source change
//   npm run mobile:tunnel     # HTTPS from anywhere: https://<random>.trycloudflare.com
//
// Why this exists as a script instead of "just run the dev server with --host":
// `vite.config.js` binds the DEV server to localhost ON PURPOSE — it can serve
// project source via path traversal, so it must never listen on a LAN interface.
// This script therefore builds to dist/ and serves through `server.mjs`, which has
// the traversal guard and the production security headers. Same code the phone
// would get from Railway.
//
// THE CAMERA CAVEAT: `getUserMedia` only runs in a secure context. iOS Safari
// counts https:// and localhost as secure — a plain http://192.168.x.x LAN URL is
// NOT, so the barcode scanner and the photo camera are dead there while the rest
// of the app works fine. Layout, tap targets and flows: plain LAN is enough. For
// an actual scan on an actual phone, two ways to get a secure context:
//
//   --https   a real certificate for THIS Mac's LAN address, signed by a CA you
//             trust on the phone once (scripts/local-cert.mjs). Stays on your
//             Wi-Fi, nothing is published, and the URL is stable. Costs one round
//             of tapping through iOS Settings the first time.
//   --tunnel  Cloudflare's cert on a public URL. Zero phone setup, works off
//             Wi-Fi, but see the exposure warning below.
//
// --tunnel PUBLISHES this machine's app on a public URL for as long as the
// command runs (Cloudflare quick tunnel, random hostname, gone on Ctrl-C). It is
// pointed at YOUR LOCAL DATABASE. Everything behind a login stays behind that
// login, but the endpoints that are public by design (/api/track, /api/get-price)
// are public there too. Don't leave it running unattended.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCerts, serveCa, instructions } from './local-cert.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const TUNNEL = has('--tunnel');
const HTTPS = has('--https');
const WATCH = has('--watch');
const BUILD = !has('--no-build');
const VERBOSE = has('--verbose');
const PORT = Number((argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) ||
  Number(process.env.PORT) || (HTTPS ? 8080 : 3000);
// server.mjs serves TLS on HTTPS_PORT and 301s plain HTTP on PORT. Its defaults are
// 443/80, which need root — on a dev machine both move above 1024.
const HTTPS_PORT = Number((argv.find((a) => a.startsWith('--https-port=')) || '').split('=')[1]) ||
  Number(process.env.HTTPS_PORT) || 8443;
const CA_PORT = 8081;

// First non-internal IPv4 — the address the phone has to dial on this Wi-Fi.
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

const children = [];
function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: root, ...opts });
  children.push(child);
  child.on('error', (e) => {
    console.error(`\n[mobile] could not start ${cmd}: ${e.message}`);
    if (cmd === 'cloudflared') console.error('[mobile] install it with:  brew install cloudflared');
    shutdown(1);
  });
  return child;
}
let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
  setTimeout(() => process.exit(code), 300).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 1. Build (once, or watching). `vite build --watch` rewrites dist/ on save and
//    express.static reads from disk per request, so a phone refresh picks the
//    change up — no restart, just pull-to-refresh.
async function build() {
  if (!BUILD) return;
  if (WATCH) {
    console.log('[mobile] building dist/ (watching for changes)…');
    const w = run('npx', ['vite', 'build', '--watch'], { stdio: VERBOSE ? 'inherit' : 'ignore' });
    w.on('exit', (c) => { if (!closing && c) shutdown(c); });
    // Wait for the first build to land before serving a stale/absent dist/.
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      const idx = path.join(root, 'dist', 'index.html');
      if (fs.existsSync(idx) && fs.statSync(idx).mtimeMs > started - 1000) return;
      await new Promise((r) => setTimeout(r, 400));
    }
    return;
  }
  console.log('[mobile] building dist/…');
  await new Promise((resolve, reject) => {
    const b = run('npx', ['vite', 'build'], { stdio: VERBOSE ? 'inherit' : 'ignore' });
    b.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`vite build exited ${c}`))));
  });
}

// 2. The real server (dist/ + /api, production headers + traversal guard).
function serve(tls) {
  const s = run('node', ['server.mjs'], {
    stdio: VERBOSE ? 'inherit' : ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      PORT: String(PORT),
      ...(tls ? { TLS_CERT: tls.cert, TLS_KEY: tls.key, HTTPS_PORT: String(HTTPS_PORT) } : {}),
    },
  });
  s.on('exit', (c) => { if (!closing) { console.error(`[mobile] server exited (${c})`); shutdown(c || 1); } });
}

// 3. Optional public HTTPS URL. cloudflared prints the hostname on stderr; we
//    surface just that line and stay quiet about the rest unless --verbose.
function tunnel() {
  return new Promise((resolve) => {
    const t = run('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    const scan = (buf) => {
      const text = String(buf);
      if (VERBOSE) process.stderr.write(text);
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !done) { done = true; resolve(m[0]); }
    };
    t.stdout.on('data', scan);
    t.stderr.on('data', scan);
    t.on('exit', (c) => { if (!closing && !done) { console.error(`[mobile] cloudflared exited (${c})`); shutdown(c || 1); } });
  });
}

function banner(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  console.log(`\n┌${'─'.repeat(width + 2)}┐`);
  for (const l of lines) console.log(`│ ${l.padEnd(width)} │`);
  console.log(`└${'─'.repeat(width + 2)}┘\n`);
}

await build();

// --https: issue (or reuse) a certificate for this Mac's LAN address before the
// server starts, and keep the CA reachable over plain HTTP so a phone that hasn't
// been set up yet can still fetch it — the one file that must travel before the
// device trusts anything.
let tls = null;
if (HTTPS) {
  try {
    tls = ensureCerts();
    console.log(`[mobile] certificate covers: ${tls.sans.join(', ')}`);
  } catch (e) {
    console.error(`[mobile] could not create the certificate: ${e.message}`);
    console.error('[mobile] fall back to: npm run mobile:tunnel');
    shutdown(1);
  }
}
// The CA has to stay reachable for as long as the phone might need it — and on its
// own plain-HTTP port, since it's the prerequisite for the HTTPS one.
const caPort = HTTPS ? await new Promise((r) => { serveCa(CA_PORT, r); }) : CA_PORT;

serve(tls);
// Give the listener a moment so the first tap doesn't hit a closed port.
await new Promise((r) => setTimeout(r, 800));

if (HTTPS) {
  const target = tls.host || tls.ip;
  banner([
    ...(tls.newCa ? [] : ['Already trusted this phone? Just open:', `  https://${target}:${HTTPS_PORT}`, '']),
    ...instructions({ ip: tls.ip, host: tls.host, httpsPort: HTTPS_PORT, caPort }),
    '',
    `Plain http://${tls.ip}:${PORT} redirects here. Nothing is published to the internet.`,
  ]);
} else if (TUNNEL) {
  console.log('[mobile] opening a Cloudflare quick tunnel…');
  const url = await tunnel();
  banner([
    'On your iPhone, open:',
    url,
    '',
    'HTTPS — the barcode scanner and photo camera work here.',
    'PUBLIC while this runs. Ctrl-C kills the tunnel and the URL.',
  ]);
} else {
  const ip = lanIp();
  banner([
    'On your iPhone (same Wi-Fi as this Mac), open:',
    ip ? `http://${ip}:${PORT}` : `(no LAN address found — try npm run mobile:tunnel)`,
    '',
    'Plain HTTP: layout/flows work, the CAMERA DOES NOT (iOS needs',
    'a secure context). For scanning on-device: npm run mobile:https',
  ]);
}
console.log('[mobile] Ctrl-C to stop.' + (WATCH ? ' Watching src/ — refresh the phone after a save.' : ''));
