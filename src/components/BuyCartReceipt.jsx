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

async function textFromImage(file, onProgress) {
  const { default: Tesseract } = await lazyImport(() => import('tesseract.js'));
  const { data } = await Tesseract.recognize(file, 'eng', {
    logger: (m) => { if (m.status === 'recognizing text') onProgress(Math.round(m.progress * 100)); },
  });
  return data?.text || '';
}

export function BuyCartReceipt({ cart, canEdit, onChanged, onSignOut }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null);
  const [statedTotal, setStatedTotal] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState('');

  const files = (cart.files || []).filter((f) => f.kind === 'receipt');
  const committed = cart.receiptLines || [];
  const approved = (cart.lines || []).filter((l) => l.status === 'approved');
  const diffs = compareReceiptToApproved(committed, approved);
  const rowsTotal = rows ? Math.round(rows.reduce((n, r) => n + (Number(r.totalPrice) || 0), 0) * 100) / 100 : 0;

  function read(t, source) {
    const parsed = parseReceipt(t, { source });
    setRows(parsed.rows.map((r) => ({ ...r })));
    // The receipt's own total is what the cards were actually charged, so it is what the
    // reconciliation must run against — prefilled, and still editable.
    setStatedTotal(parsed.statedTotal != null ? String(parsed.statedTotal) : String(parsed.total || ''));
    if (!parsed.rows.length) setErr('Nothing on that looked like a purchased item. Check the text, or add the lines by hand.');
    else setErr('');
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
      await api.cartFileAttach({
        cartId: cart.id, kind: 'receipt', key, name: file.name,
        contentType: file.type, sizeBytes: file.size,
      });
      onChanged();

      if (file.type === 'application/pdf') {
        setBusy('pdf');
        const t = await textFromPdf(file);
        setText(t);
        read(t, 'pdf');
      } else if (String(file.type).startsWith('image/')) {
        setBusy('ocr');
        const t = await textFromImage(file, setProgress);
        setText(t);
        read(t, 'ocr');
      }
    } catch (ex) {
      if (ex.unauthorized) return onSignOut();
      // The file may well have landed even though the reading fell over — say so rather
      // than leaving someone re-uploading it.
      setErr(`${ex.message} The receipt itself was saved; you can still type the lines in.`);
    } finally { setBusy(''); setProgress(0); }
  }

  function editRow(i, patch) { setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))); }
  function dropRow(i) { setRows((rs) => rs.filter((_, j) => j !== i)); }
  function addRow() { setRows((rs) => [...(rs || []), { sku: '', size: '', qty: 1, unitPrice: null, totalPrice: null, source: 'manual' }]); }

  async function commit() {
    setBusy('save'); setErr('');
    try {
      await api.cartSaveReceipt(cart.id, rows.filter((r) => String(r.sku || '').trim()), Number(statedTotal));
      setRows(null); setText('');
      onChanged();
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
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
        </span>
        {canEdit && (
          <label className="btn sm ghost bc-upload">
            {busy === 'upload' ? 'Uploading…' : busy === 'pdf' ? 'Reading the PDF…' : busy === 'ocr' ? `Reading the photo… ${progress}%` : 'Upload receipt'}
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
              <button type="button" className="btn sm ghost" onClick={() => download(f)}>Download</button>
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
          <p className="muted sm">Receipt total <b>{money(cart.receipt_total)}</b> · cards issued {money(cart.gc_total)} · <b>{money(cart.balance_remaining)}</b> left over.</p>
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
            <label className="field">
              <span className="field-label">Receipt total (what the till charged)</span>
              <PriceInput value={statedTotal} onChange={(e) => setStatedTotal(e.target.value)} />
            </label>
            <span className="muted sm">
              These rows add up to {money(rowsTotal)}
              {Number(statedTotal) > 0 && Math.abs(rowsTotal - Number(statedTotal)) > 0.01
                ? ` — ${money(Math.abs(Number(statedTotal) - rowsTotal))} apart from the total, usually the tax.`
                : ''}
            </span>
            <button type="button" className="btn primary" disabled={busy === 'save' || !rows.length || !(Number(statedTotal) > 0)} onClick={commit}>
              {busy === 'save' ? 'Saving…' : 'Save these lines'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setRows(null)}>Cancel</button>
          </div>
        </div>
      )}

      {err && <div className="error mt">{err}</div>}
    </section>
  );
}
