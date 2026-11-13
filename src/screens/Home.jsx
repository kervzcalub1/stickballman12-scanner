// Role-aware home screen: a find box, the floor's four daily jobs, what is waiting on
// somebody, then every tool grouped by job (HOME_SECTIONS), daily floor work first.
import React, { useState } from 'react';
import { TopBar } from '../components/common.jsx';
import { HomeToolCard, HomeDescToggle, HomeSectionTitle, useHomeDescriptions } from '../components/HomeTools.jsx';
import { NavIcon } from '../components/NavIcons.jsx';
import { usePendingCounts } from '../hooks.js';
import { InboundToday } from '../components/InboundToday.jsx';
import { isVinCode } from '../lib/codes.js';
import { roleLabel, HOME_SECTIONS, HOME_ATTENTION, HOME_QUICK, homeCardBadges, isAdminRole, hasAnyPriv, hasPriv } from '../lib/constants.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

export function Home({ user, onPick, onSignOut }) {
  const isAdmin = isAdminRole(user.role);
  const isSuper = user.role === 'superadmin';
  const counts = usePendingCounts();
  const [find, setFind] = useState('');
  const [describe, setDescribe] = useHomeDescriptions();
  // Buying Requests is a PRIVILEGE, so the card is drawn for whoever holds one rather
  // than for a role — a warehouse account with none never sees it, and a PH account with
  // one does. The server refuses independently either way.
  const canBuy = hasAnyPriv(user);
  // An admin-only section still shows a non-admin the cards whose PRIVILEGE they hold
  // (`privKey`: Check Access for "Manage user access", eBay + SHEIN for "Connect integrations").
  const sections = HOME_SECTIONS
    .map((s) => (s.cards.some((c) => c.priv) ? { ...s, cards: s.cards.filter((c) => !c.priv || canBuy) } : s))
    .map((s) => (s.adminOnly && !isAdmin ? { ...s, adminOnly: false, cards: s.cards.filter((c) => c.privKey && hasPriv(user, c.privKey)) } : s))
    .filter((s) => s.cards.length);
  const attention = counts
    ? HOME_ATTENTION.filter((a) => (counts[a.count] || 0) > 0 && (!a.priv || hasPriv(user, a.priv))
      && (!a.adminOnly || user.role === 'admin' || isSuper))
    : [];
  const now = attention.filter((a) => a.tier === 'now');
  const backlog = attention.filter((a) => a.tier !== 'now');

  // One box for "where is this shoe": a VIN opens that pair, anything else (SKU, UPC,
  // name, shelf code) is an Inventory search across everything. Inventory already does
  // exactly this with its own box; Home only hands the text over in the URL. No
  // autoFocus — on iOS a programmatic focus leaves the keyboard down and the box looks
  // broken, and a scanner gun on this page is the exception, not the rule.
  function submitFind(e) {
    e.preventDefault();
    const v = find.trim();
    if (!v) return;
    if (isVinCode(v) || /^s[a-z]*-?\d/i.test(v)) onPick('inventory', { vin: v });
    else onPick('inventory', { q: v });
  }

  return (
    <div className="app">
      <TopBar onSignOut={onSignOut} />
      <div className="home-head">
        <div className="home-greeting">Hi {user.name} <span className="role-badge">{roleLabel(user.role)}</span></div>
        <form className="home-find" onSubmit={submitFind} role="search">
          <span className="home-find-icon" aria-hidden="true"><NavIcon name="inventory" /></span>
          <input id="home-find" type="search" enterKeyHint="search" autoComplete="off"
            aria-label="Find a shoe by VIN, SKU, UPC, name or shelf"
            placeholder="VIN, SKU, UPC, name or shelf"
            value={find} onChange={(e) => setFind(e.target.value)} />
          <button type="submit" className="btn primary sm" disabled={!find.trim()}>Find</button>
        </form>
        <nav className="home-quick" aria-label="Daily jobs">
          {HOME_QUICK.map((q) => (
            <button type="button" key={q.key} className="home-quick-btn" onClick={() => onPick(q.key)}>
              <span className="home-quick-icon"><NavIcon name={q.key} /></span>
              {q.label}
            </button>
          ))}
        </nav>
      </div>
      {/* Above the chores, because it is the thing that decides what the morning looks
          like. It renders nothing at all when there is no inbound stock, so a quiet
          week does not leave a permanent empty card people learn to skip past. */}
      <InboundToday onOpen={() => onPick('expected')} />
      {attention.length > 0 && (
        <section className="home-section" data-accent="attention">
          <h2 className="home-section-title">Needs attention</h2>
          {now.length > 0 && (
            <div className="home-grid home-attn-grid">
              {now.map((a) => (
                <button className="home-card home-attention" key={a.id || a.key} onClick={() => onPick(a.key, a.query)}>
                  <span className="home-attention-top">
                    <span className="home-card-icon"><NavIcon name={a.key} /></span>
                    <span className="home-attention-count">{fmt(counts[a.count])}</span>
                  </span>
                  <span className="home-card-title">{a.label}</span>
                </button>
              ))}
            </div>
          )}
          {backlog.length > 0 && (
            <div className="home-backlog">
              <span className="home-backlog-label">Backlog</span>
              {backlog.map((a) => (
                <button className="home-attention home-backlog-item" key={a.id || a.key} onClick={() => onPick(a.key, a.query)}>
                  <span className="home-backlog-icon"><NavIcon name={a.key} /></span>
                  <span className="home-attention-count">{fmt(counts[a.count])}</span>
                  <span className="home-backlog-name">{a.label}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      {/* A section of three cards or fewer takes half the width on a wide screen, so two
          short ones (Boxes + Sell & Ship, Marketplaces + Administration) share a row
          instead of each leaving an empty half behind it. DOM order is kept — no dense
          packing — so the daily work still reads top to bottom. */}
      <div className={`home-sections home-compact${describe ? ' home-describe' : ''}`}>
      {sections.filter((s) => (!s.adminOnly || isAdmin) && (!s.superOnly || isSuper)).map((section, i) => (
        <section className={section.cards.length <= 3 ? 'home-section half' : 'home-section'} key={section.title} data-accent={section.accent}>
          <HomeSectionTitle title={section.title}>
            {i === 0 && <HomeDescToggle on={describe} onChange={setDescribe} />}
          </HomeSectionTitle>
          <div className="home-grid home-tools">
            {section.cards.map((c) => (
              <HomeToolCard key={c.key} icon={c.key} title={c.title}
                sub={c.key === 'report' && !isAdmin ? `${c.sub} (view-only)` : c.sub}
                badges={homeCardBadges(c.key, counts)} onClick={() => onPick(c.key)} />
            ))}
          </div>
        </section>
      ))}
      </div>
    </div>
  );
}
