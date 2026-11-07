// Every word the SHEIN page says for a status or a term, in ONE place (docs/context/shein-listings.md →
// "Words"). Display only: API fields, database values and the keys used in the URL never change, so a
// word can be changed here without a migration. Pure: the server imports it through sheinListings.js.
//
// `plain()` is for text the SERVER wrote (a job's phase, a summary, an API error), which still uses the
// old words and can be stored in old rows. It is not used on SHEIN's own quoted messages.

export const SECTION_WORDS = {
  today: 'Today',
  listings: 'Shoes on SHEIN',
  check: 'Fix problems',
  reprice: 'Prices',
  live: 'Automatic sync',
};

// One line under the section tabs: what this section is for. Check and Prices open with their own line.
export const SECTION_LEADS = {
  today: 'What needs you right now. Start at the top and work down.',
  listings: 'Every Shopify shoe and whether it is on SHEIN. Tap a shoe to see its sizes; tick shoes to add or fix them.',
  live: 'Keeps SHEIN and Shopify stock in step. Normally you only check that everything below says ON.',
};

export const CARD_WORDS = { title: 'SHEIN', sub: 'See what’s listed, fix problems, change prices' };

// One word (or two) per size or product, and what it means. The chip class lives in sheinListings.js.
export const STATUS_WORDS = {
  blocked: { label: 'Blocked', meaning: 'Can’t be sent until something is fixed. The row says what, and has the button.' },
  error: { label: 'Error', meaning: 'We tried, but SHEIN refused it, rejected it in its review, or didn’t answer. Shows SHEIN’s message.' },
  out_of_date: { label: 'Needs update', meaning: 'On SHEIN, but different from Shopify (the price, the wrong SKU, a size turned off, or our listing changed).' },
  not_on_shein: { label: 'Not on SHEIN', meaning: 'Ready to list. Nothing is wrong.' },
  shein_only: { label: 'Not in Shopify', meaning: 'A SHEIN size whose SKU Shopify doesn’t have. Automatic sync keeps it at 0.' },
  in_review: { label: 'In review', meaning: 'Sent. SHEIN is reviewing it.' },
  synced: { label: 'Synced', meaning: 'On SHEIN and approved. Size, SKU and price match Shopify.' },
  excluded: { label: 'Not listing', meaning: 'A Shopify draft, or someone chose “Don’t list on SHEIN”. Not in the counts.' },
  unknown: { label: 'Not checked yet', meaning: 'Hasn’t been checked yet.' },
};

export const JOB_WORDS = {
  done: 'Done', running: 'Running', queued: 'Queued', stopped: 'Stopped', failed: 'Failed',
  interrupted: 'Interrupted', awaiting_confirm: 'Waiting for you',
};
export const JOB_KIND_WORDS = {
  snapshot: 'Refresh from SHEIN', probe: 'Ask SHEIN which sizes it allows', recheck: 'Shopify change check',
  preview: 'Preview', run: 'Send to SHEIN',
};

export const TERMS = {
  preview: 'Preview',
  previewSafe: 'Preview (changes nothing)',
  refresh: 'Refresh from SHEIN',
  advanced: 'Advanced',
  more: 'More options',
  how: 'How this works',
  stopping: 'What’s stopping it',
  cantRead: 'Couldn’t read this',
};

// Old word → new word, longest first. Used on server text only, and listed in the glossary.
const PLAIN = [
  [/\bdry[- ]runs\b/gi, 'previews'], [/\bdry[- ]run(ning|ned)?\b/gi, 'preview'],
  [/\bre-?read(ing)? Shopify \+ SHEIN\b/gi, 'refresh from SHEIN'], [/\bre-?read(ing)?\b/gi, 'refresh'], [/\bsnapshots?\b/gi, 'refresh'],
  [/\bseller[- ]SKUs\b/gi, 'SKUs'], [/\bseller[- ]SKU\b/gi, 'SKU'],
  [/\b(?:the )?live (?:stock )?walk\b/gi, 'the full check'], [/\bwalk\b/gi, 'full check'],
  [/\blive (?:fix|sync)\b/gi, 'automatic sync'],
  [/\bcut-?over\b/gi, 'switching over'],
  [/\bblockers?\b/gi, 'what’s stopping it'],
  [/\bSPU\b/g, 'product'], [/\bSKC\b/g, 'colour'], [/\bgoodsId\b/g, 'pair'], [/\bpartialEdit\b/g, 'edit'],
  [/\bpublish quota\b/gi, 'monthly new-product limit'],
];
const keepCase = (from, to) => (/^[A-Z]/.test(from) && !/^[A-Z]{2,}/.test(from) ? to[0].toUpperCase() + to.slice(1) : to);

export function plain(text) {
  if (text == null || text === '') return text;
  let out = String(text);
  for (const [re, to] of PLAIN) out = out.replace(re, (m) => keepCase(m, to));
  return out;
}
