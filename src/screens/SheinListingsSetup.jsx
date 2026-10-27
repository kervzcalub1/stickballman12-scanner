// SHEIN Listings → Setup tab (`?tab=setup`): what publishing brand-new products needs from a person ONCE,
// for every product of a kind (docs/context/shein-listings.md → "Phase 4"): what SHEIN says about new
// listings (store gates, quota), the D6 box sizes (UNCONFIRMED placeholders block every publish), the
// category per Shopify product type + size group, the SHEIN brand per Shopify vendor, and the SHEIN
// details (attribute defaults) per SHEIN product type. All DB only; re-reading SHEIN is a read
// (admin / Connect integrations). `?pt=` = the product type open in the details editor.
// Phase 5: the Go-live checklist and the 4seller cut-over card sit on top (src/components/SheinCutover.jsx).
import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { SIZE_GROUPS } from '../lib/sheinPublish.js';
import { fmt, when, NEEDS_PRIV } from '../components/SheinListingsBits.jsx';
import { CategoryPicker, BrandPicker, AttrEditor, BoxDefaults, gateProblems, GROUP_LABEL, SELLER_CENTER } from '../components/SheinPublishBits.jsx';
import { GoLiveCard, CutoverCard } from '../components/SheinCutover.jsx';

function Gates({ gates, readAt, canWrite, reload, onSignOut }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const g = gates || {};
  const probs = gateProblems(gates);
  const yes = (v) => (v === true ? <span className="ebo-chip ok">Yes</span> : v === false ? <span className="ebo-chip bad">No</span> : <span className="ebo-chip">Not read yet</span>);
  async function refresh() {
    setBusy(true); setErr('');
    try { await api.sheinListingMeta({ gates: 1, refresh: 1 }); await reload(); } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="card" data-setup="gates">
      <h3 className="er-step-title">SHEIN and new products</h3>
      <p className="muted sm">Checked again right before every publish. Each published product uses 1 of the store’s monthly publish quota; deleting it later doesn’t give it back.</p>
      <dl className="shl-facts">
        <dt>SHEIN takes new listings</dt><dd>{yes(g.perm ? g.perm.canPublishProduct === true : null)}{g.perm?.reason ? <span className="shl-shein-said">SHEIN said: “{g.perm.reason}”</span> : null}</dd>
        <dt>Publish quota this month</dt><dd>{!g.quota ? <span className="ebo-chip">Not read yet</span> : g.quota.isControlled ? <><b>{fmt(g.quota.availableQuota)}</b> left{g.quota.totalQuota != null ? ` of ${fmt(g.quota.totalQuota)}` : ''}</> : 'Not limited'}</dd>
        <dt>Shelf limit</dt><dd>{!g.shelf ? <span className="ebo-chip">Not read yet</span> : g.shelf.need ? <><b>{fmt(g.shelf.remain_count)}</b> left</> : 'Not limited'}</dd>
      </dl>
      {probs.length > 0 && <p className="notice sm mt">{probs.map((p) => <span key={p.key} className="shl-block">{p.text}</span>)}Dry runs still work. Sort it out in <a className="ebl-link" href={SELLER_CENTER} target="_blank" rel="noreferrer">Seller Center ↗</a>.</p>}
      <div className="er-actions">
        <span className="muted xs shl-grow">{readAt ? `As read ${when(readAt)} — every publish dry run reads it again (1 h cache).` : 'Not read yet — the first publish dry run reads it.'}</span>
        <button type="button" className="btn ghost sm" disabled={!canWrite || busy} title={canWrite ? 'Reads only — nothing on SHEIN changes' : NEEDS_PRIV} onClick={refresh}>{busy ? 'Asking SHEIN…' : 'Ask SHEIN again (read-only)'}</button>
      </div>
      {err && <p className="error sm">{err}</p>}
    </div>
  );
}

function Categories({ canWrite, onSignOut }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null);   // { productType, sizeGroup, current }
  const [msg, setMsg] = useState('');
  async function load() { try { setD(await api.sheinPublishMaps('category')); setErr(''); } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); } }
  useLive(['shein_category_map', 'shein_listing_products'], load);
  const maps = d?.maps || [];
  const types = useMemo(() => {
    const t = new Map((d?.usage || []).map((u) => [u.productType, u.products]));
    for (const m of maps) if (!t.has(m.shopify_product_type)) t.set(m.shopify_product_type, 0);
    return [...t.entries()].map(([productType, products]) => ({ productType, products }));
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  async function clear(m) {
    if (!window.confirm(`Clear the SHEIN category for “${m.shopify_product_type}” · ${GROUP_LABEL[m.size_group]}? Those products go back to “No SHEIN category picked”. Nothing on SHEIN changes.`)) return;
    try { await api.sheinPublishMapSave('category', { action: 'clear', productType: m.shopify_product_type, sizeGroup: m.size_group }); setMsg('Cleared.'); await load(); } catch (e) { setErr(e.message); }
  }
  return (
    <div className="card" data-setup="categories">
      <h3 className="er-step-title">Categories</h3>
      <p className="muted sm">SHEIN files every product in one last-level category. Pick it once per Shopify product type and size group — every product of that kind uses it. From a product’s Details, SHEIN also suggests one from the photo.</p>
      {err && <p className="error sm">{err}</p>}
      {msg && <p className="ebl-ok sm">{msg}</p>}
      {!d && !err && <div className="shl-skel shl-skel-row" />}
      {d && <p className="muted xs">{d.leaves ? `${fmt(d.leaves.length)} SHEIN categories read.` : 'SHEIN’s category list hasn’t been read yet — an admin reads it from the picker, or a publish dry run does.'}</p>}
      {d && !types.length && <div className="empty-state">Every Shopify shoe is on SHEIN — no new product needs a category.</div>}
      {types.map((t) => {
        const rows = maps.filter((m) => m.shopify_product_type === t.productType);
        return (
          <div key={t.productType || '(none)'} className="shl-sz-group" data-type={t.productType}>
            <h4 className="shl-h4">Shopify type “{t.productType || '(none)'}” <span className="muted xs">{fmt(t.products)} product{t.products === 1 ? '' : 's'} not on SHEIN</span></h4>
            <table className="shl-rtable">
              <thead><tr><th>Size group</th><th>SHEIN category</th><th>Set by</th><th /></tr></thead>
              <tbody>
                {SIZE_GROUPS.map((g) => {
                  const m = rows.find((r) => r.size_group === g);
                  const isEdit = edit && edit.productType === t.productType && edit.sizeGroup === g;
                  return (
                    <React.Fragment key={g}>
                      <tr data-group={g}>
                        <td data-label="Size group"><b>{GROUP_LABEL[g]}</b></td>
                        <td data-label="SHEIN category">{m ? <>{m.category_path || m.category_id} <span className="muted xs">#{m.category_id}</span></> : <span className="muted">none yet</span>}</td>
                        <td data-label="Set by" className="xs">{m ? `${m.set_by || '—'} ${when(m.set_at)}` : '—'}</td>
                        <td data-label="" className="shl-rt-act">
                          <button type="button" className={`btn xs ${m ? 'ghost' : 'shl-fix'}`} onClick={() => setEdit(isEdit ? null : { productType: t.productType, sizeGroup: g, current: m?.category_id || null })}>{isEdit ? 'Close' : m ? 'Change' : 'Choose category'}</button>
                          {m && <button type="button" className="btn xs ghost" onClick={() => clear(m)}>Clear</button>}
                        </td>
                      </tr>
                      {isEdit && <tr className="shl-rt-panel"><td colSpan={4}><CategoryPicker productType={t.productType} sizeGroup={g} current={edit.current} canWrite={canWrite} onSignOut={onSignOut}
                        onCancel={() => setEdit(null)} onSaved={async (mm) => { setEdit(null); setMsg(`Saved: “${t.productType}” · ${GROUP_LABEL[g]} → ${mm?.category_path || mm?.category_id}.`); await load(); }} /></td></tr>}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function Brands({ canWrite, onSignOut }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState('');
  const [msg, setMsg] = useState('');
  async function load() { try { setD(await api.sheinPublishMaps('brand')); setErr(''); } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); } }
  useLive(['shein_brand_map'], load);
  const vendors = d?.vendors || [];
  return (
    <div className="card" data-setup="brands">
      <h3 className="er-step-title">Brands</h3>
      <p className="muted sm">Shopify vendor → the SHEIN brand it goes up as. Only brands SHEIN lists as authorised for our store can be used (listing an unauthorised Nike / Jordan can get products rejected); a new one is applied for in <a className="ebl-link" href={SELLER_CENTER} target="_blank" rel="noreferrer">Seller Center ↗</a>.</p>
      {err && <p className="error sm">{err}</p>}
      {msg && <p className="ebl-ok sm">{msg}</p>}
      {!d && !err && <div className="shl-skel shl-skel-row" />}
      {d && !vendors.length && <div className="empty-state">No vendor has a product that isn’t on SHEIN.</div>}
      {vendors.length > 0 && (
        <table className="shl-rtable">
          <thead><tr><th>Shopify vendor</th><th className="num">Not on SHEIN</th><th>SHEIN brand</th><th /></tr></thead>
          <tbody>
            {vendors.map((v) => {
              const m = (d.maps || []).find((x) => x.vendor === v.vendor);
              return (
                <React.Fragment key={v.vendor}>
                  <tr data-vendor={v.vendor}>
                    <td data-label="Vendor"><b>{v.vendor}</b></td>
                    <td data-label="Not on SHEIN" className="num">{fmt(v.products)}</td>
                    <td data-label="SHEIN brand">{m?.no_brand ? <span className="muted">no brand (generic)</span> : m ? <>{m.brand_name || m.brand_code} <span className="muted xs">{m.brand_code}</span></> : <span className="shl-was">not mapped — blocks publishing</span>}</td>
                    <td data-label="" className="shl-rt-act"><button type="button" className={`btn xs ${m ? 'ghost' : 'shl-fix'}`} onClick={() => setEdit(edit === v.vendor ? '' : v.vendor)}>{edit === v.vendor ? 'Close' : m ? 'Change' : 'Map to a SHEIN brand'}</button></td>
                  </tr>
                  {edit === v.vendor && <tr className="shl-rt-panel"><td colSpan={4}><BrandPicker vendor={v.vendor} canWrite={canWrite} onSignOut={onSignOut} onCancel={() => setEdit('')}
                    onSaved={async (mm) => { setEdit(''); setMsg(mm ? `Saved: ${v.vendor} → ${mm.brand_name || mm.brand_code}.` : `Cleared ${v.vendor}.`); await load(); }} /></td></tr>}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Details({ pt, setPt, canWrite, onSignOut }) {
  const [d, setD] = useState(null);
  async function load() { try { setD(await api.sheinPublishMaps('category')); } catch (e) { if (e.unauthorized) onSignOut(); } }
  useLive(['shein_category_map'], load);
  // the SHEIN product types our category maps use (a type can sit under more than one category)
  const types = useMemo(() => {
    const m = new Map();
    for (const x of d?.maps || []) if (!m.has(String(x.product_type_id))) m.set(String(x.product_type_id), { productTypeId: Number(x.product_type_id), categoryId: Number(x.category_id), path: x.category_path || `#${x.category_id}` });
    return [...m.values()];
  }, [d]);
  const cur = types.find((t) => String(t.productTypeId) === String(pt)) || types[0] || null;
  return (
    <div className="card" data-setup="details">
      <h3 className="er-step-title">SHEIN details per product type</h3>
      <p className="muted sm">SHEIN asks for details Shopify doesn’t have (upper material, closure, …). A person sets them once per SHEIN product type; never guessed. Copy them from one of our approved SHEIN products of the same type to save typing — you check them before they’re saved.</p>
      {!d && <div className="shl-skel shl-skel-row" />}
      {d && !types.length && <div className="empty-state">Choose a category first (above) — the details SHEIN asks for depend on it.</div>}
      {types.length > 0 && (
        <>
          <select className="input shl-select" value={cur ? String(cur.productTypeId) : ''} onChange={(e) => setPt(e.target.value)} aria-label="SHEIN product type">
            {types.map((t) => <option key={t.productTypeId} value={t.productTypeId}>{t.path} (type {t.productTypeId})</option>)}
          </select>
          {cur && <AttrEditor key={cur.productTypeId} productTypeId={cur.productTypeId} categoryId={cur.categoryId} canWrite={canWrite} onSignOut={onSignOut} />}
        </>
      )}
    </div>
  );
}

export function SheinListingsSetup({ canWrite, gates, cut, onSignOut, onOpenProduct, onOpenJob }) {
  const [pt, setPt] = useQueryParam('pt', '');
  return (
    <div className="shl-setup">
      {cut && <GoLiveCard cut={cut} canWrite={canWrite} />}
      {cut && <CutoverCard cut={cut} canWrite={canWrite} onOpenProduct={onOpenProduct} onOpenJob={onOpenJob} />}
      <div className="card shl-setup-lede">
        <h3 className="er-step-title">Publishing setup</h3>
        <p className="muted sm">What SHEIN needs before a Shopify shoe that isn’t on SHEIN can be published — set once, used by every product of that kind. Saving here changes <b>our records only</b>; nothing goes to SHEIN until a publish dry run is checked and confirmed. Each product’s Details shows exactly which of these it is still missing.</p>
      </div>
      <Gates gates={gates.gates} readAt={gates.readAt} canWrite={canWrite} reload={gates.reload} onSignOut={onSignOut} />
      <div className="card" data-setup="box">
        <h3 className="er-step-title">Box size and weight</h3>
        <p className="muted sm">SHEIN needs every size’s box: length × width × height (cm) and weight (g). One default per size group.</p>
        <BoxDefaults canWrite={canWrite} onSignOut={onSignOut} />
      </div>
      <Categories canWrite={canWrite} onSignOut={onSignOut} />
      <Brands canWrite={canWrite} onSignOut={onSignOut} />
      <Details pt={pt} setPt={setPt} canWrite={canWrite} onSignOut={onSignOut} />
    </div>
  );
}

export default SheinListingsSetup;
