// SHEIN → Today: what needs attention, one short list with a button to each, and one line saying whether
// the automatic sync is healthy. Reads only what the two existing endpoints already return
// (api/shein/listings, api/shein/live); it adds no new data. A read that fails says so, and never shows
// a 0 that could be taken for "nothing to do".
import React, { useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { useSheinNav } from '../components/SheinNav.jsx';
import { fmt, when, TONE } from '../components/SheinListingsBits.jsx';
import { TERMS, plain } from '../lib/sheinWords.js';

// One line of the list: the count, what it is, what's behind it, and the button.
function Row({ tone, n, what, why, button, onGo, state }) {
  return (
    <div className={`shein-today-row e-${tone}`} data-today={state}>
      <b className="shein-today-n">{n}</b>
      <span className="shein-today-text"><span>{what}</span>{why && <span className="muted xs">{why}</span>}</span>
      {onGo && <button type="button" className="btn sm" onClick={onGo}>{button}</button>}
    </div>
  );
}
const CantRead = ({ what, why, onRetry, state }) => (
  <div className="shein-today-row e-warn" data-today={state} data-unread="">
    <b className="shein-today-n">?</b>
    <span className="shein-today-text"><span>{what}: {TERMS.cantRead.toLowerCase()}</span>{why && <span className="muted xs">{plain(why)}</span>}</span>
    <button type="button" className="btn ghost sm" onClick={onRetry}>Try again</button>
  </div>
);

function healthLine(live) {
  const sync = live.sync || {};
  const failing = Number(live.unitCounts?.failing || 0);
  if (!live.connected) return ['bad', 'SHEIN isn’t connected, so nothing is syncing.'];
  if (sync.orders !== 'on') return ['bad', 'Automatic sync is off: a SHEIN sale is not taken off Shopify, so another store can sell the same pair.'];
  if (!live.worker) return ['warn', 'This server doesn’t run the automatic sync (only the live server does).'];
  if (failing > 0) return ['bad', `Automatic sync is on, but ${fmt(failing)} SHEIN sale${failing === 1 ? ' hasn’t' : 's haven’t'} reached Shopify.`];
  return ['ok', `Automatic sync is working.${sync.polledAt ? ` Last checked ${when(sync.polledAt)}.` : ''}`];
}

export function SheinToday({ onSignOut }) {
  const go = useSheinNav();
  const [list, setList] = useState(null);
  const [listErr, setListErr] = useState('');
  const [live, setLive] = useState(null);
  const [liveErr, setLiveErr] = useState('');
  async function loadList() {
    try { setList(await api.sheinListings({ page: 1, pageSize: 1 })); setListErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setListErr(e.message || 'No answer'); }
  }
  async function loadLive() {
    try { setLive(await api.sheinLive()); setLiveErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setLiveErr(e.message || 'No answer'); }
  }
  useLive(['shein_listing_products', 'shein_listing_variants', 'shein_listing_jobs'], loadList);
  useLive(['shein_live_runs', 'shein_order_units', 'app_settings'], loadLive);

  // A failed refresh must not leave old numbers looking current.
  const s = listErr ? null : list?.summary;
  const l = liveErr ? null : live;
  const by = s?.byStatus || {};
  const count = (k, f) => Number(by[k]?.[f] || 0);
  const neverRead = !!s && !s.lastSnapshot && s.all === 0;
  const stops = (s?.topBlockers || []).slice(0, 3);
  const failing = Number(l?.unitCounts?.failing || 0);
  const health = l ? healthLine(l) : null;
  const loading = (!list && !listErr) || (!live && !liveErr);
  const open = (status) => go('listings', { status, tab: '', p: '', q: '', blocker: '', brand: '', shop: '' });
  const nothing = s && l && !neverRead && !failing && !count('not_on_shein', 'sizes') && !count('blocked', 'products') && !count('out_of_date', 'sizes') && !count('error', 'products');

  return (
    <div className="card shein-today">
      {health
        ? <p className={`shein-today-health ${health[0]}`} data-health={health[0]} role="status">{health[1]}</p>
        : liveErr ? <p className="shein-today-health warn" data-health="unread" role="status">Automatic sync: {TERMS.cantRead.toLowerCase()}.</p>
          : <div className="shl-skel shl-skel-line" aria-label="Loading" />}

      {loading && !s && !l && [0, 1, 2].map((i) => <div key={i} className="shl-skel shl-skel-row" />)}
      {nothing && <p className="muted sm shein-today-clear" data-today="clear">Nothing needs you right now.</p>}

      {/* The one that costs money while it waits goes first. */}
      {l && failing > 0 && (
        <Row tone="bad" n={fmt(failing)} what={`SHEIN sale${failing === 1 ? '' : 's'} not taken off Shopify`} why="Another store can sell these pairs until this is fixed." state="failing" button="Fix now" onGo={() => go('live')} />
      )}

      {neverRead && (
        <Row tone="muted" n="–" what="SHEIN hasn’t been read yet" why="The list fills in after the first refresh." state="never" button="Go to Shoes on SHEIN" onGo={() => go('listings')} />
      )}
      {s && !neverRead && count('not_on_shein', 'sizes') > 0 && (
        <Row tone={TONE.not_on_shein} n={fmt(count('not_on_shein', 'sizes'))} what="Sizes not on SHEIN yet" why="In stock on Shopify and ready to list." state="not_on_shein" button="See them" onGo={() => open('not_on_shein')} />
      )}
      {s && !neverRead && count('blocked', 'products') > 0 && (
        <Row tone={TONE.blocked} n={fmt(count('blocked', 'products'))} what={`Shoe${count('blocked', 'products') === 1 ? '' : 's'} blocked`}
          why={stops.length ? stops.map((b) => `${b.title.replace(/\.$/, '')} (${fmt(b.products)})`).join(' · ') : null} state="blocked" button="See why" onGo={() => open('blocked')} />
      )}
      {s && !neverRead && count('out_of_date', 'sizes') > 0 && (
        <Row tone={TONE.out_of_date} n={fmt(count('out_of_date', 'sizes'))} what="Wrong sizes, SKUs or prices to fix" why="On SHEIN, but different from Shopify." state="out_of_date" button="Fix them" onGo={() => open('out_of_date')} />
      )}
      {s && !neverRead && count('error', 'products') > 0 && (
        <Row tone={TONE.error} n={fmt(count('error', 'products'))} what={`Shoe${count('error', 'products') === 1 ? '' : 's'} SHEIN refused`} why="SHEIN’s reason is on each one." state="error" button="See why" onGo={() => open('error')} />
      )}
      {listErr && <CantRead what="Shoes on SHEIN" why={listErr} onRetry={loadList} state="list" />}

      {liveErr && <CantRead what="SHEIN sales reaching Shopify" why={liveErr} onRetry={loadLive} state="live" />}
    </div>
  );
}
