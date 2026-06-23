# Receiving (intake)

Component: `Receiving` in `src/App.jsx` (also reused for rescale intake via
`mode`). List of past batches: `BatchList`. Endpoints under `api/batches/*`,
`api/vins/reserve.js`, `api/items/lookup.js`.

## 3-step wizard
1. **Shipment details** — buyer defaults to `stickballman12`; supplier + date
   required. Tracking typed / camera-scanned / OCR'd from a label photo
   (`src/trackingOcr.js`: zxing → Tesseract.js, lazy-loaded).
2. **Items** — `+ Add Item` opens the scanning modal. Field auto-focuses so a
   **HID scanner gun types straight in**. Auto-detects UPC vs SKU. Re-scanning a
   shoe's boxes **auto-increments qty by size**. A **With Box** checkbox sets
   `with_box` (off → status `no_box`). "Complete item" adds it to the cart.
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

## Product lookup (fills name/sku/image/sizes/gender/colorway)
`searchUpc` / `searchSku` — see `integrations.md`.
