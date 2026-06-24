// Role-aware home screen: grouped cards with pending-work badges.
import React from 'react';
import { TopBar, CardBadges } from '../components/common.jsx';
import { usePendingCounts } from '../hooks.js';
import { roleLabel, HOME_SECTIONS, homeCardBadges } from '../lib/constants.js';

export function Home({ user, onPick, onSignOut }) {
  const isAdmin = user.role === 'admin';
  const counts = usePendingCounts();
  return (
    <div className="app">
      <TopBar onSignOut={onSignOut} />
      <div className="home-greeting">Hi {user.name} <span className="role-badge">{roleLabel(user.role)}</span></div>
      {HOME_SECTIONS.filter((s) => !s.adminOnly || isAdmin).map((section) => (
        <section className="home-section" key={section.title}>
          <h2 className="home-section-title">{section.title}</h2>
          <div className="home-grid">
            {section.cards.map((c) => (
              <button className="home-card" key={c.key} onClick={() => onPick(c.key)}>
                <span className="home-card-icon">{c.icon}</span>
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
