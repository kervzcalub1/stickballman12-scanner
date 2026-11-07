// GET  /api/ebay-sync/products?tab=uploaded|not_uploaded|needs_attention&q=&offset= -> { ok, rows, total, tabs }
// POST /api/ebay-sync/products { productId, action:'verify'|'list'|'relist' } -> { ok, issues?, itemId?, error? }
// verify is always allowed (eBay's own dry run); list / relist only when the Create switch is live.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { requirePrivilege } from '../_lib/buycart.js';
import { dbConfigured } from '../_lib/db.js';
import { ebaySyncProducts, ebaySyncProductTabs } from '../_lib/db.js';
import { productAction } from '../_lib/ebay-sync.js';
import { pageOffset } from '../../src/lib/ebaySync.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  const qs = new URL(req.url, 'http://x').searchParams;
  if (req.method === 'GET') {
    const user = requireRole(req, res, ['ph_team']);
    if (!user) return;
    if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
    if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
    const offset = pageOffset(qs.get('offset'));
    if (offset == null) return send(res, 400, { ok: false, error: 'The offset must be a whole number, 0 or more.' });
    const tab = ['uploaded', 'not_uploaded', 'needs_attention'].includes(qs.get('tab')) ? qs.get('tab') : 'uploaded';
    const { rows, total } = await ebaySyncProducts({ tab, q: String(qs.get('q') || '').slice(0, 80), offset });
    return send(res, 200, { ok: true, rows, total, tabs: await ebaySyncProductTabs() });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'connect_integrations', 'Listing on eBay needs an admin, or the “Connect integrations” privilege.');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const body = await getJsonBody(req);
  const productId = String(body.productId || '');
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) return send(res, 400, { ok: false, error: 'Which product?' });
  if (!['verify', 'list', 'relist'].includes(body.action)) return send(res, 400, { ok: false, error: 'Action must be verify, list or relist.' });
  const out = await productAction(productId, body.action, { by: user.name || user.username || '' });
  return send(res, 200, out);
}
