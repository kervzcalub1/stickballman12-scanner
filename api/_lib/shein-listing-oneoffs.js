// SHEIN Listings — one-off fixes run by scripts/db-setup.mjs (idempotent: a second run finds nothing). Plain SQL
// strings only (no imports), so db-setup can load them before anything else and e2e can run them on seeded rows.
// docs/context/shein-listings.md → "The status engine (stage 2)".

// 2026-11-17 · the size errors no rule could clear before stage 2:
//  (a) SHEIN APPROVED a photo / Product Model change of the shoe AFTER the rejection: a photo approval cleared nothing
//      (that send carries no size list), so the old review_rejected stayed for ever (27 sizes on 5 shoes locally);
//  (b) the size is ON SHEIN now (another SHEIN product carries it) but its error came from a send that tried to ADD it
//      (our duplicate publish / an add-sizes) — moot. The engine ignores (b) for errors that carry their `op` now
//      (lastErrorShown); this clears the older ones, which don't.
// Each clearing is written to the listing log (shein_listing_actions, action auto_clear_error). → one row { sizes, shoes }
// $1 = only these Shopify product ids (text[]), NULL = every shoe (db-setup passes NULL; e2e its own shoes).
export const STALE_REJECTIONS_SQL = `
  WITH approved AS (
    SELECT i.shopify_product_id, max(COALESCE(i.sent_at, i.updated_at)) AS at
      FROM shein_listing_job_items i JOIN shein_listing_jobs j ON j.id = i.job_id
     WHERE j.kind = 'run' AND i.op IN ('photos', 'model') AND i.status = 'done' AND i.shopify_product_id IS NOT NULL
     GROUP BY 1
  ), src AS (
    SELECT v.row_key, v.shopify_product_id, v.last_error,
           (SELECT f.op FROM shein_listing_job_items f JOIN shein_listing_jobs fj ON fj.id = f.job_id
             WHERE fj.kind = 'run' AND f.status = 'failed' AND v.row_key = ANY(f.variant_ids)
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(f.blockers) b WHERE b->>'code' = v.last_error->>'code')
             ORDER BY f.id DESC LIMIT 1) AS from_op,
           (SELECT max(f.updated_at) FROM shein_listing_job_items f JOIN shein_listing_jobs fj ON fj.id = f.job_id
             WHERE fj.kind = 'run' AND f.status = 'failed' AND v.row_key = ANY(f.variant_ids)) AS failed_at
      FROM shein_listing_variants v
     WHERE v.last_error->>'code' IN ('review_rejected', 'shein_prevalid') AND ($1::text[] IS NULL OR v.shopify_product_id = ANY($1::text[]))
  ), judged AS (
    SELECT s.*, v.shein_sku, v.match,
           (a.at IS NOT NULL AND (s.failed_at IS NULL OR s.failed_at <= a.at)
             AND (NOT (s.last_error ? 'at') OR (s.last_error->>'at')::timestamptz <= a.at)) AS approved_after,
           (v.shein_sku IS NOT NULL AND v.match IN ('sku', 'link', 'published') AND NOT (s.last_error ? 'op')
             AND s.from_op IN ('publish', 'add_sku')) AS moot_on_shein
      FROM src s JOIN shein_listing_variants v ON v.row_key = s.row_key LEFT JOIN approved a ON a.shopify_product_id = s.shopify_product_id
  ), hit AS (
    SELECT row_key, shopify_product_id, last_error, CASE WHEN approved_after THEN 'approved_after' ELSE 'moot_on_shein' END AS why
      FROM judged WHERE approved_after OR moot_on_shein
  ), done AS (
    UPDATE shein_listing_variants v SET last_error = NULL, updated_at = now() FROM hit WHERE v.row_key = hit.row_key
    RETURNING hit.row_key, hit.shopify_product_id, hit.last_error, hit.why
  ), logged AS (
    INSERT INTO shein_listing_actions (action, by, shopify_product_id, row_keys, detail)
    SELECT 'auto_clear_error', 'db-setup one-off (2026-11-17)', shopify_product_id, array_agg(row_key),
           jsonb_build_object('reason', 'stale SHEIN rejection: ' || string_agg(DISTINCT why, ', '),
             'was', jsonb_agg(jsonb_build_object('rowKey', row_key, 'code', last_error->>'code', 'why', why)))
      FROM done GROUP BY shopify_product_id RETURNING 1
  )
  SELECT (SELECT count(*) FROM done)::int AS sizes, (SELECT count(*) FROM logged)::int AS shoes`;
