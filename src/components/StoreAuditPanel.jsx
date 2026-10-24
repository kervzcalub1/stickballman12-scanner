// THE AUDIT of a store order (docs/store-orders-plan.md §4.5–4.7) — PH / admin, on the order.
//
// Kevin's process, as he described it: what the warehouse actually received, against what
// the supplier declared (the list, which is the invoice), against what the card statement
// says was paid. Receipts help when a store gave one; often it didn't. So the table leads
// with QUANTITIES per store (declared → received → short / over, never netted), and the
// money follows: the list's $, the receipt's $, the card's $, and what a shortfall is worth.
//
// Before the order has LANDED it never says "short" — a box can still be on a truck. Mark
// audited (the `audit_po` privilege) freezes the whole table onto the order and closes it;
// from then on the frozen copy is what's shown, and only an admin can undo it.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { FormModal } from './common.jsx';
import { estDate, estToday } from '../lib/format.js';
import { storeAuditCsv, compareReceiptToList, receiptDiffSentence } from '../lib/storeAudit.js';
import { downloadStoreAuditPdf } from '../lib/storeAuditPdf.js';
import { textFromPdf } from '../lib/pdfText.js';
import { parseReceipt } from '../lib/receiptParse.js';
import { downloadCSV } from '../lib/csv.js';

const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${money(n)}`);
const MAX_RECEIPT_BYTES = 15 * 1024 * 1024;   // R2's presign can't enforce a size; this does

export function StoreAuditPanel({ detail, onChanged, onSignOut }) {
  const { po } = detail;
  const [data, setData] = useState(null);       // { variance, charges, receipts, can }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [form, setForm] = useState(null);       // a FormModal: { title, message, fields, submitLabel, onSubmit }
  const [emails, setEmails] = useState(null);   // { store, list }

  const load = () => api.poAudit(Number(po.id)).then((r) => { setData(r); setError(''); })
    .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  // Re-read whenever the order does (live updates re-read `detail` on any PO change).
  useEffect(() => { load(); }, [detail]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (action, extra = {}) => {
    setBusy(true); setError('');
    try { setData(await api.poAuditAct(Number(po.id), action, extra)); onChanged?.(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); throw e; }
    finally { setBusy(false); }
  };
  const quiet = (p) => p.catch(() => { /* shown in the panel */ });

  if (!data) return <div className="card po-box store-audit">{error ? <div className="po-err">{error}</div> : <span className="muted sm">Loading the audit…</span>}</div>;

  const audited = !!po.audited_at;
  const v = audited && po.audit_snapshot ? po.audit_snapshot : data.variance;
  if (!v) return null;
  const landed = v.landed || {};
  const toggle = (k) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const chargesOf = (sid) => (data.charges || []).filter((c) => Number(c.po_store_id) === Number(sid));
  const receiptsOf = (sid) => (data.receipts || []).filter((r) => Number(r.po_store_id) === Number(sid));
  // Before it has landed a shortage is a box still in transit, not a claim.
  const showShort = landed.landed || audited;

  const addCharge = (s) => setForm({
    title: `Card charge · ${s.name}`,
    message: 'One line off the card statement. A credit back on the card is a negative amount.',
    submitLabel: 'Add charge',
    fields: [
      { name: 'amount', label: 'Amount', type: 'number', step: '0.01', required: true, placeholder: '1,320.00' },
      { name: 'chargedOn', label: 'Statement date', type: 'date', value: estToday() },
      { name: 'cardLast4', label: 'Card (last 4)', placeholder: '1234', maxLength: 4 },
      { name: 'note', label: 'Note', placeholder: 'optional' },
    ],
    onSubmit: async (f) => { await act('charge_add', { storeId: s.store_id, ...f }); setForm(null); },
  });
  const editCredit = (s) => setForm({
    title: `Credit · ${s.name}`,
    message: `What the supplier agreed to credit for this store’s shortfall (${money(s.owed)} owed), and what has come back.`,
    submitLabel: 'Save',
    fields: [
      { name: 'agreed', label: 'Credit agreed', type: 'number', step: '0.01', value: s.credit_agreed ?? '' },
      { name: 'received', label: 'Credit received', type: 'number', step: '0.01', value: s.credit_received ?? '' },
      { name: 'note', label: 'Note', value: s.credit_note || '' },
    ],
    onSubmit: async (f) => { await act('credit', { storeId: s.store_id, ...f }); setForm(null); },
  });
  const receiptTotal = (r, read = null) => setForm({
    title: `Receipt total · ${r.store_name}`,
    message: read
      ? (read.pdf
        ? (read.statedTotal != null
          ? `Read from the PDF’s text: ${money(read.statedTotal)}${read.rows.length ? ` · ${read.rows.length} line${read.rows.length === 1 ? '' : 's'}` : ''}. Check it before saving.`
          : 'No total found in the PDF’s text — type it off the receipt.')
        : read.agreed
          ? `Read twice — both reads say ${money(read.statedTotal)}. Check it against the receipt before saving.`
          : `The two reads disagree (${read.totals.map(money).join(' vs ')}). Type the total off the receipt.`)
      : 'The total printed on the receipt.',
    submitLabel: 'Save total',
    fields: [{ name: 'amount', label: 'Receipt total', type: 'number', step: '0.01', required: true,
      value: (read?.agreed || read?.pdf) && read.statedTotal != null ? read.statedTotal : (r.amount ?? '') }],
    onSubmit: async (f) => {
      await act('receipt_amount', { receiptId: r.id, amount: f.amount,
        ...(read ? { lines: read.rows, ...(read.pdf ? {} : { readAgreed: !!read.agreed }) } : {}) });
      setForm(null);
    },
  });
  // A PDF (usually the store's email) carries its text — read here, no AI, no cost.
  const readPdf = async (blob) => {
    const parsed = parseReceipt(await textFromPdf(blob), { source: 'pdf' });
    return { pdf: true, statedTotal: parsed.statedTotal ?? null, rows: parsed.rows.map(({ sku, size, qty, totalPrice }) => ({ sku, size, qty, totalPrice })) };
  };
  const isPdf = (r) => /pdf/i.test(r.content_type || '') || /\.pdf$/i.test(r.r2_key || '');
  const readReceipt = async (r) => {
    setBusy(true); setError('');
    try {
      receiptTotal(r, isPdf(r)
        ? await readPdf((await api.poReceiptBlob(Number(po.id), r.id)).blob)
        : await api.poReceiptRead(Number(po.id), r.id));
    }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  };
  const viewReceipt = async (r) => {
    try {
      const { blob } = await api.poReceiptBlob(Number(po.id), r.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  };
  const uploadReceipt = async (s, file) => {
    if (!file) return;
    if (file.size > MAX_RECEIPT_BYTES) { setError('That file is over 15 MB — take a smaller photo.'); return; }
    setBusy(true); setError('');
    try {
      const type = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'image/jpeg');
      const { uploadUrl, key } = await api.poReceiptSign(Number(po.id), s.store_id, type);
      const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': type } });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      const { receipt } = await api.poReceiptAttach({ poId: Number(po.id), storeId: s.store_id, key, name: file.name, contentType: type, sizeBytes: file.size });
      await load(); onChanged?.();
      // Read straight away — a PDF from its own text, a photo by the AI (twice) — and the
      // total comes up for a person to confirm: one step, not upload-then-"Read it".
      try {
        receiptTotal({ ...receipt, store_name: s.name },
          type === 'application/pdf' ? await readPdf(file) : await api.poReceiptRead(Number(po.id), receipt.id));
      } catch { /* the reader is unavailable — the total is typed with "Total…" instead */ }
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  };
  const pickEmail = async (s) => {
    setBusy(true); setError('');
    try { setEmails({ store: s, list: (await api.poReceiptEmails(Number(po.id), s.declared_total)).receipts || [] }); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  };
  const callLanded = () => setForm({
    title: 'Call it landed',
    message: `${landed.labels_in} of ${landed.labels} boxes are in. Say why the rest won’t come — the audit counts them short from here.`,
    submitLabel: 'Call it landed',
    fields: [{ name: 'note', label: 'Why', type: 'textarea', required: true, placeholder: 'Box 7 lost — claim filed with UPS' }],
    onSubmit: async (f) => { await act('landed', { note: f.note }); setForm(null); },
  });
  const markAudited = () => setForm({
    title: `Mark ${po.po_code} audited`,
    message: `${v.totals.received_units} of ${v.totals.declared_units} pairs · ${v.totals.short} short · ${money(v.totals.owed)} owed`
      + `${v.totals.charged_total != null ? ` · charged ${money(v.totals.charged_total)}` : ' · no card charges entered'}. `
      + 'This freezes the table onto the order and closes it.',
    submitLabel: 'Mark audited',
    fields: [{ name: 'note', label: 'Audit note', type: 'textarea', placeholder: 'optional — what was agreed with the supplier' }],
    onSubmit: async (f) => { await act('mark_audited', { note: f.note }); setForm(null); },
  });
  const unaudit = () => setForm({
    title: 'Undo the audit',
    message: 'The order goes back to receiving and the frozen table is dropped. Kevin audits it again.',
    submitLabel: 'Undo the audit', danger: true, fields: [],
    onSubmit: async () => { await act('unaudit'); setForm(null); },
  });

  return (
    <div className="card po-box store-audit">
      <div className="po-card-top">
        <div>
          <b>Audit — by store</b>
          <div className="po-track muted sm">What arrived, against each store’s list, against the card. Quantities first.</div>
        </div>
        <span className="store-audit-exports">
          <button type="button" className="btn sm ghost" onClick={() => downloadCSV(`audit-${po.po_code}.csv`, storeAuditCsv(v))}>CSV</button>
          <button type="button" className="btn sm ghost"
            onClick={() => downloadStoreAuditPdf(v, { po, generatedAt: `${estDate(new Date())}` }).catch((e) => setError(e.message))}>PDF</button>
        </span>
      </div>

      <div className="store-order-state sm">
        {audited
          ? <span className="po-chip ok">Audited by {po.audited_by} · {estDate(po.audited_at)} EST</span>
          : landed.landed
            ? <span className="po-chip ok">{landed.override ? `Called landed by ${landed.override.by}` : 'Landed'} · {landed.labels_in} of {landed.labels} boxes in</span>
            : <span className="po-chip packed">{landed.labels_in} of {landed.labels} boxes in — still arriving{landed.open_batches ? ' · a batch is still open' : ''}</span>}
        {!audited && landed.overdue?.length > 0 && (
          <span className="po-chip warn">Delivered, not received: box {landed.overdue.map((b) => b.box_number).join(', ')}</span>
        )}
        {v.untied_units > 0 && <span className="po-chip warn">Not tied to a store: {v.untied_units} pair{v.untied_units === 1 ? '' : 's'}</span>}
        {v.list_after_receiving && <span className="po-chip warn">⚠ List entered after receiving</span>}
        {showShort && v.totals.overcharge > 0 && <span className="po-chip warn">Charged over list + tax: {money(v.totals.overcharge)}</span>}
        {showShort && v.totals.undercharge > 0 && (
          <span className="po-chip warn" title="The card came in below the list plus tax. A discount — or the list (what the supplier is paid on) is priced above what was really paid.">
            Charged under the list: {money(v.totals.undercharge)} — check its prices
          </span>
        )}
      </div>
      {landed.override?.note && !audited && <p className="muted sm">“{landed.override.note}”</p>}
      {audited && po.audit_note && <p className="muted sm">Audit note: “{po.audit_note}”</p>}
      {error && <div className="po-err" role="alert">{error}</div>}

      <div className="table-scroll">
        <table className="store-audit-table">
          <thead>
            <tr>
              <th>Store</th><th>Declared</th><th>Declared $</th><th>Receipt $</th><th>Charged $</th>
              <th>Received</th><th>Short</th><th>Over</th><th>$ owed</th>
              <th title={v.tax_pct ? `What each store should have charged: the list plus ${v.tax_pct}% tax (${v.tax_source})` : 'No tax rate on the supplier’s cost preset — compared with the list as it stands'}>
                Card vs list{v.tax_pct ? ` + ${v.tax_pct}% tax` : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {v.stores.map((s) => {
              const k = `s${s.store_id}`;
              const isOpen = open.has(k);
              const receiptOff = s.receipt_total != null && s.charged_total != null && Math.abs(s.receipt_total - s.charged_total) >= 0.01;
              return (
                <React.Fragment key={k}>
                  <tr className={`store-audit-row${isOpen ? ' open' : ''}`} onClick={() => toggle(k)}>
                    <td><span className="store-audit-caret">{isOpen ? '▾' : '▸'}</span> <b>{s.name}</b></td>
                    <td>{s.declared_units}</td>
                    <td>{money(s.declared_total)}</td>
                    <td className={receiptOff ? 'warn-cell' : ''} title={receiptOff ? 'The receipt and the card disagree — the first question for the store' : ''}>
                      {s.receipt_total == null ? <span className="muted">no receipt</span> : money(s.receipt_total)}
                    </td>
                    <td>{s.charged_total == null ? <span className="muted">—</span> : money(s.charged_total)}</td>
                    <td>{s.received_units}</td>
                    <td className={showShort && s.short ? 'bad-cell' : ''}>{showShort ? s.short : '—'}</td>
                    <td className={s.over ? 'warn-cell' : ''}>{s.over}</td>
                    <td className={showShort && s.owed ? 'bad-cell' : ''}>{showShort ? money(s.owed) : '—'}{showShort && s.unpriced_short ? ' +?' : ''}</td>
                    <td className={s.charge_flag === 'over' ? 'bad-cell' : s.charge_flag === 'under' ? 'warn-cell' : ''}>
                      {signed(s.charged_minus_expected ?? s.charged_minus_declared)}{s.charge_flag === 'ok' ? ' ✓' : ''}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="store-audit-detail">
                      <td colSpan={10}>
                        <div className="store-audit-skus">
                          {s.skus.map((g) => {
                            const gk = `${k}|${g.sku}`;
                            const gOpen = open.has(gk);
                            return (
                              <div key={gk} className="store-audit-sku">
                                <button type="button" className="linklike sm" onClick={() => toggle(gk)}>
                                  {gOpen ? '▾' : '▸'} {g.sku}{g.name ? ` · ${g.name}` : ''} — {g.received} of {g.declared}
                                  {showShort && g.short ? ` · ${g.short} short` : ''}{g.over ? ` · ${g.over} over` : ''}
                                </button>
                                {gOpen && (
                                  <div className="store-audit-sizes">
                                    {g.sizes.map((z) => (
                                      <span key={z.size} className={`size-chip static${showShort && z.short ? ' short' : z.over ? ' over' : ''}`}>
                                        {z.size}: {z.received}/{z.declared}{showShort && z.short ? ` −${z.short}` : ''}{z.over ? ` +${z.over}` : ''}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {!audited && (
                          <>
                            <div className="store-audit-sub">
                              <b className="sm">Card charges</b>
                              {chargesOf(s.store_id).map((c) => (
                                <span key={c.id} className="store-order-box">
                                  <span className="po-chip">{money(c.amount)}{c.charged_on ? ` · ${c.charged_on}` : ''}{c.card_last4 ? ` · ••${c.card_last4}` : ''}{c.note ? ` · ${c.note}` : ''}</span>
                                  <button type="button" className="btn xs ghost" disabled={busy} onClick={() => quiet(act('charge_remove', { chargeId: c.id }))}>Remove</button>
                                </span>
                              ))}
                              <button type="button" className="btn xs" disabled={busy} onClick={() => addCharge(s)}>+ Charge</button>
                            </div>
                            <div className="store-audit-sub">
                              <b className="sm">Receipts</b>
                              {receiptsOf(s.store_id).map((r) => (
                                <span key={r.id} className="store-order-box">
                                  <span className="po-chip">
                                    {r.email_receipt_id ? `✉ ${r.email_order ? `#${r.email_order}` : 'email'}` : (r.name || 'receipt')}
                                    {' · '}{r.amount == null ? 'no total yet' : money(r.amount)}
                                    {r.read_agreed === false ? ' · reads disagreed' : ''}
                                  </span>
                                  {r.r2_key && <button type="button" className="btn xs ghost" onClick={() => viewReceipt(r)}>Open</button>}
                                  {r.r2_key && (
                                    <button type="button" className="btn xs ghost" disabled={busy} onClick={() => readReceipt(r)}>Read it</button>
                                  )}
                                  <button type="button" className="btn xs ghost" disabled={busy} onClick={() => receiptTotal(r)}>Total…</button>
                                  <button type="button" className="btn xs ghost danger" disabled={busy} onClick={() => quiet(act('receipt_remove', { receiptId: r.id }))}>Remove</button>
                                </span>
                              ))}
                              <label className="btn xs">
                                + Photo / PDF
                                <input type="file" accept="image/*,application/pdf" hidden disabled={busy}
                                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadReceipt(s, f); }} />
                              </label>
                              <button type="button" className="btn xs ghost" disabled={busy} onClick={() => pickEmail(s)}>✉ From email…</button>
                            </div>
                            {(() => {
                              // The store's receipt lines against Joey's list for it.
                              const read = receiptsOf(s.store_id).flatMap((r) => (Array.isArray(r.lines) ? r.lines : []));
                              if (!read.length) return null;
                              const { diffs, bySize } = compareReceiptToList(read, s);
                              return (
                                <div className="store-audit-sub">
                                  <b className="sm">Receipt vs list</b>
                                  {diffs.length
                                    ? <ul className="store-receipt-diffs sm">{diffs.map((d) => <li key={`${d.kind}|${d.sku}|${d.size}`}>{receiptDiffSentence(d)}</li>)}</ul>
                                    : <span className="sm">✓ the receipt matches the list{bySize ? '' : ' (shoe by shoe — the receipt prints no sizes)'}</span>}
                                </div>
                              );
                            })()}
                            <div className="store-audit-sub">
                              <b className="sm">Credit</b>
                              <span className="sm">
                                agreed {money(s.credit_agreed)} · received {money(s.credit_received)}{s.credit_note ? ` · ${s.credit_note}` : ''}
                              </span>
                              <button type="button" className="btn xs ghost" disabled={busy} onClick={() => editCredit(s)}>Edit</button>
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            <tr className="store-audit-total">
              <td><b>Total</b></td>
              <td>{v.totals.declared_units}</td>
              <td>{money(v.totals.declared_total)}</td>
              <td>{money(v.totals.receipt_total)}</td>
              <td>{money(v.totals.charged_total)}</td>
              <td>{v.totals.received_units}</td>
              <td>{showShort ? v.totals.short : '—'}</td>
              <td>{v.totals.over}</td>
              <td>{showShort ? money(v.totals.owed) : '—'}</td>
              <td>{v.totals.charged_total != null && v.totals.expected_charge != null ? signed(v.totals.charged_total - v.totals.expected_charge)
                : v.totals.charged_total != null && v.totals.declared_total != null ? signed(v.totals.charged_total - v.totals.declared_total) : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="po-box-actions">
        {!audited && !landed.all_in && !landed.override && (
          <button type="button" className="btn sm ghost" disabled={busy} onClick={callLanded}>Call it landed…</button>
        )}
        {!audited && landed.override && (
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => quiet(act('landed', { note: null }))}>Clear “called landed”</button>
        )}
        {!audited && data.can?.audit && (
          <button type="button" className="btn sm primary" disabled={busy || !landed.landed || v.untied_units > 0 || po.status !== 'receiving'}
            title={!landed.landed ? 'Not landed yet' : v.untied_units ? 'Tie every received box to a store first' : po.status !== 'receiving' ? `The order is ${po.status}` : ''}
            onClick={markAudited}>
            Mark audited
          </button>
        )}
        {audited && data.can?.unaudit && (
          <button type="button" className="btn sm ghost danger" disabled={busy} onClick={unaudit}>Undo the audit</button>
        )}
      </div>

      {emails && (
        <div className="modal-overlay" onClick={() => setEmails(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Email receipt for {emails.store.name}</h3>
            <p className="muted sm">Emails filed around this order, the closest to {money(emails.store.declared_total)} first.</p>
            {!emails.list.length && <p className="muted">No email receipts in that window.</p>}
            <ul className="store-email-list">
              {emails.list.map((er) => (
                <li key={er.id}>
                  <button type="button" className="linklike" disabled={busy}
                    onClick={() => act('receipt_email', { storeId: emails.store.store_id, emailReceiptId: er.id }).then(() => setEmails(null)).catch(() => {})}>
                    {money(er.total)} · {er.store_name || er.store || 'store?'}{er.city ? `, ${er.city}` : ''}
                    {er.order_number ? ` · #${er.order_number}` : ''} · {er.received_at ? `${estDate(er.received_at)} EST` : ''}
                    {er.used ? ' · already attached' : ''}
                  </button>
                </li>
              ))}
            </ul>
            <div className="modal-actions"><button type="button" className="btn ghost" onClick={() => setEmails(null)}>Close</button></div>
          </div>
        </div>
      )}
      {form && <FormModal {...form} onClose={() => setForm(null)} />}
    </div>
  );
}
