// A STORE ORDER's list (docs/store-orders-plan.md): one supplier buying from many stores of
// one retailer, each store shipping its own boxes. Shared by the supplier portal
// (SupplierApp) and the staff order screen (PoDetail) — the server decides who may do what
// (po/store-list, po/store), this only shows the doors that are open.
//
// What it shows, per store: the shoes and sizes it said it is sending at what price, its
// pairs and $ (the invoice we build — the stores never send one), and the boxes that store
// ships. Then the order's totals and where the list stands: being written → confirmed by
// the supplier → (staff) "invoice checked".
import React, { useState } from 'react';
import { api } from '../api.js';
import { PoLineRow, PoLineHeader } from './PoScanModal.jsx';
import { parseStorePaste } from '../lib/storePaste.js';
import { compareSizes } from '../lib/codes.js';
import { estDate } from '../lib/format.js';
import { ManifestPrint } from './ManifestPrint.jsx';

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const pairsWord = (n) => `${n} pair${n === 1 ? '' : 's'}`;

// The paste window. A store list is ONE paste: "Store: …" lines, each followed by its shoes
// (SKU $price, then "size x qty" lines). Previewed store by store before anything is sent.
function StorePasteModal({ po, onClose, onAdded, onSignOut }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const parsed = parseStorePaste(text);
  const blocked = parsed.unpriced.length > 0;
  const send = async () => {
    setBusy(true); setError('');
    try {
      await api.poStoreList(Number(po.id), parsed.stores.map((s) => ({
        name: s.name,
        shoes: s.shoes.map((x) => ({ sku: x.sku, name: x.name || null, unitCost: x.unitCost, sizes: x.sizes })),
      })));
      onAdded();
      onClose();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
    } finally { setBusy(false); }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal store-paste" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="modal-title">Paste the store list · {po.po_code}</h3>
          <button type="button" className="btn icon ghost" onClick={onClose}>×</button>
        </div>
        <textarea className="input" rows={10} value={text} autoFocus disabled={busy} aria-label="Paste the store list"
          placeholder={'Store: AF #1234 Dallas\nDZ5485-612 $110\n8 x 2\n9 x 3\n\nStore: AF #2210 New Orleans\nDZ5485-612 $110\n10 x 4'}
          onChange={(e) => setText(e.target.value)} />
        <p className="muted xs">
          Start each store with a <code>Store:</code> line, then each shoe: the SKU with its price each
          (e.g. <code>DZ5485-612 $110</code>) and one <code>size x qty</code> per line. Every shoe needs its
          price — this list is the invoice. Pasting again adds to what’s there.
        </p>
        {error && <div className="po-err" role="alert">{error}</div>}
        {parsed.stores.length > 0 && (
          <ul className="po-paste-list store-paste-list">
            {parsed.stores.map((s) => (
              <li key={s.name}>
                <div className="po-paste-head">
                  <b>{s.name}</b>
                  <span className="po-paste-n">{pairsWord(s.pairs)} · {money(s.total)}</span>
                </div>
                {s.shoes.map((x) => {
                  const n = x.sizes.reduce((k, z) => k + z.qty, 0);
                  return (
                    <div key={x.sku} className="store-paste-shoe">
                      <span className="po-line-meta">{x.sku}{x.name ? ` · ${x.name}` : ''}</span>
                      <span className={x.unitCost == null ? 'po-paste-warn xs' : 'muted xs'}>
                        {x.unitCost == null ? 'no price — add it on the SKU line' : `${money(x.unitCost)} ea · ${money(x.unitCost * n)}`}
                      </span>
                      <div className="po-paste-sizes">
                        {[...x.sizes].sort((a, b) => compareSizes(a.size, b.size)).map((z) => (
                          <span key={z.size} className="size-chip static">{z.size} ×{z.qty}</span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </li>
            ))}
          </ul>
        )}
        {parsed.skipped.length > 0 && (
          <div className="po-paste-skipped" role="alert">
            <b>Not added — fix these lines if they matter:</b>
            <ul>{parsed.skipped.map((k, i) => <li key={i}><code>{k.line}</code> — {k.why}{k.store ? ` (${k.store})` : ''}</li>)}</ul>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary wide" disabled={busy || !parsed.pairs || blocked} onClick={send}>
            {busy ? 'Adding…'
              : blocked ? `${parsed.unpriced.length} shoe${parsed.unpriced.length === 1 ? '' : 's'} without a price`
                : parsed.pairs ? `Add ${pairsWord(parsed.pairs)} from ${parsed.stores.length} store${parsed.stores.length === 1 ? '' : 's'} · ${money(parsed.total)}`
                  : 'Paste a store list to add'}
          </button>
        </div>
      </div>
    </div>
  );
}

// `staff` = the PH / admin view (on-behalf edits, unlock, invoice checked).
// `lineBusy` / `onPatchLine` come from the screen so line edits share its busy state.
export function StoreOrderPanel({ detail, staff = false, onChanged, onPatchLine, lineBusy = null, staffLabel = '', onSignOut }) {
  const { po } = detail;
  const stores = detail.stores || [];
  const lines = (detail.lines || []).filter((l) => l.po_box_id == null);
  const boxes = (detail.boxes || []).filter((b) => b.kind !== 'replacement');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pasting, setPasting] = useState(false);

  const audited = !!po.audited_at;
  const frozen = audited || po.status === 'reconciled' || po.status === 'closed';
  const confirmed = !!po.list_confirmed_at;
  // Mirrors orderListEditBlock (api/_lib/po-manifest.js): the supplier writes it until they
  // confirm it; staff can correct it until the audit.
  const canEdit = !frozen && (staff || (!confirmed && ['draft', 'shipped', 'receiving'].includes(po.status)));
  // Boxes are added while the order is still going out.
  const canAddBox = !frozen && !['reconciled', 'closed'].includes(po.status);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); onChanged(); } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
    } finally { setBusy(false); }
  };
  const act = (action, extra) => run(() => api.poStore(Number(po.id), action, extra));
  const addBox = (store) => run(() => api.poBoxAdd(Number(po.id), 1, Number(store.id)));
  const rename = (store) => {
    const name = window.prompt('Store name', store.name);
    if (name == null || !name.trim() || name.trim() === store.name) return;
    act('rename', { storeId: Number(store.id), name: name.trim() });
  };
  const remove = (store) => {
    if (!window.confirm(`Remove ${store.name} and everything listed under it?`)) return;
    act('remove', { storeId: Number(store.id) });
  };
  const confirmList = () => {
    if (!window.confirm(staff
      ? 'Confirm this list on the supplier’s behalf? It locks the list for them.'
      : 'Confirm this list? It’s what the stores told you they are sending, at these prices. After this, only Stickballman12 can change it.')) return;
    act('confirm');
  };
  // A store that shipped under ITS OWN label: its tracking number goes on the store's box so
  // the warehouse can match the carton (po/store-tracking).
  const storeTracking = (b) => {
    const t = window.prompt(`Box ${b.box_number}: the tracking number on the store's own label`, b.tracking_source === 'store' ? (b.tracking_number || '') : '');
    if (t == null || !t.trim()) return;
    run(() => api.poStoreTracking(Number(b.id), t.trim()));
  };
  // Staff: a received box that matched no label — say which label (so which store) it is.
  const tie = (ub, poBoxId) => run(() => api.poTieBox(Number(po.id), Number(ub.id), poBoxId ? Number(poBoxId) : null));
  // Staff: pairs received before their price was on the list — cost them from it now.
  const fillCosts = () => run(async () => {
    const { plan } = await api.poFillCostsPreview(Number(po.id));
    if (!plan.fillable) {
      const why = [
        plan.noLine ? `${plan.noLine} with no priced line for their store` : '',
        plan.noPresetPairs ? `${plan.noPresetPairs} because the supplier has no cost preset` : '',
      ].filter(Boolean).join(', ');
      throw new Error(`No blank costs to fill${why ? ` — ${why}` : ''}.`);
    }
    if (!window.confirm(`Fill the cost of ${plan.fillable} received pair${plan.fillable === 1 ? '' : 's'} from this order's list?`
      + (plan.noLine ? ` (${plan.noLine} more have no priced line for their store and stay blank.)` : ''))) return;
    await api.poFillCosts(Number(po.id));
  });
  const untied = detail.untied_boxes || [];
  const untiedPairs = untied.reduce((n, b) => n + (Number(b.units) || 0), 0);
  const labelName = (b) => {
    const st = stores.find((x) => Number(x.id) === Number(b.po_store_id));
    return `Box ${b.box_number}${st ? ` · ${st.name}` : ''}${b.tracking_number ? ` · ${b.tracking_number}` : ''}`;
  };
  const unlock = () => {
    const note = window.prompt('Why is the list being reopened? (goes on the order’s history)');
    if (note == null || !note.trim()) return;
    act('unlock', { note: note.trim() });
  };

  const totalPairs = stores.reduce((n, s) => n + (Number(s.declared_units) || 0), 0);
  const totalMoney = stores.reduce((n, s) => n + Number(s.declared_total || 0), 0);
  const unpriced = stores.reduce((n, s) => n + (Number(s.unpriced_lines) || 0), 0);

  return (
    <div className="card po-box store-order">
      <div className="po-card-top">
        <div>
          <b>Order list — by store</b>
          <div className="po-track muted sm">What each store said it is sending, at what price. This is the invoice.</div>
        </div>
        <span className="muted sm">{stores.length} store{stores.length === 1 ? '' : 's'} · {pairsWord(totalPairs)} · <b>{money(totalMoney)}</b></span>
      </div>

      <div className="store-order-state sm">
        {confirmed
          ? <span className="po-chip ok">Confirmed{po.list_confirmed_by ? ` by ${po.list_confirmed_by}` : ''} · {estDate(po.list_confirmed_at)} EST</span>
          : <span className="po-chip packed">Not confirmed yet</span>}
        {staff && po.invoice_checked_at && <span className="po-chip ok">Invoice checked by {po.invoice_checked_by} · {estDate(po.invoice_checked_at)} EST</span>}
        {audited && staff && <span className="po-chip ok">Audited by {po.audited_by} · {estDate(po.audited_at)} EST</span>}
        {unpriced > 0 && <span className="po-chip warn">{unpriced} line{unpriced === 1 ? '' : 's'} without a price</span>}
      </div>
      {error && <div className="po-err" role="alert">{error}</div>}

      {/* Received boxes that belong to NO label, so to no store. Never guessed: a person
          says which label each one is (store-orders-plan §4.4). */}
      {staff && untied.length > 0 && (
        <div className="store-untied" role="alert">
          <b>Not tied to a store: {pairsWord(untiedPairs)}</b>
          <span className="muted sm"> — received without a label this order knows. Pick the label each box came under.</span>
          {untied.map((ub) => (
            <div key={ub.id ?? `b${ub.batch_id}`} className="store-untied-row sm">
              <span>
                {ub.batch_code} · box {ub.box_number ?? '—'}{ub.tracking_number ? ` · ${ub.tracking_number}` : ' · no tracking'} · {pairsWord(Number(ub.units) || 0)}
              </span>
              {ub.id != null && !frozen && (
                <select className="input sm" value="" disabled={busy} aria-label={`Tie box ${ub.box_number} to a label`}
                  onChange={(e) => e.target.value && tie(ub, e.target.value)}>
                  <option value="">Tie to…</option>
                  {boxes.map((b) => <option key={b.id} value={b.id}>{labelName(b)}</option>)}
                </select>
              )}
            </div>
          ))}
        </div>
      )}

      {!stores.length && (
        <p className="muted sm">
          Paste the list store by store — each store’s name, then the shoes it is sending with the price each.
          Then add the boxes each store is shipping, and ask for labels.
        </p>
      )}

      {stores.map((s) => {
        const sLines = lines.filter((l) => Number(l.po_store_id) === Number(s.id))
          .sort((a, b) => (a.sku === b.sku ? compareSizes(a.size, b.size) : a.sku.localeCompare(b.sku)));
        const sBoxes = boxes.filter((b) => Number(b.po_store_id) === Number(s.id));
        const sReceived = sBoxes.reduce((n, b) => n + (Number(b.received_units) || 0), 0);
        return (
          <details key={s.id} className="store-order-store" open={stores.length <= 3}>
            <summary>
              <b>{s.name}</b>
              <span className="muted sm">
                {pairsWord(Number(s.declared_units) || 0)} · {s.declared_total != null ? money(s.declared_total) : 'no price'}
                {' · '}{s.box_count} box{s.box_count === 1 ? '' : 'es'}
                {staff && sReceived > 0 ? ` · ${sReceived} received` : ''}
                {staff && s.charged_total != null ? ` · charged ${money(s.charged_total)}` : ''}
              </span>
            </summary>
            {sLines.length > 0 && (canEdit ? (
              <ul className="po-lines po-lines-edit">
                <PoLineHeader />
                {sLines.map((l) => (
                  <PoLineRow key={l.id} line={l} disabled={busy || lineBusy === Number(l.id)}
                    onSave={(patch) => onPatchLine(l, patch)}
                    attribution={l.entered_on_behalf ? (staff ? `Entered by ${l.entered_by_name || 'staff'}` : `Entered for you by ${staffLabel}`) : null} />
                ))}
              </ul>
            ) : (
              <ul className="po-lines">
                {sLines.map((l) => (
                  <li key={l.id}>
                    <span className="po-line-name">{l.name || l.sku}</span>
                    <span className="po-line-meta">{l.sku} · size {l.size} · ×{l.qty_expected}</span>
                    <span className={`po-line-money${l.unit_cost == null ? ' none' : ''}`}>
                      {l.unit_cost == null ? 'no price' : `${money(l.unit_cost)} each · ${money(l.unit_cost * l.qty_expected)}`}
                    </span>
                  </li>
                ))}
              </ul>
            ))}
            <div className="store-order-boxes sm">
              {sBoxes.length
                ? sBoxes.map((b) => (
                  <span key={b.id} className="store-order-box">
                    <span className="po-chip">
                      Box {b.box_number}{b.tracking_number ? ` · ${b.tracking_number}` : ' · no label yet'}
                      {b.tracking_source === 'store' ? ' (store’s label)' : ''}
                      {staff && Number(b.received_units) > 0 ? ` · ${b.received_units} received` : ''}
                    </span>
                    {canAddBox && b.status !== 'received' && (!b.tracking_number || b.tracking_source === 'store') && (
                      <button type="button" className="btn xs ghost" disabled={busy} onClick={() => storeTracking(b)}>
                        {b.tracking_number ? 'Change store’s tracking #' : 'Store’s own tracking #'}
                      </button>
                    )}
                  </span>
                ))
                : <span className="muted">No boxes yet — add each box this store is shipping.</span>}
            </div>
            <div className="po-box-actions">
              {canAddBox && <button type="button" className="btn sm" disabled={busy} onClick={() => addBox(s)}>+ Add a box</button>}
              {canEdit && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => rename(s)}>Rename</button>}
              {canEdit && !confirmed && !s.box_count && (
                <button type="button" className="btn sm ghost danger" disabled={busy} onClick={() => remove(s)}>Remove store</button>
              )}
            </div>
          </details>
        );
      })}

      <div className="po-box-actions">
        {canEdit && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => setPasting(true)}>
            📋 {stores.length ? 'Paste more to the store list' : 'Paste the store list'}
          </button>
        )}
        {!confirmed && !frozen && stores.length > 0 && (
          <button type="button" className="btn sm primary" disabled={busy || unpriced > 0} onClick={confirmList}>
            {staff ? 'Confirm for the supplier' : 'Confirm the list'}
          </button>
        )}
        {staff && confirmed && !audited && (
          <button type="button" className="btn sm ghost" disabled={busy} onClick={unlock}>Reopen the list</button>
        )}
        {staff && confirmed && (
          <button type="button" className="btn sm ghost" disabled={busy}
            onClick={() => act('invoice_checked', { checked: !po.invoice_checked_at })}>
            {po.invoice_checked_at ? 'Clear “invoice checked”' : 'Mark invoice checked'}
          </button>
        )}
        {staff && !frozen && (detail.batches || []).length > 0 && (
          <button type="button" className="btn sm ghost" disabled={busy} onClick={fillCosts}
            title="Pairs received before their price was on the list get the price their store paid">
            Fill costs from this order’s list
          </button>
        )}
      </div>

      {/* The supplier sends this to the stores' manager; staff have it with the other reports. */}
      {!staff && stores.length > 0 && (
        <ManifestPrint poId={Number(po.id)} poCode={po.po_code} byStore only={['invoice']} label="Invoice:" onSignOut={onSignOut} />
      )}

      {pasting && <StorePasteModal po={po} onClose={() => setPasting(false)} onAdded={onChanged} onSignOut={onSignOut} />}
    </div>
  );
}
