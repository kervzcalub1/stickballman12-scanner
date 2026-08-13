// LINK AN ALREADY-RECEIVED BATCH TO ITS PURCHASE ORDER.
//
// THE APP DOES THIS NOW: PH Purchase Orders → open the order → "Link a received
// shipment" (same writes, same guards, no terminal). Keep using this script for a bulk
// clean-up, or when there's no UI to hand.
//
// The case both exist for: the box turned up and the warehouse started scanning it
// in as a plain receiving batch, and only THEN did PH open the purchase order for it.
// Nothing in the app can join those two up afterwards — "Receive against a purchase
// order" is a step-1 choice, so once scanning has started the link is out of reach.
// The order then sits in the queue reading as still-outstanding and its reconciliation
// shows nothing arriving, while the stock is already on the shelf.
//
//   node scripts/link-batch-to-po.mjs --po PO-00012                        # inspect + find candidates
//   node scripts/link-batch-to-po.mjs --po PO-00012 --batch B-2026-0042    # DRY RUN of the link
//   node scripts/link-batch-to-po.mjs --po PO-00012 --batch B-2026-0042 --apply
//
// Extra flags:
//   --map 2=1Z999AA10123456784   give received box 2 the tracking # of that PO label
//                                (repeatable). Use when the warehouse scanned without
//                                entering per-box tracking, so the boxes can't self-match.
//   --ship-labels                mark the MATCHED labels shipped when the supplier never
//                                scanned them out. Needed for a per-label manifest: only
//                                shipped labels count as "expected", so leaving them
//                                pending makes a fully-delivered order read as
//                                "received blind" with every pair an overage.
//   --force                      proceed even though the batch's supplier and the PO's
//                                supplier don't match (that usually means the WRONG batch).
//
// Nothing is written without --apply. Every write is idempotent and narrowly guarded,
// so re-running after a half-finished run finishes the job rather than doubling it.
//
// Raw SQL goes through this script's OWN pool (the app's `sql` tag is module-private);
// everything with a business rule attached — the status move, the reconciliation, the
// auto-close — calls the app's own functions, so this repair can't drift from what
// receiving does.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// ---- env (same loader the other scripts use; no dotenv dependency) ----------
if (!process.env.DATABASE_URL) {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (add it to .env).');
  process.exit(1);
}
// api/_lib/db.js only turns TLS on for Neon or an explicit sslmode; a managed host
// reached over the public internet needs it too, so make it explicit before its pool
// is built — otherwise running this against prod from a laptop just hangs.
{
  const u = process.env.DATABASE_URL;
  if (/\.railway\.app|\.rlwy\.net|\.rds\.amazonaws\.com/.test(u) && !/sslmode=/.test(u)) {
    process.env.DATABASE_URL = u + (u.includes('?') ? '&' : '?') + 'sslmode=require';
  }
}

const {
  lookupPoByCodeOrTracking, getPoFull, markPoReceiving,
  getPoReconcileState, autoReconcileIfClean, addPoComment,
} = await import('../api/_lib/db.js');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /\bsslmode=require\b|\.neon\.tech|\.railway\.app|\.rlwy\.net/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false } : undefined,
});
const q = (text, params = []) => pool.query(text, params).then((r) => r.rows);

// ---- args ------------------------------------------------------------------
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1] ?? null; };
const all = (f) => args.reduce((acc, a, i) => (a === f && args[i + 1] ? [...acc, args[i + 1]] : acc), []);

const PO_REF = val('--po');
const BATCH_REF = val('--batch');
const APPLY = has('--apply');
const SHIP_LABELS = has('--ship-labels');
const FORCE = has('--force');
const MAPS = all('--map');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const norm = (t) => String(t || '').trim().toUpperCase().replace(/\s+/g, '');
const warnings = [];
const warn = (m) => { warnings.push(m); console.log(`  ⚠  ${m}`); };
async function die(m) { console.error(`\n✖ ${m}\n`); await pool.end().catch(() => {}); process.exit(1); }
async function done(code = 0) { await pool.end().catch(() => {}); process.exit(code); }

if (!PO_REF) {
  console.error('Usage: node scripts/link-batch-to-po.mjs --po <PO-code|tracking#> [--batch <batch code|id>] [--apply]');
  console.error('Run with --po alone to inspect the order and list candidate batches.');
  await done(1);
}

// ---- the purchase order ----------------------------------------------------
const found = await lookupPoByCodeOrTracking(PO_REF);
if (!found) await die(`No purchase order matches "${PO_REF}" (try its PO code or any of its tracking numbers).`);
const { po, boxes: labels, lines } = await getPoFull(Number(found.po.id));

console.log(`\n${bold(po.po_code)} · ${po.supplier_name || '—'} · status ${bold(po.status)}`);
console.log(`  manifest scope: ${po.manifest_scope === 'po' ? 'whole order' : 'per label'}` +
  `   labels: ${labels.length}   declared units: ${lines.reduce((n, l) => n + (l.qty_expected || 0), 0)}`);
if (po.received_batch_id) console.log(`  already carries received_batch_id ${po.received_batch_id}`);
console.log('\n  Labels on the order:');
for (const b of labels) {
  console.log(`    #${b.box_number}  ${(b.tracking_number || '(no tracking)').padEnd(26)} ${b.status}${b.kind === 'replacement' ? ' · replacement' : ''}`);
}

if (['reconciled', 'closed'].includes(po.status)) {
  await die(`${po.po_code} is already ${po.status} — it can't be received against again. ` +
            'Re-open it in the app first if this really needs to change.');
}

// ---- discovery mode: which batch is it? ------------------------------------
if (!BATCH_REF) {
  const trackings = labels.map((b) => norm(b.tracking_number)).filter(Boolean);
  const candidates = await q(`
    SELECT b.id, b.batch_code, b.supplier_name, b.status, b.created_at, b.po_id,
           (SELECT count(*) FROM items i      WHERE i.batch_id = b.id)::int AS units,
           (SELECT count(*) FROM batch_boxes x WHERE x.batch_id = b.id)::int AS boxes
    FROM batches b
    WHERE (b.kind IS NULL OR b.kind = 'receiving')
      AND b.created_at > now() - interval '90 days'
      AND (
        ($1 <> '' AND b.supplier_name ILIKE '%' || $1 || '%')
        OR upper(replace(coalesce(b.tracking_number, ''), ' ', '')) = ANY($2::text[])
        OR EXISTS (SELECT 1 FROM batch_boxes x WHERE x.batch_id = b.id
                     AND upper(replace(coalesce(x.tracking_number, ''), ' ', '')) = ANY($2::text[]))
      )
    ORDER BY b.created_at DESC
    LIMIT 15`, [po.supplier_name || '', trackings]);
  console.log(`\n  Candidate batches ${dim('(same supplier, or a tracking # matching a label, last 90 days)')}:`);
  if (!candidates.length) console.log('    (none — pass --batch explicitly)');
  for (const b of candidates) {
    const link = b.po_id
      ? (Number(b.po_id) === Number(po.id) ? ' · ALREADY LINKED to this PO' : ` · linked to PO id ${b.po_id}`)
      : '';
    console.log(`    ${bold(b.batch_code)}  ${String(b.units).padStart(3)} units · ${b.boxes} box(es) · ${b.status} · ` +
      `${new Date(b.created_at).toISOString().slice(0, 10)} · ${b.supplier_name || '—'}${link}`);
  }
  console.log(`\n  Next: node scripts/link-batch-to-po.mjs --po ${po.po_code} --batch <batch code>\n`);
  await done();
}

// ---- the batch -------------------------------------------------------------
const [batch] = await q(
  'SELECT * FROM batches WHERE batch_code = $1 OR id = $2 LIMIT 1',
  [BATCH_REF, Number(BATCH_REF) || -1],
);
if (!batch) await die(`No batch matches "${BATCH_REF}".`);

const recvBoxes = await q(`
  SELECT x.*, (SELECT count(*) FROM items i WHERE i.box_id = x.id)::int AS units
  FROM batch_boxes x WHERE x.batch_id = $1 ORDER BY x.box_number`, [batch.id]);
const [{ n: units }] = await q('SELECT count(*)::int AS n FROM items WHERE batch_id = $1', [batch.id]);

console.log(`\n${bold(batch.batch_code)} · ${batch.supplier_name || '—'} · status ${bold(batch.status)} · ${units} units`);
if (recvBoxes.length) {
  console.log('  Boxes the warehouse received:');
  for (const x of recvBoxes) {
    console.log(`    #${x.box_number}  ${(x.tracking_number || '(no tracking)').padEnd(26)} ${x.status} · ${x.units} units`);
  }
} else {
  console.log(`  ${dim('single-box batch (no per-box rows) — its tracking # lives on the batch')}`);
}

// ---- guards ----------------------------------------------------------------
console.log('\nChecks:');
if (batch.po_id && Number(batch.po_id) !== Number(po.id)) {
  await die(`${batch.batch_code} is already linked to a DIFFERENT purchase order (id ${batch.po_id}). ` +
            'Sort out which link is the right one before running this.');
}
const alreadyLinked = Number(batch.po_id) === Number(po.id);
if (alreadyLinked) console.log(`  ✓ already linked to ${po.po_code} — checking the rest`);
if (batch.status === 'open') {
  warn(`${batch.batch_code} is still OPEN (intake unfinished). The link is fine, but the order ` +
       "won't auto-close until the batch is finished in the app.");
}
if (!units) warn('this batch has NO units — linking it would tell the order that nothing arrived.');

// A batch from another supplier is nearly always the wrong batch, and a wrong link
// writes a false receipt against a real order — so this one stops the script.
const supA = norm(batch.supplier_name);
const supB = norm(po.supplier_name);
if (supA && supB && !supA.includes(supB) && !supB.includes(supA)) {
  warn(`supplier mismatch — the batch says "${batch.supplier_name}", the order says "${po.supplier_name}".`);
  if (!FORCE) await die('Refusing on a supplier mismatch. Re-run with --force if this really is the right batch.');
}

// ---- tracking: match received boxes to the order's labels ------------------
const labelByTracking = new Map(labels.filter((b) => b.tracking_number).map((b) => [norm(b.tracking_number), b]));
// A single-box batch keeps its tracking on the batch itself, not in a box row.
const carriers = recvBoxes.length
  ? recvBoxes.map((x) => ({ number: x.box_number, tracking: x.tracking_number }))
  : [{ number: 1, tracking: batch.tracking_number }];

const fills = new Map(); // received box number -> tracking # to write
for (const m of MAPS) {
  const [n, t] = String(m).split('=');
  const target = carriers.find((c) => String(c.number) === String(n).trim());
  if (!target) await die(`--map ${m}: this batch has no received box #${n}.`);
  if (!labelByTracking.has(norm(t))) {
    await die(`--map ${m}: "${t}" is not a tracking number on ${po.po_code}. Only this order's own ` +
              'labels can be attached — a typo here would invent a shipment that never existed.');
  }
  if (target.tracking && norm(target.tracking) !== norm(t)) {
    await die(`--map ${m}: box #${n} already carries "${target.tracking}". Refusing to overwrite a scanned tracking #.`);
  }
  fills.set(String(n).trim(), String(t).trim());
}

console.log('\nTracking:');
const matched = new Set();
for (const c of carriers) {
  const eff = fills.get(String(c.number)) || c.tracking;
  const label = eff ? labelByTracking.get(norm(eff)) : null;
  if (label) matched.add(Number(label.id));
  const via = fills.has(String(c.number)) ? ' (from --map)' : '';
  console.log(`  received #${c.number}: ${(eff || '(no tracking)').padEnd(26)} → ` +
    (label ? `label #${label.box_number} [${label.status}]${via}`
      : eff ? 'no label on this order matches' : 'nothing to match on'));
}
for (const b of labels) {
  if (b.kind === 'replacement' || matched.has(Number(b.id))) continue;
  console.log(`  label #${b.box_number} ${dim(b.tracking_number || '(no tracking)')} → no received box matches ` +
    dim('(still in transit, or received in another batch)'));
}
if (!matched.size) {
  warn('no received box matches any label on this order. The link still works — reconciliation is by ' +
       'SKU+size, not by label — but the per-box evidence trail stays empty. ' +
       'Attach them with --map <boxNumber>=<tracking>.');
}

// A per-label manifest only counts labels that SHIPPED. If the supplier never scanned
// them out (common when the box beats the paperwork), expected stays 0 and a fully
// delivered order reads "received blind" with every pair an overage.
const perBox = po.manifest_scope !== 'po';
const stuck = labels.filter((b) => matched.has(Number(b.id)) && ['pending', 'packed'].includes(b.status));
if (perBox && stuck.length && !SHIP_LABELS) {
  warn(`${stuck.length} matched label(s) are still ${[...new Set(stuck.map((b) => b.status))].join('/')} at the ` +
       'supplier, so their declared units do NOT count as expected yet. Add --ship-labels to record them as ' +
       'shipped — they physically did ship, we received them.');
}

// ---- what the order will read afterwards -----------------------------------
const SHIPPED = ['shipped', 'in_transit', 'delivered'];
const willShip = SHIP_LABELS ? stuck.map((b) => Number(b.id)) : [];
const expectedUnits = lines
  .filter((l) => {
    if (po.manifest_scope === 'po') return l.po_box_id == null;
    const lb = labels.find((b) => Number(b.id) === Number(l.po_box_id));
    if (!lb || lb.kind === 'replacement') return false;
    return SHIPPED.includes(lb.status) || willShip.includes(Number(lb.id));
  })
  .reduce((n, l) => n + (l.qty_expected || 0), 0);

console.log('\nAfter linking, the order would read:');
console.log(`  expected ${bold(String(expectedUnits))} units   received ${bold(String(units))} units` +
  (expectedUnits === 0 ? dim('   → "received blind": nothing declared counts yet')
    : units === expectedUnits ? dim('   → the totals match')
      : dim(`   → off by ${units - expectedUnits}`)));
console.log(dim('  (the line-by-line table is printed for real after --apply)'));

// ---- plan ------------------------------------------------------------------
const plan = [];
if (!alreadyLinked) plan.push(`batches.po_id → ${po.id} on ${batch.batch_code}`);
if (!po.received_batch_id) plan.push(`purchase_orders.received_batch_id → ${batch.id}`);
if (['draft', 'shipped'].includes(po.status)) plan.push(`${po.po_code} status ${po.status} → receiving`);
for (const [n, t] of fills) plan.push(`received box #${n} tracking → ${t}`);
for (const id of willShip) {
  const b = labels.find((x) => Number(x.id) === id);
  plan.push(`label #${b.box_number} status ${b.status} → shipped`);
}
plan.push('a system note on the order recording this repair');

console.log(`\n${bold('Plan')} (${plan.length} change${plan.length === 1 ? '' : 's'}):`);
for (const p of plan) console.log(`  • ${p}`);

if (!APPLY) {
  console.log(`\n${bold('DRY RUN')} — nothing was written. Re-run with --apply to make these changes.\n`);
  await done();
}

// ---- apply -----------------------------------------------------------------
// One client, one transaction for the raw writes; then the app's own markPoReceiving
// for the PO-side move. Both halves are idempotent, so a failure between them is fixed
// by re-running rather than by hand.
console.log('\nApplying…');
const client = await pool.connect();
const applied = [];
try {
  await client.query('BEGIN');
  if (!alreadyLinked) {
    const r = await client.query(
      'UPDATE batches SET po_id = $1 WHERE id = $2 AND (po_id IS NULL OR po_id = $1) RETURNING id',
      [po.id, batch.id],
    );
    // 0 rows = something linked this batch elsewhere between the read and the write.
    if (!r.rowCount) throw new Error('the batch was linked to another purchase order while this script was running');
    applied.push(`${batch.batch_code} linked to ${po.po_code}`);
  }
  for (const [n, t] of fills) {
    const r = recvBoxes.length
      ? await client.query(
        `UPDATE batch_boxes SET tracking_number = $1
         WHERE batch_id = $2 AND box_number = $3 AND coalesce(tracking_number, '') = '' RETURNING id`,
        [t, batch.id, Number(n)])
      : await client.query(
        `UPDATE batches SET tracking_number = $1 WHERE id = $2 AND coalesce(tracking_number, '') = '' RETURNING id`,
        [t, batch.id]);
    applied.push(r.rowCount ? `received box #${n} tracking set to ${t}`
      : `received box #${n} already had a tracking # — left alone`);
  }
  for (const id of willShip) {
    const b = labels.find((x) => Number(x.id) === id);
    const r = await client.query(
      `UPDATE po_boxes SET status = 'shipped', shipped_at = COALESCE(shipped_at, now())
       WHERE id = $1 AND status IN ('pending', 'packed') RETURNING id`, [id]);
    applied.push(r.rowCount ? `label #${b.box_number} marked shipped`
      : `label #${b.box_number} was no longer pending/packed — left alone`);
  }
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  client.release();
  await die(`nothing was written (rolled back) — ${e.message}`);
} finally {
  client.release();
}
for (const line of applied) console.log(`  ✓ ${line}`);

await markPoReceiving(Number(po.id), Number(batch.id));
console.log(`  ✓ ${po.po_code} moved to receiving (received_batch_id ${po.received_batch_id || batch.id})`);

// Leave the trail: someone will open this order later and wonder how an order raised
// after the fact has a fully-received batch against it.
await addPoComment({
  poId: Number(po.id), kind: 'system', audience: 'internal',
  body: `Linked to receiving batch ${batch.batch_code} (${units} units) by scripts/link-batch-to-po.mjs — ` +
        'this order was opened after the warehouse had already started scanning the shipment, ' +
        'so receiving could not be run against it.',
  author: { id: null, name: null, role: 'system' },
}).catch((e) => console.log(`  ⚠  could not add the system note: ${e.message}`));

// ---- where the order now stands -------------------------------------------
const st = await getPoReconcileState(Number(po.id));
if (st) {
  const s = st.summary;
  console.log(`\n${bold('Reconciliation')} — ${s.received_units}/${s.expected_units} units   ` +
    `match ${s.match} · short ${s.shortage} · over ${s.overage} · wrong size ${s.wrong_size} · not on PO ${s.wrong_sku}`);
  if (s.no_manifest) console.log('  ⚠  received blind — nothing the supplier declared counts as expected yet.');
  for (const r of st.rows) {
    const tag = (r.flag === 'match' ? 'ok' : r.flag).padEnd(10);
    console.log(`   ${tag} ${String(r.sku).padEnd(16)} ${String(r.size).padEnd(6)} exp ${String(r.expected).padStart(3)}  got ${String(r.received).padStart(3)}`);
  }
  if (!st.intakeDone) console.log('  ·  intake is not finished (a linked batch is still open)');
  if (st.awaitingBoxes) console.log('  ·  a label is still pending/packed at the supplier');
}

const closed = await autoReconcileIfClean(Number(po.id)).catch(() => null);
console.log(closed
  ? `\n✓ ${po.po_code} came out clean and closed itself (reconciled).`
  : `\n✓ Done. ${po.po_code} is in the reconcile queue for someone to review and close.`);
if (warnings.length) console.log(`\n${warnings.length} warning(s) above — worth reading before you tell the team it's fixed.`);
console.log('');
await done();
