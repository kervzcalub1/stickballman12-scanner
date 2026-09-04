// What a 1ID sticker IS, in words, when no pair wears it.
//
// Two screens ask this question and they must not answer it differently: Inventory
// (scan a sticker, "is this one used yet?") and the Sold/Shipped scan-out, where it is
// the difference between a dead end and an instruction. It used to live only in
// Inventory, so the scan-out screen — the one a warehouse hand uses 200 times a day —
// just said "No item found" and stopped.
//
// **The `available` wording is the one that matters, and it used to be wrong.** It read
// "Still on the roll", which is an assumption, and production says it is false a few
// hundred times over: 344 stickers were peeled out of the middle of worked rolls and
// applied to boxes that were then never received. Someone standing in front of such a
// box, holding it, being told the sticker is "still on the roll" learns nothing and
// concludes the app is broken. What we can state as fact is narrower and more useful:
// nothing has ever been received against this number.

export const STICKER_STATES = {
  available: {
    tone: 'free',
    label: 'Never received',
    // Said in the order it needs to be acted on: what is true, then why you might be
    // holding it, then what to do.
    body: 'No pair has ever been received against this number. Either it is still on the roll, or this box was labelled and the shoe was never scanned in.',
    // One line, for a scan banner read at arm's length while holding a box.
    short: 'labelled but never received — send it to Receiving',
    action: 'Receive the shoe first, then scan it out.',
  },
  assigned: {
    tone: 'used',
    label: 'In use',
    body: 'This sticker is on a pair already.',
    short: 'already on another pair',
    action: null,
  },
  // Assigned with nothing to open: the pair was removed from inventory. vin_stock keeps
  // the record deliberately — the sticker was still physically used.
  assigned_gone: {
    tone: 'used',
    label: 'Spent',
    body: 'It was used on a pair that has since been removed from inventory. The number is spent either way — never put it on another shoe.',
    short: 'used on a pair that was removed',
    action: 'Relabel this box with a fresh sticker.',
  },
  void: {
    tone: 'void',
    label: 'Voided',
    body: 'Torn, lost or misprinted, and voided. A voided number is never reused — grab another sticker.',
    short: 'this sticker was voided',
    action: 'Relabel this box with a fresh sticker.',
  },
  unknown: {
    tone: 'unknown',
    label: 'Not one of ours',
    body: 'A valid 1ID shape, but not a number we printed. Nothing has been received against it — check the scan, or use a sticker from the roll.',
    short: 'not a sticker we printed',
    action: null,
  },
};

// `info` is a /api/vins/check response. `assigned` splits on whether the pair survives,
// because "on another shoe" and "on a shoe that was deleted" need different actions.
export function stickerState(info) {
  if (!info || !info.state) return null;
  if (info.state === 'assigned' && !info.item) return { key: 'assigned_gone', ...STICKER_STATES.assigned_gone };
  const s = STICKER_STATES[info.state];
  return s ? { key: info.state, ...s } : null;
}

// The one line a scan banner shows. Falls back to the plain server error so a failure
// this file has no opinion about still says something true.
export function stickerScanMessage(vin, info, fallback) {
  const s = stickerState(info);
  if (!s) return fallback || `No item found for ${vin}.`;
  return `${vin} — ${s.short}.`;
}
