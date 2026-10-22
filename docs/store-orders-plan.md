# Store orders — plan v2 (multi-store supplier purchases: Joey)

Status: **A (#304) + B (#305) merged; C (receiving attribution) built 2026-10-23; D, E to go.** v2 written 2026-10-23, replacing v1 the same day. What's live: `docs/context/purchase-orders.md` → Store orders.

**C as built, where it differs from §4.4:** tie-later lives on the PH order screen (StoreOrderPanel), not the warehouse Reconciliation screen (the endpoint allows warehouse too); the Telegram discrepancy alert on tie/untie is left for D with the other alert triggers.

**Sources:**
- The Oct 17 meeting: transcript plus Kylene's notes.
- Tasks T-1309, T-1286, T-1278, T-1272, T-1290 and T-1273.
- **Kevin's audit process**, which changed v1. Stores often charge the card at purchase. Receipts exist only sometimes, either as paper (photographed) or as an email. Kevin audits *after* receiving: received vs declared vs card statement.
- Three code passes at HEAD `4565e73`:
  - orders, supplier and reconciliation;
  - pre-sell, receiving and roles;
  - receipts.
- An adversarial review of v1 found 4 blockers and 15 majors. All of them are folded in here and tagged `[B1]`, `[M4]` etc.

---

## 1. The problem

**How Joey buys:**
- Joey buys one shoe in bulk from about 15 stores of one retailer (Athlete's Foot; contact Malik).
- **Each store packs and ships its own boxes straight to us.** Joey is never there.
- Store managers text him their counts, and he copies them into notes.

**What goes wrong:**
- Box counts are wrong: a box says 12 and holds 6, or says 22 and holds 6.
- The stores never invoice. The card statement shows only store and total.
- Receipts are sometimes there and sometimes not.

**What it cost on the last order** (working numbers; Kevin owns the final ones):

| Shoe | Bought | Price |
|---|---|---|
| Royals | 213 | $120 |
| Cincinnati | 145–146 | $110 |
| Last Dance | 161 | $77.50 |

- We were charged $53,959.05 against $53,367.50 expected.
- We are short about 11 + 1 pairs.
- Pre-sold buyers are owed sizes that never came, and their labels are already scanned, so they can't be cancelled.

**What was agreed:**
- A master list split by store, with each store's count, sizes and price.
- **We** build the invoice. Joey: "they're not going to invoice us."
- Joey enters his own records. Ruby used to enter them, and they were "always wrong".
- Brent scans what actually arrives.
- Variance is documented as money owed.
- **Quantities first, sizes second.**

## 2. The process the system must support (v2)

```
 Joey buys ─▶ ① Order + stores + boxes ─▶ ② Joey's list (by store, with prices) ─▶ ③ labels per store
          (card is often charged here)                  │ ideally at purchase; allowed later, flagged
                                                         ▼
 ④ Stores ship ─▶ ⑤ Brent receives (each box's tracking scanned → tied to its label → its store)
                                                         ▼
 ⑥ Kevin: charges from the statement + receipts when there are any (any time)
                                                         ▼
 ⑦ Kevin audits: received vs declared vs charged (vs receipt) → owed per store → Mark audited
    (freezes the list, snapshots the numbers, closes the order) ─▶ ⑧ credit / refund per store
```

- **No charge gate.** The card is often already charged before the list exists, so blocking labels on an approval would block shoes that are already paid for [B3].
- There is an **optional "Invoice checked"** mark for when a store does wait.
- The real control is ⑦.

## 3. What exists today (verified)

| Need | Today |
|---|---|
| A whole-order list | ✅ `manifest_scope='po'`, with lines where `po_box_id` is NULL. A supplier can paste it, but **only while the order is `draft`** (`scan-bulk.js:78`). |
| Reconcile on totals | ✅ `getPoReconciliation`. Received = every item in every batch where `batches.po_id` = this PO, using `coalesce(original_sku/size)`. |
| Price per pair | ✅ `po_lines.unit_cost` (shelf price) and `tip`. Suppliers can see them. |
| Raise an order, numberless boxes, ask for labels | ✅ `po/create {boxes}`, `label-add`, `request-labels`, `assign-labels`. |
| Receiving tied to a label | ⚠️ **Only through the tracking string.** `batch_boxes` has no `po_box_id`. The client knows `slot.poBoxId` but never sends it. Tracking per box is **optional**. A single-box receive puts every pair on one batch tracking number. The normaliser strips whitespace only. |
| Receipt tooling | ✅ The buy-cart stack can be reused: `cart/file-sign` and `file-attach` (photos/PDF/HEIC, supplier-scoped, R2 proxy), `cart/receipt-read.js` (gpt-5.4-mini, **already measured on an Athlete's Foot receipt**), `receiptCheck.js`, and `compareReceiptToApproved`. Email receipts land in `email_receipts`, but Athlete's Foot is **not** a detected store: no store and no lines, only totals when they're printed. |
| Card statements | ❌ Nothing exists. |
| Store | ❌ Nowhere. |
| Audit role | ⚠️ There is no finance role. Privileges (`users.privileges`, `buycart.js:42`) are the way to add one. No migration needed. |

---

## 4. Design

### 4.1 Schema (all in PR A)

**Where each piece goes in `scripts/db-setup.mjs`. This matters on a fresh database [B1]:**
- `po_stores`, `po_store_charges`, the `po_lines` / `po_boxes` / `batch_boxes` / `purchase_orders` columns, and the store index go **before** the po_lines index block (~:1015). That block will reference `po_store_id` after PR B.
- `po_store_receipts` goes **after** `email_receipts` (created at :1979), because it references it.
- `presell_stock_po` and `at_risk_alerted` go **after** `presell_stock` (created at :2046).
- Checked: `email_receipts.id` and `presell_stock.id` are BIGSERIAL; `batch_boxes.id` and `po_boxes.id` are BIGINT identity.

```sql
-- stores on an order
CREATE TABLE IF NOT EXISTS po_stores (
  id BIGSERIAL PRIMARY KEY,
  po_id BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                    -- trimmed, inner spaces collapsed
  position INT NOT NULL DEFAULT 0,
  credit_agreed NUMERIC(12,2),           -- what the supplier agreed to credit THIS store's shortfall [M10]
  credit_received NUMERIC(12,2),
  credit_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS po_stores_po_name_idx ON po_stores (po_id, lower(name));   -- [B2]

-- what the card was actually charged — MANY per store (split charges, later credits) [minor]
CREATE TABLE IF NOT EXISTS po_store_charges (
  id BIGSERIAL PRIMARY KEY,
  po_store_id BIGINT NOT NULL REFERENCES po_stores(id) ON DELETE CASCADE,  -- see §8b
  amount NUMERIC(12,2) NOT NULL,         -- negative = a credit back on the card
  charged_on DATE,                        -- the statement date (EST civil date)
  card_last4 TEXT, note TEXT,
  entered_by TEXT, entered_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- receipts, WHEN a store gave one
CREATE TABLE IF NOT EXISTS po_store_receipts (
  id BIGSERIAL PRIMARY KEY,
  po_store_id BIGINT NOT NULL REFERENCES po_stores(id) ON DELETE RESTRICT,
  r2_key TEXT, name TEXT, content_type TEXT, size_bytes INT,   -- a photo or a PDF
  email_receipt_id BIGINT REFERENCES email_receipts(id) ON DELETE SET NULL,  -- or an ingested email
  amount NUMERIC(12,2),                   -- receipt total (typed, or AI-read and confirmed)
  lines JSONB,                             -- AI/parsed lines [{sku,size,qty,totalPrice}] (optional)
  read_agreed BOOLEAN,                     -- the two AI reads of the total agreed?
  uploaded_by TEXT, uploaded_by_id BIGINT, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now());

ALTER TABLE po_lines   ADD COLUMN IF NOT EXISTS po_store_id BIGINT REFERENCES po_stores(id) ON DELETE RESTRICT;
ALTER TABLE po_boxes   ADD COLUMN IF NOT EXISTS po_store_id BIGINT REFERENCES po_stores(id) ON DELETE SET NULL;
ALTER TABLE po_boxes   ADD COLUMN IF NOT EXISTS tracking_source TEXT;   -- NULL/'ours' | 'store' [M2]
ALTER TABLE batch_boxes ADD COLUMN IF NOT EXISTS po_box_id BIGINT REFERENCES po_boxes(id) ON DELETE SET NULL; -- [M1]

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS by_store BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS list_confirmed_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS list_confirmed_by TEXT,
  ADD COLUMN IF NOT EXISTS invoice_checked_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS invoice_checked_by TEXT,
  ADD COLUMN IF NOT EXISTS landed_override_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS landed_override_by TEXT,
  ADD COLUMN IF NOT EXISTS landed_override_note TEXT,
  ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS audited_by TEXT,
  ADD COLUMN IF NOT EXISTS audit_note TEXT, ADD COLUMN IF NOT EXISTS audit_snapshot JSONB;   -- [M11]

-- the NEW store index only; the old one is swapped in PR B (§6)
CREATE UNIQUE INDEX IF NOT EXISTS po_lines_po_store_sku_size_idx ON po_lines (po_store_id, sku, size)
  WHERE po_box_id IS NULL AND dimensions IS NULL AND po_store_id IS NOT NULL;

-- pre-sell: pairs listed per (stock row, PO) [M12]
CREATE TABLE IF NOT EXISTS presell_stock_po (
  stock_id BIGINT NOT NULL REFERENCES presell_stock(id) ON DELETE CASCADE,
  po_id BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  qty INT NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (stock_id, po_id));
ALTER TABLE presell_stock ADD COLUMN IF NOT EXISTS at_risk_alerted INT;
```

**Other schema notes:**
- `LIVE_TABLES` gains `po_stores`, `po_store_charges`, `po_store_receipts` and `presell_stock_po`.
- Charges and receipts use RESTRICT on purpose. Removing a store that holds money evidence is refused by the API, not cascaded away [M10].

### 4.2 Store orders: creating them and the list

**Creating** [M7]:
- `po/create {byStore:true}` sets `by_store = true` and `manifest_scope = 'po'` from the start.
- It allows **0 boxes**.
- Empty-shoe-box orders are refused.

**The paste** (`src/lib/storePaste.js`, new):
```
Store: AF #1234 Dallas
DZ5485-612 $110
8 x2
9 x3
Store: AF #2210 New Orleans
DZ5485-612 $110
10 x4
```
- `Store:` / `Store -` / `Store #12` starts a block. The name is normalised (trim, collapse spaces, case-insensitive match).
- Each block is parsed **on its own** with the existing SKU / `$price` / `size x qty` rules. The plain parser merges the same SKU across blocks and applies the last price; that was demonstrated, and it is why blocks must be split first [M8].
- **A price is required on every SKU.**
- The same SKU+size already in that store **at a different price → refused** ("$110 on the list, $120 in this paste"), never silently re-priced [M8].
- The preview shows each store's pairs and $, and a grand total.
- Caps: 30 stores, 150 store×SKU entries, 1,000 lines. Rate limited.

**Write path:** new `POST /api/po/store-list` (supplier on their own order, ph_team, admin).
- It runs as one `sql.transaction`:
  - upsert the stores;
  - insert the lines with `po_store_id = (SELECT id FROM po_stores WHERE po_id=… AND lower(name)=lower(…))`. The transaction helper takes pre-built queries, so ids can't be passed between steps; this subquery avoids that.
- **All or nothing.**

**Who may edit the list, and when** [B3][B4][M14]. One helper, `orderListEditBlock({po, user})` in `api/_lib/po-manifest.js`, is called from **every** order-level writer:
- `store-list`;
- `po/store` (rename and remove);
- `line.js` when it's an order-level line;
- `scan-order`;
- `scan-bulk` in order mode.

| | Supplier (Joey) | Staff (ph_team/admin) |
|---|---|---|
| Before Confirm | ✅ while draft, shipped or receiving | ✅ on behalf |
| After Confirm | ❌ "Confirmed — ask us to change it" | ✅ but **every edit writes a system comment** (before → after, who) |
| After **Mark audited** | ❌ | ❌ frozen (the only freeze point) |

- On a `by_store` order, `scan-order` / `scan-bulk` order mode return **409** ("This order is by store — use the store list") [M6].
- A **store paste onto an order that already has non-store order-level lines** is refused, with a staff-only **"Assign these lines to a store"** tool [M6]. This converts the interim PO from §8.
- `po/scan` (per-box lines) on a `by_store` order → 409. `poHasBoxLines` stops counting `kind='replacement'` labels [M7].
- `updatePoLine` sibling merge adds `AND po_store_id IS NOT DISTINCT FROM <line's store> AND dimensions IS NULL`, and 23505 maps to 409 in `line.js` [M9].
- **A late list is flagged, not blocked** [M14]. If `list_confirmed_at` (or the first line) is later than the order's first received batch, the audit shows "⚠ List entered after pairs were received". A list written after seeing the count is a control risk. Suppliers still never see received counts (`hideReceivedUnits`).

**Confirm list** (Joey) sets `list_confirmed_*`.

**"Invoice checked"** (optional, staff) sets `invoice_checked_*`. It is informational only and blocks nothing.

### 4.3 Boxes and labels per store

- Each store section has **+ Add box** (`label-add {poStoreId}`). PH assigns tracking exactly as today, with `request-labels` unchanged. Labels **never wait on the list**.
- `request-labels` on a `by_store` order also requires every non-replacement box to have a store.
- **The store used its own label** [M2]: Joey or staff can type a tracking number on *that store's box*. It is saved with `tracking_source='store'` and registered with 17TRACK, using the same global-unique and number-format checks as `label-add`. This is the only case where a supplier may set tracking.
- **Replacement label** (reship): `resolution` → reference asks **which store** and sets `po_store_id` on the replacement label [M10].
- **`label-move`** of a store box to another order is refused ("Remove it from the store first") [M10].
- **Remove store** is refused if the store has boxes, charges or receipts, or if the list is confirmed. Otherwise its lines go with it.
- **`deletePo`** deletes the receipt R2 objects too. Archive cleanup never touches receipts [M10].

### 4.4 Receiving: tying every pair to a store [M1]

1. **Direct link.** The client already holds `slot.poBoxId` (`Receiving.jsx:316-319`). Send it on `batchAddBox`, and `addBatchBox` stores `batch_boxes.po_box_id`. `getPoReceivedBoxes` then matches on `po_box_id` first and **normalised tracking** (alphanumeric only) second.
2. **On a `by_store` PO, every box must be tied to a label before "Add items":**
   - Client: the slot's tracking must match a label on the order. It is prefilled, and if it's edited it must still match.
   - Server: the same check in `add-box` / `box-commit` when the batch's PO is `by_store`.
   - "No tracking number" and the single-box path are refused for these POs. They are already forced to multi-box.
3. **Store chip**: "Store: AF #1234 Dallas" on the Step-2 box line (`Receiving.jsx:2535`) and on each box row (`:2483`).
4. **Tie later**: on the Reconciliation screen, staff can tie an unattributed received box to a label ("Box received without its label → tie to …"), which writes `batch_boxes.po_box_id`. "Not tied to a store: N pairs" is shown loudly, never guessed.
5. **Cost by store**: `poLineMoney(lines, sku, size, poBoxId, storeId)` prefers the box's store line. When lines or prices arrive after the pairs were received, the order shows **"Fill costs from this order's list"**, which re-runs `items/cost-backfill` for this PO [M14].

### 4.5 Landed [M3]

An order has **landed** when either:
- every non-replacement label has a received box tied to it and no batch is open; or
- staff **"Call it landed"** with a note (e.g. "box 7 lost — claim filed"), stored in `landed_override_*`.

**Before landed:**
- The report reads "N of M boxes in — still arriving" and never says "short".
- After a label shows **Delivered** for 2 days with no receipt scan, it says "overdue".

### 4.6 The audit (Kevin) — `getPoStoreVariance(poId)`

It is served on `po/reconciliation` as `store_variance`. Matching uses the existing `rcCodes` / `rcSizeNum` and `coalesce(original_*)`.

| Store | Declared pairs | Declared $ | Receipt $ | Charged $ (statement) | Received | Short | Over | $ owed (short) | Charged − declared |
|---|---|---|---|---|---|---|---|---|---|

**How each column is worked out:**
- Short and Over are counted **per SKU+size and never netted** (a missing 9.5 isn't paid by an extra 11).
- $ owed = Σ short × that line's price.
- Expanding a store shows SKUs; expanding a SKU shows sizes. **Quantities lead.**
- **Receipt $**: the sum of the store's receipts, or "— no receipt". If it disagrees with the statement it is highlighted, and that is the first question for the store.
- **Receipt lines vs declared**: when a receipt has lines (AI-read), use the `compareReceiptToApproved` pattern ("receipt has 2 more size 10 than Joey's list").

**Other rows and flags:**
- A total row.
- "Not tied to a store: N".
- "⚠ list entered after receiving".
- "Overcharge total".

**Charges entry:** add rows (amount, statement date, last 4, note). Negative amounts are credits.

**Receipts:**
- **Upload** a photo or PDF. Reuse the `cart/file-sign` / `file-attach` pattern: new `po/receipt-sign` + `po/receipt-attach` + `po/receipt-file` proxy, supplier on their own order, staff. Add a client size check (max 15 MB), since R2 presign doesn't enforce one.
- **Read it**: the read logic is pulled out of `cart/receipt-read.js` into `api/_lib/receipt-ai.js` `readReceiptImage(buffer)`. It reads the **total twice** (the cancellations pattern) and prefills amount and lines for a person to confirm. About $0.002 per receipt. PDFs are read client-side with pdfjs, as the buy-cart does today.
- **Attach an ingested email receipt**: a picker of `email_receipts` filtered by date and total (Athlete's Foot emails file with totals but no store). Teaching the email parser Athlete's Foot is out of scope; see §10.

**Mark audited** (privilege **`audit_po`**, plus admin):
- writes `audited_*` and `audit_note`;
- stores the whole variance JSON in **`audit_snapshot`** [M11];
- runs `snapshotReconciliation`, which sets the order to `reconciled` and freezes it;
- shows the snapshot from then on.

**Unaudit** (admin) clears all of that, with a system comment.

**Auto-reconcile skips `by_store` orders that aren't audited** (`autoReconcileIfClean`) [M4]. Today, store A short and store B over would net to "clean" and freeze the order before Kevin sees it.

**Per-store credit** (`credit_agreed` / `credit_received`) is shown in the table. The order's existing resolution (refund / replacement) stays for the order as a whole [M10].

**Exports:** PDF and CSV modes `invoice` (declared, by store, EST date of confirmation) and `stores` (the variance) in `manifestPdf.js` / `manifestCsv.js`. They take the same input object, so the two can never disagree.

### 4.7 Alert

`reconcileOutcomeForIntake` (`db.js:5433`) is the **one** hook. It is shared by commit, box-commit and set-status [M15]. `link-batch`, `unlink-batch` and the "tie later" action call it too.

For `by_store`:
- It fires only when the order has **landed**.
- Example text: "PO-1234 · Joey — 4 of 15 stores short · 12 pairs · $1,320 owed" plus the top 3 stores.
- `once:true` with `ref = po:<id>:store:<short>/<owed>`, so it re-alerts only when the numbers change.

Non-store orders are unchanged.

### 4.8 What the supplier can see [M5]

`po/get`, `po/list` and the advisor PO tools move to an explicit **strip-list for suppliers**:
- `audited_*`, `audit_note`, `audit_snapshot`, `invoice_checked_by`, `landed_override_*`;
- all of `po_store_charges`;
- `credit_*`;
- receipt `email_receipt_id`.

**Joey keeps:**
- his stores, lines and prices;
- his own uploaded receipts;
- the confirm status.

An e2e test asserts the supplier JSON contains none of the stripped keys.

### 4.9 Pre-sell guard (Pre-sell Listings) [M12][M13]

**(a) Cap on the increment, per PO.** `presell_stock_po` records how many of a row's pairs were listed against each PO.
- In `presell-listings/create.js` and `action.js qty`, adding `n` pairs with a PO requires `listed_for_po + n ≤ PO expected` for that SKU+size.
  - "PO expected" means the PO's order-level lines, or its non-replacement box lines, matched with `rcCodes` / `rcSizeNum`.
- The refusal names it: "PO-1234 lists 5 of DZ5485-612 size 10 — 3 already pre-listed, you're adding 4."
- A PO with no list yet is allowed, with "⚠ no list to check against".
- Linking a PO to rows that already exceed the cap (`details`) is **allowed and flagged at-risk**, not refused.
- Lowering `qty` stays allowed down to `sold`.

**(b) At risk, after landed.**
- For each linked row: `at_risk = max(0, sold_for_this_PO − received on THIS PO's batches for that SKU+size)`. Received uses `coalesce(original_*)` and the reconciliation matching. "Arrived (any batch)" is shown separately so the two numbers aren't confused.
- **Screen:** Inbound pre-sell block, plus Pre-sell Listings → Stock, showing "size 10: sold 8, arrived 5 → 3 orders at risk".
- **Telegram:** the pre-sell chat, gated on `PRESELL_WATCH`, posted when `at_risk_alerted` changes.
- **Known limit:** reconciliation size matching strips the letter, so a GS `7Y` and a men's `7` collide. The pre-sell and reconciliation matching are kept identical for consistency, and this is documented.

---

## 5. PRs and order

| PR | Contents | db:setup | Estimate |
|---|---|---|---|
| **A — schema** | all of §4.1 (in the right place in the file [B1]); nothing reads it yet | ✅ | 2 h |
| **B — store order entry** | §4.2, §4.3; the index swap (§6); `orderListEditBlock` everywhere; supplier strip-list (§4.8); invoice PDF/CSV; SupplierApp + PoDetail by store; supplier SOP article | ✅ (swap) | 2 days |
| **C — receiving attribution** | §4.4: `batch_boxes.po_box_id`, the required matching tracking on store POs, the store chip, tie later, store-supplied tracking, the alphanumeric normaliser, cost by store | — | 1 day |
| **D — audit** | §4.5–4.7: charges, receipts (upload + AI read + email attach), variance, landed + override, Mark audited + snapshot, auto-reconcile skip, per-store credit, the `audit_po` privilege, the alert | — | 2 days |
| **E — pre-sell guard** | §4.9 | — | 1 day |

- **Total:** about 6 working days.
- **Joey's first store order needs A + B + C.** D can follow while the boxes are in transit, because the audit happens after receiving anyway.
- **Each PR:**
  1. `npm run build`.
  2. The new e2e spec, plus the touched specs (§7). Kill any stale `:5189` server first.
  3. Merge on your "deploy".
  4. You run `db:setup`.

## 6. Migration safety (the index swap)

The rule:
- Postgres infers a partial unique index only when the `ON CONFLICT … WHERE` implies the index predicate.
- The new clause `po_box_id IS NULL AND dimensions IS NULL AND po_store_id IS NULL` implies the old predicate, so **new code works on the old index**.
- The old clause does not imply the new one, so **old code + new index = every whole-order paste fails**.

The order:

| Step | What happens | Why it's safe |
|---|---|---|
| **PR A** | Adds columns and the *store* index only | Old code is untouched |
| **PR B** code | Ships the new clause in `addPoOrderScan`'s non-store branch, with the full predicate | It works on the old index until `db:setup` |
| **PR B** db-setup | Edits the **existing** block (~:1025): creates the new non-store index **under a new name**, then drops the old one, inside one `sql.transaction`, so there is never a moment with no arbiter | — |

- `docs/context/deploy.md` gets a warning: after PR B, never run an older branch's `db:setup` against prod. It would drop the index and fail to recreate it if two stores share a SKU+size.
- **Every order-level line writer, re-tested across the swap:**
  - `addPoOrderScan`, called from `scan-order`, `scan-bulk` and `cart/raise-po`;
  - `updatePoLine`;
  - `deletePoLine`;
  - `setPoLineQty`;
  - `scripts/clone-prod-local.mjs` and `db-go-live.mjs`, which copy and truncate only.
- A **fresh-DB `db:setup` run** is part of PR A's check [B1].

## 7. Tests

**New specs:**
- **`po-store-order.spec.js`**:
  - a 2-store paste with the **same SKU+size in both** gives 2 lines;
  - a missing price is refused and nothing is written;
  - a different price for an existing line is refused;
  - re-pasting adds;
  - every writer returns 409 after Confirm for the supplier, while a staff edit is allowed and logged;
  - an audited order is frozen for all;
  - store paste over non-store lines is refused, and "assign to store" works;
  - `scan-order` / `scan-bulk` order mode return 409 on `by_store`;
  - 0-box create;
  - boxes per store;
  - request-labels needs every box to have a store;
  - store-supplied tracking;
  - label-move refused;
  - another supplier gets 403;
  - **the supplier JSON has no stripped keys**;
  - the non-store whole-order paste is unchanged.
- **`po-store-receiving.spec.js`**:
  - the box→label link via `po_box_id`;
  - an edited non-matching tracking is refused on a store PO;
  - a dashed tracking matches;
  - a loose unattributed box shows "Not tied", and "tie later" fixes it;
  - cost by store.
- **`po-store-audit.spec.js`**:
  - 3 stores: exact / short 2 of one size / over 1 of another (not netted);
  - $ owed;
  - charges, including negatives;
  - receipt $ ≠ statement highlighted;
  - not landed → no "short";
  - Call it landed;
  - the late-list flag;
  - auto-reconcile skipped until audited;
  - Mark audited snapshots and freezes, and Unaudit;
  - `7.5W` and dual codes don't fake a shortage;
  - PDF/CSV rows equal the API;
  - the alert fires once on landed and re-fires on changed numbers;
  - receipt AI read with a fake reader URL.
- **`presell-po-cap.spec.js`**:
  - per-PO increment cap;
  - a second PO on the same SKU+size;
  - linking an over-cap row → flagged;
  - qty down to sold allowed;
  - at-risk from this PO's batches only;
  - the post goes out once (fake Telegram, `opts.enabled`).
- **Fresh-DB `db:setup`** in a throwaway database.

**Re-run:** `po-paste`, `po-order-manifest`, `po-supplier-raised`, `po-manifest-window`, `po-wholeorder-1id`, `po-edit`, `po-box-diffs`, `po-received-*`, `po-link-batch`, `receiving-*`, `cost-*`, `buy-cart`, `presell-*`, `alerts*`, `est-timezone`.

## 8. Joey's 260 pairs now (no build)

1. Joey raises the order himself and pastes **one** whole-order list with prices. **One price per SKU**: today's parser re-prices every pair of a SKU to the last price it sees [M8].
2. In the PO's **comment thread** (internal), PH records which store each tracking number belongs to. Don't use the reconcile note, which is supplier-visible and gets overwritten.
3. Brent receives each box **with its tracking scanned**. It's optional in the app, so this is a must by instruction until PR C.
4. Kevin audits by hand with Reconciliation and Jamiah's received export.
5. When PR B ships, staff convert this order with "Assign these lines to a store", if wanted.

I (Kervy) train Joey on step 1 (T-1278 / T-1309).

## 8b. Review of v2 against the code — build rules (2026-10-23)

These override anything above that disagrees.

**Schema and migrations**
- **Foreign keys are CASCADE, not RESTRICT.** RESTRICT broke `deletePo`, whose cascade reaches charges and receipts. The **API** refuses instead:
  - `po/delete` and store removal are refused while a charge or receipt exists, or while the list is confirmed.
  - Deleting an order also deletes its receipt files in R2.
  - *(Done in PR A.)*
- **`db:go-live` WIPE** lists the 4 new tables. *(Done in PR A.)*
  - `presell_stock.po_id` already trips its safety check today. That is a known old issue and is left alone.
- **Legacy pre-sell rows are backfilled** into `presell_stock_po` (row qty → its `po_id`). The backfill is idempotent. *(Done in PR A.)*
- **The index swap in PR B keeps the same name** `po_lines_po_sku_size_idx`. It is not "new name then drop" [B-1]:
  - **Why not a new name:** :903 recreates the old name on every run, and db-setup has no transaction across calls.
  - **The change:** edit the block at ~:1086 so the predicate adds `AND po_store_id IS NULL`.
  - **How it runs:** the DROP + CREATE goes in **one multi-statement `sql()` string**, which Postgres runs as one implicit transaction.
  - **Line :903:** it stays as is. It's a no-op on existing databases and runs before `po_store_id` exists on a fresh one.

**What suppliers can see** [M-c]
- One `supplierPoView(data)` helper in `api/_lib` is used by **every** supplier-reachable endpoint that returns order data:
  - `po/get`, `po/list`;
  - `po/track-refresh` (it already leaks `entered_by_name` / `batches` today);
  - `po/close-box`, `po/ship`, `po/reopen-box`, `po/request-labels`;
  - the new store endpoints.
- It strips the audit, landed, invoice and charge fields, `reconciliation`, `reconcile_note_by` and `labels_key`.
- The e2e key assertion covers every one of those endpoints.
- `listPos` stops selecting `audit_snapshot` for staff list rows.

**Closing, audit and reconcile** [M-d, M-e]
- On `by_store` orders, `po/reconcile` (the manual Reconcile button) returns 409 and points to **Mark audited**.
- `autoReconcileIfClean` skips **every** `by_store` order. That one gate also covers the `reconcile-list` sweep.
- **Mark audited** requires status `receiving` and the order to have landed.
- A **replacement reopen** (`reopenPoForReceiving`) marks the audit superseded:
  - it clears `audited_*` and writes a system comment;
  - the old snapshot is kept in the comment as history.
- **Unaudit** sets the status back to `receiving` and clears `reconciliation` and `reconciled_at`.
- Kevin settles replacements on store orders by hand (`settleReplacementIfArrived` doesn't run for them).

**Tying received pairs to labels** [M-f, M-g, M-h]
- **One shared matcher** — "`batch_boxes.po_box_id = label.id` OR normalised tracking" — is used everywhere a received box is matched to a label:
  - `getPoReceivedBoxes`, `getPoFull.received_units`;
  - `poBoxReceived`, which guards `removePoBox` / `label-move`;
  - `cost-backfill`;
  - the receiving client's `trackedLabel` / `slotKey`.
- `batch_boxes.po_box_id` **has no unique index**, because two cartons can share one label.
- **Setting `po_box_id`:**
  - `addBatchBox` sets it on the existing-slot branch too, since `sync-boxes` usually creates the row first.
  - `sync-boxes` carries `poBoxId`.
  - `renumberBatchBox` keeps it.
  - `linkBatchToPo`'s `boxMap` writes it.
  - `unlinkBatchFromPo` clears it.
- **Server-side refusals on `by_store` orders:**
  - the single-batch `commit` with a `poId`;
  - `noTracking` on `create-open`.
- **When a store box has no tracking yet**, Brent isn't stuck:
  - If he opened it from the label (`poBoxId` sent), it's accepted, and he can save the carton's number onto that label (`tracking_source='store'`).
  - Otherwise: "Receive without a label → tie it later".
- **New endpoint `po/store-tracking`** (supplier on their own store box, plus staff) records a store's own tracking number, with the same uniqueness and format checks and 17TRACK registration.
- `removePoBox`'s "keep at least one label" rule is relaxed for `by_store` orders, where 0 boxes is a valid state.

**Who can edit the list** [M-j]
- `orderListEditBlock` is also called from:
  - `lines-dimensions.js`;
  - `po/update.js` (refuse `order_kind='boxes'` on `by_store`);
  - `po/delete`.
- `line.js` uses **only** the new helper for order-level lines.
- Supplier list edits: allowed in **draft, shipped and receiving** until Confirm.
- In `store-list`, a 23505 from the old index during the deploy gap is mapped to a clear message.

**Pre-sell** [M-i]
- `presell_sales` gets **`po_id`**, set at sale time from the row's `po_id`, so "sold for this PO" can be counted.
- The `qty` action applies to the row's current `po_id` (`presell_stock_po` changes by the difference).
- `details` re-pointing a row's `po_id` moves nothing; the new PO starts at 0.
- `rcCodes` and `rcSizeNum` are exported from db.js.

**Receipts, alerts, costs and privileges**
- **Receipt endpoints are copied from `cart/file-*`, minus the cart-only parts:** buyer access, the cart status gate, the `cart_code` regex, event logging and the gift-card branch.
- **The AI reader URL becomes env-overridable** (`RECEIPT_AI_URL`), so e2e can point it at a fake reader. A double read costs about $0.005.
- **The email-receipt picker is staff-only.**
- **`audit_po` is added to `PRIVILEGES`** (`buycart.js`) and to the client list. Suppliers can't hold it.
- **Alert:** every new trigger runs `reconcileOutcomeForIntake` then `alertPoDiscrepancy`, with a `by_store` body. The triggers are link, unlink, tie later and **Call it landed**.
- **Fill costs from this order's list:**
  - a new ph_team endpoint, scoped by `poId`;
  - its own-label match uses `po_box_id`;
  - an unattributed box gets **no** store price guess (blank).

## 9. Decisions — SETTLED 2026-10-23 (user: "go with your recommendations")

- Kevin is **ph_team**. Give his account the new **`audit_po`** privilege; admins have it automatically.
- D1–D7 below are decided as recommended.

- **D1 — no charge gate.** Revised, because stores charge at purchase. Optional "Invoice checked" only.
- **D2 — who audits.** A new privilege, `audit_po` (Kevin; admins automatically). It gates charges, credits, Mark audited and Unaudit. Viewing stays with warehouse and ph_team, as today. *What role is Kevin's account?*
- **D3 — Joey sees the variance?** Recommended: no. Staff send him the PDF.
- **D4 — store orders for any supplier?** Recommended: yes. They switch on with `byStore` or a `Store:` paste.
- **D5 — $ owed on shelf price only?** Recommended: yes. Tax and other extras show in "Charged − declared".
- **D6 — a list entered after the pairs arrived?** Recommended: allow it, flagged on the audit.
- **D7 — AI reading of receipt photos?** Recommended: on (about $0.002 each). A person always confirms the amount.

## 10. Out of scope (noted)

- Teaching the email-receipt parser Athlete's Foot (`detectStore` plus a line parser, then a Make sync). Do it if email receipts turn out to be common.
- Importing the Capital One statement as CSV. Charges are typed for now. A later import could auto-match on date and amount.
- Pre-sell arrivals still count any batch of the same SKU+size (the arrival post). The at-risk check in §4.9 uses this PO only.
- The GS `Y` vs men's size collision in matching (§4.9).
