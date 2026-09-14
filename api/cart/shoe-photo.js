// GET /api/cart/shoe-photo?fileId=…   header: x-api-key: <BUYING_API_KEY>
//
// The shoe photo a buyer took, served to a MACHINE — specifically the Make.com scenario
// that builds the Telegram approval card. Telegram cannot fetch it any other way: every
// file in this app is proxied behind a session and the bucket serves nothing by link, so
// `sendPhoto` has no URL to point at. Make pulls the bytes with this key and uploads them
// to Telegram itself (`send_bydata`).
//
// Key-gated and login-free, the same shape `api/listing/ebay.js` already uses for the
// browser extension. A scenario cannot hold a session: privileges are re-read from the
// database on every call by design, and handing Make somebody's login would make every
// approval look like it came from that person.
//
// ── THE ONE RULE THAT MATTERS ────────────────────────────────────────────────
// It serves `kind = 'shoe'` AND NOTHING ELSE.
//
// A static key plus a numeric id is enumerable — anybody holding the key can walk the
// file table. That is an acceptable trade for photographs of shoes on a shelf; it is not
// acceptable for the other two things in that table. A GIFT CARD IMAGE IS A BEARER
// INSTRUMENT, and a receipt is somebody's financial record. Both live in `buy_cart_files`
// beside these, keyed by the same sequence, one integer away.
//
// So the kind is checked on the ROW, not taken from the query string — a caller must not
// be able to widen what they are allowed to read by asking for it differently.
import { send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCartFileById, dbConfigured } from '../_lib/db.js';
import { getObject } from '../_lib/r2.js';
import { imageForCard } from '../_lib/imgformat.js';

const TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });

  const expected = String(process.env.BUYING_API_KEY || '').trim();
  if (!expected)
    return send(res, 503, { ok: false, error: 'The buying photo API is not configured (BUYING_API_KEY missing on the server).' });
  const given = String(req.headers['x-api-key'] || '').trim();
  // Length-independent compare is overkill for a photo, but the habit is cheap and this
  // key will grow more endpoints.
  if (!given || given !== expected)
    return send(res, 401, { ok: false, error: 'Bad or missing API key.' });

  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const fileId = Number(new URL(req.url, 'http://x').searchParams.get('fileId'));
  if (!Number.isInteger(fileId) || fileId <= 0)
    return send(res, 400, { ok: false, error: 'A valid fileId is required.' });

  try {
    const file = await getBuyCartFileById(fileId);
    // 404 for "not a shoe", not 403: a key-holder learning which ids are gift cards is
    // itself a small leak, and there is nothing they can do with the answer anyway.
    if (!file || file.kind !== 'shoe')
      return send(res, 404, { ok: false, error: 'No shoe photo with that id.' });

    const stored = await getObject(file.r2_key);
    const ext = String(file.r2_key).split('.').pop().toLowerCase();
    // SENT AT CARD SIZE, not at archive size. The stored object is untouched — it is the
    // evidence — but what goes down the wire is capped at 1280px and re-encoded, because
    // one request is routinely ten sizes of one shoe and Telegram resizes to 1280 anyway.
    // Eleven simultaneous 1.4 MB fetches folded a tunnel and cost eleven cards. Fails
    // open: anything it cannot shrink comes back as the original bytes.
    const { bytes, contentType } = await imageForCard(stored);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType || file.content_type || TYPE[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `inline; filename="${String(file.sku || 'shoe').replace(/[^A-Za-z0-9._-]/g, '_')}.${contentType === 'image/jpeg' ? 'jpg' : ext}"`);
    // Not a bearer instrument, but not public either — it names what somebody is buying.
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.end(bytes);
  } catch (e) {
    console.error('[cart/shoe-photo]', e.message);
    return send(res, 500, { ok: false, error: 'Could not fetch that photo.' });
  }
}
