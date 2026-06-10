# Stickballman12 · Shoe Scanner

A React (Vite) web app to scan a shoe barcode (UPC) or enter a SKU, look it up,
display the shoe details + one reference image, then capture sizes & quantities
and send them to a sheet.

## What it does

- **Two lookup modes**
  - **Barcode (UPC)** — the **StockX UPC Search is the primary** lookup; if it
    returns nothing or errors, the search automatically rotates to the **Alias**
    UPC API as a fallback.
    - **Barcode Scanner** — a focused input that captures a HID scanner gun (or
      manual typing) and searches on Enter.
    - **Camera** — scans the barcode with the device camera (`@zxing`).
  - **SKU** — search via KicksDB (StockX products).
- **Result** — Name, SKU, UPC (when available), and **one** reference image.
- **Sizes & quantities** — the layout depends on the provider:
  - **StockX** (UPC) resolves the exact size for the scanned barcode, so it
    shows that single size plus a **quantity text box**.
  - **Alias** (UPC) and **KicksDB** (SKU) return the full size run, shown as a
    **two-column table** (Size | Quantity) with − / + steppers per size.
  - When no sizes are known, you type sizes into editable rows and can add more.
- **Send to Sheet** — posts the product + rows to the backend.

## Security model

All third-party credentials/keys live **server-side only** (Vercel serverless
functions in `/api`) and are **never** shipped to the browser:

- Alias email/password and the KicksDB key are read from environment variables.
- The frontend only calls our own `/api/*` endpoints (same-origin).
- **Access gate**: users sign in with `APP_PASSWORD`; the server returns an
  HMAC-signed, expiring session token (`SESSION_SECRET`) required by every API.
- Input validation (UPC digits, SKU charset), per-IP rate limiting, and
  hardened HTTP headers / CSP (`vercel.json`).

## Run locally

```bash
npm install
cp .env.example .env   # then fill in values (a working .env is already present)
npm run dev            # http://localhost:5173  (API runs via Vite middleware)
```

Default local access password: `stickball2026` (change it in `.env`).

## Deploy to Vercel

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full end-to-end guide,
including the Google Sheets service-account setup and all environment variables.

## "Send to Sheet" integration (Google Sheets API)

`/api/send-to-sheet` appends one row per variant directly to a Google Sheet
using a service account. Until the `GOOGLE_*` keys are provided, submissions are
validated and acknowledged as a stub. Request shape (from the browser):

```json
{
  "product": { "name": "…", "sku": "…" },
  "rows": [{ "size": "10", "quantity": 2 }]
}
```

Each variant becomes a sheet row across columns **A–I**:
`[ unique_id, name, sku, size, quantity, "", "", "Not Added", "" ]`
(unique_id, Product Name, SKU, Size, Quantity, Price, Remarks, Status, Added by).

**Concurrency safety.** Google's `values.append` + `OVERWRITE` can silently
overwrite rows when two users submit at the same instant (measured: 37/40 rows
lost in a 40-way burst). To prevent that, each row carries a per-row `unique_id`
in column A; after appending, the server reads those cells back and re-appends
any row whose id didn't survive (bounded retries with backoff + jitter). Keep
column A **hidden + protected**, with the service account granted edit access.
This eliminates loss at realistic concurrency; note that very large
simultaneous bursts are instead bounded by Google's per-user write quota
(~60/min). See [DEPLOYMENT.md](./DEPLOYMENT.md) for the sheet layout and setup.
