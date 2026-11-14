// GET  /api/ebay-sync/edit?productId=gid://shopify/Product/N -> { ok, saved, shopify, defaults, imageFinder, titleMax }
// POST /api/ebay-sync/edit { productId, title?, description?, pictures?: [url] } -> { ok, issues, saved, checkError }   save, then "Check with eBay"
// POST /api/ebay-sync/edit { productId, clear: true }                          -> { ok, issues, cleared }  back to Shopify's own
// eBay-only edits (docs/context/ebay-sync.md): a title / description / photos that go to eBay instead of Shopify's.
// Shopify is NEVER written. Reading needs the PH team; saving needs an admin or "Connect integrations".
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { requirePrivilege } from '../_lib/buycart.js';
import { dbConfigured } from '../_lib/db.js';
import { ebayEditInfo, saveEbayEdit } from '../_lib/ebay-sync.js';

const PID = /^gid:\/\/shopify\/Product\/\d+$/;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method === 'GET') {
    const user = requireRole(req, res, ['ph_team']);
    if (!user) return;
    if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
    if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
    const productId = String(new URL(req.url, 'http://x').searchParams.get('productId') || '');
    if (!PID.test(productId)) return send(res, 400, { ok: false, error: 'Which product?' });
    try { return send(res, 200, await ebayEditInfo(productId)); } catch (e) {
      console.error('[ebay-sync/edit]', e.message);
      return send(res, 500, { ok: false, error: 'Could not read this shoe.' });
    }
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'connect_integrations', 'Editing for eBay needs an admin, or the “Connect integrations” privilege.');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const body = await getJsonBody(req);
  const productId = String(body.productId || '');
  if (!PID.test(productId)) return send(res, 400, { ok: false, error: 'Which product?' });
  const input = body.clear === true ? { clear: true } : {
    title: typeof body.title === 'string' ? body.title : null,
    description: typeof body.description === 'string' ? body.description : null,
    pictures: Array.isArray(body.pictures) ? body.pictures.filter((u) => typeof u === 'string').slice(0, 50) : null,
  };
  try {
    const out = await saveEbayEdit(productId, input, { by: user.name || user.username || '' });
    return send(res, out.ok === false ? 400 : 200, out);
  } catch (e) {
    console.error('[ebay-sync/edit]', e.message);
    return send(res, 500, { ok: false, error: 'That did not save.' });
  }
}
