# Sales history & velocity

Table: `sales_history` (`scripts/db-setup.mjs`). Import: `scripts/import-sales.mjs`.
Query: `salesVelocity(sku)` in `api/_lib/db.js`. E2E: `e2e/sales-history.spec.js`.

The platform **Sales Report** export — two columns, `Style ID,Sale Date`, one row per
sale — loaded so the app can answer *how fast does this actually sell*. Nothing else here
can: `items.status` only knows about pairs that went through our own flow, while this
counts every sale. The first import was **18,686 sales across 1,848 styles over 176 days**
(2026-02-28 → 2026-08-23), roughly 4,000 sales a month.

## Importing
```
node scripts/import-sales.mjs ~/Downloads/SalesReport-….csv          # local
node scripts/import-sales.mjs <file> --dry                            # parse only, write nothing
node scripts/import-sales.mjs <file> --prod                           # against PROD_DATABASE_URL
```
- **Re-importing is safe.** Exports overlap — next month's file repeats this month's
  sales — so the import **replaces everything already stored inside the file's own date
  range** before inserting. Appending blindly would silently double a style's velocity,
  and a doubled velocity is a buy decision made on a lie. Proven by importing the same
  file twice: 18,686 rows both times.
- Rows with **no Style ID** are skipped and counted (35 in the first export). Unparseable
  dates likewise.
- Dates are parsed by hand from `M/D/YYYY`. `new Date(string)` would read them in the
  host's timezone and can roll a sale back a day — this business runs on EST.
- ⚠️ **New table — `npm run db:setup` is required on every environment** before the
  import or the advisor can use it. This is the schema-drift trap in `CLAUDE.md`.

## Dual SKUs
561 of 18,721 rows carry the dual-SKU notation, e.g. `315115-112/DD8959-100`. The row
keeps the string whole in `style_id`, and `codes` holds it **split on `/` and
upper-cased**, GIN-indexed. A lookup for either half finds the sale — and finds it
**once**, because it is still one row. (Same notation that faked 154 short pairs on a PO
once; see `po-reconciliation-notation-matching`.)

## `salesVelocity(sku)`
Returns `sold_total`, `sold_30d`, `sold_90d`, `first_sale`, `last_sale`, the export's own
`data_from`/`data_to`, a `per_week` rate, and a `liquidity` band.

- **Windows are EST** (`now() AT TIME ZONE 'America/New_York'`). `current_date` follows
  the host's clock, and the PH team's day runs a day ahead of the one we file sales under.
- **The band reads off the last 30 days**, not lifetime: a style that sold well in spring
  and stopped is a slow mover *today*, and the buyer is deciding today. `≥7/week` daily,
  `≥1/week` weekly, else monthly — the same three the calculator's liquidity picker
  offers, so a suggestion needs no translation.
- **`null` means the export was never loaded**, which is different from a style that
  never sold. The advisor reports the first as unknown and the second as a fact; see
  `advisor.md`.
