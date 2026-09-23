# Live updates (no refresh)

Every screen that shows shared data — counts, progress bars, lists, statuses — updates
itself within about a second of anybody's write. Added 2026-09-23.

## How it works

```
any write ──► Postgres trigger sb_live (per STATEMENT) ──► pg_notify('sb_change', '<table>')
                                                                  │
server: api/_lib/live.js — ONE dedicated LISTEN connection, folds a 250 ms burst into one message
                                                                  │
GET /api/live — one SSE stream per open tab: `event: change` / `data: {"tables":[…]}`
                                                                  │
browser: src/lib/live.js — one shared stream per tab (fetch + SSE parser, reconnects)
                                                                  │
useLive(tables, reload) in src/hooks.js — the screen re-reads through its OWN endpoint
```

- **The payload is a table name and nothing else.** No row, id or value travels on the
  stream, so it cannot show anybody something their own call would not: each screen
  re-reads through its ordinary, authorised endpoint. That is also why the stream needs
  only `requireAuth`, not a role.
- **Triggers, not endpoint code.** No write path can forget to announce itself — scripts,
  merge tools and endpoints added later are covered for free. `LIVE_TABLES` in
  `scripts/db-setup.mjs` is the list; **a new table a screen reads has to be added there**
  (and `db:setup` run) or its screen will only update on the 60 s fallback.
- **Not announced:** `login_attempts`, `locks`, `edit_locks` (PH presence has its own
  heartbeat loop), `telegram_link_requests`, `scan_failures`.
- **Statement level:** a 200-row bulk update is one notice.
- **Only when rows moved.** A statement trigger fires even when its WHERE matched nothing,
  and some READ paths run a checking UPDATE (`po/reconcile-list` auto-closes clean POs on
  every read). Announcing those made reading a page a "change", so every open copy of it
  read again — forever. Each table therefore has three triggers (`sb_live_ins/_upd/_del`,
  each with a transition table `changed`, one event per trigger is a Postgres rule) that
  notify only `IF EXISTS (SELECT 1 FROM changed)`, plus `sb_live_trunc`. **Checked:**
  every warehouse/admin screen (27) and PH screen (12) was opened and left idle — zero
  notices. A read that genuinely writes every time would loop; don't build one.

## `useLive(tables, reload, opts)`

`opts`: `paused` (a write of the user's own is in flight, or a draft a reload would
clobber), `every` (fallback poll, default 60 s; 0 = off), `mount` (run once on mount;
`false` when the screen already loads itself), `minGap` (default 1.5 s).

The rules that keep it out of the way:
- never overlapping; a change landing mid-read runs **one** more read after it;
- never while the tab is hidden — catches up the moment it is visible again;
- never while `paused` — catches up when the pause lifts;
- at most one read per `minGap` — `items` changes on every scan, and a floor scanning at
  speed must not turn every watching screen into a busy loop;
- never a spinner; callers swap state **only when it changed**
  (`setX(cur => JSON.stringify(cur) === JSON.stringify(n) ? cur : n)`), so a half-typed
  input, a scroll position, a selection or an open row is never disturbed.

In-progress local drafts (the Receiving cart, a box being packed, a PO being created) are
**not** live-reloaded — only the server-backed data around them.

**`afterTyping(sel)`** (hooks.js): a reload that would re-seed inputs from the server value
(PoDetail's line rows, SupplierApp's scanned lines, Pre-sell's per-size counts, which are
keyed on the server count) awaits it first, so a re-read never lands under a cursor.

**Heavy lists use `minGap: 5000`** — Inventory's list, Shelve, PO Overview, Inbound,
Reconciliation, the Home inbound bar, the PH grid. They all watch `items`, which moves on
every scan; 5 s is still far under "refresh to see it". Reconciliation's list rebuilds every
open PO's state per read: if prod load shows it, drop `items` from its tables first.

## What is live (2026-09-23)

| Live | Not live, and why |
|---|---|
| Home badges + inbound bar, Inventory (list + unit), Batches (list + open batch), Receiving → Recent, Shelve list, Mark Shipped "remaining", No Box, Box Stock, Locations (list + open shelf), 1ID stock, In-Store Listing, Deleted, Costs, PO Overview, PO detail, Inbound, Reconciliation, Supplier portal orders, Rescale requests, Pre-sell, Merge tools, Create-PO supplier list, Buying requests (list + request), PH grid (via `quietRefresh`) + rescale chips, PH edited photos, Listing-photos modal, Check Access, Payout presets | Receiving wizard's cart and Existing Stock (one person's unsaved scan draft); Settings (a two-field admin form — would overwrite typing); Box Labels (one scan's lookup + a chosen size); Image Finder / Price Inquiry (marketplace searches, not our tables); SOP (static). Telegram "waiting" list in Check Access reads `telegram_link_requests`, which is not announced → 60 s fallback. |

PH grid: its old 15 s `setInterval` is now `useLive`'s fallback (`LIST_POLL_MS`), and a
hidden PH tab no longer polls — it catches up when it is shown again.

`usePendingCounts` (every home badge) is live. The PH grid keeps its own `quietRefresh`
loop (row freeze, edit locks); `useLive` just calls it sooner.

## Reliability

- The server's listener reconnects on its own (3 s). After a reconnect it sends `"*"`,
  and every open screen re-reads once — anything written while it was deaf was never
  announced.
- The browser reconnects with backoff (1 s → 30 s) and also re-reads everything once it
  is back. A 401 stops it; the next ordinary call signs the person out.
- Streams are closed by the server after 30 minutes so the token is re-checked; the
  client reconnects immediately.
- Hard cap of 400 open streams (`MAX_STREAMS`), 25 s heartbeat (under proxy idle cuts).
- The **dot beside the clock** says which state a page is in: green = live, amber =
  reconnecting (what is on screen may be behind), none = nothing on this page is live.
- `LISTEN` needs a real session: a transaction-mode pooler (pgbouncer) in front of
  Postgres would silently break it. Railway's Postgres is direct.

## Testing gotcha: never wait for `networkidle`

Every page holds its live stream open, so Playwright's `networkidle` never arrives and the
wait times out (CI failed two specs on exactly this on the first push). Wait for the
response the assertion actually depends on (`page.waitForResponse(r => r.url().includes('/api/ph/list'))`),
or an element. The SOP screenshot scripts use `waitUntil: 'load'` for the same reason.
