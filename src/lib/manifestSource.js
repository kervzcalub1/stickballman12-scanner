// WHO wrote the expected list on a purchase order — the supplier scanning their own
// boxes, or our own staff typing it in for them (`entered_on_behalf`, stamped by
// `po/scan` and `po/line` from the caller's role — see api/_lib/po-manifest.js).
//
// The order uses whatever lines exist either way; nothing here changes which manifest is
// counted against. What it changes is what the warehouse is told. A list the supplier
// scanned is their own declaration, and a shortage against it is theirs to answer for. A
// list PH typed from a photo or a chat message is OUR transcription of a claim — a
// mismatch against it is as likely to be a typo on our side as a missing pair, so the
// person unpacking has to know which one they are holding before they raise a shortage.
//
// Kind is decided on LINE counts, not units: a line with qty 0 is still a declaration,
// and basing it on units made an all-zero manifest look like no manifest at all.

// `lines` — po_lines as returned by getPoFull (they carry entered_on_behalf, and
// entered_by_name except on a supplier's own response, where the server strips it).
// Returns { kind, lines, units, supplierUnits, staffUnits, by, names }.
//   'none'     — nothing declared; receiving blind
//   'supplier' — the supplier declared all of it
//   'staff'    — every line was entered on their behalf
//   'mixed'    — both, which is the case that most needs saying out loud
export function manifestSource(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const names = new Set();
  let supplierLines = 0; let staffLines = 0;
  let supplierUnits = 0; let staffUnits = 0;
  for (const l of list) {
    const qty = Math.max(0, Number(l.qty_expected) || 0);
    if (l.entered_on_behalf) {
      staffLines += 1; staffUnits += qty;
      const n = l.entered_by_name || l.entered_by_username;
      if (n) names.add(String(n));
    } else {
      supplierLines += 1; supplierUnits += qty;
    }
  }
  const kind = !list.length ? 'none'
    : staffLines && supplierLines ? 'mixed'
      : staffLines ? 'staff' : 'supplier';
  return {
    kind,
    lines: list.length,
    units: supplierUnits + staffUnits,
    supplierLines, staffLines, supplierUnits, staffUnits,
    // One name reads as accountability ("ask Maria"); several would read as a list to
    // scan past, so they collapse to the generic phrasing instead.
    by: names.size === 1 ? [...names][0] : null,
    names: [...names],
  };
}

// The same judgement as a sentence, for the receiving banner.
// `tone`: 'ok' (quiet — the normal case) | 'warn' (staff-entered) | 'bad' (nothing).
export function manifestSourceNote(src) {
  const who = src.by ? `by ${src.by}` : 'by our team';
  switch (src.kind) {
    case 'none':
      return {
        tone: 'bad',
        label: 'No manifest',
        text: 'Nothing has been declared for this order, so there is nothing to check the boxes against — you are receiving blind. If the supplier sends their list later, PH can enter it on the purchase order.',
      };
    case 'staff':
      return {
        tone: 'warn',
        label: 'Entered on the supplier’s behalf',
        text: `The supplier did not scan this order. This list was entered ${who} from what they sent us, so treat it as their claim rather than their scan — check it, and raise a mismatch as a question before a shortage.`,
      };
    case 'mixed':
      return {
        tone: 'warn',
        label: 'Part entered on the supplier’s behalf',
        text: `The supplier scanned ${src.supplierUnits} unit${src.supplierUnits === 1 ? '' : 's'}; the other ${src.staffUnits} ${src.staffUnits === 1 ? 'was' : 'were'} entered ${who} from what they sent us.`,
      };
    default:
      return {
        tone: 'ok',
        label: 'Scanned by the supplier',
        text: 'The supplier scanned this list themselves as they packed.',
      };
  }
}

// One short line for the printed sheet, where there is room for a phrase and not a
// paragraph. Returns '' for a supplier-scanned manifest: the sheet already says it is the
// supplier's, so the note is only worth ink when the answer is NOT the expected one.
// No staff name is printed — the paper outlives the question, and a supplier's own copy
// has the name stripped by the server anyway (api/po/get.js).
export function manifestSourceStamp(src) {
  switch (src.kind) {
    case 'none': return 'Nothing was declared for this order - received blind.';
    case 'staff': return 'Entered on the supplier’s behalf - not scanned by the supplier.';
    case 'mixed': return `Part entered on the supplier’s behalf - ${src.staffUnits} of ${src.units} units were not scanned by the supplier.`;
    default: return '';
  }
}
