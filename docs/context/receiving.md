# Receiving (intake)

Component: `Receiving` in `src/App.jsx` (also reused for rescale intake via
`mode`). List of past batches: `BatchList`. Endpoints under `api/batches/*`,
`api/vins/reserve.js`, `api/items/lookup.js`.

## 3-step wizard
1. **Shipment details** — buyer defaults to `stickballman12`; supplier + date
   required. The **supplier dropdown is loaded from `GET /api/suppliers`** (seeded
   list + auto-saved custom names); picking "Custom…" and typing a new vendor
   auto-saves it on commit (`addSupplier`, V6 Feature 1). Tracking typed /
   camera-scanned / OCR'd from a label photo (`src/trackingOcr.js`: zxing →
   Tesseract.js, lazy-loaded). As the tracking # is entered it's checked against
   past batches/boxes (`GET /api/batches/check-tracking`, debounced); a repeat
   shows a **non-blocking duplicate warning** and, if committed, sets
   `batches.duplicate_of` (V6 Feature 8).
2. **Items** — `+ Add Item` opens the scanning modal. Field auto-focuses so a
   **HID scanner gun types straight in**. Auto-detects UPC vs SKU. Re-scanning a
   shoe's boxes **auto-increments qty by size**. A **With Box** checkbox sets
   `with_box` (off → status `no_box`). "Complete item" adds it to the cart.
   **Newest scanned shoe shows on top** of the cart; **sizes sort smallest→largest**
   in both the cart and the scanning modal (`compareSizes`, V6 Features 3 & 6).
   ⚠️ Scan **no-box pairs separately** so their VINs/labels don't get mixed with
   with-box pairs (see SOP-WAREHOUSE.md).
3. **Issues** — no-box pairs auto-listed; manual issues addable. Finish commits.

## VINs & commit
- On commit (`api/batches/commit.js`): `createBatch` → `reserveVins` (atomic
  `nextval('vin_seq')`) → `insertItems` → `insertIntakeEvents`.
- Each unit gets its own **VIN** (`SBM-YYMMDD-######`), visible before submit so
  staff can label. Consolidation merges identical lines but each unit keeps a VIN.
- Gaps in VIN numbering are harmless and expected; **never reuse a number**.
- First event chain: "Scanned by <user>" → "Received into inventory".
- Rescale intake (`mode='rescale'`) sets `kind='rescale'` + `restock_pending=true`
  (see `rescale.md`).
- **Global indicator price**: after responding, `enrichGlobalIndicators`
  best-effort resolves each unit's Alias `catalog_id` — **by UPC** (Alias UPC
  search) or, for SKU-only scans, **by SKU** (official catalog search) — caching it
  in `products`, then fetches the global indicator (official `api.alias.org`,
  `ALIAS_API_KEY`, region 3) per catalog_id + size and stores `global_indicator`
  (+ seeds `price` = GI×1.2). Never blocks the commit; failure leaves GI null for
  PH to fill. See `integrations.md` / `ph-report.md`.

## Product lookup (fills name/sku/image/sizes/gender/colorway)
`searchUpc` / `searchSku` — see `integrations.md`.
