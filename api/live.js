// GET /api/live  (any signed-in account)  -> text/event-stream
//
// One long-lived stream per open tab. Each message is `event: change` with
// `data: {"tables":["items","batches"]}` — which tables were written, never what was
// written. The screen that cares re-reads through its own endpoint, with its own
// permissions (docs/context/live-updates.md). `"*"` means "re-read everything": the
// server's listener reconnected and may have missed something.
//
// Closed by the server after STREAM_MAX_MS so the token is re-checked: a stream opened
// by an account that is later signed out or disabled must not stay open for days. The
// client reconnects straight away with whatever token it holds now; a 401 stops it.
import { send, applySecurity, rateLimit, requireAuth } from './_lib/util.js';
import { subscribeChanges, liveStreamCount } from './_lib/live.js';

const HEARTBEAT_MS = 25_000;             // under every proxy's idle cut-off (Railway's is ~60s+)
const STREAM_MAX_MS = 30 * 60 * 1000;
const MAX_STREAMS = 400;                 // a whole team's tabs many times over; a runaway loop is not

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  // Per IP: a whole warehouse can sit behind one address, and every tab opens one stream
  // (and reopens it every 30 minutes). Generous enough for a team, not for a loop.
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (liveStreamCount() >= MAX_STREAMS)
    return send(res, 503, { ok: false, error: 'Too many live connections.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',            // no proxy may hold the stream back to batch it
  });
  res.write('retry: 3000\n\n');

  let open = true;
  const write = (s) => { if (open) { try { res.write(s); } catch { close(); } } };
  const unsubscribe = subscribeChanges((tables) =>
    write(`event: change\ndata: ${JSON.stringify({ tables })}\n\n`));
  const beat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
  const cap = setTimeout(() => close(), STREAM_MAX_MS);

  function close() {
    if (!open) return;
    open = false;
    clearInterval(beat); clearTimeout(cap); unsubscribe();
    try { res.end(); } catch { /* already gone */ }
  }
  req.on('close', close);
  res.on('error', close);
}
