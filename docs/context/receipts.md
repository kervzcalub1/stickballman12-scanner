# Email receipts — every store receipt in our mailboxes, filed by where and who

Built 2026-10-06 (task passed from JK to Kervy: "Foot Locker receipt parser and organized
receipt storage"). Screen `src/screens/Receipts.jsx` at **`/receipts`** (staff home →
In-Store Mode) and **`/ph/receipts`** (PH home → Purchase Orders). E2E: `e2e/receipts.spec.js`.

## Why
Receipts reach us by email, and finding one meant asking the buyer or searching the
mailbox by order number (`cart/receipt-email`, buy-cart.md). The ask: file them
**automatically** as they arrive — spam included, because some land there — and say
**where** each purchase was made (store, address, city, state, ZIP) and **who** made it,
so Council's buys can be told from Joey's, without Joey sending his receipts in by hand.

## The two halves
**Make (the reader)** — a scheduled "Receipt sweep" scenario reads the order mailboxes
(Gmail incl. Spam, the Yahoo folders incl. Bulk), parses each receipt email with the same
`parser.js` as the order-number lookup (scenario 6282792), and POSTs one email per call to
our ingest endpoint. Requested from the Make session on 2026-10-06 with the full contract
(store_location + recipients added to the parser, spam folders added to the lookup too).
Status (2026-10-07, from the Make session): **parser done, sweep built but NOT deployed.**
- `parser.js` (`~/Make.com Stickballman12/receipt-parser/`) has a `mode:"sweep"` entry
  beside the order-number lookup — one parser for both. It now emits `store_location`
  (in-store header block; online with no printed address → all null, never invented),
  `recipients` (from the mail module's **`headersList`**, not `headers`; `original_to` =
  X-Forwarded-To / X-Original-To / Resent-To, else the forwarded block's `To:`),
  `order_number`, and `message_key` = `mailbox|folder|<Message-ID>` (fallback
  `from~subject~date`). Marketing / shipping notices → `post:false`, not sent; an
  unsupported store with order # + totals is still sent (`store:null` + warnings).
  Tests: `test.js` 8/8, `test-sweep.js` 7/7.
- Spam: Yahoo `Bulk` added to `YAHOO_FOLDERS` (9 folders). **Gmail Spam is NOT in
  `[Gmail]/All Mail`** — it needs its own `[Gmail]/Spam` search module (in the sweep; a
  pending edit to 6282792 too).
- Sweep: `sweep-blueprint.json` — tick → router: Gmail All Mail · Gmail Spam · the 9 Yahoo
  folders → parse → POST (filter `post = true`), window 2 days, ≤50 mails/folder, every
  15 min, every module `onerror: Resume`. Key placeholder `__PASTE_RECEIPT_INGEST_KEY__`.
  **Untested against Make** — on the first run watch the router filter and the
  `headersList` mapping.
- Blocked on Kervy: Make MCP re-auth (nothing can be deployed), and `RECEIPT_INGEST_KEY`
  on Railway (prod ingest answered 503 on 2026-10-07). Deploy order: 6282792 from the new
  parser + its Gmail Spam module → create the sweep → paste the key.
- Not needed: headers through Yahoo helper 6283660 — the order-number lookup
  (`cart/receipt-email`) never reads recipients/location; only the sweep does.

**App (the filer)** — this repo:
- `POST /api/receipts/ingest` (`x-api-key: RECEIPT_INGEST_KEY`, compared in constant time;
  unset → 503). Body = the contract in the endpoint's header comment. It only ever ADDS:
  `message_key` (mailbox + folder + Message-ID) is unique, so the sweep's overlapping
  windows re-send harmlessly (`duplicate: true`). Unknown money stays NULL, never 0.
- `email_receipts` — the receipt: mailbox/folder, from, subject, recipients (as sent) +
  `recipient_addrs` (every address, lower-cased — what buyers match on), store + location,
  order number, totals, items (JSONB, same shape as the lookup: `final_price` = LINE total),
  parser warnings, the email text, buyer (`buyer_user_id`, `buyer_source` email|manual).
- `user_purchase_emails` — the addresses a buyer orders with. **One address, one person**
  (unique on lower(email)).

## Who bought it
The store emails the receipt to the address on the order. A receipt is filed under the
person who registered ANY of its recipient addresses — to, cc, delivered-to, or the
**original recipient of a forward** (a buyer who forwards their receipts to the order
mailbox is matched by their own address).
- **Suppliers add their own** on their Buying Requests page (`PurchaseEmails`, mode
  'mine') — we can't know which address a supplier buys under unless they say. Staff can
  too (same endpoint, own account). Shared env logins can't own one.
- **Admins manage everyone's** from the Receipts page → "Purchase emails" (mode 'all').
  A taken address answers 409; an admin is told whose, a supplier only that it's taken.
- **Registering an address claims the receipts that already arrived to it** — only ones
  nobody assigned. A person's assignment is never overwritten.
- Removing an address stops future matches; filed receipts keep their buyer.
- **Admin assigns by hand** on a receipt (`POST /api/receipts/assign`) when nothing matched
  or it matched wrongly → `buyer_source = 'manual'`.
- Council vs Joey **by state / store**: the location is stored and filterable; the rule
  itself waits on Jemiah / Jared (asked 2026-10-07). Until then, the buyer comes from the
  registered addresses or an admin.

## The page
Chips per buyer (count + total; "Unassigned" is one of them), filters for store, state,
EST date range and search (order #, store, city, email). Rows: received (EST, a **spam**
tag when it came from a spam folder), store + city/state/ZIP, order #, buyer, pairs, total,
and the **buying request** it belongs to. That link is found at READ time: a request's
emailed receipt is filed as `Email receipt <order>.txt` (cart/receipt-email), so a receipt
the sweep filed first still links once the buyer attaches it. Detail: location, recipients,
items, totals, parser notes, the email text. Staff only (`warehouse`, `ph_team`, admin);
suppliers get 403 — they register addresses, they don't browse the mailbox.

## Env
`RECEIPT_INGEST_KEY` — any long random string; the same value goes in the Make scenario
(pasted by a person, never sent through chat). Local `.env` has one for the suite.

## Not yet
- The Council/Joey state rule (waiting on the answer).
- A supplier's view of their own filed receipts.
- Auto-attaching a filed receipt to its buying request (today it links; the request's own
  receipt step is unchanged).
