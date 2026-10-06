// "Get updates on Telegram — Connect": the 🔔 panel's connect step, put where a person
// can't miss it (docs/context/alerts.md). Shown on a supplier's Buying Requests list:
// a buyer in a store is the one who most needs "your cards are released" on their phone,
// and the bell in the top bar is easy to never notice.
//
// Same flow as AlertsPanel's Connect (one-use deep link, /start filled in); the bot writes
// the link to `users`, the live stream says so, and the banner goes away by itself. Hidden
// when connected, when Telegram isn't configured, for a shared login, and — per device —
// after "Not now". A connection Telegram later refused ("broken") brings it back as Reconnect.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { Icon } from './NavIcons.jsx';

const DISMISS_KEY = 'tg-connect-banner-dismissed';
const readDismissed = () => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } };

export function TelegramConnectBanner({ what = 'updates' }) {
  const [state, setState] = useState(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setState(await api.myAlerts()); } catch { /* the banner is optional — say nothing */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  useLive(['users'], load, { mount: false });
  // Coming back from the Telegram app — re-read straight away.
  useEffect(() => {
    const onBack = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onBack);
    return () => document.removeEventListener('visibilitychange', onBack);
  }, [load]);

  const tg = state?.telegram;
  const broken = !!tg?.broken;
  if (!state || state.account !== 'own' || !state.configured) return null;
  if (tg?.connected && !broken) return null;
  if (dismissed && !broken) return null;

  async function connect() {
    setError(''); setBusy(true);
    // Opened inside the tap — iOS blocks a window opened after an await (AlertsPanel).
    const win = window.open('', '_blank');
    try {
      const { url } = await api.telegramConnectLink();
      if (win && !win.closed) win.location.href = url; else window.location.href = url;
      setWaiting(true);
    } catch (e) {
      if (win && !win.closed) win.close();
      setError(e.message);
    } finally { setBusy(false); }
  }
  function notNow() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode: hides until reload */ }
    setDismissed(true);
  }

  return (
    <div className={`tg-banner${broken ? ' broken' : ''}`} role="region" aria-label="Telegram updates">
      <span className="al-icon" aria-hidden="true"><Icon name="send" /></span>
      <div className="tg-banner-text">
        <b>{broken ? 'Telegram stopped reaching you' : 'Get updates on Telegram'}</b>
        <span className="muted sm">
          {waiting
            ? 'Press Start in Telegram to finish — this goes away once you’re connected.'
            : broken
              ? 'Telegram refused our last message (the bot was blocked or the chat deleted). Reconnect to keep getting them.'
              : `Link your own Telegram and we message you ${what} — no need to keep this page open.`}
        </span>
        {error && <span className="error sm">{error}</span>}
      </div>
      <div className="tg-banner-actions">
        <button type="button" className="btn sm primary" onClick={connect} disabled={busy}>
          {busy ? 'Opening…' : broken ? 'Reconnect' : waiting ? 'Open Telegram again' : 'Connect Telegram'}
        </button>
        {!broken && <button type="button" className="btn sm ghost" onClick={notNow}>Not now</button>}
      </div>
    </div>
  );
}
