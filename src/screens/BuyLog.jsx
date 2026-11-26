// Buy Log — a supplier's own record of what they bought for us from a store that gives no
// receipt (docs/context/buy-log.md). Alex, 2026-11-26: Joey buys through a Nike store that
// pulls stock from Nike's warehouse and wants paying up front — "full transparency and
// accountability for every dollar spent", from the first order.
//
// ONE screen for the supplier (their own orders) and for PH / admin (every supplier's),
// like Buying Requests: the two are looking at the same record. What it holds per order:
//   · the declaration — order date + number, SKU, pairs, cost; a size when it is known
//   · the payments — one row each (date, amount, method, who sent it), entered by staff
//   · the purchase orders it ships on → ordered vs shipped vs received, per SKU
// and the whole log downloads as Excel / CSV, one row per line.
// `?id=` is the open order and `?new=1` the blank form, so a refresh stays where you were.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estToday, PH_DATETIME } from '../lib/format.js';
import { downloadCSV } from '../lib/csv.js';
import { toCsv } from '../lib/manifestCsv.js';
import { buildXlsx, XLSX_MIME } from '../lib/xlsx.js';
import { BUY_COLS, buyRows, buyMoney, PAY_LABEL, RECV_LABEL } from '../lib/buyLog.js';

const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PAY_TONE = { unpaid: 'bad', part: 'warn', paid: 'ok', over: 'warn' };
const RECV_TONE = { no_po: 'muted', not_shipped: 'muted', shipped: 'info', part: 'warn', received: 'ok', over: 'warn' };
const METHODS = ['Zelle', 'Cash', 'Wire', 'Cash App', 'Venmo', 'Card', 'Check', 'Other'];
const when = (t) => (t ? `${PH_DATETIME.format(new Date(t))} EST` : '');
const blankLine = () => ({ key: Math.random().toString(36).slice(2), sku: '', name: '', size: '', qty: '', unit_cost: '' });
const Chip = ({ tone, children }) => <span className={`bl-chip ${tone}`}>{children}</span>;

export function BuyLog({ user, onHome, onSignOut }) {
  const [q, setQ] = useQueryParam('q', '');
  const [from, setFrom] = useQueryParam('from', '');
  const [to, setTo] = useQueryParam('to', '');
  const [openId, setOpenId] = useQueryParam('id', '');
  const [isNew, setIsNew] = useQueryParam('new', '');
  const [data, setData] = useState(null);       // { buys, can, suppliers }
  const [error, setError] = useState('');

  async function load() {
    try { const r = await api.buyLogs({ q: q.trim(), from, to }); setData(r); setError(''); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [q, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['buy_logs', 'buy_log_lines', 'buy_log_payments', 'buy_log_pos', 'po_lines', 'batches'], load, { mount: false });

  const buys = data?.buys || [];
  const can = data?.can || {};
  const tot = useMemo(() => buys.reduce((t, b) => ({ pairs: t.pairs + b.money.pairs, total: t.total + b.money.total, paid: t.paid + b.money.paid }), { pairs: 0, total: 0, paid: 0 }), [buys]);

  function download(fmt) {
    const rows = buyRows(buys);
    const name = `buy-log_${from || 'start'}_to_${to || estToday()}`;
    if (fmt === 'csv') return downloadCSV(`${name}.csv`, toCsv(BUY_COLS, rows));
    const MONEY = new Set(['unit_cost', 'line_total', 'order_total', 'paid', 'balance']);
    const INT = new Set(['qty', 'sku_shipped', 'sku_received']);
    const bytes = buildXlsx({ sheetName: 'Buy log', columns: BUY_COLS.map(([k, label]) => ({ label, type: MONEY.has(k) ? 'money' : INT.has(k) ? 'int' : 'text' })), rows: rows.map((r) => BUY_COLS.map(([k]) => r[k])) });
    const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
    const a = document.createElement('a'); a.href = url; a.download = `${name}.xlsx`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const editing = isNew === '1' || !!openId;
  return (
    <div className="app">
      <TopBar title="Buy Log" onHome={onHome} onSignOut={onSignOut} />
      {editing ? (
        <BuyOrder id={openId ? Number(openId) : null} user={user} suppliers={data?.suppliers || []} canAll={!!can.all}
          onSignOut={onSignOut} onClose={() => { setOpenId(''); setIsNew(''); load(); }}
          onSaved={(id) => { setIsNew(''); setOpenId(String(id)); load(); }} />
      ) : (
        <div className="card">
          <p className="muted sm">
            What was bought from a store that gives no receipt: the shoes, what they cost, what was paid and when, and what has
            arrived. {can.all ? 'A supplier enters their own orders; you can enter one for them, and you record the payments.' : 'Enter each order here as you place it. Sizes are optional — leave them blank when the store picks them.'}
          </p>
          <div className="bl-toolbar">
            <input type="search" className="oo-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU, order #, store or tracking…" aria-label="Search the buy log" />
            <label><span className="muted xs">Ordered from</span><input className="input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" /></label>
            <label><span className="muted xs">to</span><input className="input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" /></label>
            {(q || from || to) && <button type="button" className="btn ghost sm" onClick={() => { setQ(''); setFrom(''); setTo(''); }}>Clear</button>}
            <span className="bl-grow" />
            <button type="button" className="btn ghost sm" disabled={!buys.length} onClick={() => download('xlsx')}>⬇ Excel</button>
            <button type="button" className="btn ghost sm" disabled={!buys.length} onClick={() => download('csv')}>⬇ CSV</button>
            {can.edit && <button type="button" className="btn primary sm" onClick={() => setIsNew('1')}>＋ New order</button>}
          </div>
          {error && <div className="error mt">{error}</div>}
          {data == null ? <p className="muted">Loading…</p> : !buys.length ? (
            <p className="muted">{q || from || to ? 'No orders match.' : 'No orders yet. Press ＋ New order to enter the first one.'}</p>
          ) : (
            <>
              <div className="bl-totals">
                <span><b>{buys.length}</b> <span className="muted xs">order{buys.length === 1 ? '' : 's'}</span></span>
                <span><b>{tot.pairs.toLocaleString('en-US')}</b> <span className="muted xs">pairs</span></span>
                <span><b>{usd(tot.total)}</b> <span className="muted xs">ordered</span></span>
                <span><b>{usd(tot.paid)}</b> <span className="muted xs">paid</span></span>
                <span><b>{usd(tot.total - tot.paid)}</b> <span className="muted xs">balance</span></span>
              </div>
              <div className="bl-scroll">
                <table className="bl-table">
                  <thead><tr><th>Order</th>{can.all && <th>Bought by</th>}<th>Store · order #</th><th>Shoes</th><th className="num">Pairs</th><th className="num">Total</th><th>Payment</th><th>Receiving</th></tr></thead>
                  <tbody>
                    {buys.map((b) => (
                      <tr key={b.id} className="bl-row" onClick={() => setOpenId(String(b.id))}>
                        <td data-label="Order"><button type="button" className="bl-link" onClick={(e) => { e.stopPropagation(); setOpenId(String(b.id)); }}>{b.code}</button><div className="muted xs">{b.ordered_on || 'no date'}</div></td>
                        {can.all && <td data-label="Bought by">{b.supplier_name}</td>}
                        <td data-label="Store · order #">{b.store || '—'}{b.order_number ? <div className="muted xs">#{b.order_number}</div> : null}</td>
                        <td data-label="Shoes"><b>{b.lines[0]?.sku}</b>{b.lines.length > 1 ? <span className="muted sm"> +{new Set(b.lines.map((l) => l.sku)).size - 1} more</span> : null}</td>
                        <td data-label="Pairs" className="num">{b.money.pairs}</td>
                        <td data-label="Total" className="num">{usd(b.money.total)}</td>
                        <td data-label="Payment"><Chip tone={PAY_TONE[b.money.state]}>{PAY_LABEL[b.money.state]}</Chip>{b.money.state === 'part' ? <div className="muted xs">{usd(b.money.balance)} left</div> : null}</td>
                        <td data-label="Receiving"><Chip tone={RECV_TONE[b.receiving]}>{RECV_LABEL[b.receiving]}</Chip>{b.pos.length ? <div className="muted xs">{b.counts.received} of {b.counts.ordered} in</div> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// One order: the declaration (editable), then — once it exists — payments, purchase orders
// and the ordered / shipped / received comparison.
function BuyOrder({ id, suppliers, canAll, onClose, onSaved, onSignOut }) {
  const [buy, setBuy] = useState(null);
  const [can, setCan] = useState({ edit: true, pay: false });
  const [pos, setPos] = useState([]);
  const [form, setForm] = useState({ supplier_user_id: '', store: '', order_number: '', ordered_on: estToday(), tracking: '', note: '' });
  const [lines, setLines] = useState([blankLine()]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pay, setPay] = useState({ paid_on: estToday(), amount: '', method: 'Zelle', paid_by: '', note: '' });
  const [poPick, setPoPick] = useState('');

  const fill = (b) => {
    setForm({ supplier_user_id: b.supplier_user_id || '', store: b.store, order_number: b.order_number, ordered_on: b.ordered_on || '', tracking: (b.tracking_numbers || []).join('\n'), note: b.note });
    setLines(b.lines.map((l) => ({ key: `l${l.id}`, id: l.id, sku: l.sku, name: l.name || '', size: l.size || '', qty: String(l.qty), unit_cost: String(l.unit_cost), entered_by: l.entered_by })));
    setDirty(false);
  };
  async function load({ keepForm = false } = {}) {
    if (!id) return;
    try {
      const r = await api.buyLog(id);
      setBuy(r.buy); setCan(r.can || {}); setPos(r.pos || []);
      if (!keepForm) fill(r.buy);
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }
  useEffect(() => { setBuy(null); setError(''); setNotice(''); if (id) load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Someone else's payment or a new receive shows up by itself — never over what is being typed.
  useLive(['buy_logs', 'buy_log_lines', 'buy_log_payments', 'buy_log_pos', 'po_lines', 'batches'], () => load({ keepForm: dirty }), { mount: false });

  const setF = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); };
  const setL = (key, k, v) => { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [k]: v } : l))); setDirty(true); };
  const typed = lines.filter((l) => l.sku.trim() || l.qty || l.unit_cost);
  const draft = buyMoney(typed.map((l) => ({ qty: Number(l.qty) || 0, unit_cost: Number(l.unit_cost) || 0 })), buy?.payments || []);
  const editable = can.edit !== false;

  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api.buyLogSave({
        id: id || undefined, supplier_user_id: form.supplier_user_id || undefined, store: form.store, order_number: form.order_number,
        ordered_on: form.ordered_on, tracking_numbers: form.tracking.split(/[\s,;]+/).filter(Boolean), note: form.note,
        lines: typed.map((l) => ({ id: l.id, sku: l.sku, name: l.name, size: l.size, qty: Number(l.qty), unit_cost: l.unit_cost === '' ? '' : Number(l.unit_cost) })),
      });
      setNotice('Saved.'); setDirty(false);
      if (!id) onSaved(r.id); else await load();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  }
  async function act(body, done) {
    setBusy(true); setError(''); setNotice('');
    try { await api.buyLogAct({ id, ...body }); done?.(); await load({ keepForm: dirty }); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); await load({ keepForm: dirty }); }
    finally { setBusy(false); }
  }
  const remove = async () => {
    if (!window.confirm(`Delete ${buy.code}? Its lines, payments and PO links go with it.`)) return;
    setBusy(true);
    try { await api.buyLogAct({ id, action: 'delete' }); onClose(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); setBusy(false); }
  };
  const linkable = pos.filter((o) => !(buy?.pos || []).some((x) => x.po_id === o.po_id));

  if (id && !buy) return <div className="card"><button type="button" className="btn ghost sm" onClick={onClose}>← All orders</button>{error ? <div className="error mt">{error}</div> : <p className="muted">Loading…</p>}</div>;
  return (
    <>
      <div className="card">
        <div className="bl-head">
          <button type="button" className="btn ghost sm" onClick={() => { if (!dirty || window.confirm('Leave without saving your changes?')) onClose(); }}>← All orders</button>
          <h2 className="bl-title">{buy ? buy.code : 'New order'}{buy ? <span className="muted sm"> · {buy.supplier_name}</span> : null}</h2>
          {buy && <span className="bl-chips"><Chip tone={PAY_TONE[buy.money.state]}>{PAY_LABEL[buy.money.state]}</Chip><Chip tone={RECV_TONE[buy.receiving]}>{RECV_LABEL[buy.receiving]}</Chip></span>}
        </div>
        {buy && <p className="muted xs">Entered by {buy.created_by || '—'} {when(buy.created_at)}{buy.updated_by ? ` · last changed by ${buy.updated_by} ${when(buy.updated_at)}` : ''}</p>}
        <div className="bl-form">
          {!id && canAll && (
            <label><span className="muted xs">Whose order</span>
              <select className="input" value={form.supplier_user_id} onChange={(e) => setF('supplier_user_id', e.target.value)} aria-label="Whose order">
                <option value="">Pick the supplier…</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {!suppliers.length && <span className="muted xs">No supplier has “Keep a buy log” switched on yet (Check Access).</span>}
            </label>
          )}
          <label><span className="muted xs">Store</span><input className="input" value={form.store} disabled={!editable} maxLength={120} placeholder="Nike Factory Store — Lancaster" onChange={(e) => setF('store', e.target.value)} aria-label="Store" /></label>
          <label><span className="muted xs">Order # (if any)</span><input className="input" value={form.order_number} disabled={!editable} maxLength={60} onChange={(e) => setF('order_number', e.target.value)} aria-label="Order number" /></label>
          <label><span className="muted xs">Order date (EST)</span><input className="input" type="date" value={form.ordered_on} disabled={!editable} onChange={(e) => setF('ordered_on', e.target.value)} aria-label="Order date" /></label>
          <label className="bl-wide"><span className="muted xs">Tracking numbers (one per line, when it ships)</span><textarea className="input" rows={2} value={form.tracking} disabled={!editable} onChange={(e) => setF('tracking', e.target.value)} aria-label="Tracking numbers" /></label>
          <label className="bl-wide"><span className="muted xs">Note</span><input className="input" value={form.note} disabled={!editable} maxLength={600} onChange={(e) => setF('note', e.target.value)} aria-label="Note" /></label>
        </div>

        <h3 className="rows-title">Shoes <span className="muted sm">· SKU, pairs and cost are needed; the size only if you know it</span></h3>
        <div className="bl-scroll">
          <table className="bl-table bl-lines">
            <thead><tr><th>SKU</th><th>Shoe name (optional)</th><th>Size (optional)</th><th className="num">Pairs</th><th className="num">Cost per pair</th><th className="num">Line total</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td><input className="input" value={l.sku} disabled={!editable} maxLength={40} placeholder="HF5441-112" onChange={(e) => setL(l.key, 'sku', e.target.value.toUpperCase())} aria-label={`SKU, line ${i + 1}`} /></td>
                  <td><input className="input" value={l.name} disabled={!editable} maxLength={160} onChange={(e) => setL(l.key, 'name', e.target.value)} aria-label={`Shoe name, line ${i + 1}`} /></td>
                  <td><input className="input bl-sm" value={l.size} disabled={!editable} maxLength={12} placeholder="any" onChange={(e) => setL(l.key, 'size', e.target.value)} aria-label={`Size, line ${i + 1}`} /></td>
                  <td className="num"><input className="input bl-sm" type="number" min="1" step="1" inputMode="numeric" value={l.qty} disabled={!editable} onChange={(e) => setL(l.key, 'qty', e.target.value)} aria-label={`Pairs, line ${i + 1}`} /></td>
                  <td className="num"><input className="input bl-sm" type="number" min="0" step="0.01" inputMode="decimal" value={l.unit_cost} disabled={!editable} onChange={(e) => setL(l.key, 'unit_cost', e.target.value)} aria-label={`Cost per pair, line ${i + 1}`} /></td>
                  <td className="num">{l.qty && l.unit_cost !== '' ? usd(Number(l.qty) * Number(l.unit_cost)) : '—'}{l.entered_by ? <div className="muted xs">by {l.entered_by}</div> : null}</td>
                  <td>{editable && lines.length > 1 && <button type="button" className="btn ghost sm" aria-label={`Remove line ${i + 1}`} onClick={() => { setLines((ls) => ls.filter((x) => x.key !== l.key)); setDirty(true); }}>✕</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="bl-foot">
          {editable && <button type="button" className="btn ghost sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>＋ Add a shoe</button>}
          <span className="bl-grow" />
          <span><b>{draft.pairs}</b> <span className="muted xs">pairs</span> · <b>{usd(draft.total)}</b> <span className="muted xs">order total</span></span>
        </div>
        {error && <div className="error mt" role="alert">{error}</div>}
        {notice && <div className="notice mt" role="status">{notice}</div>}
        {editable && (
          <div className="bl-foot">
            <button type="button" className="btn primary" disabled={busy || (!dirty && !!id) || !typed.length} onClick={save}>{busy ? 'Saving…' : id ? 'Save changes' : 'Save the order'}</button>
            {buy && <button type="button" className="btn ghost sm bl-danger" disabled={busy} onClick={remove}>Delete this order</button>}
          </div>
        )}
      </div>

      {buy && (
        <>
          <div className="card">
            <h3 className="rows-title">Payments <span className="muted sm">· {usd(buy.money.paid)} paid of {usd(buy.money.total)}{buy.money.balance > 0.005 ? ` · ${usd(buy.money.balance)} still to pay` : buy.money.balance < -0.005 ? ` · ${usd(-buy.money.balance)} over` : ''}</span></h3>
            {!buy.payments.length ? <p className="muted sm">No payment recorded yet.</p> : (
              <div className="bl-scroll">
                <table className="bl-table">
                  <thead><tr><th>Paid on</th><th className="num">Amount</th><th>How</th><th>Sent by</th><th>Note</th><th>Recorded</th><th /></tr></thead>
                  <tbody>{buy.payments.map((p) => (
                    <tr key={p.id}>
                      <td>{p.paid_on}</td><td className="num"><b>{usd(p.amount)}</b></td><td>{p.method || '—'}</td><td>{p.paid_by || '—'}</td><td className="sm">{p.note || ''}</td>
                      <td className="muted xs">{p.created_by} {when(p.created_at)}</td>
                      <td>{can.pay && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { if (window.confirm(`Remove the ${usd(p.amount)} payment of ${p.paid_on}?`)) act({ action: 'unpay', payment_id: p.id }); }}>Remove</button>}</td>
                    </tr>))}
                  </tbody>
                </table>
              </div>
            )}
            {can.pay ? (
              <div className="bl-form bl-pay">
                <label><span className="muted xs">Paid on (EST)</span><input className="input" type="date" value={pay.paid_on} max={estToday()} onChange={(e) => setPay({ ...pay, paid_on: e.target.value })} aria-label="Paid on" /></label>
                <label><span className="muted xs">Amount</span><input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} aria-label="Amount paid" /></label>
                <label><span className="muted xs">How</span><select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} aria-label="Payment method">{METHODS.map((m) => <option key={m}>{m}</option>)}</select></label>
                <label><span className="muted xs">Sent by</span><input className="input" value={pay.paid_by} maxLength={80} placeholder="Alex" onChange={(e) => setPay({ ...pay, paid_by: e.target.value })} aria-label="Sent by" /></label>
                <label className="bl-wide"><span className="muted xs">Note (reference #, who received it)</span><input className="input" value={pay.note} maxLength={300} onChange={(e) => setPay({ ...pay, note: e.target.value })} aria-label="Payment note" /></label>
                <button type="button" className="btn primary sm" disabled={busy || !(Number(pay.amount) > 0) || !pay.paid_on}
                  onClick={() => act({ action: 'pay', ...pay, amount: Number(pay.amount) }, () => setPay({ ...pay, amount: '', note: '' }))}>Record payment</button>
              </div>
            ) : <p className="muted xs">Payments are recorded by the Stickballman12 team.</p>}
          </div>

          <div className="card">
            <h3 className="rows-title">Shipped and received <span className="muted sm">· {buy.counts.received} of {buy.counts.ordered} pairs in</span></h3>
            <p className="muted sm">Link the purchase order(s) this order ships on. “Shipped” is what those POs’ box lists say; “Received” is what the warehouse scanned in on them.</p>
            <div className="bl-pos">
              {buy.pos.map((o) => (
                <span key={o.po_id} className="bl-po"><b>{o.po_code}</b> <span className="muted xs">{o.status}{o.tag_code ? ` · ${o.tag_code}` : ''}</span>
                  {editable && <button type="button" className="btn ghost sm" disabled={busy} aria-label={`Unlink ${o.po_code}`} onClick={() => act({ action: 'unlink', po_id: o.po_id })}>✕</button>}</span>
              ))}
              {editable && (linkable.length ? (
                <>
                  <select className="input" value={poPick} onChange={(e) => setPoPick(e.target.value)} aria-label="Purchase order to link">
                    <option value="">Pick a purchase order…</option>
                    {linkable.map((o) => <option key={o.po_id} value={o.po_id}>{o.po_code} · {o.day} · {o.pairs} pairs · {o.status}{o.tag_code ? ` · ${o.tag_code}` : ''}</option>)}
                  </select>
                  <button type="button" className="btn sm" disabled={busy || !poPick} onClick={() => act({ action: 'link', po_id: Number(poPick) }, () => setPoPick(''))}>Link</button>
                </>
              ) : !buy.pos.length ? <span className="muted sm">No purchase order from {buy.supplier_name} to link yet — open one when it ships.</span> : null)}
            </div>
            <div className="bl-scroll">
              <table className="bl-table">
                <thead><tr><th>SKU</th><th className="num">Ordered</th><th className="num">Shipped</th><th className="num">Received</th><th className="num">Still to come</th><th>By size (ordered → received)</th></tr></thead>
                <tbody>{buy.compare.map((r) => (
                  <tr key={r.sku} className={r.extra ? 'bl-extra' : ''}>
                    <td><b>{r.sku}</b>{r.name ? <div className="muted xs">{r.name}</div> : null}{r.extra ? <div className="xs"><Chip tone="warn">not on this order</Chip></div> : null}</td>
                    <td className="num">{r.extra ? '—' : r.ordered}</td><td className="num">{r.shipped}</td>
                    <td className="num"><b>{r.received}</b>{!r.extra && r.received > r.ordered ? <div className="xs"><Chip tone="warn">+{r.received - r.ordered}</Chip></div> : null}</td>
                    <td className="num">{r.extra ? '—' : r.short || <Chip tone="ok">all in</Chip>}</td>
                    <td className="sm">{r.sizes ? r.sizes.map((z) => <span key={z.size} className={`bl-size${z.received === z.ordered ? '' : ' off'}`}>{z.size}: {z.ordered} → {z.received}</span>) : r.extra ? '' : <span className="muted">sizes not declared</span>}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
