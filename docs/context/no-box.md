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
  label — vertical UPC barcode on the left **with the UPC digits down the outside
  left edge and the bars inboard of them**, then **NAME → colorway → size → SKU**
  down the right, the order and
  weighting a Nike box label uses (colorway sits directly under the name in a
  lighter/narrower face, 2-line clamp). So no-box pairs scan and read like a
  normal boxed pair.
  - **The digits are drawn INTO the barcode canvas** (`displayValue`), not printed
    as a separate row like the VIN/shelf labels do — the barcode is rotated, and
    only text baked into the canvas turns with it and stays glued to the bars.
  - **The rotation direction is load-bearing** (`rotate90`, 90° **CW**). Clockwise
    puts the digits on the OUTSIDE left edge, reading top-to-bottom, with the bars
    between them and the text — what Nike prints on a real box, and the strip still
    visible when boxes are stacked on a shelf. Counter-clockwise (what we shipped
    until 2026-08-22) buries the number on the inside edge, between the bars and the
    text column. Brent asked for the flip off the floor.
    They ship with **`flat: true`**, which is load-bearing: JsBarcode's default
    UPC-A layout hangs the first and last digit OUTSIDE the guard bars and widens
    the canvas ~17%, and since the barcode scales to a fixed length on the label, a
    wider canvas means **narrower modules** (0.241 mm → 0.206 mm on the smallest
    stock, on a code already under GS1 nominal). Flat centres the digits under the
    bars instead, so the number costs ~9% of bar *height* and nothing of
    scannability. **Never set `displayValue` without `flat`.** Accessible **only on this page**
  and from the Box Labels tool. Emitted as an exact-size PDF
  (`src/lib/labelPdf.js`, `drawBoxLabel`); no-UPC records fall back to a
  centered text-only label with the same row order. The whole text column
  auto-scales to fit, so a 2-line name + 2-line colorway still fits small stock.
  See `docs/context/locations.md` "Labels" for the why (iOS AirPrint
  scaling/footer fix) — and for the two ways this went wrong in the field: a CSP
  that blocked the print iframe, and lazy chunks that 404 in a tab left open
  across a deploy (blank barcode column + dead Print button). Only a record with
  **no UPC at all** gets the text-only label; a UPC we hold but fail to encode
  now fails the print loudly rather than printing "No UPC on file".
- Uses `items.upc` (+ colorway). UPC must be on the record (captured at
  scan/lookup). Legacy items without a UPC can't be backfilled by SKU (per-size
  UPCs aren't in the SKU lookup) → the page **prompts** for one before printing, typed off
  the tongue label inside the shoe, and saves it to the unit
  (`api/items/set-upc.js`). No reverse-lookup endpoint — deliberate.
- **A scanned UPC fills the gap — once a person confirms the shoe.**
  `POST /api/items/backfill-upc` (warehouse + ph_team) writes a scanned code onto
  **every** pair of that style and that exact size that has none on file. Both the
  Box Labels tool and the Inventory search bar call it on any UPC, so the codes
  staff read off real boxes accumulate instead of being answered once and thrown
  away.
  - **Two phases, because the catalogue is sometimes wrong.** One UPC can come back
    carrying variants from several different products and the lookup takes the
    first (`sku-multi-code`), so `{ upc }` only *asks*: it returns the shoe it
    thinks the code names and writes nothing. `{ upc, confirm: { sku, size } }`
    writes. The client can **veto or approve, never dictate** — phase two re-runs
    the lookup and refuses (`reason: 'changed'`) if the style or size the person was
    shown is no longer what comes back, so a hand-edited request can't put an
    arbitrary code on arbitrary stock.
  - **The prompt asks about the shoe, not about saving** (`src/components/UpcCheck.jsx`).
    Photo, name, style, size, Yes/No. Asked "shall I save this?" somebody answers
    from whether they want the chore; asked "is this the shoe in your hand?" they
    answer from the box, which is the only thing they can actually verify. When the
    barcode pointed at more than one product the prompt says so.
  - **Nobody is asked a question whose answer changes nothing** — if no pair of that
    style+size is missing a UPC, phase one returns `nothing-to-fill` silently
    (`countUnitsMissingUpc`). A code the catalogue can't place is also a quiet
    no-op, never an error on a search bar.
  - It only ever fills a **blank** (a hand-corrected UPC is never overwritten), the
    **size comes from the lookup server-side** (a client-supplied size is a guess —
    `receiving.md`), and each fill is logged to the unit's history as a note.
  - On Box Labels the ask runs **after** the scan's own answer is on screen and
    never blocks it; saying Yes re-asks `api/items/find` so the newly-matching pairs
    replace the anonymous catalogue hit with their real VINs.
- **A missing UPC is safer than a borrowed one.** Receiving used to stamp one
  scanned UPC on every size in a box (`receiving.md`), so a size-8.5 pair printed
  size 10's barcode — and a replacement box then scanned as size 10 for good.
  Fixed at intake 2026-09-03, and 1,029 existing units had their wrong code
  cleared (`scripts/repair-unit-upcs.mjs`, old code kept in `items.notes`). Those
  pairs now hit the prompt where they used to print silently: that is the fix
  working, not a regression.
- **Sizes carry a men's/women's marker** — "9 W", "11.5 M", drawn as ONE string
  at the size's own font size (warehouse feedback: a bare "9" doesn't say which
  it is, and the marker should read as big as the number).
  `sizeParts()`/`sizeLabel()` in `src/lib/codes.js` resolve it in order:
  the size string's own suffix ("8.5W"/"10Y") → `items.gender` (Men/Women/
  Youth/Toddler/Unisex, set by `normalizeGender`) → the product name
  ("Wmns …", "(GS)"). **Unisex and unknown print BARE** — a wrong letter on the
  box is worse than none. Most older rows have `gender` NULL, which is why the
  name fallback matters; the Box Labels tool now stores the catalogue's gender on
  units it mints. Same helper drives the on-screen size text on both pages.

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
