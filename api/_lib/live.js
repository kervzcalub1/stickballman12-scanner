// Live updates — the server half (docs/context/live-updates.md).
//
// Postgres announces every write on channel `sb_change` with the TABLE NAME as the
// payload (the sb_live triggers in scripts/db-setup.mjs). This module holds ONE dedicated
// connection that LISTENs, folds a burst of notices into one message every 250 ms, and
// hands it to every open /api/live stream. It carries table names and nothing else —
// each screen re-reads through its own authorised endpoint, so the stream can never show
// anybody something their own call would not.
//
// Dedicated, not from the pool: LISTEN belongs to one session, and a pooled client goes
// back to be reused by somebody else's query. It has to stay ours for the process's life.
import pg from 'pg';

const CHANNEL = 'sb_change';
const COALESCE_MS = 250;
const RETRY_MS = 3000;

const subscribers = new Set();
let client = null;
let connecting = false;
let pending = new Set();
let timer = null;
let everListened = false;

function flush() {
  timer = null;
  const tables = [...pending];
  pending = new Set();
  if (!tables.length) return;
  for (const fn of subscribers) { try { fn(tables); } catch { /* one dead stream never stops the rest */ } }
}

function queue(table) {
  pending.add(table);
  if (!timer) timer = setTimeout(flush, COALESCE_MS);
}

async function connect() {
  if (client || connecting || !process.env.DATABASE_URL) return;
  connecting = true;
  const url = process.env.DATABASE_URL;
  const c = new pg.Client({
    connectionString: url,
    // Same TLS rule as the pool in db.js and scripts/db-setup.mjs.
    ssl: /\bsslmode=require\b|\.neon\.tech|\brlwy\.net\b|\.railway\.app\b/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  const lost = (why) => {
    if (client !== c) return;
    client = null;
    console.warn(`[live] listener lost (${why}) — reconnecting in ${RETRY_MS / 1000}s`);
    c.end().catch(() => {});
    setTimeout(connect, RETRY_MS);
  };
  try {
    await c.connect();
    c.on('notification', (m) => { if (m.channel === CHANNEL && m.payload) queue(m.payload); });
    c.on('error', (e) => lost(e.message));
    c.on('end', () => lost('connection ended'));
    await c.query(`LISTEN ${CHANNEL}`);
    const recovered = everListened;
    everListened = true;
    client = c;
    // Anything written while we were deaf was never announced. Tell every open screen to
    // re-read everything once, rather than let it sit on stale data until the next change.
    if (recovered) queue('*');
  } catch (e) {
    console.warn(`[live] could not listen (${e.message}) — retrying in ${RETRY_MS / 1000}s`);
    c.end().catch(() => {});
    setTimeout(connect, RETRY_MS);
  } finally {
    connecting = false;
  }
}

/** Receive batches of changed table names. Returns the unsubscribe. */
export function subscribeChanges(fn) {
  subscribers.add(fn);
  connect();
  return () => subscribers.delete(fn);
}

export const liveStreamCount = () => subscribers.size;
