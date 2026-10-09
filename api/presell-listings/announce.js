// POST /api/presell-listings/announce { stockIds, since } -> { ok, sent }
// After a listing run (one paste can be several create calls), ONE post to the pre-sell
// Telegram group saying what just went up (Alex, 2026-10-10): each shoe, sizes × pairs,
// Alias / StockX prices, and whether it's IN TRANSIT or a plain PRE-SELL. Built from our
// own rows — only listings that actually went through, created since the run started.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, presellAnnounceRows } from '../_lib/db.js';
import { sendPresellSale } from '../_lib/telegram.js';

const usd = (c) => `$${Math.round(Number(c) / 100).toLocaleString('en-US')}`;
const range = (a, b) => (a === b ? usd(a) : `${usd(a)}–${usd(b)}`);

// Rows (one per stock × platform) → message lines. Exported for the tests.
export function announceLines(rows, by) {
  const shoes = new Map();
  for (const r of rows) {
    const k = r.sku;
    if (!shoes.has(k)) shoes.set(k, { sku: r.sku, name: r.name, sizes: new Map(), transit: false, note: null, expected: null });
    const s = shoes.get(k);
    if (r.in_transit && !r.arrived_at) { s.transit = true; s.note = s.note || r.transit_note; s.expected = s.expected || r.expected_on; }
    if (!s.sizes.has(r.size)) s.sizes.set(r.size, {});
    s.sizes.get(r.size)[r.platform] = r;
  }
  const all = [...shoes.values()];
  const transit = all.some((s) => s.transit);
  const pairs = (sz) => Math.max(...Object.values(sz).map((x) => x.n));
  const total = all.reduce((n, s) => n + [...s.sizes.values()].reduce((k, sz) => k + pairs(sz), 0), 0);
  const lines = [transit ? '🚚 LISTED — IN-TRANSIT PRE-SELL' : '📝 LISTED — PRE-SELL', `${total} pair${total === 1 ? '' : 's'}${by ? ` · by ${by}` : ''}`];
  for (const s of all) {
    lines.push({ b: `${s.sku}${s.name ? ` · ${s.name}` : ''}` });
    if (s.transit && (s.note || s.expected)) lines.push(`Shipment: ${s.note || 'in transit'}${s.expected ? ` · expected ${String(s.expected).slice(0, 10)}` : ''}`);
    lines.push([...s.sizes.entries()].map(([size, sz]) => `${size} × ${pairs(sz)}`).join(' · '));
    for (const p of ['alias', 'stockx']) {
      const rs = [...s.sizes.values()].map((sz) => sz[p]).filter(Boolean);
      if (!rs.length) continue;
      const n = rs.reduce((k, r) => k + r.n, 0);
      const live = rs.reduce((k, r) => k + r.live, 0);
      lines.push(`${p === 'alias' ? 'Alias' : 'StockX'}: ${n} listing${n === 1 ? '' : 's'} at ${range(Math.min(...rs.map((r) => r.min_cents)), Math.max(...rs.map((r) => r.max_cents)))}${live < n ? ` (${n - live} not live yet)` : ''}`);
    }
  }
  return lines;
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);   // admin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const since = Date.parse(b.since);
  if (!Array.isArray(b.stockIds) || !b.stockIds.length || !Number.isFinite(since) || Date.now() - since > 6 * 3600_000)
    return send(res, 400, { ok: false, error: 'Nothing to announce.' });
  const rows = await presellAnnounceRows(b.stockIds.slice(0, 500), new Date(since).toISOString());
  if (!rows.length) return send(res, 200, { ok: true, sent: false, reason: 'nothing went through' });
  try {
    await sendPresellSale(announceLines(rows, user.name || user.username || ''));
    return send(res, 200, { ok: true, sent: true });
  } catch (e) {
    console.error('[presell-listings/announce]', e.message);
    return send(res, 200, { ok: true, sent: false, reason: e.message });
  }
}
