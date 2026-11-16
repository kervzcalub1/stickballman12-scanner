// "Rejected by SHEIN" (2026-11-17; docs/context/shein-listings.md → "Rejected by SHEIN"). Pure: the rows
// GET /api/shein/listings?rejected=1 returns, put together from OUR send records (db.js rejectedListingData):
// one row per Shopify shoe whose latest send of some kind (publish, add sizes, photos, …) SHEIN rejected
// (review_rejected) or refused at its pre-check (shein_prevalid), or whose sizes still carry such an answer
// as their last error. SHEIN's own words, when, which job, how many sizes, and `next` = the one action that
// resubmits it and who may press it. Nothing here changes how an error expires or is cleared (the engine's
// variantReadiness owns that) — it only shows what is stored.
import { isPhotoRejection, OP_LABEL } from './sheinListings.js';

export const REJECT_CODES = ['review_rejected', 'shein_prevalid'];
// The order a shoe's rejections are judged in when it has several (the first decides `next`).
const OP_RANK = ['publish', 'photos', 'add_sku', 'model', 'edit', 'price', null];
export const REJECTED_WHAT = { publish: 'publish', add_sku: 'add_sizes', photos: 'photos', edit: 'edit', price: 'price', model: 'model', null: 'sizes' };
export const PRIV = 'admin_or_connect_integrations';

const rejectionOf = (blockers) => (blockers || []).find((b) => REJECT_CODES.includes(b?.code)) || null;
// SHEIN's own words from a stored blocker (review_rejected → failedReason; pre-check → sheinMessage + module)
export function sheinReason(b, fallback = null) {
  const p = b?.params || {};
  return { code: b?.code || null, reason: p.failedReason || p.sheinMessage || fallback || null, module: p.module || null, traceId: p.traceId || null };
}
const time = (v) => (v ? new Date(v).getTime() : 0);
const iso = (v) => (v ? new Date(v).toISOString() : null);

// What resubmits ONE rejection, and who may press it. `canWrite` = admin or Connect integrations (the caller).
//   publish_again   POST {action:'publish_again', productIds:[id]} (admin / Connect integrations) — allows a NEW publish;
//                   then POST {action:'preview', productIds:[id], ops:['publish']} and Confirm on the sheet
//   preview_publish the same preview, when Publish again was already pressed after this rejection (PH ok)
//   preview_photos  POST {action:'preview', productIds:[id], ops:['photos']} — after fixing the photos (Choose photos)
//   preview_add_sizes POST {action:'preview', productIds:[id]} (Add missing sizes; it re-tries sizes SHEIN rejected)
//   preview_update  POST {action:'preview', productIds:[id], ops:['price','edit']}
//   preview_model   POST {action:'preview', productIds:[id], ops:['model']}
// Every preview is PH ok and reads only; its Confirm (the send) needs an admin / Connect integrations.
export function nextFor(r, { product, neverLive, photosFixedAt = 0, canWrite = false } = {}) {
  const off = product?.status === 'excluded' || String(product?.shopify_status || '').toUpperCase() !== 'ACTIVE';
  if (off) {
    const why = product?.excluded ? 'Marked “Don’t list on SHEIN” — list it again first.' : 'Not active on Shopify — nothing is sent to SHEIN.';
    return { action: null, label: null, who: null, canPress: false, ops: null, fixFirst: null, say: why };
  }
  const photo = isPhotoRejection(r.reason);
  const preview = (action, label, ops, say, fixFirst = null) => ({ action, label, who: 'ph_team', confirmNeeds: PRIV, canPress: true, ops, fixFirst, say });
  if (r.op === 'publish' || (r.op == null && neverLive)) {
    const pressed = time(product?.publish_again_at) > time(r.at);
    const fix = photo ? 'Fix the photos first (Choose photos — leave the branded ones out, or use the clean photos). ' : 'Fix what SHEIN said in the shoe’s Details first. ';
    if (pressed) return preview('preview_publish', 'Preview the publish', ['publish'], `${fix}Publish again was pressed${product?.publish_again_by ? ` by ${product.publish_again_by}` : ''} — preview the publish, then an admin confirms it.`, photo ? 'photos' : null);
    return { action: 'publish_again', label: 'Publish again', who: PRIV, confirmNeeds: PRIV, canPress: !!canWrite, ops: ['publish'], fixFirst: photo ? 'photos' : null,
      say: `${fix}Then an admin (or Connect integrations) presses Publish again — SHEIN gets it as a NEW product — and confirms its preview.` };
  }
  if (r.op === 'photos') return preview('preview_photos', 'Replace SHEIN photos', ['photos'], 'Fix the photos (Choose photos), preview Replace SHEIN photos, then an admin confirms it.', 'photos');
  if (r.op === 'model') return preview('preview_model', 'Send the Product Model', ['model'], 'Check the Product Model in the shoe’s SHEIN details, preview the fix again, then an admin confirms it.');
  if (r.op === 'edit' || r.op === 'price') return preview('preview_update', 'Update prices & sizes', ['price', 'edit'], 'Fix what SHEIN said, preview Update prices & sizes again, then an admin confirms it.');
  // add sizes (or a size's last error with no send found): a photo rejection is fixed on the shoe's photos first
  if (photo && !(photosFixedAt > time(r.at))) {
    return preview('preview_photos', 'Fix photos', ['photos'], 'SHEIN rejected the shoe’s photos: fix them (Choose photos), Replace SHEIN photos (an admin confirms), then preview Add missing sizes again.', 'photos');
  }
  return preview('preview_add_sizes', 'Add missing sizes', null, photo ? 'The new photos are on SHEIN — preview Add missing sizes again (it re-tries the sizes SHEIN rejected), then an admin confirms it.'
    : 'Fix what SHEIN said, preview Add missing sizes again (it re-tries the sizes SHEIN rejected), then an admin confirms it.');
}

// → rows, newest rejection first. includeOff = also shoes that are off (not active on Shopify / "Don't list").
export function rejectedList({ latest = [], failed = [], products = [], variants = [], canWrite = false, includeOff = false, shopifyUrl = () => null } = {}) {
  const vBy = new Map(); for (const v of variants) { const a = vBy.get(v.shopify_product_id) || []; a.push(v); vBy.set(v.shopify_product_id, a); }
  const latestBy = new Map(); for (const i of latest) { const a = latestBy.get(i.shopify_product_id) || []; a.push(i); latestBy.set(i.shopify_product_id, a); }
  const out = [];
  for (const p of products) {
    const vs = vBy.get(p.shopify_product_id) || [];
    const neverLive = !vs.some((v) => v.shein_sku);
    const items = latestBy.get(p.shopify_product_id) || [];
    const photosFixedAt = Math.max(0, ...items.filter((i) => i.op === 'photos' && i.status === 'done').map((i) => time(i.updated_at)));
    const rejections = [];
    const covered = new Set();
    for (const i of items) {
      const b = i.status === 'failed' ? rejectionOf(i.blockers) : null;
      if (!b) continue;
      // a rejected PUBLISH only matters while the shoe is not on SHEIN — once it is live (another SHEIN product
      // carries its SKUs) there is nothing to publish again
      if (i.op === 'publish' && !neverLive) continue;
      const s = sheinReason(b, i.error);
      const ids = new Set(i.variant_ids || []);
      for (const x of ids) covered.add(x);
      rejections.push({ op: i.op, what: REJECTED_WHAT[i.op] || i.op, whatLabel: OP_LABEL[i.op] || i.op, ...s, at: iso(i.updated_at), sentAt: iso(i.sent_at),
        jobId: Number(i.job_id), itemId: Number(i.id), source: 'send', variantIds: [...ids] });
    }
    // sizes whose last error is a SHEIN rejection the readiness still shows (unchanged since), not covered above
    const mootPublish = new Set(items.filter((i) => i.op === 'publish' && i.status === 'failed' && !neverLive).flatMap((i) => i.variant_ids || []));
    const errV = vs.filter((v) => REJECT_CODES.includes(v.last_error?.code) && !v.excluded && (!v.last_error.hash || v.last_error.hash === v.target_hash)
      && !covered.has(v.row_key) && !mootPublish.has(v.row_key));
    if (errV.length) {
      const from = failed.find((i) => i.shopify_product_id === p.shopify_product_id && errV.some((v) => (i.variant_ids || []).includes(v.row_key))) || null;
      const s = sheinReason(errV[0].last_error);
      rejections.push({ op: from?.op || null, what: REJECTED_WHAT[from?.op ?? null] || 'sizes', whatLabel: from ? (OP_LABEL[from.op] || from.op) : 'Sizes', ...s,
        at: iso(from?.updated_at), sentAt: null, jobId: from ? Number(from.job_id) : null, itemId: from ? Number(from.id) : null, source: 'size_error', variantIds: errV.map((v) => v.row_key) });
    }
    if (!rejections.length) continue;
    const off = p.status === 'excluded' || String(p.shopify_status || '').toUpperCase() !== 'ACTIVE';
    if (off && !includeOff) continue;
    rejections.sort((a, b) => OP_RANK.indexOf(a.op) - OP_RANK.indexOf(b.op) || time(b.at) - time(a.at));
    const ids = new Set(rejections.flatMap((r) => r.variantIds));
    const hit = vs.filter((v) => ids.has(v.row_key));
    const shop = vs.filter((v) => v.shopify_variant_id && !v.excluded);
    const main = rejections[0];
    const withNext = rejections.map(({ variantIds, ...r }) => ({ ...r, sizes: variantIds.filter((x) => vs.some((v) => v.row_key === x)).length,
      next: nextFor(r, { product: p, neverLive, photosFixedAt, canWrite }) }));
    out.push({
      productId: p.shopify_product_id, title: p.title, style: p.style, vendor: p.vendor, imageUrl: p.image_url, shopifyStatus: p.shopify_status, shopifyUrl: shopifyUrl(p.shopify_product_id),
      status: p.status, spu: p.spu || null, neverLive, live: !neverLive,
      stock: { pairs: shop.reduce((n, v) => n + Math.max(0, Number(v.shopify_qty) || 0), 0), sizesInStock: shop.filter((v) => Number(v.shopify_qty) > 0).length, sizes: shop.length },
      what: main.what, whatLabel: main.whatLabel, code: main.code, reason: main.reason, module: main.module, isPhoto: isPhotoRejection(main.reason),
      at: main.at, jobId: main.jobId, itemId: main.itemId,
      sizes: hit.length, sizeNames: hit.map((v) => v.shopify_size || v.shein_size).filter(Boolean),
      publishAgain: p.publish_again_at && time(p.publish_again_at) > time(main.at) ? { by: p.publish_again_by || null, at: iso(p.publish_again_at) } : null,
      rejections: withNext, next: withNext[0].next,
    });
  }
  out.sort((a, b) => time(b.at) - time(a.at) || String(a.title || '').localeCompare(String(b.title || '')));
  return out;
}
