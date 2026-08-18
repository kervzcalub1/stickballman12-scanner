// Deleted — the archive of pairs removed from inventory (Inventory / New Inventory
// "Remove pairs"). The items row is genuinely gone, so this table IS the record:
// each entry carries the whole original row plus the unit's frozen history, which
// would otherwise have cascaded away with it.
//
// Searchable by SKU (the way anyone actually looks for one — "did we remove any of
// these?"), VIN, or name, with a date range over WHEN IT WAS REMOVED.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { statusLabel } from '../statuses.js';
import { PH_DATETIME } from '../lib/format.js';
import { eventLabel, dedupeEvents } from '../lib/history.js';
import { useQueryParam } from '../lib/urlstate.js';

export function DeletedItems({ onHome, onSignOut }) {
  const [q, setQ] = useQueryParam('q', '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openVin, setOpenVin] = useState(null); // vin whose frozen history is expanded

  async function load() {
    setLoading(true); setError('');
    try {
      const { rows: r } = await api.deletedItems(q.trim(), from, to);
      setRows(r || []);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setLoading(false); }
  }
  // Debounced so typing a SKU doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [q, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = rows.length;

  return (
    <div className="app">
      <TopBar title="Deleted" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          Pairs removed from inventory. The record is kept here — including the unit's
          history — after the inventory row itself is gone.
        </p>
        <div className="del-filters">
          <label className="del-search">
            <span className="muted xs">Search SKU, VIN or name</span>
            <input type="search" value={q} placeholder="CU9225-100" onChange={(e) => setQ(e.target.value)} />
          </label>
          <label><span className="muted xs">Removed from</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label><span className="muted xs">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          {(q || from || to) && (
            <button className="btn sm ghost" onClick={() => { setQ(''); setFrom(''); setTo(''); }}>Clear</button>
          )}
        </div>

        {error && <div className="error mt">{error}</div>}
        {loading ? <div className="muted mt">Loading…</div> : (
          <>
            <div className="muted sm mt">{total} removed pair{total === 1 ? '' : 's'}{q ? ` matching “${q}”` : ''}</div>
            {total === 0 ? (
              <div className="empty mt">Nothing has been removed{q || from || to ? ' that matches this search' : ' yet'}.</div>
            ) : (
              <div className="inv-tablewrap mt">
                <table className="inv-table del-tbl">
                  <thead>
                    <tr>
                      <th>Removed</th><th>Shoe</th><th>SKU</th><th>Size</th>
                      <th>VIN</th><th>Status then</th><th>Batch</th><th>Reason</th><th>By</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const events = dedupeEvents(Array.isArray(r.events) ? r.events : []);
                      const open = openVin === r.vin;
                      return (
                        <React.Fragment key={r.id}>
                          <tr>
                            <td className="del-when">{r.deleted_at ? PH_DATETIME.format(new Date(r.deleted_at)) : '—'}</td>
                            <td>{r.name || '—'}</td>
                            <td className="mono">{r.sku || '—'}</td>
                            <td>{r.size || '—'}</td>
                            <td className="mono sm">{r.vin}</td>
                            <td>{r.status ? statusLabel(r.status) : '—'}</td>
                            <td className="sm">{r.batch_code || '—'}</td>
                            <td className="sm">{r.reason || <span className="muted">—</span>}</td>
                            <td className="sm">{r.deleted_by || '—'}</td>
                            <td>
                              <button className="btn sm ghost" disabled={!events.length}
                                title={events.length ? 'Its history, frozen at deletion' : 'No history was recorded'}
                                onClick={() => setOpenVin(open ? null : r.vin)}>
                                🕘 {events.length || 0}
                              </button>
                            </td>
                          </tr>
                          {open && (
                            <tr className="del-hist-row">
                              <td colSpan={10}>
                                <div className="del-hist">
                                  <div className="muted xs">History of {r.vin}, as it stood when the pair was removed</div>
                                  <ul>
                                    {events.map((e, i) => (
                                      <li key={i}>
                                        <span className="muted sm">{e.created_at ? PH_DATETIME.format(new Date(e.created_at)) : ''}</span>
                                        {' — '}{eventLabel(e)}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
