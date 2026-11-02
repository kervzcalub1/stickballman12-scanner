// /no-box — two jobs for pairs that came without a box, picked from two cards
// (docs/context/no-box.md, Brent 2026-11-03):
//   /no-box/box-swap          pairs set aside at inbound until their box is ready; the VIN
//                             sticker goes on at the swap (BoxSwap.jsx)
//   /no-box/print-box-labels  the No Box queue: bought without a box — box labels, box
//                             found, use a box from stock (NoBoxReport.jsx)
// The sub-page is the second path segment, so a refresh or a link lands on the same job.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, CardBadges } from '../components/common.jsx';
import { NavIcon } from '../components/NavIcons.jsx';
import { useLive } from '../hooks.js';
import { NoBoxReport } from './NoBoxReport.jsx';
import { BoxSwap } from './BoxSwap.jsx';

const SUBS = ['box-swap', 'print-box-labels'];
const subFromPath = () => {
  const seg = String(window.location.pathname || '').replace(/^\/+|\/+$/g, '').split('/')[1] || '';
  return SUBS.includes(seg) ? seg : '';
};

export function NoBoxHub({ user, onHome, onSignOut }) {
  const [sub, setSub] = useState(subFromPath);
  const [counts, setCounts] = useState(null);
  useEffect(() => {
    const onPop = () => setSub(subFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const open = (s) => {
    const path = s ? `/no-box/${s}` : '/no-box';
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setSub(s);
  };
  async function loadCounts() {
    try { const { counts: c } = await api.pendingCounts(); setCounts(c || null); }
    catch (e) { if (e.unauthorized) onSignOut(); }
  }
  useEffect(() => { if (!sub) loadCounts(); }, [sub]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['items'], loadCounts, { mount: false, paused: !!sub });

  if (sub === 'box-swap') return <BoxSwap user={user} onBack={() => open('')} onSignOut={onSignOut} />;
  if (sub === 'print-box-labels') return <NoBoxReport user={user} onHome={() => open('')} onSignOut={onSignOut} />;

  const n = (k) => (counts && Number(counts[k]) > 0 ? Number(counts[k]) : 0);
  const cards = [
    { key: 'box-swap', icon: 'box-labels', title: 'Box swap',
      sub: 'Pairs set aside at inbound until their box is ready — scan the shoe, then the VIN sticker going on it',
      count: n('box_swap'), label: 'Waiting' },
    { key: 'print-box-labels', icon: 'nobox', title: 'Print box labels',
      sub: 'Bought without a box — print a box label (UPC, SKU, size), mark a box found, or use a box from stock',
      count: n('no_box'), label: 'No box' },
  ];
  return (
    <div className="app">
      <TopBar title="No Box" onHome={onHome} onSignOut={onSignOut} />
      <div className="home-grid home-tools">
        {cards.map((c) => (
          <button type="button" className="home-card" key={c.key} onClick={() => open(c.key)}>
            <span className="home-card-icon"><NavIcon name={c.icon} /></span>
            <span className="home-card-text">
              <span className="home-card-title">{c.title}</span>
              <span className="home-card-sub">{c.sub}</span>
              <CardBadges badges={[[c.label, c.count]]} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
