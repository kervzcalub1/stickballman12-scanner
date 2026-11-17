// The receipts on a purchase order — TWO kinds, each in its own lane (docs/context/purchase-orders.md
// → "Two receipts"):
//   Purchase receipt = from the STORE: what was bought and the price paid.
//   Drop-off receipt = from the COURIER: proof the boxes were handed over.
// Suppliers were putting store receipts in the drop-off box, so the two are told apart four ways at
// once (name, picture, colour, one line saying who it is from and what it proves), each lane has its
// own upload button and drop area, and a receipt filed in the wrong lane is MOVED with one press —
// by anyone who can open the order — and put back with Undo. The supplier uploads, or our team does
// for them. Staff can ask for the drop-off receipt on Telegram once a box has left.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { ImageZoomModal } from './common.jsx';
import { estDate, estTime } from '../lib/format.js';

const MAX_BYTES = 15 * 1024 * 1024;
export const hasDroppedOff = (boxes) => (boxes || []).some((b) => ['shipped', 'in_transit', 'delivered'].includes(b.status));

export function PoDropoffChip({ po, supplier = false }) {
  const dropped = Number(po?.shipped_count) > 0;
  if (!dropped || Number(po?.dropoff_receipt_count) > 0 || ['reconciled', 'closed'].includes(po?.status)) return null;
  return <span className="po-chip dropoff-missing">{supplier ? 'Upload drop-off receipt' : 'No drop-off receipt'}</span>;
}

// The two lanes. `from` + `proves` are the explicit difference; `looks` says how to recognise one.
export const RECEIPT_KINDS = {
  purchase: {
    title: 'Purchase receipt', plural: 'Purchase receipts', short: 'purchase receipts', from: 'From the store',
    proves: 'What was bought and the price paid.',
    looks: 'It lists the shoes and a total: a store receipt, an online order confirmation, an invoice.',
  },
  dropoff: {
    title: 'Drop-off receipt', plural: 'Drop-off receipts', short: 'drop-off receipts', from: 'From the courier',
    proves: 'Proof the boxes were handed over.',
    looks: 'It shows UPS / FedEx / USPS, the date and the tracking numbers or box count. No shoe prices.',
  },
};
const OTHER = { purchase: 'dropoff', dropoff: 'purchase' };
const kindOf = (r) => (r.kind === 'purchase' ? 'purchase' : 'dropoff');

// A small picture of each paper, so the lanes differ at a glance and not only by their words.
function KindPicture({ kind }) {
  return kind === 'purchase' ? (
    <svg className="po-rcpt-pic" viewBox="0 0 40 40" aria-hidden="true">
      <path d="M11 5h18v30l-3-2-3 2-3-2-3 2-3-2-3 2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M15 12h10M15 17h10M15 22h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <text x="24.5" y="27.5" fontSize="9" fontWeight="700" textAnchor="middle" fill="currentColor">$</text>
    </svg>
  ) : (
    <svg className="po-rcpt-pic" viewBox="0 0 40 40" aria-hidden="true">
      <path d="M4 12h19v15H4zM23 17h7l5 5v5H23z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="11" cy="29" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="28" cy="29" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M9 19l3 3 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Reads the order itself, so it works the same on all three pages that show it, and a supplier's
// upload appears on the team's open page without a refresh.
export function PoDropoffReceipts({ po, isSupplier = false, onSignOut }) {
  const inputs = { purchase: useRef(null), dropoff: useRef(null) };
  const [data, setData] = useState(null);
  const poId = po?.id;
  const reload = () => api.poGet(poId).then(setData).catch((ex) => { if (ex.unauthorized) onSignOut?.(); });
  useEffect(() => { setData(null); if (poId) reload(); }, [poId]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['po_dropoff_receipts', 'po_boxes'], reload, { mount: false, minGap: 3000 });
  const boxes = data?.boxes || [];
  const all = data?.dropoffReceipts || [];
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);      // { kind, err?, text, undo?: { id, back } } — shown in that lane
  const [view, setView] = useState(null);      // { url, label }
  const [dragOver, setDragOver] = useState('');
  const [fresh, setFresh] = useState(null);    // the receipt just moved: marked for a moment where it landed
  const dropped = hasDroppedOff(boxes);
  const say = (kind, text, extra = {}) => setNote({ kind, text, ...extra });
  const fail = (kind, ex) => { if (ex.unauthorized) return onSignOut?.(); say(kind, ex.message, { err: true }); };

  // Boxes are often dropped off over several days (7, then 10, then 13), so an order holds
  // many receipts — and several can be picked or dropped at once. Each file becomes its own
  // receipt, one after another; a file that fails says so without losing the others.
  async function uploadFiles(kind, list) {
    const files = [...(list || [])];
    if (!files.length) return;
    setNote(null);
    let saved = 0;
    const problems = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > MAX_BYTES) { problems.push(`${file.name}: over 15 MB — try a smaller photo`); continue; }
      setBusy(`up:${kind}:${files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…'}`);
      try {
        const { uploadUrl, key } = await api.poDropoffSign(po.id, file.type);
        const put = await fetch(uploadUrl, { method: 'PUT', body: file });
        if (!put.ok) throw new Error('the upload did not go through — try again');
        await api.poDropoffAttach({ poId: po.id, key, name: file.name, contentType: file.type, sizeBytes: file.size, kind });
        saved++;
      } catch (ex) {
        if (ex.unauthorized) { setBusy(''); return onSignOut?.(); }
        problems.push(`${file.name}: ${ex.message}`);
      }
    }
    setBusy('');
    const ok = saved ? (saved === 1 ? 'Receipt saved.' : `${saved} receipts saved.`) : '';
    if (problems.length) say(kind, `${ok ? `${ok} ` : ''}Not saved — ${problems.join('; ')}`, { err: true });
    else if (ok) say(kind, `${ok} Filed under ${RECEIPT_KINDS[kind].short}.`);
    await reload();
  }
  const uploading = (kind) => (busy.startsWith(`up:${kind}:`) ? busy.split(':').slice(2).join(':') : '');
  const anyUpload = busy.startsWith('up:');

  async function open(r) {
    setBusy(`view${r.id}`);
    try {
      const { blob, filename } = await api.poDropoffFile(r.id);
      const url = URL.createObjectURL(blob);
      if (String(r.content_type).startsWith('image/')) setView({ url, label: r.name || RECEIPT_KINDS[kindOf(r)].title });
      else {
        const a = document.createElement('a');
        a.href = url; a.download = filename || r.name || 'receipt.pdf';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    } catch (ex) { fail(kindOf(r), ex); } finally { setBusy(''); }
  }

  async function remove(r) {
    setBusy(`rm${r.id}`); setNote(null);
    try { await api.poDropoffDelete(po.id, r.id); await reload(); } catch (ex) { fail(kindOf(r), ex); } finally { setBusy(''); }
  }

  // Filed in the wrong lane: one press moves it, and Undo puts it back. Nothing about the file changes.
  async function move(r, to, { undo = false } = {}) {
    const from = kindOf(r);
    setBusy(`mv${r.id}`); setNote(null);
    try {
      await api.poDropoffMove(po.id, r.id, to);
      await reload();
      setFresh(r.id);
      setTimeout(() => setFresh((cur) => (cur === r.id ? null : cur)), 4000);
      const name = r.name || 'The receipt';
      say(to, undo ? `${name} is back under ${RECEIPT_KINDS[to].short}.` : `${name} moved here from ${RECEIPT_KINDS[from].short}.`,
        undo ? {} : { undo: { r: { ...r, kind: to }, back: from } });
    } catch (ex) { fail(from, ex); } finally { setBusy(''); }
  }

  async function ask() {
    setBusy('ask'); setNote(null);
    try {
      const r = await api.nudge('po', po.id, 'supplier', `Please upload the drop-off receipt for ${po.po_code}.`);
      say('dropoff', r.sentTo?.length ? `Asked ${r.sentTo.join(', ')} on Telegram.` : 'They aren’t on Telegram, so nothing was sent. Message them another way.');
    } catch (ex) { fail('dropoff', ex); } finally { setBusy(''); }
  }

  // A supplier only reaches their own orders, so a supplier's upload here is theirs.
  const canRemove = (r) => !isSupplier || r.uploaded_role === 'supplier';

  const lane = (kind) => {
    const K = RECEIPT_KINDS[kind];
    const other = OTHER[kind];
    const list = all.filter((r) => kindOf(r) === kind);
    const up = uploading(kind);
    return (
      <section key={kind} className={`po-rcpt-lane po-${kind}${dragOver === kind ? ' drag' : ''}`} aria-label={K.plural} data-receipt-lane={kind}
        onDragOver={(e) => { e.preventDefault(); setDragOver(kind); }}
        onDragEnter={(e) => { e.preventDefault(); setDragOver(kind); }}
        onDragLeave={() => setDragOver((cur) => (cur === kind ? '' : cur))}
        onDrop={(e) => { e.preventDefault(); setDragOver(''); if (!anyUpload) uploadFiles(kind, e.dataTransfer?.files); }}>
        <div className="po-rcpt-head">
          <KindPicture kind={kind} />
          <div className="po-rcpt-what">
            <b className="po-rcpt-title">{list.length > 1 ? `${K.plural} (${list.length})` : K.title}</b>
            <span className="po-rcpt-from">{K.from}</span>
            <span className="po-rcpt-proves">{K.proves}</span>
          </div>
        </div>
        <p className="muted xs po-rcpt-looks">{K.looks}</p>
        <div className="po-dropoff-h">
          {!list.length && (kind === 'dropoff' ? (
            <span className={dropped ? 'po-chip dropoff-missing' : 'muted sm'}>
              {dropped ? (isSupplier ? 'Please upload it' : 'Not in yet') : 'Needed once a box is dropped off'}
            </span>
          ) : <span className="muted sm">None yet</span>)}
          <span className="po-dropoff-actions">
            {kind === 'dropoff' && !isSupplier && dropped && !list.length && (
              <button type="button" className="btn sm ghost" disabled={busy === 'ask'} onClick={ask}>
                {busy === 'ask' ? 'Asking…' : 'Ask supplier'}
              </button>
            )}
            <button type="button" className="btn sm po-rcpt-upload" disabled={anyUpload} onClick={() => inputs[kind].current?.click()}>
              {up || `${list.length ? '+ Add' : 'Upload'} ${K.title.toLowerCase()}`}
            </button>
            {/* multiple: one drop-off a day for three days is three receipts, often sent together. */}
            <input ref={inputs[kind]} type="file" accept="image/*,application/pdf" multiple hidden aria-label={`Upload ${K.short}`}
              onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ''; uploadFiles(kind, files); }} />
          </span>
        </div>
        {list.length > 0 && (
          <ul className="po-dropoff-list">
            {list.map((r) => (
              <li key={r.id} className={fresh === r.id ? 'po-rcpt-fresh' : undefined}>
                <span className="po-rcpt-file">
                  <span className="po-dropoff-name">{r.name || K.title}</span>
                  <span className="muted xs">{r.uploaded_by || ''} · {estDate(r.uploaded_at)} {estTime(r.uploaded_at)} EST
                    {r.moved_at ? ` · moved here by ${r.moved_by || 'someone'}` : ''}</span>
                </span>
                <span className="po-rcpt-row-actions">
                  <button type="button" className="btn sm ghost" disabled={busy === `view${r.id}`} onClick={() => open(r)}>
                    {String(r.content_type).startsWith('image/') ? 'View' : 'Download'}
                  </button>
                  <button type="button" className="btn sm ghost po-rcpt-move" disabled={busy === `mv${r.id}`} onClick={() => move(r, other)}
                    title={`Wrong place? File it under ${RECEIPT_KINDS[other].short} instead. Nothing is lost.`}
                    aria-label={`Move ${r.name || 'this receipt'} to ${RECEIPT_KINDS[other].short}`}>
                    {busy === `mv${r.id}` ? 'Moving…' : `⇄ Move to ${other === 'dropoff' ? 'drop-off' : 'purchase'}`}
                  </button>
                  {canRemove(r) && (
                    <button type="button" className="btn sm ghost" disabled={busy === `rm${r.id}`} onClick={() => remove(r)}>Remove</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {note?.kind === kind && (
          <p className={note.err ? 'error sm' : 'po-rcpt-note sm'} role={note.err ? 'alert' : 'status'}>
            {note.text}
            {note.undo && (
              <button type="button" className="btn sm ghost po-rcpt-undo" disabled={busy.startsWith('mv')}
                onClick={() => move(note.undo.r, note.undo.back, { undo: true })}>Undo</button>
            )}
          </p>
        )}
      </section>
    );
  };

  return (
    <section className="po-rcpts" aria-label="Receipts">
      <div className="po-rcpts-h">
        <b>Receipts</b>
        <span className="muted xs">Two different papers. Put each one in its own box — pick several files at once, or drop them on a box. In the wrong box? Press <b>Move</b>.</span>
      </div>
      <div className="po-rcpts-grid">{lane('purchase')}{lane('dropoff')}</div>
      {view && <ImageZoomModal url={view.url} label={view.label} onClose={() => { URL.revokeObjectURL(view.url); setView(null); }} />}
    </section>
  );
}
