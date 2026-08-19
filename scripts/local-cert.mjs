#!/usr/bin/env node
// A locally-trusted HTTPS certificate for this Mac's LAN address, so a phone can
// open the app over https:// and USE THE CAMERA.
//
//   node scripts/local-cert.mjs            # create/refresh certs/ (idempotent)
//   node scripts/local-cert.mjs --serve    # …and serve the CA for the iPhone to install
//   npm run mobile -- --https              # the thing you actually run
//
// iOS Safari only exposes getUserMedia in a secure context, and it does NOT accept
// a plain http://192.168.x.x LAN URL. The fix is a real certificate for that IP,
// signed by a small CA you create once and trust on the phone once. This is the
// same trick mkcert plays; done here with the openssl that ships with macOS so
// there's nothing to install, and — deliberately — the CA is NEVER added to this
// Mac's system keychain. Only the devices you choose to trust it are affected.
//
// Everything lands in certs/ (git-ignored: *.pem/*.key are already excluded, and
// certs/ is listed too). The private keys never leave this machine; the only file
// that goes to the phone is certs/rootCA.pem, which is public by design.
//
// TWO VALIDITY RULES, both Apple's, both quietly fatal if you get them wrong:
//   • iOS 13+ rejects a TLS server certificate valid for more than 825 days.
//   • The 2020 policy caps server certs at 398 days; user-installed roots are
//     exempt, but there is no upside to betting on the exemption.
// So the leaf gets 397 days. Re-running this script re-issues it from the SAME
// CA, which means the phone keeps working without being touched again.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CERT_DIR = path.join(root, 'certs');
const CA_CERT = path.join(CERT_DIR, 'rootCA.pem');
const CA_KEY = path.join(CERT_DIR, 'rootCA-key.pem');
const LEAF_CERT = path.join(CERT_DIR, 'local.pem');
const LEAF_KEY = path.join(CERT_DIR, 'local-key.pem');
const SANS_FILE = path.join(CERT_DIR, '.sans');       // what the current leaf covers
const CA_NAME = 'Stickballman12 Local Dev CA';

const LEAF_DAYS = 397;   // see the note above — not a number to raise
const CA_DAYS = 3650;
const RENEW_WITHIN_DAYS = 14;

function openssl(args, opts = {}) {
  const r = spawnSync('openssl', args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

// The address the phone dials. Bonjour name first — DHCP can hand this Mac a new
// IP tomorrow, and `.local` keeps working when it does (the cert covers both).
export function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return null;
}
export function bonjourHost() {
  const r = spawnSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' });
  const name = (r.stdout || '').trim();
  return name ? `${name}.local` : null;
}

function sanList() {
  const ip = lanIp();
  const host = bonjourHost();
  return [
    ...(host ? [`DNS:${host}`] : []),
    'DNS:localhost',
    ...(ip ? [`IP:${ip}`] : []),
    'IP:127.0.0.1',
  ];
}

function expiringSoon(certFile) {
  try {
    const out = openssl(['x509', '-enddate', '-noout', '-in', certFile]);
    const end = new Date(out.replace('notAfter=', '').trim());
    return end.getTime() - Date.now() < RENEW_WITHIN_DAYS * 86_400_000;
  } catch { return true; }
}

function makeCa() {
  if (fs.existsSync(CA_CERT) && fs.existsSync(CA_KEY)) return false;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-days', String(CA_DAYS),
    '-keyout', CA_KEY, '-out', CA_CERT,
    '-subj', `/CN=${CA_NAME}/O=Stickballman12 Local Dev`,
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  fs.chmodSync(CA_KEY, 0o600);
  return true;
}

// Re-issue when: no leaf, the SANs changed (new Wi-Fi → new IP), or it's nearly
// expired. Same CA every time, so the phone never has to be re-trusted.
function makeLeaf(sans) {
  const want = sans.join(',');
  const have = fs.existsSync(SANS_FILE) ? fs.readFileSync(SANS_FILE, 'utf8').trim() : '';
  const fresh = fs.existsSync(LEAF_CERT) && fs.existsSync(LEAF_KEY) &&
    have === want && !expiringSoon(LEAF_CERT);
  if (fresh) return false;

  const csr = path.join(CERT_DIR, 'local.csr');
  const ext = path.join(CERT_DIR, 'local.ext');
  fs.writeFileSync(ext, [
    `subjectAltName=${want}`,
    'extendedKeyUsage=serverAuth',          // required since iOS 13
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid,issuer',
  ].join('\n') + '\n');

  openssl(['req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-keyout', LEAF_KEY, '-out', csr,
    '-subj', `/CN=${(sans[0] || 'DNS:localhost').split(':')[1]}`]);
  openssl(['x509', '-req', '-in', csr, '-CA', CA_CERT, '-CAkey', CA_KEY,
    '-CAcreateserial', '-out', LEAF_CERT, '-days', String(LEAF_DAYS),
    '-sha256', '-extfile', ext]);

  fs.chmodSync(LEAF_KEY, 0o600);
  fs.rmSync(csr, { force: true });
  fs.rmSync(ext, { force: true });
  fs.writeFileSync(SANS_FILE, `${want}\n`);
  return true;
}

// Idempotent: call before serving. Returns the paths + what the cert covers.
export function ensureCerts() {
  const sans = sanList();
  const newCa = makeCa();
  const newLeaf = makeLeaf(sans);
  return { cert: LEAF_CERT, key: LEAF_KEY, ca: CA_CERT, sans, newCa, newLeaf,
    ip: lanIp(), host: bonjourHost() };
}

// Hand the CA to the phone. Plain HTTP on purpose — this is the one file that has
// to travel BEFORE the phone trusts anything, so it can't come over the https URL
// it's the prerequisite for.
//
// Getting iOS to actually take it comes down to three things, each of which silently
// fails a different way:
//   • Content-Disposition: attachment sends the file to the Files download manager
//     instead of the profile installer, and a downloaded .pem there is a dead end.
//     Serve it INLINE and Safari asks "allow this website to download a configuration
//     profile?", which is the prompt you want.
//   • The URL needs a certificate extension. `.cer` carrying DER is the form iOS is
//     happiest with; `.crt` (PEM) is served too for anything else on the network.
//   • Landing on a bare IP with no page is indistinguishable from "the server isn't
//     running", so `/` is a real page with one big link rather than a raw download.
export function serveCa(port = 8081, onReady) {
  const pem = fs.readFileSync(CA_CERT);
  // DER is what .cer means; iOS accepts it without argument.
  const der = spawnSync('openssl', ['x509', '-in', CA_CERT, '-outform', 'der'],
    { encoding: 'buffer' }).stdout;
  const page = `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Trust this Mac</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:28px 22px;
background:#0f1116;color:#e7e9ee}h1{font-size:21px;margin:0 0 6px}p{color:#9aa3b2;margin:0 0 18px}
a.btn{display:block;text-align:center;background:#4f7cff;color:#fff;text-decoration:none;
font-weight:700;padding:16px;border-radius:12px;margin:22px 0}ol{padding-left:20px;color:#c8cdd8}
li{margin:8px 0}code{background:#1b1f2a;padding:2px 6px;border-radius:5px;font-size:15px}</style>
<h1>Trust this Mac</h1>
<p>One-time setup so the phone accepts this Mac's local HTTPS — that's what the camera needs.</p>
<a class=btn href="/stickballman12-local-ca.cer">Download the certificate</a>
<ol>
<li>Tap <b>Allow</b> when Safari asks about a configuration profile.</li>
<li><b>Settings</b> → <b>Profile Downloaded</b> → <b>Install</b> (top right).</li>
<li><b>Settings</b> → <b>General</b> → <b>About</b> → <b>Certificate Trust Settings</b> →
turn <b>on</b> full trust for <code>${CA_NAME}</code>.</li>
</ol>
<p>Step 3 is the one everyone misses — without it Safari still refuses the certificate.</p>`;

  const server = http.createServer((req, res) => {
    const path_ = String(req.url || '/').split('?')[0];
    if (path_.endsWith('.cer') || path_.endsWith('.crt')) {
      const isDer = path_.endsWith('.cer') && der && der.length;
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Cache-Control': 'no-store' });
      return res.end(isDer ? der : pem);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page);
  });
  // A port already in use would otherwise throw an unhandled 'error' and take the
  // whole run down — say so and step to the next port instead.
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.warn(`[cert] port ${port} is busy — serving the CA on ${port + 1} instead`);
    server.listen(++port, () => onReady?.(port));
  });
  server.listen(port, () => onReady?.(port));
  return server;
}

export function instructions({ ip, host, httpsPort = 8443, caPort = 8081 }) {
  const target = host || ip;
  return [
    'ON THE IPHONE — once, then never again:',
    `  1. Safari → http://${ip}:${caPort}   (a page with a Download button)`,
    '  2. Tap Allow → Settings → Profile Downloaded → Install (top right)',
    '  3. Settings → General → About → Certificate Trust Settings',
    `     → turn ON full trust for "${CA_NAME}"`,
    '     (step 3 is the one everyone misses — without it Safari still refuses)',
    '',
    'THEN, for this and every future session:',
    `  https://${target}:${httpsPort}`,
    ...(host && ip ? [`  (or https://${ip}:${httpsPort} — the cert covers both)`] : []),
    '',
    'Camera + scanner work there: it is a real secure context.',
  ];
}

// --- standalone -------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = ensureCerts();
  console.log(`[cert] CA:   ${info.newCa ? 'created' : 'reused'}  ${CA_CERT}`);
  console.log(`[cert] leaf: ${info.newLeaf ? 'issued' : 'still valid'}  (${info.sans.join(', ')})`);
  if (process.argv.includes('--serve')) {
    const caPort = await new Promise((r) => { serveCa(8081, r); });
    console.log(`\n${instructions({ ...info, caPort }).join('\n')}\n`);
    console.log('[cert] serving the CA — Ctrl-C when the phone has it.');
  } else {
    console.log('\nRun `npm run mobile -- --https` to serve the app with it.');
  }
}
