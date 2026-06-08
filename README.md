# Stickballman12 · Shoe Scanner

A React (Vite) web app to scan a shoe barcode (UPC) or enter a SKU, look it up,
display the shoe details + one reference image, then capture sizes & quantities
and send them to a sheet.

## What it does

- **Two lookup modes**
  - **Barcode (UPC)** — search via the Alias UPC API.
    - **Barcode Scanner** — a focused input that captures a HID scanner gun (or
      manual typing) and searches on Enter.
    - **Camera** — scans the barcode with the device camera (`@zxing`).
  - **SKU** — search via KicksDB (StockX products).
- **Result** — Name, SKU, UPC (when available), and **one** reference image.
- **Sizes & quantities** — add a `SIZE` + `QUANTITY` row; the **+** button on
  each row adds another (− removes). Available sizes autocomplete when known.
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

1. Push to a Git repo and import it in Vercel (framework preset: **Vite**).
2. Add these **Environment Variables** (Production + Preview):
   `ALIAS_EMAIL`, `ALIAS_PASSWORD`, `KICKSDB_KEY`, `APP_PASSWORD`,
   `SESSION_SECRET`, and optionally `SHEET_WEBHOOK_URL`.
3. Deploy. The `/api` folder is auto-detected as serverless functions.

> Rotate `APP_PASSWORD`/`SESSION_SECRET` for production and never commit `.env`.

## "Send to Sheet" integration (pending)

`/api/send-to-sheet` forwards the payload to `SHEET_WEBHOOK_URL` if set (e.g. a
Google Apps Script Web App). Until that URL is provided, submissions are
validated and acknowledged as a stub. Payload shape:

```json
{
  "submittedAt": "ISO-8601",
  "name": "…", "sku": "…", "upc": "…", "image": "…",
  "rows": [{ "size": "10", "quantity": 2 }]
}
```
