// GET /api/receipts/mail-probe   (admin only)
//   -> 200 { ok, at, results: [{ provider, host, port, ok, ms, greeting?, capabilities?, error? }] }
//
// Phase 0 of fetching receipt mail ourselves, without Make (docs/context/receipts.md → "Reading
// the mailboxes ourselves"). One question: can THIS server open an IMAP connection (TLS, port
// 993) to each mail provider? Some hosts block mail ports going out, and the whole plan rests
// on this one being open — so it is asked from production before anything else is built.
//
// It logs in to nothing and sends no credentials: connect, read the server's greeting, ask what
// it supports (CAPABILITY), say goodbye. The hosts are a fixed list — the caller cannot name
// one, so this is not a way to make the server connect somewhere of somebody's choosing.
import tls from 'node:tls';
import { send, applySecurity, rateLimit, requireAdmin } from '../_lib/util.js';

const HOSTS = [
  { provider: 'Gmail', host: 'imap.gmail.com' },
  { provider: 'Yahoo', host: 'imap.mail.yahoo.com' },
  { provider: 'iCloud', host: 'imap.mail.me.com' },
  { provider: 'AOL', host: 'imap.aol.com' },
  { provider: 'Outlook', host: 'outlook.office365.com' },
];
const PORT = 993;
const TIMEOUT_MS = 10_000;

function probe({ provider, host }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = { provider, host, port: PORT, ok: false, ms: 0 };
    let buf = '';
    let step = 0; // 0 = waiting for the greeting, 1 = waiting for the CAPABILITY answer
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      out.ms = Date.now() - t0;
      if (error) out.error = String(error).slice(0, 200);
      try { socket.destroy(); } catch { /* closed */ }
      resolve(out);
    };
    const socket = tls.connect({ host, port: PORT, servername: host, timeout: TIMEOUT_MS });
    const timer = setTimeout(() => finish(`No answer in ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS + 500);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('timeout', () => finish(`No answer in ${TIMEOUT_MS / 1000} s`));
    socket.on('error', (e) => finish(e.code ? `${e.code}: ${e.message}` : e.message));
    socket.on('close', () => finish(out.ok ? null : 'Connection closed before the server answered'));
    socket.on('data', (chunk) => {
      buf += chunk;
      if (step === 0 && /\r?\n/.test(buf)) {
        const line = buf.split(/\r?\n/)[0];
        out.greeting = line.slice(0, 160);
        if (!/^\* (OK|PREAUTH)/i.test(line)) return finish('The server did not greet us as an IMAP server');
        out.ok = true; // connected and greeted: the port is open
        step = 1;
        buf = '';
        socket.write('a1 CAPABILITY\r\n');
      } else if (step === 1 && /^a1 /im.test(buf)) {
        const caps = /^\* CAPABILITY (.+)$/im.exec(buf);
        if (caps) out.capabilities = caps[1].trim().split(/\s+/).slice(0, 40);
        socket.write('a2 LOGOUT\r\n');
        clearTimeout(timer);
        finish(null);
      }
    });
  });
}

/** Every provider at once. Exported so it can be run from a script too. */
export const probeMailHosts = () => Promise.all(HOSTS.map(probe));

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAdmin(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 6 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  const results = await probeMailHosts();
  return send(res, 200, { ok: results.every((r) => r.ok), at: new Date().toISOString(), results });
}
