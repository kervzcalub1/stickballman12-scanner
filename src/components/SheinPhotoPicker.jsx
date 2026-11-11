// SHEIN Listings → "Choose photos" (2026-11-11): the photos a publish would send to SHEIN, in order,
// each with Leave out / Put back. SHEIN rejects photos with text, a logo or a store name on them
// ("The image contains watermark information") and promises like fast delivery ("false service
// promises") — the PH-branded cover is the usual one. Saved per product (`publish_choices photoSkip`,
// our records only); the next preview / publish never sends a left-out photo. Reads GET ?photos=
// (Shopify live + the PH edited photos for the style), never SHEIN.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { RemoteThumb, ImageZoomModal } from './common.jsx';
import { fmt } from './SheinListingsBits.jsx';
import { plain } from '../lib/sheinWords.js';

export function SheinPhotoPicker({ productId, onSaved, onSignOut, lede = null }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [zoom, setZoom] = useState(-1);
  async function load() {
    try { setD(await api.sheinListingPhotos(productId)); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut?.(); else setErr(plain(e.message)); }
  }
  useEffect(() => { setD(null); load(); }, [productId]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <p className="error xs" role="alert">{err} <button type="button" className="btn ghost xs" onClick={load}>Try again</button></p>;
  if (!d) return <div className="shl-skel shl-skel-row" />;

  const list = d.source === 'ph_edited' ? d.ph : d.shopify;
  const skip = [...list.filter((x) => x.skipped).map((x) => x.key), ...(d.source === 'ph_edited' ? d.shopify : d.ph).filter((x) => x.skipped).map((x) => x.key), ...(d.stale || []).map((x) => x.key)];
  const kept = list.filter((x) => !x.skipped).length;
  async function save(next, say) {
    setBusy(true); setMsg('');
    try {
      await api.sheinListingAction({ action: 'publish_choices', productId, photoSkip: [...new Set(next)] });
      await load(); setMsg(say); onSaved?.(say);
    } catch (e) { if (e.unauthorized) onSignOut?.(); else setMsg(`Not saved: ${plain(e.message)}`); }
    setBusy(false);
  }
  const toggle = (x, i) => (x.skipped
    ? save(skip.filter((k) => k !== x.key), `Photo ${i + 1} put back.`)
    : save([...skip, x.key], `Photo ${i + 1} left out — SHEIN won’t get it.`));

  return (
    <div className="shl-photos" data-photos-picker="">
      {lede}
      <p className="xs">
        <b>{fmt(Math.min(kept, d.max))}</b> of {fmt(list.length)} photo{list.length === 1 ? '' : 's'} go to SHEIN, from {d.source === 'ph_edited' ? <>the PH edited photos for <b>{d.style}</b></> : 'Shopify'}{kept > d.max ? ` (the first ${d.max})` : ''}.
        {' '}Photo 1 is the main photo.
      </p>
      <p className="muted xs">SHEIN rejects photos with text, a logo or the store name on them (“watermark”) and promises like fast delivery or a warranty. Leave those out — Shopify is not changed.</p>
      {!list.length && <p className="notice xs">No photos found {d.source === 'ph_edited' ? 'for this style' : 'on Shopify'}.</p>}
      <div className="shl-photo-grid">
        {list.map((x, i) => (
          <div key={x.key} className={`shl-photo${x.skipped ? ' off' : ''}`} data-photo={i + 1} data-skipped={x.skipped ? 'yes' : 'no'}>
            <button type="button" className="shl-photo-img" onClick={() => setZoom(i)} aria-label={`Look at photo ${i + 1}`}>
              <RemoteThumb src={x.url} className="ebl-thumb shl-photo-thumb" alt={`Photo ${i + 1}`} />
            </button>
            <span className="xs">{i + 1}{i === 0 ? ' · main' : ''}{x.angle ? ` · ${x.angle}` : ''}{x.skipped ? <b className="shl-bad-text"> · left out</b> : ''}</span>
            <button type="button" className={`btn xs ${x.skipped ? 'ghost' : 'shl-fix'}`} disabled={busy} onClick={() => toggle(x, i)}>{x.skipped ? 'Put back' : 'Leave out'}</button>
          </div>
        ))}
      </div>
      {kept < 2 && list.length > 0 && <p className="shl-bad-text xs" role="status">Only {fmt(kept)} photo{kept === 1 ? '' : 's'} left — SHEIN usually needs at least 2.{d.source === 'shopify' && d.ph.length ? ' Try the PH edited photos, or put one back.' : d.source === 'ph_edited' ? ' Untick “Use PH edited photos” to use Shopify’s instead, or put one back.' : ' Add clean photos on Shopify, or put one back.'}</p>}
      {(d.stale || []).length > 0 && (
        <p className="muted xs">{fmt(d.stale.length)} left-out photo{d.stale.length === 1 ? ' is' : 's are'} no longer on {d.stale.every((x) => x.shopify) ? 'Shopify' : 'the list'}.{' '}
          <button type="button" className="shl-linkbtn" disabled={busy} onClick={() => save(skip.filter((k) => !d.stale.some((s) => s.key === k)), 'Forgot the photos that are gone.')}>Forget {d.stale.length === 1 ? 'it' : 'them'}</button></p>
      )}
      {msg && <p className="ebl-ok xs" role="status">{msg}</p>}
      {zoom >= 0 && list[zoom] && (
        <ImageZoomModal url={list[zoom].url} label={`Photo ${zoom + 1}${list[zoom].skipped ? ' (left out)' : ''}`} onClose={() => setZoom(-1)}
          onPrev={zoom > 0 ? () => setZoom(zoom - 1) : null} onNext={zoom < list.length - 1 ? () => setZoom(zoom + 1) : null} />
      )}
    </div>
  );
}
