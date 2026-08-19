// PO Phase 3: reconciliation. Warehouse/PH review a received PO's expected-vs-
// received table (grouped by SKU+size), see per-line flags (match / shortage /
// overage / wrong-size / wrong-sku), leave a note explaining the outcome, copy a
// discrepancy report to send the supplier in the group chat, and reconcile & close
// the PO — which freezes the snapshot onto it. See docs/context/purchase-orders.md.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useQueryParam } from '../lib/urlstate.js';
import { TopBar, copyToClipboard } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { PoResolution } from '../components/PoResolution.jsx';
import { ManifestPrint } from '../components/ManifestPrint.jsx';

const FLAG = {
  match:      { label: 'Match', cls: 'ok' },
  shortage:   { label: 'Short', cls: 'bad' },
  overage:    { label: 'Over', cls: 'warn' },
  wrong_size: { label: 'Wrong size', cls: 'warn' },
  wrong_sku:  { label: 'Not on PO', cls: 'bad' },
};

function flagText(r) {
  if (r.flag === 'shortage') return `Short ${r.expected - r.received}`;
  if (r.flag === 'overage') return `Over +${r.received - r.expected}`;
  return FLAG[r.flag]?.label || r.flag;
}

// What the chip should actually SAY. "To reconcile" on a 13-of-13 all-matched PO is
// noise — it reads as a chore when there's nothing to decide. So name the real state:
// what's wrong, or what's still on its way, or that it's done.
//   rc = { clean, no_manifest, shortage, overage, wrong_size, wrong_sku,
//          expected_units, received_units, intake_done, awaiting_boxes }
export function poChip(status, rc) {
  if (status === 'reconciled') return { cls: 'ok', label: 'Reconciled' };
  if (status === 'closed') return { cls: 'muted', label: 'Archived' };
  if (!rc) return { cls: 'receiving', label: 'To reconcile' };
  if (!rc.intake_done) return { cls: 'receiving', label: 'Receiving' };
  if (rc.no_manifest) return { cls: 'warn', label: 'Received blind' };
  const issues = (rc.shortage || 0) + (rc.overage || 0) + (rc.wrong_size || 0) + (rc.wrong_sku || 0);
  if (issues) return { cls: 'bad', label: `${issues} discrepanc${issues === 1 ? 'y' : 'ies'}` };
  // Clean, but auto-reconcile held off because a label hasn't left the supplier yet —
  // more units are still due, so closing now would freeze an incomplete picture.
  if (rc.awaiting_boxes) return { cls: 'receiving', label: 'Boxes still out' };
  return { cls: 'ok', label: 'Matched · ready to close' };
}

// The PO tag is usually just the supplier's name again — printing both gives you
// "Andrew · Andrew". Only show it when it actually says something new.
const tagOf = (po) => {
  const t = String(po?.tag_code || '').trim();
  return t && t.toLowerCase() !== String(po?.supplier_name || '').trim().toLowerCase() ? t : '';
};

// Worst-first, so a SKU group inherits the flag that most needs attention.
const SEVERITY = ['shortage', 'wrong_sku', 'overage', 'wrong_size', 'match'];
const worstFlag = (rows) => SEVERITY.find((f) => rows.some((r) => r.flag === f)) || 'match';

// Collapse the per-size rows into one row per SKU: the product name is printed once
// and each size becomes a chip. Kills the repetition when a PO carries the same shoe
// in several sizes (the flat list repeats the full name on every one).
function groupBySku(rows) {
  const out = new Map();
  for (const r of rows) {
    const k = r.sku || '—';
    if (!out.has(k)) out.set(k, { sku: k, name: r.name, expected: 0, received: 0, sizes: [] });
    const g = out.get(k);
    g.expected += r.expected; g.received += r.received; g.sizes.push(r);
    if (!g.name && r.name) g.name = r.name;
  }
  return [...out.values()].map((g) => ({ ...g, flag: worstFlag(g.sizes) }));
}

// Plain-text discrepancy report for the group chat. `note` is the reconciliation note —
// appended so the copied message already carries the explanation instead of the sender
// retyping it underneath.
function buildReport(po, rows, summary, note) {
  const tail = (lines) => {
    const n = String(note || '').trim();
    if (n) lines.push('', `Note: ${n}`);
    return lines.join('\n');
  };
  const bad = rows.filter((r) => r.flag !== 'match');
  // Received with no manifest: nothing was declared, so a per-line "not on PO" list is
  // noise — report the totals and that it was received blind instead.
  if (summary.no_manifest) {
    return tail([`${po.po_code} · ${po.supplier_name}`,
      `No manifest was provided for this shipment — received blind.`,
      `${summary.received_units} unit${summary.received_units === 1 ? '' : 's'} received and logged; none were pre-declared, so nothing is flagged as a discrepancy.`]);
  }
  const lines = [`${po.po_code} · ${po.supplier_name}`,
    `Received ${summary.received_units} of ${summary.expected_units} expected units.`];
  if (bad.length === 0) { lines.push('All items matched — no discrepancies. ✅'); return tail(lines); }
  lines.push('', 'Discrepancies:');
  for (const r of bad) {
    const label = r.flag === 'shortage' ? `short ${r.expected - r.received}`
      : r.flag === 'overage' ? `over +${r.received - r.expected}`
      : r.flag === 'wrong_size' ? 'wrong size — not on the PO'
      : 'not on the PO';
    lines.push(`- ${r.sku} size ${r.size}: ${label} (expected ${r.expected}, got ${r.received})`);
  }
  if (summary.match) lines.push('', `Matched: ${summary.match} line${summary.match === 1 ? '' : 's'}.`);
  return tail(lines);
}

export function Reconciliation({ canReconcile, onHome, onSignOut }) {
  const [pos, setPos] = useState(null);
  const [error, setError] = useState('');
  // Same as PoOverview: ?po= keeps the open order across a refresh. The reconciliation
  // rows are always re-fetched from the server, never restored from the URL.
  const [openIdRaw, setOpenIdRaw] = useQueryParam('po');
  const openId = openIdRaw ? Number(openIdRaw) : null;
  const setOpenId = (v) => setOpenIdRaw(v == null ? '' : String(v));
  const [detail, setDetail] = useState(null); // { po, rows, summary }
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [bySku, setBySku] = useState(false);     // opt-in: one row per SKU + size chips
  const [showMatched, setShowMatched] = useState(false); // matched lines stay folded away
  const [note, setNote] = useState('');          // draft text of the reconciliation note
  const [noteSaved, setNoteSaved] = useState(''); // what's on the server, to detect edits
  const [noteBusy, setNoteBusy] = useState(false);

  // The archived list only grows and is opened rarely, so it's a separate fetch that
  // never runs unless the tab is actually visited.
  const [tab, setTab] = useQueryParam('tab');           // '' = active, 'archived'
  const archived = tab === 'archived';
  const [archivedPos, setArchivedPos] = useState(null);

  const loadList = () => {
    api.poReconcileList()
      .then((r) => setPos(r.pos || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  };
  const loadArchived = () => {
    api.poArchived()
      .then((r) => setArchivedPos(r.pos || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  };
  useEffect(loadList, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (archived && archivedPos == null) loadArchived(); }, [archived]); // eslint-disable-line react-hooks/exhaustive-deps

  const doUnarchive = async (poId, poCode) => {
    if (!window.confirm(`Bring ${poCode} back? It returns to Reconciled — the frozen count is unchanged.`)) return;
    setBusy(true);
    try {
      await api.poUnarchive(poId);
      loadArchived(); loadList();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  };

  const loadDetail = (id) => {
    api.poReconciliation(id)
      .then((r) => {
        setDetail({
          po: r.po, rows: r.rows, summary: r.summary,
          intakeDone: r.intake_done, awaitingBoxes: r.awaiting_boxes,
          resolution: r.resolution, steps: r.steps, comments: r.comments || [],
          receivedBoxes: r.received_boxes || [],
          boxDiffs: r.box_diffs || [],
        });
        setNote(r.po.reconcile_note || ''); setNoteSaved(r.po.reconcile_note || '');
      })
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  };

  const open = (id) => {
    setOpenId(id); setDetail(null); setError(''); setCopied(false); setShowMatched(false);
    setNote(''); setNoteSaved('');
  };

  // Fetch whenever a PO is open but its detail isn't loaded. Driven off `openId` rather
  // than the click, because ?po= can arrive from the URL — a refresh, a Back, or the
  // "Review & copy the report" deep link on the batch-saved alert. Fetching only in the
  // click handler left every one of those stuck on "Loading…" forever.
  useEffect(() => {
    if (openId && !detail) loadDetail(openId);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every resolution write returns the fresh row, so the checklist updates without a
  // refetch — but the thread and the PO's own status can both move too (logging
  // replacement tracking reopens the order), so pull the detail again after.
  const doStep = async (payload) => {
    setBusy(true); setError('');
    try {
      await api.poResolutionStep({ poId: openId, ...payload });
      const r = await api.poReconciliation(openId);
      setDetail((d) => ({
        ...d, po: r.po, rows: r.rows, summary: r.summary,
        intakeDone: r.intake_done, awaitingBoxes: r.awaiting_boxes,
        resolution: r.resolution, steps: r.steps, comments: r.comments || [],
        receivedBoxes: r.received_boxes || d.receivedBoxes,
        boxDiffs: r.box_diffs || d.boxDiffs,
      }));
      loadList();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  };

  const doComment = async (body) => {
    setBusy(true); setError('');
    try {
      const r = await api.poComment(openId, body);
      setDetail((d) => ({ ...d, comments: [...(d.comments || []), r.comment] }));
      loadList();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  };

  const writeNote = async (text) => {
    setNoteBusy(true); setError('');
    try {
      const r = await api.poSaveNote(openId, text);
      setNoteSaved(r.reconcile_note || '');
      setNote(r.reconcile_note || '');
      setDetail((d) => ({ ...d, po: { ...d.po,
        reconcile_note: r.reconcile_note, reconcile_note_by: r.reconcile_note_by,
        reconcile_note_at: r.reconcile_note_at } }));
      loadList(); // keep the list card's preview in step
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setNoteBusy(false); }
  };
  const saveNote = () => writeNote(note);

  // Most of what you'd tell the supplier is something you already typed internally, so
  // one tap promotes a comment into the note rather than making you retype it. There's
  // only ever ONE supplier-facing note, so replacing an existing one is confirmed first.
  const sendToSupplier = async (body) => {
    if (noteSaved.trim() && noteSaved.trim() !== body.trim()
      && !window.confirm('Replace the note the supplier currently sees with this line?')) return;
    await writeNote(body);
  };

  const doReconcile = async () => {
    if (!window.confirm('Reconcile & close this PO? This freezes the current received-vs-expected snapshot.')) return;
    setBusy(true);
    try {
      const r = await api.poReconcile(openId);
      setDetail((d) => ({ ...d, po: r.po, rows: r.rows, summary: r.summary, receivedBoxes: r.received_boxes || d.receivedBoxes, boxDiffs: r.box_diffs || d.boxDiffs }));
      loadList();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  };

  const doArchive = async () => {
    if (!window.confirm('Archive this PO? It moves to the Archived tab — you can bring it back from there.')) return;
    setBusy(true);
    try {
      await api.poClose(openId);
      setOpenId(null); setDetail(null); loadList();
      if (archivedPos != null) loadArchived(); // keep the other tab honest if it's been opened
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  };

  const copyReport = async () => {
    const ok = await copyToClipboard(buildReport(detail.po, detail.rows, detail.summary, noteSaved));
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1800); }
  };

  // ---- List ----
  if (!openId) {
    const list = archived ? archivedPos : pos;
    const card = (p) => {
      const chip = poChip(p.status, p.rc);
      // "3 of 0 units received" is nonsense on a blind receipt — nothing was ever
      // declared to count against.
      const units = !p.rc || p.rc.expected_units == null
        ? `${p.unit_count} expected unit${p.unit_count === 1 ? '' : 's'}`
        : p.rc.no_manifest
          ? `${p.rc.received_units} unit${p.rc.received_units === 1 ? '' : 's'} received · no manifest`
          : `${p.rc.received_units} of ${p.rc.expected_units} unit${p.rc.expected_units === 1 ? '' : 's'} received`;
      return (
        <div className="po-card-wrap" key={p.id}>
          <button className="po-card" onClick={() => open(p.id)}>
            <div className="po-card-top">
              <span className="po-code">{p.po_code}</span>
              <span className={`po-chip ${chip.cls}`}>{chip.label}</span>
            </div>
            <div className="po-card-meta">
              <span>{p.supplier_name}</span>
              {tagOf(p) && <span>{tagOf(p)}</span>}
              <span>{units}</span>
            </div>
            {(p.resolution_state === 'open' || p.comment_count > 0) && (
              <div className="rcn-card-foot">
                {p.resolution_state === 'open' && <span className="po-flag warn">Resolution open</span>}
                {p.resolution_state === 'settled' && <span className="po-flag ok">Resolved</span>}
                {p.comment_count > 0 && (
                  <span className="muted xs">{p.comment_count} note{p.comment_count === 1 ? '' : 's'}</span>
                )}
              </div>
            )}
            {p.reconcile_note && (
              <div className="rcn-note-peek">
                <Icon name="reconcile" /> {p.reconcile_note}
              </div>
            )}
          </button>
          {/* Outside the card button — nesting a button inside a button is invalid and
              swallows the click on mobile. */}
          {archived && (
            <button className="btn ghost sm rcn-unarchive" disabled={busy}
              onClick={() => doUnarchive(p.id, p.po_code)}>
              Bring back
            </button>
          )}
        </div>
      );
    };

    return (
      <div className="app">
        <TopBar title="PO Reconciliation" onHome={onHome} onSignOut={onSignOut} />
        <div className="wrap-narrow">
          {error && <div className="po-err">{error}</div>}
          <div className="rcn-tabs">
            <button className={archived ? '' : 'on'} onClick={() => setTab('')}>Active</button>
            <button className={archived ? 'on' : ''} onClick={() => setTab('archived')}>Archived</button>
          </div>
          {list == null ? <p className="muted">Loading…</p>
            : list.length === 0 ? (
              <div className="card empty-state">
                {archived
                  ? 'Nothing archived yet. Archiving a reconciled order moves it here — and you can bring it back.'
                  : 'No received purchase orders yet. Reconciliation shows up here once a PO has been received against.'}
              </div>
            ) : (
              <div className="po-list">{list.map(card)}</div>
            )}
        </div>
      </div>
    );
  }

  // ---- Detail ----
  const po = detail?.po; const s = detail?.summary;
  // Received blind: nothing was declared, so nothing is a "discrepancy" — every line is
  // just a receipt and the problems/matched split doesn't apply.
  const blind = !!s?.no_manifest;
  // Anything started on the checklist means someone is actively working this order — the
  // moment where "has the supplier actually been told?" is worth asking.
  const resolutionStarted = !!detail?.resolution?.state && detail.resolution.state !== 'none';
  const headChip = poChip(po?.status, s && {
    ...s, intake_done: detail?.intakeDone, awaiting_boxes: detail?.awaitingBoxes,
  });
  // Group BEFORE the problem/matched split, so a SKU that's short in one size and fine
  // in another lands in the problem section once (with every size chip) instead of
  // being torn in half across the two sections.
  const allRows = bySku ? groupBySku(detail?.rows || []) : (detail?.rows || []);
  const problems = blind ? [] : allRows.filter((r) => r.flag !== 'match');
  const matched = blind ? allRows : allRows.filter((r) => r.flag === 'match');

  // One line: flat (per size) or grouped (per SKU, sizes as chips).
  const renderRow = (r, key) => (
    <div className={`rcn-row ${r.flag}`} key={key}>
      <div className="rcn-main">
        <div className="rcn-id">
          <b>{r.sku || '—'}</b>
          {!bySku && <span className="rcn-size">size {r.size}</span>}
        </div>
        {r.name && r.name !== r.sku && <div className="rcn-name">{r.name}</div>}
        {bySku && (
          <div className="rcn-chips">
            {r.sizes.map((z, i) => (
              <span className={`rcn-chip ${z.flag}`} key={i}>
                {z.size}<i>{z.received}/{z.expected}</i>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="rcn-right">
        <div className="rcn-qty"><b>{r.received}</b><span>/{r.expected}</span></div>
        <div className="rcn-status">
          {blind ? <span className="po-flag">Received</span>
            : r.flag === 'match' ? <span className="rcn-tick" title="Match">✓</span>
            : <span className={`po-flag ${FLAG[r.flag]?.cls || ''}`}>{bySku ? FLAG[r.flag]?.label : flagText(r)}</span>}
        </div>
      </div>
    </div>
  );

  const renderRows = (list) => list.map((r, i) => renderRow(r, `${r.sku || '—'}-${r.size ?? 'g'}-${i}`));

  return (
    <div className="app">
      <TopBar title={po ? po.po_code : 'Reconciliation'} onHome={onHome} onSignOut={onSignOut}
        right={<button className="btn ghost sm" onClick={() => { setOpenId(null); setDetail(null); }}>← All</button>} />
      <div className="wrap-narrow">
        {error && <div className="po-err">{error}</div>}
        {!po ? <p className="muted">Loading…</p> : (
          <>
            <div className="card">
              <div className="po-card-top">
                <h3 className="rows-title">{po.po_code}{tagOf(po) ? ` · ${tagOf(po)}` : ''}</h3>
                <span className={`po-chip ${headChip.cls}`}>{headChip.label}</span>
              </div>
              <p className="muted sm">{po.supplier_name} · received <b>{s.received_units}</b> of <b>{s.expected_units}</b> expected units</p>
              {blind ? (
                <p className="rcn-no-manifest sm">
                  <b>No manifest provided.</b> The supplier didn’t scan out and no one entered a manifest on their behalf, so every received unit is logged but nothing is flagged as a discrepancy. The items below are what the warehouse actually received.
                </p>
              ) : (
                <div className="rcn-summary">
                  {s.clean ? <span className="po-flag ok">All {s.match} lines matched ✓</span> : null}
                  {!s.clean && s.match ? <span className="po-flag ok">{s.match} match</span> : null}
                  {s.shortage ? <span className="po-flag bad">{s.shortage} short</span> : null}
                  {s.overage ? <span className="po-flag warn">{s.overage} over</span> : null}
                  {s.wrong_size ? <span className="po-flag warn">{s.wrong_size} wrong size</span> : null}
                  {s.wrong_sku ? <span className="po-flag bad">{s.wrong_sku} not on PO</span> : null}
                </div>
              )}
              {po.manifest_scope === 'po' && !s.no_manifest && (
                <p className="muted xs" style={{ marginTop: '8px' }}>Whole-order manifest — matched on order totals, no per-box breakdown.</p>
              )}
              {/* What the supplier said was in the boxes, as a printable packing slip —
                  the paper you stand next to the pallet with when a count is disputed.
                  Hidden on a blind receipt: there is no manifest to print, and an empty
                  slip would read as "the supplier declared nothing" rather than "nobody
                  ever entered one". */}
              {!blind && (
                <ManifestPrint poId={openId} poCode={po.po_code}
                  received={detail.receivedBoxes} compare={{ rows: detail.rows }} onSignOut={onSignOut} />
              )}
              {/* On a blind receipt there's no manifest to print, but "what we received"
                  is exactly what's worth sending — it's the only record of the shipment. */}
              {blind && detail.receivedBoxes?.length > 0 && (
                <ManifestPrint poId={openId} poCode={po.po_code} label="Our count:"
                  received={detail.receivedBoxes} compare={{ rows: detail.rows }} onSignOut={onSignOut} />
              )}
            </div>

            {/* WHERE the differences are, box by box. The table above says "one Dunk is
                missing"; this says "box 11" — the difference between a message to the
                supplier and someone walking to a shelf. Only on a per-box manifest: a
                whole-order list has no per-box expectation to compare against.

                A label that hasn't been received yet is NOT listed as a pile of missing
                pairs — it's simply still outstanding, and reading it as a shortage is how
                a half-delivered order gets chased as a loss. */}
            {!blind && detail.boxDiffs?.length > 0 && (() => {
              const received = detail.boxDiffs.filter((b) => b.received);
              const pending = detail.boxDiffs.filter((b) => !b.received);
              const dirty = received.filter((b) => b.diffs.length);
              const clean = received.filter((b) => !b.diffs.length);
              if (!received.length) return null;
              return (
                <div className="card rcn-boxdiff">
                  <h3 className="rows-title">
                    By box{' '}
                    <span className="muted">({clean.length} of {received.length} match exactly)</span>
                  </h3>
                  {!dirty.length ? (
                    <p className="muted sm">Every box we opened holds exactly what its label declared.</p>
                  ) : dirty.map((b) => (
                    <div className="rcn-bd-box" key={b.box_number}>
                      <div className="rcn-bd-head">
                        <b>Box {b.box_number}</b>
                        <span className="muted sm">declared {b.expected_units} · counted {b.received_units}</span>
                      </div>
                      {b.diffs.map((d, i) => (
                        <div className={`rcn-bd-line ${d.kind}`} key={`${d.sku}-${d.size}-${i}`}>
                          <span className={`po-flag ${d.kind === 'missing' ? 'bad' : 'warn'}`}>
                            {d.kind === 'missing' ? `−${d.qty}` : `+${d.qty}`}
                          </span>
                          <span className="rcn-bd-name">{d.name || d.sku}</span>
                          <span className="muted xs">{d.sku} · size {d.size}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  {clean.length > 0 && dirty.length > 0 && (
                    <p className="muted xs rcn-bd-clean">Matching exactly: box {clean.map((b) => b.box_number).join(', ')}.</p>
                  )}
                  {pending.length > 0 && (
                    <p className="muted xs">Still to arrive: box {pending.map((b) => b.box_number).join(', ')} — not counted as short.</p>
                  )}
                </div>
              );
            })()}

            {/* OUR count, box by box — the evidence in a shortage conversation. The
                supplier's manifest says what they claim they sent; this says what came
                out of each box we opened, with that box's tracking number on it. */}
            {detail.receivedBoxes?.length > 0 && (
              <div className="card rcn-received">
                <div className="step-head">
                  <h3 className="rows-title">
                    What we received, box by box{' '}
                    <span className="muted">
                      ({detail.receivedBoxes.reduce((n, b) => n + b.units, 0)} unit
                      {detail.receivedBoxes.reduce((n, b) => n + b.units, 0) === 1 ? '' : 's'})
                    </span>
                  </h3>
                </div>
                {detail.receivedBoxes.map((b, i) => (
                  <div className="rcn-rbox" key={b.id ?? `loose-${i}`}>
                    <div className="rcn-rbox-head">
                      <b>{b.box_number ? `Box ${b.box_number}` : 'Not recorded against a box'}</b>
                      {b.tracking_number && <span className="muted sm"> · {b.tracking_number}</span>}
                      {/* The number came off the LABEL (its tracking number), not off what
                          was typed while unpacking. Say so where the two disagree, so this
                          sheet can't be read as us quietly renumbering the supplier's box. */}
                      {b.recorded_box_number != null && (
                        <span className="muted xs rcn-rbox-renamed">
                          {' '}· matched to this label by tracking; recorded while unpacking as box {b.recorded_box_number}
                        </span>
                      )}
                      <span className="rcn-rbox-units">{b.units} unit{b.units === 1 ? '' : 's'}</span>
                    </div>
                    {b.items.length === 0 ? (
                      <p className="muted xs">Opened, nothing in it.</p>
                    ) : (
                      <ul className="rcn-rbox-list">
                        {b.items.map((it) => (
                          <li key={`${it.sku}|${it.size}`}>
                            <span className="rcn-rbox-name">{it.name || it.sku}</span>
                            <span className="muted xs">{it.sku} · size {it.size}</span>
                            <span className="rcn-rbox-qty">×{it.qty}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="card">
              <div className="rcn-toolbar">
                <span className="rcn-head-lbl">SKU / size</span>
                <div className="rcn-seg">
                  <button className={bySku ? '' : 'on'} onClick={() => setBySku(false)}>By size</button>
                  <button className={bySku ? 'on' : ''} onClick={() => setBySku(true)}>By SKU</button>
                </div>
                <span className="rcn-head-qty">Got / exp</span>
              </div>

              <div className="rcn-table">
                {problems.length > 0 && renderRows(problems)}

                {/* Matched lines are the boring majority — folded away so the eye lands on
                    the discrepancies (or, on a clean PO, on nothing at all). A blind receipt
                    has no matched/problem split, so its lines are simply always shown. */}
                {matched.length > 0 && !blind && (
                  <button className="rcn-fold" onClick={() => setShowMatched((v) => !v)}>
                    <span>{matched.length} {bySku ? 'SKU' : 'line'}{matched.length === 1 ? '' : 's'} matched ✓</span>
                    <span className="rcn-fold-cta">{showMatched ? 'Hide ▴' : 'Show ▾'}</span>
                  </button>
                )}
                {matched.length > 0 && (blind || showMatched) && renderRows(matched)}
              </div>
            </div>

            {/* The "why" behind the numbers. Editable at any status — the resolution
                (credit agreed, missing pair found) usually lands days after the count,
                often once the PO is already reconciled or archived. The supplier sees
                this read-only in their portal, so it doubles as the message to them. */}
            <div className="card rcn-note">
              <div className="rcn-note-head">
                <h4 className="rows-title">Note to the supplier</h4>
                {po.reconcile_note_by && po.reconcile_note_at && (
                  <span className="muted xs">
                    {po.reconcile_note_by} · {String(po.reconcile_note_at).slice(0, 10)}
                  </span>
                )}
              </div>
              {/* Easy to work a whole resolution — ticking steps, writing internal notes —
                  and never tell the supplier anything, because the field they can actually
                  read is the one nobody types in. Say so while it's still relevant. */}
              {resolutionStarted && !noteSaved.trim() && (
                <p className="rcn-note-nudge">
                  The supplier hasn’t been told anything yet. Everything below is internal.
                </p>
              )}
              <textarea
                className="rcn-note-input"
                rows={3}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What happened, and what was agreed? e.g. “Size 10.5 shipped separately, ETA Thursday — Andrew confirmed.” The supplier can see this."
              />
              <div className="rcn-note-foot">
                <span className="muted xs">Visible to the supplier · {2000 - note.length} left</span>
                <button className="btn ghost sm" disabled={noteBusy || note === noteSaved} onClick={saveNote}>
                  {noteBusy ? 'Saving…' : note === noteSaved ? 'Saved ✓' : 'Save note'}
                </button>
              </div>
            </div>

            {/* Only for orders that actually went wrong — a clean PO has nothing to
                chase, and an empty checklist on every order is noise. Stays visible once
                started, even after the order is reconciled or archived: the money often
                lands weeks after the count did. */}
            {(!s.clean || detail.resolution?.state !== 'none') && (
              <PoResolution
                resolution={detail.resolution}
                steps={detail.steps}
                comments={detail.comments}
                busy={busy || noteBusy}
                onStep={doStep}
                onComment={doComment}
                onSendToSupplier={sendToSupplier}
                supplierNote={noteSaved}
              />
            )}

            <div className="rcn-actions">
              <button className="btn ghost" onClick={copyReport}>{copied ? 'Copied ✓' : 'Copy report'}</button>
              {canReconcile && po.status === 'receiving' && (
                <button className="btn primary" disabled={busy} onClick={doReconcile}>
                  {busy ? 'Closing…' : s?.clean && !blind ? 'Confirm & close' : 'Reconcile & close'}
                </button>
              )}
              {/* Closing mid-intake freezes a snapshot that's missing whatever hasn't
                  arrived yet — worth saying out loud, not blocking. */}
              {canReconcile && po.status === 'receiving' && (detail?.intakeDone === false || detail?.awaitingBoxes) && (
                <p className="muted xs rcn-warn">
                  {detail.intakeDone === false
                    ? 'The receiving batch is still open — more units may still be scanned in.'
                    : 'A label hasn’t left the supplier yet — more units are still due.'}
                  {' '}Closing now freezes the count as it stands.
                </p>
              )}
              {po.status === 'reconciled' && po.reconciled_at && (
                <span className="muted sm"><Icon name="reconcile" /> Reconciled {String(po.reconciled_at).slice(0, 10)}</span>
              )}
              {canReconcile && po.status === 'reconciled' && (
                <button className="btn ghost" disabled={busy} onClick={doArchive}>Archive</button>
              )}
              {canReconcile && po.status === 'closed' && (
                <button className="btn ghost" disabled={busy}
                  onClick={() => doUnarchive(po.id, po.po_code).then(() => { setOpenId(null); setDetail(null); })}>
                  Bring back from archive
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
