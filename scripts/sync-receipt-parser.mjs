// Copy the Make receipt parser into the repo (api/_lib/receipt-parser/parser.make.js).
//   npm run receipts:sync-parser [path/to/parser.js]
// The Make folder is the source (the order-number lookup runs it there too); this copy is
// what the server runs for "Check mailboxes". Run after the parser changes, then commit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const src = process.argv[2] || path.join(os.homedir(), 'Make.com Stickballman12', 'receipt-parser', 'parser.js');
const dst = new URL('../api/_lib/receipt-parser/parser.make.js', import.meta.url);
if (!fs.existsSync(src)) { console.error(`Not found: ${src}`); process.exit(1); }
const a = fs.readFileSync(src, 'utf8');
const b = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
if (a === b) { console.log('Already in sync.'); process.exit(0); }
fs.writeFileSync(dst, a);
console.log(`Copied ${a.length} bytes from ${src}. Run the receipts tests, then commit.`);
