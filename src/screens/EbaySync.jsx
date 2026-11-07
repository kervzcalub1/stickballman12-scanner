// eBay Sync (PH + admin) — the front end of our own replacement for the DPL Shopify <-> eBay
// app (docs/ebay-sync-plan.md). Overview says plainly who writes what today; the rest mirror
// DPL's tabs so staff recognise them. Every write has its own switch (Off / Test / Live) and
// there is one kill switch. Reading is for everyone on the PH team; changing anything is for
// an admin or "Connect integrations" (server enforces it too).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FormModal } from '../components/common.jsx';
import { api } from '../api.js';
import { hasPriv } from '../lib/constants.js';
import { useLive } from '../hooks.js';
import { useQueryParam, writeParam } from '../lib/urlstate.js';
import { PH_DATETIME } from '../lib/format.js';

const LIVE_TABLES = ['ebay_sync_links', 'ebay_sync_products', 'ebay_sync_log', 'ebay_sync_queue', 'app_settings'];
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const when = (iso) => (iso ? `${PH_DATETIME.format(new Date(iso))} EST` : '—');
const money = (n) => (n == null || n === '' ? '—' : `$${Number(n).toFixed(2)}`);
const human = (k) => { const s = String(k || '').replace(/[_-]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : ''; };

// The six writers. `key` is the switch name in settings.switches.
const PARTS = [
  { key: 'stock', label: 'Stock', what: 'Shopify stock to eBay', pass: 'queue' },
  { key: 'price', label: 'Price', what: 'Shopify price to eBay', pass: 'reconcile' },
  { key: 'content', label: 'Content', what: 'Title, description, photos, sizes', pass: 'content' },
  { key: 'create', label: 'New listings', what: 'List new Shopify shoes on eBay', pass: 'create' },
  { key: 'end', label: 'End listings', what: 'End eBay listings when the shoe is gone', pass: 'queue' },
];
const PASSES = [['queue', 'Queue (stock + ending)'], ['reconcile', 'Full check'], ['content', 'Content check'], ['create', 'New listings check']];

const MODE_WORDS = {
  off: 'Off',
  shadow: 'Test mode: recording only, DPL is still writing',
  live: 'Live: we write this',
};
const modeWords = (m) => MODE_WORDS[m] || 'Off';
const MODE_BUTTONS = [['off', 'Off'], ['shadow', 'Test'], ['live', 'Live']];

// What turning a part Live really changes — shown in the confirm, in plain words.
const LIVE_EFFECT = {
  stock: 'We will send Shopify quantities to eBay.',
  price: 'We will send prices to eBay (listings with a price lock or one of our own reprices keep their price).',
  content: 'We will change titles, descriptions, photos and sizes on live eBay listings.',
  create: 'We will put new Shopify shoes on eBay as real listings.',
  end: 'We will end eBay listings when the shoe is gone from Shopify.',
};

const useNarrow = () => {
  const q = '(max-width: 767px)';
  const [n, setN] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setN(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return n;
};

function Thumb({ src, alt }) {
  const [bad, setBad] = useState(false);
  return src && !bad
    ? <img className="ebl-thumb" src={src} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)} />
    : <span className="ebl-thumb ebl-thumb-empty" aria-hidden="true" />;
}

// Desktop: a table. Phone: one card per row (no sideways scrolling). `cols` = [{ h, cell(row), primary }].
function DataList({ rows, cols, rowKey, narrow, label }) {
  if (narrow) {
    return (
      <div className="esy-cards" aria-label={label}>
        {rows.map((r) => (
          <div className="esy-rc" key={rowKey(r)}>
            <div className="esy-rc-top">
              {cols.filter((c) => c.thumb).map((c) => <div className="esy-rc-thumb" key={c.h}>{c.cell(r)}</div>)}
              {cols.filter((c) => c.primary).map((c) => <div className="esy-rc-main" key={c.h}>{c.cell(r)}</div>)}
            </div>
            {cols.filter((c) => !c.primary && !c.thumb).map((c) => {
              const v = c.cell(r);
              if (v == null || v === false || v === '') return null;
              return <div className="esy-rc-row" key={c.h}><span className="esy-rc-k">{c.h}</span><span className="esy-rc-v">{v}</span></div>;
            })}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="ap-tablewrap">
      <table className="table esy-table" aria-label={label}>
        <thead><tr>{cols.map((c) => <th key={c.h}>{c.h}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={rowKey(r)}>{cols.map((c) => <td key={c.h}>{c.cell(r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

// One paged read. Never shows zeros on a failure: `err` is set and `data` stays null until a read works.
function usePaged(fetcher, deps, onSignOut) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const size = useRef(0);
  const seq = useRef(0);
  const key = JSON.stringify(deps);
  const lastKey = useRef(key);
  // A new filter or search starts again from the first page.
  useEffect(() => { if (lastKey.current !== key) { lastKey.current = key; setOffset(0); setData(null); } }, [key]);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await fetcher(offset);
      if (my !== seq.current) return;
      if (offset === 0) size.current = (r.rows || []).length;
      setData(r); setErr('');
    } catch (e) {
      if (my !== seq.current) return;
      if (e.unauthorized) onSignOut(); else setErr(e.message || 'Could not load.');
    } finally { if (my === seq.current) setLoading(false); }
  }, [fetcher, offset, onSignOut]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = useRef(true);
  useEffect(() => { setLoading(true); load(); first.current = false; }, [load, key, offset]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(LIVE_TABLES, load, { mount: false });
  const rows = data?.rows || [];
  const pager = {
    offset, total: data?.total ?? rows.length, count: rows.length,
    prev: () => setOffset(Math.max(0, offset - (size.current || rows.length || 50))),
    next: () => setOffset(offset + rows.length),
  };
  return { data, rows, err, loading, reload: load, pager };
}

function Pager({ p, label }) {
  if (!p.total || (p.offset === 0 && p.offset + p.count >= p.total)) return null;
  return (
    <div className="batch-pager">
      <button type="button" className="btn ghost sm" disabled={p.offset <= 0} onClick={p.prev}>← Prev</button>
      <span className="muted sm batch-pager-at">{fmt(p.offset + 1)}–{fmt(p.offset + p.count)} of {fmt(p.total)} {label}</span>
      <button type="button" className="btn ghost sm" disabled={p.offset + p.count >= p.total} onClick={p.next}>Next →</button>
    </div>
  );
}

// loading / error / empty wrapper so every list says the same thing the same way.
function Body({ st, empty, children }) {
  if (st.err && !st.data) return <div className="error mt" role="alert">Could not load this: {st.err} <button type="button" className="btn ghost sm" onClick={() => { st.reload(); }}>Try again</button></div>;
  if (!st.data) return <p className="muted mt">Loading…</p>;
  return (
    <>
      {st.err && <div className="error mt" role="alert">Could not refresh: {st.err}</div>}
      {st.rows.length === 0 ? <p className="muted mt">{empty}</p> : children}
    </>
  );
}

function SubTabs({ items, value, onChange, counts }) {
  return (
    <div className="seg sm esy-sub">
      {items.map(([k, label]) => (
        <button key={k} type="button" className={`seg-btn${value === k ? ' on' : ''}`} aria-pressed={value === k} onClick={() => onChange(k)}>
          {label}{counts && counts[k] != null && <> <span className="seg-n" aria-hidden="true">{fmt(counts[k])}</span></>}
        </button>
      ))}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return <input type="search" className="input esy-search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />;
}

const sizesText = (s) => (Array.isArray(s) ? s.join(', ') : s == null ? '' : String(s));

// ---------- Overview ----------
function Overview({ st, canEdit, onRun, busy }) {
  const sw = st.settings?.switches || {};
  const passes = st.passes || {};
  const handover = st.handover || [];
  const counts = st.counts && typeof st.counts === 'object' ? Object.entries(st.counts).filter(([, v]) => typeof v === 'number') : [];
  const facts = st.facts && typeof st.facts === 'object' ? Object.entries(st.facts) : [];
  const b = st.budget;
  return (
    <>
      <div className="card">
        <h3 className="er-step-title">Who is writing what today</h3>
        <p className="muted sm">Two systems writing the same thing fight each other, so each part has its own switch. DPL keeps running until a part is proven.</p>
        <p className="sm" data-orders-note><b>Orders:</b> DPL brings eBay orders into Shopify. This page doesn't touch orders.</p>
        <div className="esy-parts">
          {PARTS.map((p) => {
            const m = sw[p.key] || 'off';
            return (
              <div className={`esy-part ${m}`} key={p.key} data-part={p.key}>
                <div className="esy-part-name">{p.label}<span className="muted xs"> · {p.what}</span></div>
                <div className="esy-part-state">{modeWords(m)}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h3 className="er-step-title">Connections</h3>
        <ul className="esy-list">
          <li>{st.ebay?.connected ? <span className="ebl-ok">● eBay connected{st.ebay.user ? <> as <b>{st.ebay.user}</b></> : ''}</span> : <span className="error">● eBay is not connected. Connect it on the eBay page.</span>}</li>
          <li>
            {b ? (
              <>Trading API calls today: <b>{fmt(b.used)}</b> of {fmt(b.limit)}{b.resetAt ? <span className="muted"> · resets {when(b.resetAt)}</span> : ''}
                <div className="esy-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, b.limit ? (b.used / b.limit) * 100 : 0)}%` }} /></div></>
            ) : <span className="muted">Trading API budget: not reported</span>}
          </li>
        </ul>
      </div>

      <div className="card">
        <div className="esy-head">
          <h3 className="er-step-title">Last runs</h3>
        </div>
        {passes.reconcile?.aborted && (
          <div className="error" data-aborted>
            <p className="sm">The full check stopped and changed nothing: {passes.reconcile.aborted.why}</p>
            {passes.reconcile.aborted.shrank && canEdit && (
              <>
                <p className="sm">If that drop is real, for example after a bulk clean-up, accept the new counts and the check will carry on.</p>
                <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => onRun('reconcile', { acceptCounts: true })}>Accept the new counts</button>
              </>
            )}
          </div>
        )}
        <ul className="esy-list">
          {PASSES.map(([k, label]) => {
            const r = passes[k];
            return (
              <li key={k} data-pass={k}>
                <b>{label}</b>{' '}
                {!r || !r.at ? <span className="muted">has not run yet</span>
                  : <>{r.ok === false ? <span className="error">failed</span> : <span className="ebl-ok">ok</span>} <span className="muted">{when(r.at)}</span>{r.note ? <span className={r.ok === false ? 'error' : 'muted'}> · {r.note}</span> : ''}</>}
                {canEdit && <button type="button" className="btn ghost sm esy-run" disabled={!!busy} onClick={() => onRun(k)}>{busy === k ? 'Starting…' : 'Run now'}</button>}
              </li>
            );
          })}
        </ul>
      </div>

      {counts.length > 0 && (
        <div className="card">
          <h3 className="er-step-title">Counts</h3>
          <div className="esy-counts">{counts.map(([k, v]) => <div key={k}><b>{fmt(v)}</b><span className="muted xs">{human(k)}</span></div>)}</div>
        </div>
      )}

      <div className="card">
        <h3 className="er-step-title">Ready to hand over from DPL?</h3>
        {handover.length === 0 ? <p className="muted sm">No checks reported yet.</p> : (
          <ul className="esy-list esy-hand">
            {handover.map((h) => (
              <li key={h.key} data-ok={h.ok ? '1' : '0'}>
                <span className={h.ok ? 'ebl-ok' : 'warn-text'} aria-label={h.ok ? 'Done' : 'Not yet'}>{h.ok ? '✓' : '○'}</span> <b>{h.label}</b>
                {h.detail && <div className="muted sm">{h.detail}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {facts.length > 0 && (
        <div className="card">
          <h3 className="er-step-title">Facts</h3>
          <dl className="esy-facts">{facts.map(([k, v]) => <React.Fragment key={k}><dt>{human(k)}</dt><dd>{typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}</dd></React.Fragment>)}</dl>
        </div>
      )}
    </>
  );
}

// ---------- Shopify Products ----------
function ProductsTab({ st, canEdit, narrow, onSignOut }) {
  const [sub, setSub] = useQueryParam('ssub', 'needs_attention');
  const [q, setQ] = useQueryParam('syncq', '');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [aerr, setAerr] = useState('');
  const fetcher = useCallback((offset) => api.ebaySyncProducts({ tab: sub, q, offset }), [sub, q]);
  const list = usePaged(fetcher, [sub, q], onSignOut);
  const [tabs, setTabs] = useState(null);
  useEffect(() => { if (list.data?.tabs) setTabs(list.data.tabs); }, [list.data]);
  const createLive = st.settings?.switches?.create === 'live';

  async function act(row, action) {
    setBusy(`${action}:${row.shopify_product_id}`); setAerr(''); setMsg('');
    try {
      await api.ebaySyncProductAction(row.shopify_product_id, action);
      setMsg(action === 'verify' ? `Asked eBay about “${row.title}”.` : `Sent “${row.title}” to eBay.`);
      await list.reload();
    } catch (e) { if (e.unauthorized) onSignOut(); else setAerr(e.message || 'That did not go through.'); }
    finally { setBusy(''); }
  }

  const cols = [
    { h: 'Photo', thumb: true, cell: (r) => <Thumb src={r.image} alt={r.title} /> },
    { h: 'Shoe', primary: true, cell: (r) => (
      <div>
        <div className="ebl-title">{r.title}</div>
        <div className="muted xs ebl-meta">
          {r.style && <span>{r.style}</span>}
          {r.view_url ? <a className="ebl-link" href={r.view_url} target="_blank" rel="noreferrer">on eBay{r.item_id ? ` #${r.item_id}` : ''} ↗</a> : (r.item_id && <span>#{r.item_id}</span>)}
        </div>
      </div>) },
    ...(narrow ? [] : [{ h: 'Style', cell: (r) => r.style || <span className="muted">—</span> }]),
    { h: 'Sizes', cell: (r) => (sizesText(r.sizes) ? <span>{sizesText(r.sizes)}{r.qty != null && <span className="muted"> · qty {fmt(r.qty)}</span>}</span> : (r.qty != null ? `qty ${fmt(r.qty)}` : '')) },
    ...(sub === 'needs_attention' ? [{ h: 'What is wrong and how to fix it', cell: (r) => (
      <ul className="esy-issues">{(r.issues || []).map((i, n) => (
        <li key={`${i.code}-${n}`}><b>{i.message}</b>{i.fix && <div className="esy-fix"><span className="muted">Fix: </span>{i.fix}</div>}</li>
      ))}{(!r.issues || !r.issues.length) && <li className="muted">eBay did not say why. Press Check with eBay.</li>}</ul>) }] : []),
    { h: 'Checked', cell: (r) => (r.checked_at ? when(r.checked_at) : (sub === 'needs_attention' ? 'never' : '')) },
    ...(canEdit ? [{ h: 'Actions', cell: (r) => (
      <div className="esy-actions">
        <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => act(r, 'verify')}>{busy === `verify:${r.shopify_product_id}` ? 'Asking…' : 'Check with eBay'}</button>
        {createLive && sub !== 'uploaded' && <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => act(r, 'list')}>List on eBay</button>}
      </div>) }] : []),
  ];

  return (
    <div className="card">
      <div className="esy-filters">
        <SubTabs items={[['uploaded', 'Uploaded'], ['not_uploaded', 'Not Uploaded'], ['needs_attention', 'Needs Attention']]} value={sub} onChange={setSub} counts={tabs} />
        <SearchBox value={q} onChange={setQ} placeholder="Search title, style or SKU" />
      </div>
      {msg && <div className="notice mt">{msg}</div>}
      {aerr && <div className="error mt" role="alert">{aerr}</div>}
      {sub === 'needs_attention' && <p className="muted sm">Shoes eBay refused or that we can't list yet, with the fix in plain words.</p>}
      <Body st={list} empty={sub === 'needs_attention' ? 'Nothing needs attention.' : sub === 'uploaded' ? 'No shoes on eBay match.' : 'No shoes are waiting to be uploaded.'}>
        <DataList rows={list.rows} cols={cols} rowKey={(r) => r.shopify_product_id} narrow={narrow} label="Shopify products" />
      </Body>
      <Pager p={list.pager} label="shoes" />
    </div>
  );
}

// ---------- eBay Products ----------
const RULE_WORDS = { kept_lock: 'Kept: locked', kept_repriced: 'Kept: repriced', kept_manual: 'Kept: set on eBay', follows_shopify: 'Follows Shopify' };
const ruleWords = (r) => RULE_WORDS[r] || '';
function ListingsTab({ narrow, onSignOut, onTab }) {
  const [f, setF] = useQueryParam('sf', 'all');
  const [q, setQ] = useQueryParam('syncq', '');
  const fetcher = useCallback((offset) => api.ebaySyncListings({ filter: f, q, offset }), [f, q]);
  const ebayPage = window.location.pathname.startsWith('/ph') ? '/ph/ebay-listings' : '/ebay';
  const jump = (t) => (e) => { e.preventDefault(); onTab(t); };
  const list = usePaged(fetcher, [f, q], onSignOut);
  const [tabs, setTabs] = useState(null);
  useEffect(() => { if (list.data?.tabs) setTabs(list.data.tabs); }, [list.data]);
  const cols = [
    { h: 'Listing', primary: true, cell: (r) => (
      <div><div className="ebl-title">{r.title}</div>
        <div className="muted xs ebl-meta">{r.view_url ? <a className="ebl-link" href={r.view_url} target="_blank" rel="noreferrer">#{r.item_id} ↗</a> : <span>#{r.item_id}</span>}</div></div>) },
    { h: 'SKU', cell: (r) => <span className="ebl-sku">{r.sku || '—'}</span> },
    { h: 'Size', cell: (r) => r.size || '' },
    { h: 'Qty eBay / Shopify', cell: (r) => <span className={r.ebay_qty !== r.shopify_qty ? 'warn-text' : ''}>{r.ebay_qty ?? '—'} / {r.shopify_qty ?? '—'}</span> },
    { h: 'Price eBay / Shopify', cell: (r) => <span className={Number(r.ebay_price) !== Number(r.shopify_price) ? 'warn-text' : ''}>{money(r.ebay_price)} / {money(r.shopify_price)}</span> },
    { h: 'Price rule', cell: (r) => ruleWords(r.price_rule) },
    { h: 'State', cell: (r) => (r.state ? <span>{human(r.state)}{r.drift_since ? <span className="muted xs"> · since {when(r.drift_since)}</span> : ''}</span> : '') },
  ];
  return (
    <div className="card">
      <div className="esy-filters">
        <SubTabs items={[['all', 'All'], ['qty_drift', 'Stock differs'], ['price_kept', 'Price kept'], ['price_drift', 'Price differs'], ['no_shopify', 'Not in Shopify']]} value={f} onChange={setF} counts={tabs} />
        <SearchBox value={q} onChange={setQ} placeholder="Search title, SKU or item #" />
      </div>
      {f === 'no_shopify' && <p className="sm" data-link-note="end">Ending these is done on the eBay page, in <a className="ebl-link" href={`${ebayPage}?tab=orphans`} onClick={jump('orphans')}>Not in Shopify — end</a>.</p>}
      {f === 'price_kept' && <p className="sm" data-link-note="reprice">Repricing is done on the eBay page, in <a className="ebl-link" href={`${ebayPage}?tab=reprice`} onClick={jump('reprice')}>Reprice</a>.</p>}
      <p className="muted sm">Each row is one size. “Kept: repriced” means a price lock or our own reprice holds it; “Follows Shopify” means the Shopify price goes to eBay once Price is live.</p>
      <Body st={list} empty="No eBay sizes match.">
        <DataList rows={list.rows} cols={cols} rowKey={(r) => `${r.item_id}|${r.sku}|${r.size}`} narrow={narrow} label="eBay sizes" />
      </Body>
      <Pager p={list.pager} label="sizes" />
    </div>
  );
}

// ---------- Linked Inventory ----------
function InventoryTab({ narrow, onSignOut }) {
  const [q, setQ] = useQueryParam('syncq', '');
  const fetcher = useCallback((offset) => api.ebaySyncInventory({ q, offset }), [q]);
  const list = usePaged(fetcher, [q], onSignOut);
  const cols = [
    { h: 'SKU', primary: true, cell: (r) => <div><b className="ebl-sku">{r.sku}</b>{r.title && <div className="muted xs">{r.title}</div>}</div> },
    { h: 'Shopify stock', cell: (r) => { return fmt(r.stock); } },
    { h: 'eBay listings sharing it', cell: (r) => fmt(r.listing_count) },
    { h: 'Check', cell: (r) => (r.duplicate ? <span className="warn-text">Duplicate: this SKU is on more than one listing or variant. We show it and never guess.</span> : <span className="muted">fine</span>) },
  ];
  return (
    <div className="card">
      <div className="esy-filters"><SearchBox value={q} onChange={setQ} placeholder="Search SKU" /></div>
      <p className="muted sm">Shopify and eBay are linked by exact SKU only, the same way DPL does it.</p>
      <Body st={list} empty="No SKUs match.">
        <DataList rows={list.rows} cols={cols} rowKey={(r) => r.sku} narrow={narrow} label="Linked inventory" />
      </Body>
      <Pager p={list.pager} label="SKUs" />
    </div>
  );
}

// ---------- Profiles ----------
function ProfileCard({ profile, canEdit, onSaved, onSignOut }) {
  const [name, setName] = useState(profile.name || '');
  const [vals, setVals] = useState(() => Object.fromEntries(Object.entries(profile.config || {}).map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v, null, 1) : String(v ?? '')])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  async function save() {
    setErr(''); setOk(false);
    const config = {};
    for (const [k, orig] of Object.entries(profile.config || {})) {
      const raw = vals[k];
      if (typeof orig === 'object' && orig !== null) {
        try { config[k] = JSON.parse(raw); } catch { return setErr(`“${human(k)}” is not valid. Check the brackets and quotes.`); }
      } else if (typeof orig === 'number') {
        if (raw.trim() === '' || Number.isNaN(Number(raw))) return setErr(`“${human(k)}” must be a number.`);
        config[k] = Number(raw);
      } else config[k] = raw;
    }
    setBusy(true);
    try { await api.ebaySyncProfileSave({ id: profile.id, name, is_default: profile.is_default, config }); setOk(true); onSaved(); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message || 'That did not save.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="card" data-profile={profile.id}>
      <div className="esy-head">
        <h3 className="er-step-title">{profile.name || 'Profile'}{profile.is_default ? ' (default)' : ''}</h3>
      </div>
      <div className="esy-prof">
        {canEdit && (
          <label className="esy-field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        )}
        {Object.entries(profile.config || {}).map(([k, orig]) => (
          <label className="esy-field" key={k}><span>{human(k)}</span>
            {typeof orig === 'object' && orig !== null
              ? <textarea className="input" rows={Math.min(8, String(vals[k]).split('\n').length + 1)} value={vals[k]} disabled={!canEdit} onChange={(e) => setVals((s) => ({ ...s, [k]: e.target.value }))} />
              : <input className="input" value={vals[k]} disabled={!canEdit} inputMode={typeof orig === 'number' ? 'decimal' : undefined} onChange={(e) => setVals((s) => ({ ...s, [k]: e.target.value }))} />}
          </label>
        ))}
      </div>
      {err && <div className="error mt" role="alert">{err}</div>}
      {ok && <div className="notice mt">Saved.</div>}
      {canEdit
        ? <button type="button" className="btn primary mt" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save profile'}</button>
        : <p className="muted sm">Only an admin, or someone with Connect integrations, can change a profile.</p>}
    </div>
  );
}
function ProfilesTab({ canEdit, onSignOut }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { setData(await api.ebaySyncProfiles()); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message || 'Could not load.'); }
  }, [onSignOut]);
  useEffect(() => { load(); }, [load]);
  useLive(['ebay_sync_profiles'], load, { mount: false });
  if (err && !data) return <div className="error mt" role="alert">Could not load profiles: {err} <button type="button" className="btn ghost sm" onClick={load}>Try again</button></div>;
  if (!data) return <p className="muted mt">Loading…</p>;
  const profiles = data.profiles || [];
  if (!profiles.length) return <p className="muted mt">No profile yet.</p>;
  return <>{profiles.map((p) => <ProfileCard key={`${p.id}-${JSON.stringify(p.config)}`} profile={p} canEdit={canEdit} onSaved={load} onSignOut={onSignOut} />)}</>;
}

// ---------- Settings + Log ----------
function SettingsTab({ st, canEdit, narrow, onChanged, onSignOut }) {
  const s = st.settings || {};
  const sw = s.switches || {};
  const [confirm, setConfirm] = useState(null);   // { kind: 'live', part } | { kind: 'killoff' }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [blast, setBlast] = useState(String(s.blastPct ?? ''));
  useEffect(() => { setBlast(String(s.blastPct ?? '')); }, [s.blastPct]);

  async function save(body) {
    setErr(''); setBusy(true);
    try { const r = await api.ebaySyncSettings(body); onChanged(r.settings); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message || 'That did not go through.'); throw e; }
    finally { setBusy(false); }
  }
  const quiet = (body) => save(body).catch(() => {});
  const pick = (part, mode) => {
    if ((sw[part.key] || 'off') === mode) return;
    if (mode === 'live') setConfirm({ kind: 'live', part });
    else quiet({ switches: { [part.key]: mode } });
  };

  return (
    <>
      {err && <div className="error mt" role="alert">{err}</div>}
      {!canEdit && <div className="notice mt">You can look at the switches but not change them. Only an admin, or someone with Connect integrations, can.</div>}

      <div className={`card esy-kill${s.kill ? ' on' : ''}`}>
        <h3 className="er-step-title">Kill switch</h3>
        {s.kill ? (
          <>
            <p className="error" role="status">The kill switch is ON. Nothing is written to eBay or Shopify by this feature.</p>
            {canEdit && <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirm({ kind: 'killoff' })}>Turn the kill switch off</button>}
          </>
        ) : (
          <>
            <p className="muted sm">Stops every eBay write from this page at once. It does not touch DPL.</p>
            {canEdit && <button type="button" className="btn danger esy-killbtn" disabled={busy} onClick={() => quiet({ kill: true })}>STOP EVERYTHING NOW</button>}
          </>
        )}
      </div>

      <div className="card">
        <h3 className="er-step-title">What we write</h3>
        <p className="muted sm">Off does nothing. Test records what we would do and writes nothing. Live writes for real, and DPL writes the same thing too while it is still on.</p>
        {PARTS.map((p) => {
          const m = sw[p.key] || 'off';
          return (
            <div className="esy-switch" key={p.key} data-switch={p.key}>
              <div className="esy-switch-name"><b>{p.label}</b><div className="muted xs">{modeWords(m)}</div></div>
              <div className="seg sm esy-seg" role="group" aria-label={`${p.label} mode`}>
                {MODE_BUTTONS.map(([k, label]) => (
                  <button key={k} type="button" className={`seg-btn${m === k ? ' on' : ''}${k === 'live' && m === k ? ' no' : ''}`} aria-pressed={m === k}
                    disabled={!canEdit || busy} onClick={() => pick(p, k)}>{label}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3 className="er-step-title">Safety limits</h3>
        <div className="esy-limits">
          <label className="esy-field"><span>Blast limit (% of listings one run may change)</span>
            <input className="input" inputMode="decimal" value={blast} disabled={!canEdit} onChange={(e) => setBlast(e.target.value)} /></label>
        </div>
        {canEdit && <button type="button" className="btn primary mt" disabled={busy || blast.trim() === '' || Number.isNaN(Number(blast))}
          onClick={() => quiet({ blastPct: Number(blast) })}>Save limits</button>}
      </div>

      <LogCard narrow={narrow} onSignOut={onSignOut} />

      {confirm?.kind === 'live' && (
        <FormModal danger title={`Turn ${confirm.part.label} live?`} submitLabel="Yes, go live"
          message={`${LIVE_EFFECT[confirm.part.key]} DPL also writes this while it is still on, so for now two systems write the same thing. Every write is logged. The kill switch stops it at once.`}
          onClose={() => setConfirm(null)}
          onSubmit={async () => { await save({ switches: { [confirm.part.key]: 'live' } }); setConfirm(null); }} />
      )}
      {confirm?.kind === 'killoff' && (
        <FormModal title="Turn the kill switch off?" submitLabel="Yes, allow writes again"
          message="Parts that are set to Live will start writing again straight away."
          onClose={() => setConfirm(null)}
          onSubmit={async () => { await save({ kill: false }); setConfirm(null); }} />
      )}
    </>
  );
}

function LogCard({ narrow, onSignOut }) {
  const [domain, setDomain] = useState('');
  const [mode, setMode] = useState('');
  const fetcher = useCallback((offset) => api.ebaySyncLog({ domain, mode, offset }), [domain, mode]);
  const list = usePaged(fetcher, [domain, mode], onSignOut);
  const short = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const cols = [
    { h: 'When', primary: true, cell: (r) => <b>{when(r.at)}</b> },
    { h: 'Part', cell: (r) => human(r.domain) },
    { h: 'What', cell: (r) => human(r.action) },
    { h: 'Mode', cell: (r) => (r.mode === 'shadow' ? 'Test' : human(r.mode)) },
    { h: 'SKU / item', cell: (r) => [r.sku, r.item_id].filter(Boolean).join(' · ') },
    { h: 'Before → after', cell: (r) => (r.before == null && r.after == null ? '' : <span className="esy-ba">{short(r.before)} → {short(r.after)}</span>) },
    { h: 'Result', cell: (r) => (r.ok === false ? <span className="error">Failed{r.error ? `: ${r.error}` : ''}</span> : <span className="ebl-ok">ok</span>) },
    { h: 'By', cell: (r) => r.by || '' },
  ];
  return (
    <div className="card">
      <h3 className="er-step-title">Log of every write</h3>
      <div className="esy-filters">
        <select className="input esy-select" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Filter log by part">
          <option value="">All parts</option>
          {PARTS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <select className="input esy-select" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Filter log by mode">
          <option value="">Test and Live</option><option value="shadow">Test only</option><option value="live">Live only</option>
        </select>
      </div>
      <Body st={list} empty="Nothing logged yet.">
        <DataList rows={list.rows} cols={cols} rowKey={(r) => r.id} narrow={narrow} label="Sync log" />
      </Body>
      <Pager p={list.pager} label="entries" />
    </div>
  );
}

// ---------- Page ----------
const TABS = [['overview', 'Overview'], ['products', 'Shopify Products'], ['listings', 'eBay Products'], ['inventory', 'Linked Inventory'], ['profiles', 'Profiles'], ['settings', 'Settings + Log']];

export function EbaySync({ user, onTab, onSignOut }) {
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  const canEdit = isAdmin || hasPriv(user, 'connect_integrations');
  const narrow = useNarrow();
  const [tab, setTabRaw] = useQueryParam('sync', 'overview');
  // The search box is per section: leaving a section drops its ?syncq so it can't filter the next one.
  const setTab = (k) => { if (k !== tab) writeParam('syncq', ''); setTabRaw(k); };
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try { setSt(await api.ebaySyncStatus()); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message || 'Could not load.'); }
  }, [onSignOut]);
  useEffect(() => { load(); }, [load]);
  useLive(LIVE_TABLES, load, { mount: false });

  async function run(pass, extra) {
    setBusy(pass); setNotice(''); setErr('');
    try { await api.ebaySyncRun(pass, extra); setNotice('Started. The result shows under Last runs.'); await load(); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message || 'That did not start.'); }
    finally { setBusy(''); }
  }
  const onChanged = (settings) => { if (settings) setSt((s) => ({ ...s, settings })); load(); };

  return (
    <div className="esy">
      {err && !st && <div className="error mt" role="alert">Could not load eBay Sync: {err} <button type="button" className="btn ghost sm" onClick={load}>Try again</button></div>}
      {err && st && <div className="error mt" role="alert">{err}</div>}
      {notice && <div className="notice mt">{notice}</div>}
      {st?.settings?.kill && <div className="error esy-killbanner" role="status">Kill switch is ON. Nothing is being written.</div>}

      <div className="esy-tabs seg" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`seg-btn${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {!st && !err && <p className="muted mt">Loading…</p>}
      {st && tab === 'overview' && <Overview st={st} canEdit={canEdit} onRun={run} busy={busy} />}
      {st && tab === 'products' && <ProductsTab st={st} canEdit={canEdit} narrow={narrow} onSignOut={onSignOut} />}
      {st && tab === 'listings' && <ListingsTab narrow={narrow} onSignOut={onSignOut} onTab={onTab} />}
      {st && tab === 'inventory' && <InventoryTab narrow={narrow} onSignOut={onSignOut} />}
      {st && tab === 'profiles' && <ProfilesTab canEdit={canEdit} onSignOut={onSignOut} />}
      {st && tab === 'settings' && <SettingsTab st={st} canEdit={canEdit} narrow={narrow} onChanged={onChanged} onSignOut={onSignOut} />}
    </div>
  );
}
