# No Box / Not Ready

Component: `NoBoxReport` in `src/App.jsx`. Endpoint: `api/items/no-box.js`
(`listNoBoxItems(from,to)`). Resolve actions: `api/items/box-found.js`
(`markBoxFound`) + `api/items/event.js` (status_change).

## What it is
- A worklist of units received **without a box** (status `no_box`). They are
  **not postable** → hidden from the PH report. PH sees it view-only;
  warehouse/admin resolve. **In-store** no-box units (`kind='instore'`) appear
  here too — the queue is kind-agnostic; warehouse resolves them the same way
  (`in-store.md`).
- Day/Week/Month date filter (`DateRangeBar`).

## Resolve (warehouse/admin)
- Primary: **"📦 Box found → With Box"** → `markBoxFound` sets `with_box=true` +
  status `needs_shelf`, making the unit **sellable** (returns to the report).
  We never sell without a box.
- Secondary: an "Other status…" dropdown for edge cases (e.g. Missing) →
  `itemEvent(vin,'status_change',...)`.

## UPC box labels
- **Print box labels** (`LabelSheet mode` box-style): recreates a real shoe-box
  label — vertical UPC barcode + name/size/colorway/SKU — so no-box pairs scan
  normally. Accessible **only on this page**. Emitted as an exact-size PDF
  (`src/lib/labelPdf.js`, `drawBoxLabel`); no-UPC records fall back to a
  centered text-only label. See `docs/context/locations.md` "Labels" for the
  why (iOS AirPrint scaling/footer fix).
- Uses `items.upc` (+ colorway). UPC must be on the record (captured at
  scan/lookup). Legacy items without a UPC can't be backfilled by SKU
  (per-size UPCs aren't in the KicksDB SKU lookup) → manual entry is a TODO.
- Sizes on the label use the API's value as-is (no gender suffix appended).
