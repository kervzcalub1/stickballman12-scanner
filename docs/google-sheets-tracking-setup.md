# Shipment Tracking ⇄ Google Sheet — Integration Guide

How the label ledger (Google Sheet) and the app stay in sync for shipment
tracking. **The server is the source of truth**; the sheet is the team's label
ledger. There are exactly **two touchpoints** between them.

```
① Registration   📗 Sheet ──POST numbers──► 🖥️ Server ──/register──► 🛰️ 17TRACK
② Updates         🛰️ 17TRACK ──push──► 🖥️ Server ──forward──► 📗 Sheet
```

- **① You push numbers in.** When a label goes into service, the Apps Script sends
  its tracking number to the server, which registers it with 17TRACK so 17TRACK
  starts webhook monitoring.
- **② The server pushes status out.** When 17TRACK reports a change, it pushes to
  the server; the server updates the app database and forwards the update to the
  sheet. The sheet only ever **receives** — it never reaches back into the server.

> **Why this shape?** 17TRACK notifies one place (the server), and the server is the
> single source of truth. The sheet is a downstream ledger the server keeps fresh.

---

## Endpoint ① — Register tracking numbers (you → server)

The Apps Script decides **which** numbers and **when** (register only labels put
into service — see the quota note), then POSTs them here.

```
POST  https://stickballman12.com/api/po/tracking-register?secret=<SHARED_SECRET>
Content-Type: application/json

{ "trackingNumbers": ["1Z3YY4080322074505", "1Z3YY4080328268698"] }
```

Also accepts a single `{ "trackingNumber": "1Z…" }` or per-number carrier hints
`{ "items": [{ "number": "1Z…", "carrier": 100002 }] }` (carrier optional —
17TRACK auto-detects).

**Response (200):**

```json
{ "ok": true, "received": 2, "accepted": 2, "rejected": 0, "rejectedDetail": [] }
```

| Field | Meaning |
|---|---|
| `received` | numbers you sent, after de-dupe |
| `accepted` | newly registered with 17TRACK |
| `rejected` | e.g. already-registered or invalid |
| `rejectedDetail` | `[{ number, error }]` when `rejected > 0` |

> **"Already registered" is a rejection, not a failure** — the number is still
> tracked. Re-sending is safe, so you can register idempotently.

> ⚠️ **Register only labels in service, not the whole pre-made pool.** 17TRACK
> charges a tracking slot per registered number; unused labels sitting at
> "InfoReceived"/"NotFound" waste quota. Delivered parcels auto-stop and free their
> slot (the server calls `/stoptrack` on delivery).

---

## Endpoint ② — Receive status updates (server → you)

When 17TRACK reports a change, the server updates the app and then POSTs the update
to your Web App. Your `doPost` writes the ledger row.

**What the server sends you:**

```json
POST <your /exec URL>?secret=<SHARED_SECRET>
{
  "source": "stickballman12",
  "updates": [
    {
      "trackingNumber": "1Z3YY4080322074505",
      "status": "InTransit",       // raw 17TRACK status text
      "stage": "in_transit",       // pre_transit | shipped | in_transit | delivered | null
      "carrier": "UPS",            // may be null
      "lastCheckpoint": "Departed facility – Louisville, KY"  // may be null
    }
  ]
}
```

- Every field except `trackingNumber` may be `null`.
- `updates` may hold several entries in one call.
- **Fire-and-forget:** the server sends with a 6-second timeout and **ignores your
  reply** and does not retry — so keep `doPost` fast.
- You receive updates for **every** registered number, including labels the app
  doesn't own (the ledger is the full pool). Append rows you don't recognize —
  that's expected, not an error.

---

## The Apps Script

Handles both touchpoints: `doPost` (receive ②) and `registerNumbers` (send ①).

```javascript
// ── Config ────────────────────────────────────────────────
const SHEET_NAME   = 'Tracking';
const SHARED_SECRET = 'PUT_A_LONG_RANDOM_STRING_HERE';   // same value used on both URLs' ?secret=
const REGISTER_URL  = 'https://stickballman12.com/api/po/tracking-register';
const HEADERS = ['Tracking Number', 'Carrier', 'Status (raw)', 'Stage', 'Last Checkpoint', 'Updated At'];

// ── ② Receive status updates from the server ─────────────
function doPost(e) {
  if (SHARED_SECRET && (!e || !e.parameter || e.parameter.secret !== SHARED_SECRET))
    return json({ ok: false, error: 'unauthorized' });
  if (!e || !e.postData || !e.postData.contents) return json({ ok: false, error: 'no body' });

  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json({ ok: false, error: 'bad json' }); }

  var updates = (body && Array.isArray(body.updates)) ? body.updates : [];
  if (!updates.length) return json({ ok: true, applied: 0 });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);   // serialize concurrent pushes so read-modify-write can't race
  try {
    var sheet = getSheet(), applied = 0;
    for (var i = 0; i < updates.length; i++) if (upsertRow(sheet, updates[i])) applied++;
    return json({ ok: true, applied: applied });
  } finally {
    lock.releaseLock();
  }
}

// ── ① Send label numbers to the server for registration ──
// Call this with an array of tracking-number strings when labels go into service.
function registerNumbers(numbers) {
  var res = UrlFetchApp.fetch(REGISTER_URL + '?secret=' + SHARED_SECRET, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ trackingNumbers: numbers }),
    muteHttpExceptions: true
  });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText());   // { ok, accepted, rejected, … }
  return JSON.parse(res.getContentText());
}

// ── helpers ───────────────────────────────────────────────
function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { sheet = ss.insertSheet(SHEET_NAME); sheet.appendRow(HEADERS); sheet.setFrozenRows(1); }
  return sheet;
}

function upsertRow(sheet, u) {
  var number = String(u.trackingNumber || '').trim();
  if (!number) return false;
  var row = [number, u.carrier || '', u.status || '', u.stage || '', u.lastCheckpoint || '', new Date()];
  var last = sheet.getLastRow();
  if (last >= 2) {
    var keys = sheet.getRange(2, 1, last - 1, 1).getValues();   // column A, data rows
    for (var r = 0; r < keys.length; r++) {
      if (String(keys[r][0]).trim().toUpperCase() === number.toUpperCase()) {
        sheet.getRange(r + 2, 1, 1, row.length).setValues([row]);   // overwrite existing row
        return true;
      }
    }
  }
  sheet.appendRow(row);
  return true;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
```

> Prefer a full history log (every push its own line)? Delete the search-and-overwrite
> block in `upsertRow` and always `sheet.appendRow(row)`.

---

## Deploy the Apps Script

1. Open the spreadsheet → **Extensions → Apps Script**.
2. Paste the code, replace `SHARED_SECRET` with a long random string, **Save**.
3. **Deploy → New deployment → Web app**. **Execute as: Me**, **Who has access: Anyone**.
4. **Deploy**, authorize, copy the **Web app URL** (ends in **`/exec`**).

Later code changes need a redeploy to reach the same URL: **Deploy → Manage
deployments → ✏️ edit → Version: New version → Deploy**. ("New deployment" mints a
new URL instead.)

---

## Server configuration (Railway)

| Env var | Purpose |
|---|---|
| `TRACKING_API_KEY` | 17TRACK API token — registration, status pulls, stop-track. |
| `TRACKING_WEBHOOK_SECRET` | Shared secret gating both server endpoints. Use the **same** value as the Apps Script `SHARED_SECRET`. |
| `GOOGLE_SHEETS_TRACKING_URL` | Your Apps Script `/exec` URL **with `?secret=` appended**. This is where the server forwards updates (endpoint ②). **Required** — without it the ledger stops updating. |

The **17TRACK Package Webhook** points at the **server**
(`https://stickballman12.com/api/po/tracking-webhook?secret=…`), not at the sheet.

---

## Verify after deploy

- **Endpoint ①:** call `registerNumbers(['1Z…'])` from the Apps Script editor;
  expect `{ ok: true, accepted: 1 }` and the number appearing in the 17TRACK dashboard.
- **Endpoint ②:** fire the 17TRACK dashboard's **Test Webhook**, then check the
  Railway logs for a line like
  `[po/tracking-webhook] parsed 1 1Z…:InTransit→in_transit`. If it logs
  `parsed 0 (none)` or `0 parsed — body keys: …`, the push payload shape changed and
  the parser needs adjusting (`api/_lib/tracking.js` → `parseWebhook`/`parseTrackEntry`).
- Confirm a matching box updates in the app and the row appears/updates in the sheet.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Registration returns `rejected > 0` | Check `rejectedDetail`. "Already registered" is fine; other errors mean a bad number or a plan/quota limit. |
| `{ ok:false, error:"unauthorized" }` | `?secret=` doesn't match: for ① the Apps Script `SHARED_SECRET` ≠ server `TRACKING_WEBHOOK_SECRET`; for ② the server's `GOOGLE_SHEETS_TRACKING_URL` secret ≠ the script's `SHARED_SECRET`. |
| Ledger stops updating | `GOOGLE_SHEETS_TRACKING_URL` unset/wrong, or the Web App wasn't redeployed after a code change. |
| Sheet has numbers the app doesn't | **Expected** — the ledger is the full label pool; the app only holds numbers registered for POs. |
| Webhook logs `parsed 0` | 17TRACK payload shape/version changed — adjust the parser (see Verify). |
| Delivered parcels keep getting updates | They shouldn't — the server calls `/stoptrack` on delivery. Confirm `TRACKING_API_KEY` is valid. |

---

## Key facts

- **The database is the source of truth; the sheet is a downstream ledger.** Read the
  app for decisions.
- **The sheet never calls the server for status** — only for registration (①). Status
  always flows server → sheet (②).
- **The webhook acks 17TRACK immediately** (200) and processes after, so a slow dyno
  can't cause a 504 that makes 17TRACK retry.
- **`ContentService` always returns HTTP 200** from Apps Script — the `?secret=` check
  is the only real gate; the server ignores the reply anyway.

---

*Related: `api/po/tracking-register.js` (①), `api/po/tracking-webhook.js` (②),
`api/_lib/tracking.js` (`registerTracking` / `parseWebhook` / `forwardTrackingToSheet` /
`stopTracking`), `docs/context/purchase-orders.md`.*
