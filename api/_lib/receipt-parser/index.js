// The receipt parser, run on OUR server (docs/context/receipts.md → "Check mailboxes").
//
// parser.make.js is a byte-for-byte copy of ~/Make.com Stickballman12/receipt-parser/parser.js —
// the same file the Make order-number lookup (scenario 6282792) runs in its "Run code" module.
// It is not an ES module: it is a function BODY that reads `input` and ends in a top-level
// `return`, which is how Make runs it. So it is loaded as text and wrapped here, exactly the
// way its own tests (test-sweep.js) run it.
//
// Why here and not in Make: Make bills its code step by running time, and the sweep ran it
// once per email in 11 folders — ~710 credits a run. Make now only fetches mail and POSTs it
// raw (api/receipts/ingest-raw.js); the parsing costs nothing.
//
// To update: `npm run receipts:sync-parser` copies the Make copy over this one.
import fs from 'node:fs';

let fn = null;
function load() {
  if (fn) return fn;
  const src = fs.readFileSync(new URL('./parser.make.js', import.meta.url), 'utf8');
  // eslint-disable-next-line no-new-func
  fn = new Function('input', `return (async () => {\n${src}\n})();`);
  return fn;
}

/**
 * One email in → `{ post, skip?, parsed? }`. `parsed` is the /api/receipts/ingest body
 * (message_key, store, store_location, order_number, totals, items, recipients, text …).
 * `post:false` = not a receipt (marketing, shipping notices).
 */
export async function parseReceiptEmail(email) {
  return load()({ mode: 'sweep', ...email });
}
