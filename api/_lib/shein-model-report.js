// READ-ONLY report (owner, 2026-11-14): shoes we PUBLISHED on SHEIN whose Product Model came from a Setup
// default ("Dunk Low" on product type 374, "Nike Air" on 1852, "ACG Air Max" on 5512 — the leak: Setup saved a
// typed detail as a default for every shoe of a type) and differs from the shoe's own model (typed for the shoe,
// else read from its title when sure). These are the candidates for a correction edit. NOTHING is sent to SHEIN:
// whether live shoes get corrected is the owner's call. `node scripts/shein-model-report.mjs [--csv]`.
import { setupModelCorrections, PRODUCT_MODEL_ATTR_ID } from '../../src/lib/sheinModel.js';

// The latest DONE publish send per shoe (what SHEIN holds from us) + the shoe's row. The type comes from the body.
export const PUBLISHED_MODELS_SQL = `
  SELECT DISTINCT ON (i.shopify_product_id)
         i.shopify_product_id, i.body, i.updated_at AS sent_at, (i.body->>'product_type_id')::bigint AS product_type_id,
         p.spu, p.title, p.attr_overrides, p.status, fx.status AS fix_status, fx.job_id AS fix_job_id
    FROM shein_listing_job_items i
    JOIN shein_listing_jobs j ON j.id = i.job_id
    JOIN shein_listing_products p ON p.shopify_product_id = i.shopify_product_id
    -- its latest Product Model fix that went (or is going) to SHEIN (op 'model', 2026-11-14)
    LEFT JOIN LATERAL (
      SELECT fi.status, fi.job_id FROM shein_listing_job_items fi JOIN shein_listing_jobs fj ON fj.id = fi.job_id
       WHERE fi.shopify_product_id = i.shopify_product_id AND fi.op = 'model' AND fj.kind = 'run'
         AND fi.status IN ('pending', 'sending', 'deferred', 'in_review', 'done')
       ORDER BY fi.updated_at DESC, fi.id DESC LIMIT 1) fx ON true
   WHERE i.op = 'publish' AND j.kind = 'run' AND i.status = 'done' AND i.body IS NOT NULL
     AND p.spu IS NOT NULL
   ORDER BY i.shopify_product_id, i.updated_at DESC, i.id DESC`;
export const SETUP_MODELS_SQL = `SELECT product_type_id, extra_values FROM shein_attr_defaults WHERE attribute_id = ${PRODUCT_MODEL_ATTR_ID}`;

// The report from the two queries' rows (the script and GET /api/shein/listings?modelFix=1 share it).
// `candidates` = what "Fix the Product Model" previews: a sure own model and no fix sent yet.
export function modelReportFrom(setupRows = [], published = []) {
  const setup = new Map();
  for (const r of setupRows) setup.set(Number(r.product_type_id), [...(setup.get(Number(r.product_type_id)) || []), ...(r.extra_values || [])]);
  const rows = setupModelCorrections(published, setup);
  return { rows, candidates: rows.filter((r) => r.should && !r.fixStatus), setup: [...setup].map(([ptid, values]) => ({ ptid, values })), checked: published.length };
}
// pool: a pg Pool / Client. Runs in a READ ONLY transaction. → { rows, setup: [{ptid, values}], checked }
export async function setupModelReport(pool) {
  const c = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    await c.query('BEGIN READ ONLY');
    const { rows: setupRows } = await c.query(SETUP_MODELS_SQL);
    const { rows: published } = await c.query(PUBLISHED_MODELS_SQL);
    await c.query('COMMIT');
    return modelReportFrom(setupRows, published);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { if (c !== pool) c.release(); }
}
