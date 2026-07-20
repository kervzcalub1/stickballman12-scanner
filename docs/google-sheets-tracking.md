# Mirror tracking updates into a Google Sheet

The PO tracking system pushes every shipment-status change into a Google Sheet you
control, so the warehouse's existing "tracking labels" sheet stays current automatically.

## How it flows
```
17TRACK  ──push──▶  /api/po/tracking-webhook  ──▶  Postgres (po_boxes)
                                              └──▶  Google Apps Script Web App ──▶ your Sheet
```
17TRACK only pushes to ONE URL (ours). Our webhook updates the database and then forwards
the same update to your Apps Script. Manual "Refresh tracking" pulls do the same. It's
best-effort and env-gated: nothing happens until `GOOGLE_SHEETS_TRACKING_URL` is set, and a
slow/broken Sheet never blocks the database write.

## Payload we POST to your Apps Script
```json
{
  "source": "stickballman12",
  "updates": [
    {
      "trackingNumber": "1Z999AA10123456784",
      "status": "InTransit",          // raw 17TRACK status text
      "stage": "in_transit",           // our mapped stage: pre_transit | in_transit | delivered
      "carrier": "UPS",
      "lastCheckpoint": "Departed facility - Louisville, KY"
    }
  ]
}
```
`stage` values: **pre_transit** = label made, parcel still with the supplier · **in_transit**
= courier has it · **delivered** = arrived.

## Setup (one time)
1. Open your tracking Google Sheet → **Extensions → Apps Script**.
2. Paste the script below. Set `SHEET_NAME` to your tab name and `TRACK_COL_HEADER` to the
   header of the column that holds the tracking number.
3. **Deploy → New deployment → Web app** — *Execute as:* **Me**, *Who has access:* **Anyone**.
   Copy the `/exec` URL.
4. Set it on the server: `GOOGLE_SHEETS_TRACKING_URL=<that /exec URL>` (Railway env var).

The script **updates the matching row** by tracking number (writing Status / Stage / Carrier /
Last checkpoint / Updated columns, creating them if missing), and **appends a new row** if the
tracking number isn't in the sheet yet.

```javascript
// Google Apps Script — receives tracking updates from Stickballman12 and upserts rows.
const SHEET_NAME = 'Labels';            // <-- your tab name
const TRACK_COL_HEADER = 'Tracking #';  // <-- header of your tracking-number column

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // serialize concurrent pushes so rows don't collide
  try {
    const body = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    const headers = ensureHeaders_(sheet);
    const trackCol = headers.indexOf(TRACK_COL_HEADER);
    if (trackCol < 0) throw new Error('No "' + TRACK_COL_HEADER + '" column');

    const data = sheet.getDataRange().getValues();       // includes header row
    const norm = (s) => String(s || '').trim().toUpperCase();

    (body.updates || []).forEach(function (u) {
      const key = norm(u.trackingNumber);
      if (!key) return;
      let rowIdx = -1;
      for (let r = 1; r < data.length; r++) {
        if (norm(data[r][trackCol]) === key) { rowIdx = r; break; }
      }
      const now = new Date();
      if (rowIdx === -1) {
        const row = new Array(headers.length).fill('');
        row[trackCol] = u.trackingNumber;
        setCol_(row, headers, 'Status', u.status);
        setCol_(row, headers, 'Stage', u.stage);
        setCol_(row, headers, 'Carrier', u.carrier);
        setCol_(row, headers, 'Last checkpoint', u.lastCheckpoint);
        setCol_(row, headers, 'Updated', now);
        sheet.appendRow(row);
        data.push(row); // keep local copy in sync for this batch
      } else {
        writeCell_(sheet, headers, rowIdx, 'Status', u.status);
        writeCell_(sheet, headers, rowIdx, 'Stage', u.stage);
        writeCell_(sheet, headers, rowIdx, 'Carrier', u.carrier);
        writeCell_(sheet, headers, rowIdx, 'Last checkpoint', u.lastCheckpoint);
        writeCell_(sheet, headers, rowIdx, 'Updated', now);
      }
    });
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// Ensure our output columns exist; return the header array.
function ensureHeaders_(sheet) {
  let headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0];
  ['Status', 'Stage', 'Carrier', 'Last checkpoint', 'Updated'].forEach(function (h) {
    if (headers.indexOf(h) === -1) {
      sheet.getRange(1, headers.length + 1).setValue(h);
      headers.push(h);
    }
  });
  return headers;
}
function setCol_(row, headers, header, val) {
  const i = headers.indexOf(header);
  if (i >= 0 && val != null) row[i] = val;
}
function writeCell_(sheet, headers, rowIdx, header, val) {
  const i = headers.indexOf(header);
  if (i >= 0 && val != null) sheet.getRange(rowIdx + 1, i + 1).setValue(val);
}
```

## Notes
- Re-deploy the Web App (New deployment) if you change the script; the `/exec` URL stays stable
  for a given deployment.
- The Apps Script is the layout adapter — change which columns it writes without touching the
  app. The app only ever sends the JSON above.
