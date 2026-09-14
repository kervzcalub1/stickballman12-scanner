// The receipt: evidence, then lines.
//
// Two separate things, deliberately not one button. The FILE is the evidence — it is
// uploaded and kept whatever happens next, because "a receipt was received" is a
// closing condition on its own. The LINES are a reading of that file, and a reading can
// be wrong, so they land in an editable table and nothing is committed until a person
// has looked at them.
//
// Three ways to get the text out, in the order they cost anything:
//   · paste  — the buyer copies the order email or the web receipt. Free, exact.
//   · PDF    — pdfjs pulls the text layer out, the same machinery the PO manifest
//              import already uses. Free, exact when the PDF isn't a scan.
//   · photo  — tesseract OCR on a snap of a paper receipt. Free but rough: thermal
//              paper, creases, a car park. This is exactly why the table is editable.
//
// The two totals are both shown and neither is silently chosen: what the rows add up to
// and what the receipt SAYS. On a shop receipt they differ by the tax, and that gap is
// the difference between "we read this receipt" and "we read most of it".
import React, { useState } from 'react';
import { api } from '../api.js';
import { lazyImport } from '../lib/chunkLoad.js';
import { PriceInput } from './common.jsx';
import { parseReceipt, compareReceiptToApproved } from '../lib/receiptParse.js';
import { receiptCheckSentence } from '../lib/receiptCheck.js';

const money = (n) => (n == null ? '—' : `$${(Number(n) || 0).toFixed(2)}`);
const FLAG_LABEL = {
  bought_unapproved: 'bought but never approved',
  approved_not_bought: 'approved but not on the receipt',
  qty_differs: 'a different quantity from what was approved',
};

async function textFromPdf(file) {
  const pdfjs = await lazyImport(() => import('pdfjs-dist'));
  const workerUrl = (await lazyImport(() => import('pdfjs-dist/build/pdf.worker.min.mjs?url'))).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    // Rebuild lines by y-position: a receipt's columns arrive as separate text items,
    // and joining them with spaces in reading order is what makes "2 @ 84.99" one line
    // the parser can see rather than three unrelated fragments.
    const rows = new Map();
    for (const it of content.items) {
      const y = Math.round(it.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      out.push(rows.get(y).sort((a, b) => a.x - b.x).map((r) => r.s).join(' ').replace(/\s{2,}/g, '  ').trim());
    }
  }
  return out.join('\n');
}

/**
 * Make a phone photo of a thermal receipt legible to OCR.
 *
 * A receipt photographed on a desk is a narrow strip of small grey-on-grey text inside a
 * big frame of wood grain, and tesseract reported the one that prompted this at ~132 DPI
 * — far under what it needs. Straight off the camera it read NOTHING; grey-scaled,
 * upscaled and thresholded it recovered several rows of the same photo. Measured, not
 * assumed: the two were run against the same image and the same parser.
 *
 * Canvas only, no new dependency, and it hands back the ORIGINAL file if anything here
 * fails — a preprocessing step that can break the upload is worse than a blurry read.
 */
async function sharpenForOcr(file) {
  try {
    const bmp = await createImageBitmap(file);
    // 3× the long edge, capped: past ~4000px tesseract slows sharply for no more accuracy,
    // and a phone photo is already several megapixels.
    const scale = Math.min(3, Math.max(1, 3600 / Math.max(bmp.width, bmp.height)));
    const w = Math.round(bmp.width * scale); const h = Math.round(bmp.height * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    // Grey-scale, then push toward black and white around mid-grey. Thermal print is
    // low-contrast by nature and the paper picks up the colour of whatever it is lying
    // on; flattening both is most of what makes the digits separable.
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      const v = g > 145 ? 255 : g < 105 ? 0 : g;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    return blob || file;
  } catch { return file; }
}

async function textFromImage(file, onProgress) {
  const { default: Tesseract } = await lazyImport(() => import('tesseract.js'));
  const prepared = await sharpenForOcr(file);
  const { data } = await Tesseract.recognize(prepared, 'eng', {
    logger: (m) => { if (m.status === 'recognizing text') onProgress(Math.round(m.progress * 100)); },
  });
  return data?.text || '';
}

// TWO permissions, not one, because they are two different acts.
//
// `canUpload` is attaching EVIDENCE — a photo of a till receipt. It is safe, it is the
// thing that most often needs doing from a phone by whoever happens to have the paper,
// and holding it back is how a request sits waiting on one person. The buyer, the PH
// team, the warehouse and admin can all do it; the server re-checks and scopes a buyer
// to their own request.
//
// `canEdit` is stating WHAT THE RECEIPT SAYS — the total the whole reconciliation then
// runs against, and the lines the purchase order is raised from. That is a claim about
// money, so it stays with the buyer, either desk, or the auditor.
export function BuyCartReceipt({ cart, canUpload, canEdit, onChanged, onSignOut }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null);
  const [statedTotal, setStatedTotal] = useState('');
  // The receipt's OWN breakdown. Kept apart from the rows' sum on purpose: what the
  // lines add up to and what the shop says the goods cost are two different claims, and
  // the screen has always shown both rather than choosing.
  const [subtotal, setSubtotal] = useState('');
  const [tax, setTax] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState('');
  // Two taps to remove, without a native dialog: the row itself asks. `window.confirm`
  // is the same wrong tool as `window.prompt` — unstyleable, and it reads as the browser
  // asking rather than the app.
  const [confirming, setConfirming] = useState(null);
  // What the receipt's own arithmetic says about the reading — shown whether it agreed
  // or not, because "we checked and it adds up" is a much stronger thing to hand a
  // reviewer than silence.
  const [note, setNote] = useState('');

  const files = (cart.files || []).filter((f) => f.kind === 'receipt');
  const committed = cart.receiptLines || [];
  const approved = (cart.lines || []).filter((l) => l.status === 'approved');
  const diffs = compareReceiptToApproved(committed, approved);
  const rowsTotal = rows ? Math.round(rows.reduce((n, r) => n + (Number(r.totalPrice) || 0), 0) * 100) / 100 : 0;
  // Blank is ABSENT, not zero — the difference between "no tax was charged" and "nobody
  // read the tax", which is the same distinction the stored columns keep.
  const numOrNull = (v) => (String(v ?? '').trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const subN = numOrNull(subtotal); const taxN = numOrNull(tax); const totalN = numOrNull(statedTotal);
  const rowsMatch = subN != null && Math.abs(rowsTotal - subN) <= 0.02;
  const sumsUp = subN != null && taxN != null && totalN != null && Math.abs((subN + taxN) - totalN) <= 0.02;

  function read(t, source) {
    // Clearing it matters: a note left over from a previous AI read would sit above a
    // hand-pasted table claiming its figures had been checked.
    setNote('');
    const parsed = parseReceipt(t, { source });
    setRows(parsed.rows.map((r) => ({ ...r })));
    // The receipt's own total is what the cards were actually charged, so it is what the
    // reconciliation must run against — prefilled, and still editable.
    setStatedTotal(parsed.statedTotal != null ? String(parsed.statedTotal) : String(parsed.total || ''));
    // The text parser reads the total but not the breakdown, so these are cleared rather
    // than left showing figures from a previous read of a different receipt.
    setSubtotal(''); setTax('');
    if (!parsed.rows.length) {
      setErr(source === 'ocr'
        // Naming the cause, because the fix is in the photographer's hands and no amount
        // of retrying the same picture will help. Measured on a real one: the receipt
        // filling the frame is the whole difference between this and a clean read.
        ? 'Nothing on that photo looked like a purchased item. Retake it with the receipt filling the frame — flat, straight on, no desk around it — or paste the text instead.'
        : 'Nothing on that looked like a purchased item. Check the text, or add the lines by hand.');
    } else if (source === 'ocr' && parsed.statedTotal == null) {
      // Rows but no "Total:" line is the signature of a HALF-read photo, and half a
      // receipt is more dangerous than none — it looks like it worked. Say so while the
      // person still has the paper in front of them.
      setErr(`Read ${parsed.rows.length} line${parsed.rows.length === 1 ? '' : 's'} but couldn’t find the receipt’s own total, which usually means the photo was only partly readable. Check every row against the paper before saving.`);
    } else setErr('');
  }

  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('upload'); setErr(''); setProgress(0);
    try {
      // Store the evidence FIRST. If the reading then fails — a scanned PDF with no text
      // layer, OCR that returns mush — the receipt is still on the record, which is the
      // part that has to survive.
      const { uploadUrl, key } = await api.cartFileSign(cart.id, 'receipt', file.type);
      const put = await fetch(uploadUrl, { method: 'PUT', body: file });
      if (!put.ok) throw new Error('The upload did not go through. Try again.');
      const { file: attached } = await api.cartFileAttach({
        cartId: cart.id, kind: 'receipt', key, name: file.name,
        contentType: file.type, sizeBytes: file.size,
      });
      onChanged();

      // Somebody who may attach evidence but not state what it says gets no review
      // table — reading a receipt they cannot commit would leave a filled-in form with
      // no button, which reads as broken rather than as "not your step".
      if (!canEdit) return;

      if (file.type === 'application/pdf') {
        // A PDF already carries its text. Reading that beats looking at a picture of it,
        // costs nothing and cannot invent a digit.
        setBusy('pdf');
        const t = await textFromPdf(file);
        setText(t);
        read(t, 'pdf');
      } else if (String(file.type).startsWith('image/')) {
        // A PHOTOGRAPH goes to the vision reader first. Tesseract cannot read one: the
        // receipt that prompted this came out at ~132 DPI of grey-on-grey text and OCR
        // returned nothing at all, while the same image read cleanly here.
        setBusy('ai');
        const done = await aiRead(attached?.id);
        // Fallback, not a dead end — an unconfigured key, a timeout or a refusal drops to
        // the reader that needs no network and no budget, which sometimes still works.
        if (!done) {
          setBusy('ocr');
          const t = await textFromImage(file, setProgress);
          setText(t);
          read(t, 'ocr');
        }
      }
    } catch (ex) {
      if (ex.unauthorized) return onSignOut();
      // The file may well have landed even though the reading fell over — say so rather
      // than leaving someone re-uploading it.
      setErr(canEdit
        ? `${ex.message} The receipt itself was saved; you can still type the lines in.`
        : `${ex.message} The receipt itself was saved.`);
    } finally { setBusy(''); setProgress(0); }
  }

  /**
   * Read one uploaded receipt with the vision model. Returns true when it produced rows.
   *
   * Its output goes into the SAME editable table the text parser fills. Nothing about
   * the review step relaxes because the reading improved — if anything it tightens, as
   * this reader fails cleanly where tesseract fails visibly, so `check` (the receipt's
   * own arithmetic, run against the rows) is what a person is told before they look.
   */
  async function aiRead(fileId) {
    if (!fileId) return false;
    try {
      const r = await api.cartReceiptRead(cart.id, fileId);
      if (!r.rows?.length) return false;
      setRows(r.rows.map((x) => ({ ...x })));
      // The receipt's OWN total, never a sum of what was read — that gap is the whole
      // point of showing both.
      setStatedTotal(r.statedTotal != null ? String(r.statedTotal) : '');
      setSubtotal(r.subtotal != null ? String(r.subtotal) : '');
      setTax(r.tax != null ? String(r.tax) : '');
      setNote(receiptCheckSentence(r.check));
      setErr('');
      return true;
    } catch (ex) {
      if (ex.unauthorized) { onSignOut(); return true; }
      return false;   // fall through to tesseract
    }
  }

  function editRow(i, patch) { setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))); }
  function dropRow(i) { setRows((rs) => rs.filter((_, j) => j !== i)); }
  function addRow() { setRows((rs) => [...(rs || []), { sku: '', size: '', qty: 1, unitPrice: null, totalPrice: null, source: 'manual' }]); }

  async function commit() {
    setBusy('save'); setErr('');
    try {
      await api.cartSaveReceipt(
        cart.id, rows.filter((r) => String(r.sku || '').trim()), Number(statedTotal),
        // Blank stays blank. Sending 0 for a tax nobody read would record "the shop
        // charged no tax", which is a claim rather than a gap.
        String(subtotal).trim() === '' ? null : Number(subtotal),
        String(tax).trim() === '' ? null : Number(tax),
      );
      setRows(null); setText(''); setSubtotal(''); setTax('');
      onChanged();
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

  async function remove(f) {
    setBusy(`rm${f.id}`); setErr('');
    try { await api.cartFileDelete(cart.id, f.id); setConfirming(null); onChanged(); }
    catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

  async function download(f) {
    try {
      const { blob, filename } = await api.cartFileDownload(cart.id, f.id, 'receipt');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || f.name || 'receipt';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
  }

  return (
    <section className="card bc-receipt">
      <h3 className="bc-h">Receipt</h3>

      <div className="bc-gc-files-h">
        <span className="muted sm">
          {files.length ? `${files.length} file${files.length === 1 ? '' : 's'} on file` : 'No receipt uploaded — this is required.'}
          {!files.length && canUpload && !canEdit && (
            <span className="muted sm"> Attach it here; the desk reads it in.</span>
          )}
        </span>
        {canUpload && (
          <label className="btn sm ghost bc-upload">
            {busy === 'upload' ? 'Uploading…'
              : busy === 'pdf' ? 'Reading the PDF…'
                : busy === 'ai' ? 'Reading the receipt…'
                  : busy === 'ocr' ? `Reading the photo… ${progress}%` : 'Upload receipt'}
            {/* `capture` is deliberately absent: on a phone the file picker still offers
                the camera, and forcing it would stop somebody attaching a PDF the shop
                emailed them — which is the better evidence of the two. */}
            <input type="file" accept="image/*,application/pdf" hidden onChange={upload} />
          </label>
        )}
      </div>
      {files.length > 0 && (
        <ul className="bc-file-list">
          {files.map((f) => (
            <li key={f.id}>
              <span className="bc-file-name">{f.name || 'receipt'}</span>
              <span className="muted xs">{f.uploaded_by}</span>
              {confirming === f.id ? (
                <>
                  {/* The removal is recorded even though the file is not, and saying so
                      here is what makes the second tap an informed one. */}
                  <span className="muted sm">Remove it? The removal is logged.</span>
                  <button type="button" className="btn sm danger" disabled={busy === `rm${f.id}`}
                    onClick={() => remove(f)}>{busy === `rm${f.id}` ? 'Removing…' : 'Remove'}</button>
                  <button type="button" className="btn sm ghost" onClick={() => setConfirming(null)}>Keep</button>
                </>
              ) : (
                <>
                  <button type="button" className="btn sm ghost" onClick={() => download(f)}>Download</button>
                  {canUpload && (
                    <button type="button" className="btn sm ghost" title="Remove this file"
                      aria-label={`Remove ${f.name || 'receipt'}`}
                      onClick={() => setConfirming(f.id)}>×</button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Already committed — what the receipt says was bought, beside what was approved. */}
      {committed.length > 0 && !rows && (
        <>
          {/* Its own scroll container. A phone is the buyer's only screen, and a table
              that widens the PAGE takes the whole layout with it. */}
          <div className="bc-scroll">
          <table className="table bc-table">
            <thead><tr><th>SKU</th><th>Size</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>
            <tbody>
              {committed.map((r) => (
                <tr key={r.id} className={r.matched_line_id ? '' : 'bc-unmatched'}>
                  <td>{r.sku}</td><td>{r.size || '—'}</td><td>{r.qty}</td>
                  <td>{money(r.unit_price)}</td><td>{money(r.total_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p className="muted sm">
            {cart.receipt_subtotal != null && (
              <>Goods <b>{money(cart.receipt_subtotal)}</b>
                {cart.receipt_tax != null && <> + tax <b>{money(cart.receipt_tax)}</b></>} · </>
            )}
            Receipt total <b>{money(cart.receipt_total)}</b> · cards issued {money(cart.gc_total)} · <b>{money(cart.balance_remaining)}</b> left over.
          </p>
          {diffs.length > 0 && (
            // The whole reason both lists are kept. Approved and bought are different
            // claims, and where they part is a finding for the audit — not something to
            // tidy away by declaring whichever list is neater.
            <div className="bc-diffs">
              <b>What was bought doesn’t match what was approved:</b>
              <ul>
                {diffs.map((d) => (
                  <li key={`${d.sku}|${d.size}`}>
                    {d.sku}{d.size ? ` size ${d.size}` : ''} — approved {d.approved}, on the receipt {d.bought} ({FLAG_LABEL[d.flag]})
                  </li>
                ))}
              </ul>
            </div>
          )}
          {canEdit && <button type="button" className="btn sm ghost" onClick={() => setRows([])}>Re-read the receipt</button>}
        </>
      )}

      {canEdit && !committed.length && !rows && (
        <div className="bc-paste">
          <textarea className="input bc-paste-box" rows={6} value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="…or paste the receipt / order email text here" />
          <button type="button" className="btn" disabled={!text.trim()} onClick={() => read(text, 'paste')}>Read it</button>
        </div>
      )}

      {/* The review step, and it is not optional. */}
      {rows && (
        <div className="bc-review">
          <p className="muted sm">
            Check every row before saving — this is what the money gets reconciled against.
          </p>
          <div className="bc-scroll">
          <table className="table bc-table bc-review-table">
            <thead><tr><th>SKU</th><th>Size</th><th>Qty</th><th>Unit</th><th>Total</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td><input className="input sm" value={r.sku || ''} onChange={(e) => editRow(i, { sku: e.target.value.toUpperCase() })} /></td>
                  <td><input className="input sm bc-w-sm" value={r.size || ''} onChange={(e) => editRow(i, { size: e.target.value })} /></td>
                  <td><input className="input sm bc-w-sm" type="number" min="1" value={r.qty} onChange={(e) => editRow(i, { qty: Number(e.target.value) || 1 })} /></td>
                  <td><input className="input sm bc-w-md" value={r.unitPrice ?? ''} onChange={(e) => editRow(i, { unitPrice: Number(e.target.value) || null })} /></td>
                  <td><input className="input sm bc-w-md" value={r.totalPrice ?? ''} onChange={(e) => editRow(i, { totalPrice: Number(e.target.value) || null })} /></td>
                  <td><button type="button" className="btn sm ghost" onClick={() => dropRow(i)} aria-label="Remove row">×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="bc-review-foot">
            <button type="button" className="btn sm ghost" onClick={addRow}>Add a row</button>
            {/* The receipt's three figures, in the order it prints them. It used to ask
                for the total alone and then GUESS at the difference — "usually the tax"
                — beside whatever gap it found. A reader that returns the printed
                subtotal and tax turns that guess into something checkable. */}
            <div className="bc-totals">
              <label className="bc-total">
                <span className="field-label">Goods (subtotal)</span>
                <PriceInput value={subtotal} onChange={(e) => setSubtotal(e.target.value)} />
              </label>
              <span className="bc-total-op">+</span>
              <label className="bc-total">
                <span className="field-label">Tax</span>
                <PriceInput value={tax} onChange={(e) => setTax(e.target.value)} />
              </label>
              <span className="bc-total-op">=</span>
              <label className="bc-total strong">
                <span className="field-label">Total charged</span>
                <PriceInput value={statedTotal} onChange={(e) => setStatedTotal(e.target.value)} />
              </label>
            </div>
            <div className="bc-totals-check">
              <span className={rowsMatch ? 'bc-covered' : 'muted'}>
                The rows add up to {money(rowsTotal)}
                {subN != null
                  ? (rowsMatch ? ' — matching the subtotal.' : ` — ${money(Math.abs(subN - rowsTotal))} off the subtotal.`)
                  : ''}
              </span>
              {/* Arithmetic, not a guess. Only shown when all three are present: a
                  receipt with no tax line has nothing to disagree about. */}
              {subN != null && taxN != null && totalN != null && (
                <span className={sumsUp ? 'bc-covered' : 'bc-short'}>
                  {sumsUp
                    ? `${money(subN)} + ${money(taxN)} = ${money(totalN)} ✓`
                    : `${money(subN)} + ${money(taxN)} is ${money(subN + taxN)}, not ${money(totalN)} — one of the three is misread.`}
                </span>
              )}
            </div>
            <button type="button" className="btn primary" disabled={busy === 'save' || !rows.length || !(Number(statedTotal) > 0)} onClick={commit}>
              {busy === 'save' ? 'Saving…' : 'Save these lines'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setRows(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* What the receipt's own figures say about the reading. Rendered separately from
          the error: "the lines add up to the printed subtotal" is not a failure, and
          burying it in the same grey as everything else wastes the one sentence that
          tells a reviewer how hard to look. */}
      {note && <p className={`bc-read-note ${/does not|gap|but the receipt|missing/i.test(note) ? 'bad' : 'ok'}`}>{note}</p>}
      {err && <div className="error mt">{err}</div>}
    </section>
  );
}
