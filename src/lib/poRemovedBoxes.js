// Labels that USED to be on a purchase order — removed, or moved to another order —
// read back from the order's own system notes.
//
// Why from the notes: a removed label is a deleted `po_boxes` row (its manifest lines go
// with it), so the only record that box 14 ever existed is the note `po/label-remove`
// writes ("Label 14 (1Z…) removed, with the 6 line(s) declared for it.") and the one
// `po/label-move` writes ("Label 3 (1Z…) moved to PO-100123, where it is label 1.").
// Both carry who did it and when. Without this, a reconciliation reads "box 13, 15 …"
// with a hole at 14 and nobody can say whether box 14 is lost or was never sent.
//
// Pure: server (po/reconciliation) and tests both call it.

const RE = /^Label (\d+) \((.*?)\) (removed|moved to (\S+?), where it is label (\d+))/;

/**
 * @param {Array<{body:string, author_name?:string, author_role?:string, created_at?:string}>} notes
 *   the order's `kind='system'` notes, any order
 * @param {Iterable<number|string>} liveNumbers box numbers the order has NOW
 * @returns {Array<{box_number:number, tracking:string|null, kind:'removed'|'moved',
 *   lines:number, to_po:string|null, to_box:number|null, by:string|null, by_role:string|null, at:string|null}>}
 *   oldest first
 */
export function parseRemovedBoxes(notes, liveNumbers = []) {
  const live = new Set([...liveNumbers].map(Number));
  const out = [];
  for (const n of notes || []) {
    const m = RE.exec(String(n?.body || ''));
    if (!m) continue;
    const box = Number(m[1]);
    const tracking = m[2] && m[2] !== 'no tracking #' ? m[2] : null;
    const moved = m[3].startsWith('moved');
    const lines = Number((/with the (\d+) line\(s\)/.exec(n.body) || [])[1] || 0);
    // A label taken off a DRAFT before it ever had a number or a list is the supplier
    // tidying their own form — not a box that might be missing. Only a label that had a
    // tracking number, a declared list, or went to another order is worth a line.
    if (!moved && !tracking && !lines) continue;
    // The number was used again by a label that is on the order now: "box 4 was removed"
    // next to a live box 4 reads as a contradiction, and the live one is what counts.
    if (live.has(box)) continue;
    out.push({
      box_number: box,
      tracking,
      kind: moved ? 'moved' : 'removed',
      lines,
      to_po: moved ? m[4] : null,
      to_box: moved ? Number(m[5]) : null,
      by: n.author_name || null,
      by_role: n.author_role || null,
      at: n.created_at ? new Date(n.created_at).toISOString() : null,
    });
  }
  return out.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.box_number - b.box_number);
}
