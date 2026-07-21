// Role-aware home screen: grouped cards with pending-work badges.
import React from 'react';
import { TopBar, CardBadges } from '../components/common.jsx';
import { NavIcon } from '../components/NavIcons.jsx';
import { usePendingCounts } from '../hooks.js';
import { roleLabel, HOME_SECTIONS, HOME_ATTENTION, homeCardBadges, isAdminRole } from '../lib/constants.js';

export function Home({ user, onPick, onSignOut }) {
  const isAdmin = isAdminRole(user.role);
  const isSuper = user.role === 'superadmin';
  const counts = usePendingCounts();
  const attention = counts ? HOME_ATTENTION.filter((a) => (counts[a.count] || 0) > 0) : [];
  return (
    <div className="app">
      <TopBar onSignOut={onSignOut} />
      <div className="home-greeting">Hi {user.name} <span className="role-badge">{roleLabel(user.role)}</span></div>
      {attention.length > 0 && (
        <section className="home-section" data-accent="attention">
          <h2 className="home-section-title">Needs attention</h2>
          <div className="home-grid">
            {attention.map((a) => (
              <button className="home-card home-attention" key={a.key} onClick={() => onPick(a.key)}>
                <span className="home-attention-top">
                  <span className="home-card-icon"><NavIcon name={a.key} /></span>
                  <span className="home-attention-count">{counts[a.count]}</span>
                </span>
                <span className="home-card-title">{a.label}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {HOME_SECTIONS.filter((s) => (!s.adminOnly || isAdmin) && (!s.superOnly || isSuper)).map((section) => (
        <section className="home-section" key={section.title} data-accent={section.accent}>
          <h2 className="home-section-title">{section.title}</h2>
          <div className="home-grid">
            {section.cards.map((c) => (
              <button className="home-card" key={c.key} onClick={() => onPick(c.key)}>
                <span className="home-card-icon"><NavIcon name={c.key} /></span>
                <span className="home-card-title">{c.title}</span>
                <span className="home-card-sub">{c.key === 'report' && !isAdmin ? `${c.sub} (view-only)` : c.sub}</span>
                <CardBadges badges={homeCardBadges(c.key, counts)} />
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
