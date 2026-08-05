# No Box / Not Ready

Two screens sit under Put-away: the **No Box queue** (this page — units received
without a box, waiting to be resolved) and the **Box Labels tool**
(`/box-labels`, below) — an ad-hoc generator for replacement box labels.

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
  scan/lookup). Legacy items without a UPC can't be backfilled by SKU (per-size
  UPCs aren't in the SKU lookup) → the label sheet **prompts** for one, typed off
  the tongue label inside the shoe, and saves it to the unit
  (`api/items/set-upc.js`). No reverse-lookup endpoint — deliberate.
- Sizes on the label use the API's value as-is (no gender suffix appended).

## Box Labels tool (`/box-labels`)

`src/screens/BoxLabels.jsx`, route `box-labels`, Home tile under **Put-away**.
Admin + warehouse (ph_team never reaches the main router). One scan field routed
by code shape (`src/lib/codes.js`) into three jobs:

| Scan | Result |
|---|---|
| **VIN** (`isVinCode`) → `api/items/lookup` | The pair is already in the system: **Print box label** + **Reprint VIN label**. |
| **UPC / SKU** → `api/items/find` **first** | Exact match against **our own stock**. Lists the real units ("Use this VIN" → the VIN flow) so nobody mints a duplicate. |
| …then **UPC** → `api/upc-search` | Catalogue hit *with* the scanned size (only the StockX proxy carries per-UPC size). |
| …then anything else → `api/sku-search` | Catalogue hit, size picked from the Alias size run. No UPC (the catalogue is per-SKU). |

**Our own stock is asked first, always.** The third-party catalogue does not know
about old stock, in-store buys or anything hand-entered, so a catalogue-only
lookup answered "No product found for that UPC" *while the UPC sat on the item*.
`api/items/find.js` → `findStockByCode` matches a UPC on digits only, and a SKU
with spaces/dashes stripped (so `DQ8426 109` finds `DQ8426-109`). A code is only
treated as a UPC when it is digits **end to end** — deriving digits from anywhere
in the string reads a SKU like `MQA-NOBOX-1785906559725` as a 13-digit UPC.

From a catalogue hit (no unit behind it) there are two actions:
- **Print box label only** — prints, records nothing.
- **Give it a VIN + print both** — behind a confirm, since it's the one action
  that writes inventory. Commits **one** unit as `kind='existing'` (so it's
  PH-excluded like all old stock, and recorded already-listed), `with_box=true`
  (the replacement label *is* its box) → status `needs_shelf`, so it shows up in
  Shelve/Put-away. Box label prints first; the VIN sticker is a second job
  because the two use different label stock.

**Server:** `api/batches/commit.js` normally *requires* a `locationCode` for
`kind='existing'` (the Existing Stock screen counts shelf by shelf, standing at
the shelf). This tool is the one exception — the pair is in hand being re-boxed —
so it sends `noShelf: true` with no `locationCode`. The guard still fires for
everything else, and a *bad* shelf code is still a 404 even with `noShelf`.

No schema change. Covered by `e2e/box-labels.spec.js`.
