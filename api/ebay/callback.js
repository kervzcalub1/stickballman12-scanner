// GET /api/ebay/callback?code=…&state=…   eBay sends the owner's browser here after they
// approve (the RuName's "auth accepted" URL). No app login on this request — it's a plain
// redirect from eBay — so the one-time `state` nonce from /api/ebay/connect is the proof.
// Always ends by sending the browser back to the eBay Listings page with the outcome.
import { applySecurity, rateLimit } from '../_lib/util.js';
import { finishConnect } from '../_lib/ebay.js';

const back = (res, q) => { res.statusCode = 302; res.setHeader('Location', `/ph/ebay-listings?${q}`); res.end(); };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!rateLimit(req, { windowMs: 60_000, max: 10 })) return back(res, 'ebay_error=' + encodeURIComponent('Too many attempts — wait a minute.'));
  const qs = new URL(req.url, 'http://x').searchParams;
  // The owner pressed "No thanks" on eBay, or eBay refused.
  if (qs.get('error')) return back(res, 'ebay_error=' + encodeURIComponent(`eBay: ${qs.get('error_description') || qs.get('error')}`));
  try {
    const { user } = await finishConnect({ code: qs.get('code'), state: qs.get('state') });
    return back(res, 'ebay=connected' + (user ? `&ebay_user=${encodeURIComponent(user)}` : ''));
  } catch (e) {
    console.error('[ebay/callback]', e.message);
    return back(res, 'ebay_error=' + encodeURIComponent(e.message));
  }
}
