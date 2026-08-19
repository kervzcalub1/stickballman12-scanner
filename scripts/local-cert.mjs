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
// it's the prerequisite for. The MIME type is what makes iOS offer to install it.
export function serveCa(port = 8081) {
  const body = fs.readFileSync(CA_CERT);
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="stickballman12-local-ca.pem"',
    });
    res.end(body);
  });
  server.listen(port);
  return server;
}

export function instructions({ ip, host, httpsPort = 8443, caPort = 8081 }) {
  const target = host || ip;
  return [
    'ON THE IPHONE — once, then never again:',
    `  1. Safari → http://${ip}:${caPort}      (downloads the CA profile)`,
    '  2. Settings → Profile Downloaded → Install (top right), enter passcode',
    '  3. Settings → General → About → Certificate Trust Settings',
    `     → turn ON full trust for "${CA_NAME}"`,
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
    const caPort = 8081;
    serveCa(caPort);
    console.log(`\n${instructions({ ...info, caPort }).join('\n')}\n`);
    console.log('[cert] serving the CA — Ctrl-C when the phone has it.');
  } else {
    console.log('\nRun `npm run mobile -- --https` to serve the app with it.');
  }
}
