// The 🔔 Alerts panel — a person's own notifications, as private Telegram messages.
//
// Copied from the team Hub's "Alert Preferences" (docs/telegram-alerts-plan.md):
//   · Connect Telegram → a one-use deep link opens the bot with /start already filled in;
//     the bot answers "Connected … as <name>" and this panel flips to Connected on the
//     `users` live event — no refresh.
//   · a master switch, then one row per event that applies to THIS person's job;
//     required rows are locked on.
//   · Send test / Disconnect, and a "reconnect" warning when Telegram refused a send.
//
// Opened from the bell in TopBar, so it is the same on the warehouse, PH and supplier
// apps; `?alerts=1` keeps it open across a refresh.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { Icon } from './NavIcons.jsx';

function Switch({ on, locked = false, disabled = false, label, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label}
      className={`al-switch${on ? ' on' : ''}${locked ? ' locked' : ''}`}
      disabled={disabled || locked} onClick={() => onChange(!on)}>
      <span className="al-knob" aria-hidden="true" />
    </button>
  );
}

export function AlertsPanel({ onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');       // 'link' | 'test' | 'disconnect' | event key
  const [waiting, setWaiting] = useState(false); // sent to Telegram, Start not pressed yet
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    const r = await api.myAlerts();
    setData(r);
    if (r?.telegram?.connected && !r.telegram.broken) setWaiting(false);
  }, []);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  // The bot writes the connection to `users`; the live stream says so.
  useLive(['users'], load, { mount: false });
  // Coming back from the Telegram app — re-read straight away rather than wait.
  useEffect(() => {
    const onBack = () => { if (!document.hidden) load().catch(() => {}); };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    return () => { document.removeEventListener('visibilitychange', onBack); window.removeEventListener('focus', onBack); };
  }, [load]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { if (!flash) return undefined; const t = setTimeout(() => setFlash(''), 4000); return () => clearTimeout(t); }, [flash]);

  async function connect() {
    setError(''); setBusy('link');
    // Opened NOW, inside the tap: a window opened after an await is a popup to iOS
    // Safari and gets blocked. It shows about:blank for a beat, then hands off to Telegram.
    const win = window.open('', '_blank');
    try {
      const { url } = await api.telegramConnectLink();
      if (win && !win.closed) win.location.href = url; else window.location.href = url;
      setWaiting(true);
    } catch (e) {
      if (win && !win.closed) win.close();
      setError(e.message);
    } finally { setBusy(''); }
  }

  async function act(kind) {
    setError(''); setBusy(kind);
    try {
      if (kind === 'test') { await api.telegramSendTest(); setFlash('Test sent — check Telegram.'); }
      if (kind === 'disconnect') { await api.telegramDisconnect(); setFlash('Telegram disconnected.'); }
      await load();
    } catch (e) { setError(e.message); await load().catch(() => {}); } finally { setBusy(''); }
  }

  async function save(patch, key) {
    setError(''); setBusy(key);
    const before = data;
    // Optimistic — a switch that waits on the network feels broken.
    setData((d) => ({
      ...d,
      ...(patch.muted !== undefined ? { muted: patch.muted } : {}),
      events: (d.events || []).map((ev) => (patch.prefs && ev.key in patch.prefs ? { ...ev, on: patch.prefs[ev.key] } : ev)),
    }));
    try { setData(await api.saveMyAlerts(patch)); }
    catch (e) { setData(before); setError(e.message); } finally { setBusy(''); }
  }

  const tg = data?.telegram || {};
  const groups = [];
  for (const ev of data?.events || []) {
    let g = groups.find((x) => x.name === ev.group);
    if (!g) groups.push(g = { name: ev.group, events: [] });
    g.events.push(ev);
  }
  const required = (data?.events || []).filter((e) => e.required).map((e) => e.title);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal al-panel" role="dialog" aria-modal="true" aria-label="Alerts" onClick={(e) => e.stopPropagation()}>
        <div className="al-head">
          <div>
            <div className="al-eyebrow">Preferences</div>
            <h3 className="modal-title">Alerts</h3>
          </div>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="al-lede">Your own notifications, as private messages from the bot on Telegram.</p>

        {error && <p className="notice sm" role="alert">{error}</p>}
        {flash && <p className="al-flash" role="status">{flash}</p>}
        {!data && !error && <p className="muted sm">Loading…</p>}

        {data?.account === 'shared' && (
          <div className="al-card">
            <p className="sm">This is a shared login, so it can’t carry one person’s Telegram. Sign in with your own account to connect alerts.</p>
          </div>
        )}

        {data && data.account !== 'shared' && (<>
          <div className="al-card al-row">
            <span className="al-icon"><Icon name="bell" /></span>
            <div className="al-text">
              <div className="al-title">All alerts</div>
              <div className="al-when">Turn this off to stop every alert, including the required ones.</div>
            </div>
            <Switch on={!data.muted} label="All alerts" disabled={busy === 'muted'}
              onChange={(v) => save({ muted: !v }, 'muted')} />
          </div>

          <div className={`al-card al-row al-telegram${tg.broken ? ' broken' : ''}`}>
            <span className="al-icon"><Icon name="send" /></span>
            <div className="al-text">
              <div className="al-title">Telegram</div>
              {!data.configured ? (
                <div className="al-when">Telegram isn’t set up on this server yet.</div>
              ) : tg.connected && tg.broken ? (
                <div className="al-when al-bad">Telegram stopped accepting messages (the chat with the bot was blocked or deleted). Reconnect to get alerts again.</div>
              ) : tg.connected ? (
                <div className="al-when">Connected{tg.username ? <> as <b>@{tg.username}</b></> : tg.name ? <> as <b>{tg.name}</b></> : null}. Your alerts arrive as private messages from the bot.</div>
              ) : waiting ? (
                <div className="al-when al-wait">Tap <b>Start</b> in Telegram to finish connecting.</div>
              ) : (
                <div className="al-when">Get your alerts — gift cards, requests, approvals — as private messages from the bot.</div>
              )}
            </div>
            {data.configured && (
              <div className="al-actions">
                {tg.connected && !tg.broken ? (<>
                  <button type="button" className="btn sm" disabled={!!busy} onClick={() => act('test')}>{busy === 'test' ? 'Sending…' : 'Send test'}</button>
                  <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => act('disconnect')}>Disconnect</button>
                </>) : (
                  <button type="button" className="btn primary sm" disabled={!!busy} onClick={connect}>
                    {busy === 'link' ? 'Opening…' : tg.broken ? 'Reconnect' : waiting ? 'Open Telegram again' : 'Connect Telegram'}
                  </button>
                )}
              </div>
            )}
          </div>

          {groups.map((g) => (
            <div key={g.name} className="al-group">
              <div className="al-group-name">{g.name}</div>
              <div className="al-card al-list">
                {g.events.map((ev) => (
                  <div key={ev.key} className="al-row">
                    <div className="al-text">
                      <div className="al-title">{ev.title}{ev.required && <span className="al-req"> (required)</span>}</div>
                      <div className="al-when">{ev.when}</div>
                    </div>
                    <Switch on={ev.required || ev.on} locked={ev.required} label={ev.title}
                      disabled={data.muted || busy === ev.key}
                      onChange={(v) => save({ prefs: { [ev.key]: v } }, ev.key)} />
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!groups.length && <p className="muted sm">No alerts apply to your account yet.</p>}
          {required.length > 0 && (
            <p className="al-foot">Required alerts ({required.join(', ')}) stay on — someone is waiting on you when they fire.</p>
          )}
        </>)}
      </div>
    </div>
  );
}
