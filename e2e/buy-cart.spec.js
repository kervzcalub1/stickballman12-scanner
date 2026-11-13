// Buying requests — the CONTROLS, not the happy path.
//
// The happy path is worth little here: what this feature exists to guarantee is that
// company money can't move without somebody independent signing for it, and every test
// below is one of those guarantees. If one of these ever goes red, the process has a
// hole in it, not a cosmetic bug.
//
//   · a buyer can't approve their own request
//   · the cards must cover what was approved before anything is released
//   · a card code is never in a page payload, and reading one is recorded
//   · the person who approved cannot also audit
//   · a request can't be closed until all ten conditions are true in the data
//
// Accounts are created here rather than taken from the shared auth helper for two
// reasons: the buyer scoping keys on a REAL users row id (the helper's `e2e-sup` uid is
// not numeric, and the endpoints correctly fail closed on it), and the three duties are
// PRIVILEGES read from the database on every call — a signed token cannot carry them.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken, hashPassword } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';

loadEnv();

// Note what these say: the issuer is a PH team member who also releases cards, and the
// auditor is a warehouse hand who also audits. That is the whole point of the privilege
// model — the duties sit on top of a real job rather than replacing it.
const CAST = {
  // A supplier is only a BUYER once `request_buying` is ticked for them — most suppliers
  // just ship boxes. It is the one privilege a supplier can hold.
  buyer: { username: 'e2e_bc_buyer', name: 'E2E Buyer', role: 'supplier', privileges: ['request_buying'] },
  approver: { username: 'e2e_bc_appr', name: 'E2E Approver', role: 'warehouse', privileges: ['approve_buying'] },
  issuer: { username: 'e2e_bc_iss', name: 'E2E Issuer', role: 'ph_team', privileges: ['issue_gift_cards'] },
  auditor: { username: 'e2e_bc_aud', name: 'E2E Auditor', role: 'warehouse', privileges: ['audit_buying'] },
  // A staff account with NO privilege — proves the gates are real rather than just
  // "is this person staff", which is what a role check would have amounted to.
  bystander: { username: 'e2e_bc_none', name: 'E2E Bystander', role: 'ph_team', privileges: [] },
  // A second buyer, so "the buyer may set the costs" can be shown to mean THEIR OWN
  // request and not anybody's.
  buyer2: { username: 'e2e_bc_buyer2', name: 'E2E Other Buyer', role: 'supplier', privileges: ['request_buying'] },
  // A plain supplier — ships boxes, was never switched on for buying. Must see nothing.
  shipper: { username: 'e2e_bc_ship', name: 'E2E Shipper Only', role: 'supplier', privileges: [] },
};

let pool;
const people = {};

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  for (const [key, u] of Object.entries(CAST)) {
    const { rows } = await pool.query(
      `INSERT INTO users (name, username, pass_hash, role, status, privileges)
       VALUES ($1,$2,$3,$4,'approved',$5)
       ON CONFLICT (username) DO UPDATE
         SET role = EXCLUDED.role, status = 'approved', privileges = EXCLUDED.privileges
       RETURNING id`,
      [u.name, u.username, hashPassword('e2e-not-used'), u.role, u.privileges],
    );
    people[key] = { ...u, uid: Number(rows[0].id) };
  }
  // The buyer needs a cost stack of their own — it is what the verdicts are computed
  // against, and `cart/create` snapshots it onto the request.
  await pool.query(
    `INSERT INTO payout_presets (name, tip_amt, shipping_amt, tax_pct, gift_pct, supplier_user_id)
     VALUES ('E2E Buyer Stack', 5, 8.25, 8.25, 8, $1)
     ON CONFLICT (lower(btrim(name))) DO UPDATE SET supplier_user_id = EXCLUDED.supplier_user_id`,
    [people.buyer.uid],
  );
});

test.afterAll(async () => { await pool?.end(); });

// Sign in as one of the cast. Their uid is a real row id, which is what the buyer
// scoping and the approver-is-not-the-auditor check both key on.
//
// `privileges` goes into the stored user exactly as api/auth/login.js puts it there —
// the CLIENT reads that list to decide which buttons to draw. It is deliberately not in
// the signed token: the server re-reads the set from the database on every privileged
// call, so this list only ever affects what is rendered.
async function as(page, who) {
  const u = people[who];
  const token = signToken({ uid: u.uid, username: u.username, name: u.name, role: u.role });
  await page.addInitScript(([t, j]) => {
    sessionStorage.setItem('sb_session_token', t);
    sessionStorage.setItem('sb_user', j);
  }, [token, JSON.stringify({ username: u.username, name: u.name, role: u.role, privileges: u.privileges })]);
  return u;
}

// Drive the API with a signed token — the same requests the screens make. Used for the
// setup around each assertion so a test about approval isn't also a test about typing.
const tokenFor = (u) => signToken({ uid: u.uid, username: u.username, name: u.name, role: u.role });

async function call(request, who, path, body) {
  const res = await request.post(`/api/${path}`, {
    headers: { Authorization: `Bearer ${tokenFor(people[who])}` },
    data: body ?? {},
  });
  return { status: res.status(), body: await res.json() };
}

// The two read endpoints are GETs — posting to them answers 405, which would make a
// test pass for the wrong reason.
async function read_(request, who, path) {
  const res = await request.get(`/api/${path}`, {
    headers: { Authorization: `Bearer ${tokenFor(people[who])}` },
  });
  return { status: res.status(), body: await res.json() };
}

// A request cannot be SENT until every shoe on it carries a photo — the approver is
// deciding on something they cannot see, in a shop they are not standing in. Seeded
// straight into the table: these tests are about the controls, not about R2, and putting
// a sign+PUT+attach round trip in front of thirty tests that never look at the image
// would buy nothing. Keyed by SKU, so one row covers every size of a shoe.
async function shoePhotos(cartId, skus) {
  for (const sku of new Set((skus || []).map((x) => String(x || '').toUpperCase()).filter(Boolean))) {
    await pool.query(
      `INSERT INTO buy_cart_files (cart_id, kind, sku, r2_key, name, content_type, size_bytes, uploaded_by)
       VALUES ($1,'shoe',$2,$3,'shoe.jpg','image/jpeg',1024,'E2E')`,
      [cartId, sku, `buy-carts/e2e/${cartId}-${sku}-shoe.jpg`]);
  }
}

// `who` defaults to the main buyer; the second one exists so "a buyer reaches only
// their own" can be shown to mean something rather than being trivially true.
//
// LINES are added by STAFF unless a test says otherwise, and that is about speed, not
// about who really writes a request. A line added by a BUYER is now priced server-side
// against live Alias and StockX (`cart/line` — the buyer's own call is never trusted),
// which is one real upstream call per line; at thirty-odd tests that is minutes of
// suite time and an Alias outage away from red. Staff post the snapshot their screen
// derived, as they always have, so a line lands instantly and deterministically. The
// buyer-authored path has its own test below, and pays for one call there.
async function newRequest(request, { lines = [], submit = true, linesBy = 'approver' } = {}, who = 'buyer') {
  // The cart ROW is seeded, not POSTed. `cart/create` is rate limited to 30 a minute per
  // IP and route and this suite opens roughly that many requests, so going through the
  // endpoint here meant the whole file sat one new test away from 429 — which it then
  // did, three separate times, each time failing a test that had nothing to do with the
  // change that caused it. Nothing below is a test of OPENING a request; the two that
  // are call `cart/create` directly and are unaffected.
  //
  // `cost_stack` mirrors what `cart/create` snapshots off the buyer's payout preset
  // (`presetOut`, camelCase and numeric), because the verdicts and every "lands at"
  // figure are computed against it — a stack of silent zeros would read as a legitimate
  // no-discount supplier rather than as a broken fixture.
  const stack = {
    presetName: 'E2E Buyer Stack',
    storePct: 0, promoPct: 0, giftPct: 8, cashbackPct: 0, taxPct: 8.25,
    tipAmt: 5, shippingAmt: 8.25,
  };
  const buyer = people[who];
  const cartId = Number((await pool.query(
    `INSERT INTO buy_carts (gc_merchant, buyer_user_id, buyer_name, retailer, purpose, status, cost_stack)
     VALUES ('nike', $1,$2,'E2E Store','E2E: restocking for listings','draft',$3) RETURNING id`,
    [buyer.uid, buyer.name, JSON.stringify(stack)])).rows[0].id);
  for (const l of lines) await call(request, linesBy, 'cart/line', { cartId, line: l });
  await shoePhotos(cartId, lines.map((l) => l.sku));
  // The SEND is stamped, not posted, for the same reason the cart row is seeded: this
  // helper runs forty-odd times and `cart/submit` is capped at 30 a minute, so going
  // through the endpoint made unrelated tests 429 at the end of a run. The tests that
  // are actually ABOUT sending — a missing store, a shoe with no photo — call the
  // endpoint directly and are unaffected.
  // The stamp CLOSES THE LIST as well as marking it submitted — that is what a buyer's
  // "Close the request" does, and the gift-card desk records nothing against a list
  // still open. A test about the open list says `submit: false` and closes it itself.
  if (submit) {
    await pool.query(
      `UPDATE buy_carts SET status = 'submitted', submitted_at = now(), submitted_by = $2,
              list_closed_at = now(), list_closed_by = $2, updated_at = now()
        WHERE id = $1 AND status = 'draft'`,
      [cartId, people[who].name]);
  }
  return cartId;
}

// `qty` on the fixture is what the APPROVER decides to buy, not something the buyer
// sent — the buyer reports the shoe, the size and the shelf price, and how many is the
// decision being asked for (`cart/decide`). It rides here so a test that only cares
// about funding or auditing can say `qtyAll: LINE.qty` and get a $100 request.
const LINE = { sku: 'CW2288-111', size: '9', qty: 2, shelfPrice: 50, verdict: 'buy' };

test('a buyer cannot approve their own request', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  const r = await call(request, 'buyer', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  expect(r.status).toBe(403);
  expect(r.body.ok).toBe(false);
  // And nothing half-applied: every line is still awaiting a decision.
  const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(body.cart.lines.every((l) => l.status === 'pending')).toBe(true);
  expect(body.cart.approved_amount).toBe(0);
});

test('gift cards must cover shelf price + declared tax — tip and shipping not — before anything is released', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });          // 2 × $50 = $100 approved
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });

  // The owner's rule (2026-11-05): shelf price + declared tax. This buyer's stack also has
  // a $5 tip and $8.25 shipping — internal, for the audit, and NOT on the cards.
  const { body: g } = await read_(request, 'issuer', `cart/get?id=${cartId}`);
  expect(g.cart.approved_amount).toBe(100);
  expect(g.cart.funding_target).toBeCloseTo(108.25, 2);
  expect(g.cart.funding_tax_pct).toBe(8.25);

  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '1111222233334444', balance: 60 } });
  const short = await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
  expect(short.status).toBe(409);
  // The shortfall is NAMED — "not enough" without a number sends somebody to a
  // spreadsheet to work out what to add.
  expect(short.body.error).toContain('$48.25 short');
  expect(short.body.error).toContain('$108.25 to fund ($100.00 shelf + $8.25 tax)');

  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '5555666677778888', balance: 48.25 } });
  const ok = await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
  expect(ok.status).toBe(200);
  expect(ok.body.cart.status).toBe('funded');
});

test('a card the buyer spent can still be recorded after the receipt and the audit', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });          // $108.25 to fund
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '4000400040004000', balance: 108.25 } });
  expect((await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true })).status).toBe(200);

  // The till came to more than the card on file — a second card was spent that nobody
  // recorded. Stamped straight onto the row: this test is about the desk, not the reader.
  await pool.query(`UPDATE buy_carts SET status = 'receipted', receipt_total = 130.43 WHERE id = $1`, [cartId]);
  const first = (await read_(request, 'issuer', `cart/get?id=${cartId}`)).body.cart.giftCards[0];
  const audit1 = await call(request, 'auditor', 'cart/audit', { cartId, cards: [{ id: first.id, spent: 108.25, remaining: 0 }] });
  expect(audit1.status).toBe(200);
  expect(audit1.body.cart.status).toBe('audited');
  const gap = (checks) => checks.find((c) => c.key === 'spend_reconciled');
  expect(gap(audit1.body.checks).ok).toBe(false);

  // After the audit the desk can still record it — that was the dead end.
  const late = await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '4111411141114111', balance: 25 } });
  expect(late.status).toBe(200);

  // It lands with no spend, so the audit on file no longer covers every card…
  const { body: g } = await read_(request, 'auditor', `cart/get?id=${cartId}`);
  expect(g.cart.giftCards.find((c) => c.id === late.body.card.id).spent_amount).toBeNull();
  // …and recording it again with both cards closes the gap.
  const audit2 = await call(request, 'auditor', 'cart/audit', { cartId, cards: [
    { id: first.id, spent: 108.25, remaining: 0 },
    { id: late.body.card.id, spent: 22.18, remaining: 2.82 },
  ] });
  expect(audit2.status).toBe(200);
  expect(gap(audit2.body.checks).ok).toBe(true);

  // A finished request still takes nothing.
  await pool.query(`UPDATE buy_carts SET status = 'closed' WHERE id = $1`, [cartId]);
  const closed = await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '4222422242224222', balance: 5 } });
  expect(closed.status).toBe(409);
});

test('no card issues before an approval exists', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  const r = await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '9999000011112222', balance: 200 } });
  expect(r.status).toBe(409);
  expect(r.body.error).toMatch(/not been approved/i);
});

test('a card code never reaches the page, and reading one is recorded', async ({ page, request }) => {
  const CODE = '4242424242424242';
  const cartId = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: CODE, pin: '7788', balance: 150 } });
  await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });

  // The payload every screen renders from — masked to the last four, and no ciphertext
  // either (a `SELECT *` reaching the client would be its own kind of leak).
  const detail = await read_(request, 'issuer', `cart/get?id=${cartId}`);
  expect(JSON.stringify(detail.body)).not.toContain(CODE);
  expect(JSON.stringify(detail.body)).not.toContain('code_enc');
  expect(detail.body.cart.giftCards[0].code_last4).toBe('4242');

  // The issuer is a PH team member, so their route is the PH one — PH has its own app
  // and never touches the staff router. Asserting the path here is the point: a
  // privilege that its holder cannot navigate to is not a working permission.
  await as(page, 'issuer');
  await page.goto('/ph/gift-card-buying');
  await page.locator('.bc-row', { hasText: detail.body.cart.cart_code }).first().click();
  await expect(page.locator('.bc-gc-num').first()).toContainText('4242');
  expect(await page.content()).not.toContain(CODE);

  // Reading it is a deliberate act…
  await page.locator('.bc-gc').first().getByRole('button', { name: 'Show code' }).click();
  await expect(page.locator('.bc-gc-secret')).toContainText(CODE);
  // …and the trail says who did it.
  await expect(page.locator('.bc-events')).toContainText(/gc revealed/i);
});

test('a privilege is a real gate, not just "are you staff"', async ({ request }) => {
  // The bystander is a PH team account with no privileges — the same ROLE as the issuer.
  // Under the old model both would have passed every one of these, which is precisely
  // why the duties are not roles.
  const cartId = await newRequest(request, { lines: [LINE] });

  const approve = await call(request, 'bystander', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  expect(approve.status).toBe(403);
  expect(approve.body.error).toMatch(/approve buying requests/i);

  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });

  const issue = await call(request, 'bystander', 'cart/gift-card', { cartId, card: { code: '1212343456567878', balance: 200 } });
  expect(issue.status).toBe(403);
  expect(issue.body.error).toMatch(/issue gift cards/i);

  const audit = await call(request, 'bystander', 'cart/audit', { cartId, cards: [{ id: 1, spent: 1, remaining: 0 }] });
  expect(audit.status).toBe(403);

  // …but they can still READ it. Any staff account can see what is happening to company
  // money; what they may DO is the part that is gated.
  const read = await read_(request, 'bystander', `cart/get?id=${cartId}`);
  expect(read.status).toBe(200);
  expect(read.body.cart.cart_code).toBeTruthy();
});

test('unticking a privilege takes effect immediately, not at next sign-in', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  const ok = await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '9090808070706060', balance: 200 } });
  expect(ok.status).toBe(200);

  // Same account, same signed token, privilege revoked in the database underneath it.
  // A token-carried permission would keep working here for as long as the session lived.
  await pool.query(`UPDATE users SET privileges = '{}' WHERE id = $1`, [people.issuer.uid]);
  try {
    const after = await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '1010202030304040', balance: 50 } });
    expect(after.status).toBe(403);
  } finally {
    await pool.query(`UPDATE users SET privileges = $2 WHERE id = $1`, [people.issuer.uid, people.issuer.privileges]);
  }
});

test('the person who approved cannot also audit or close it', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  // The approver holds approve_buying and not audit_buying, so the privilege alone
  // stops them — both accounts here are warehouse, which is exactly why a role check
  // would have let this through.
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  const byApprover = await call(request, 'approver', 'cart/audit', { cartId, cards: [] });
  expect(byApprover.status).toBe(403);
  expect(byApprover.body.error).toMatch(/audit privilege/i);

  // The other half: an ADMIN can reach both, so the guard has to refuse on identity.
  // The env admin has no users row, which is exactly the case an id comparison missed.
  const cart2 = await newRequest(request, { lines: [LINE] });
  const adminToken = signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' });
  const approve = await request.post('/api/cart/decide', {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { cartId: cart2, all: true, action: 'approve', qtyAll: LINE.qty },
  });
  expect(approve.status()).toBe(200);
  const audit = await request.post('/api/cart/audit', {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { cartId: cart2, cards: [{ id: 1, spent: 1, remaining: 0 }] },
  });
  expect(audit.status()).toBe(403);
  expect((await audit.json()).error).toMatch(/you approved this request/i);
});

test('a request cannot be closed until every condition is true', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  const r = await call(request, 'auditor', 'cart/close', { cartId });
  expect(r.status).toBe(409);
  // The refusal NAMES what is outstanding. A gate that only says no is a gate people
  // learn to route around.
  expect(r.body.error).toMatch(/checks are still outstanding/);
  expect(r.body.error).toContain('receipt was received');
  expect(r.body.checks.filter((c) => c.ok).map((c) => c.key)).toContain('approved');

  // Each condition is tagged with WHICH audit answers it. The money half is answerable
  // the day the receipt lands; the goods half not until the boxes are in the building,
  // and holding one signature for both would keep every request open for the length of
  // a shipment. Asserting on the split rather than on a count, because the count moves
  // with the funding route — a card-funded request has no cards to reconcile.
  const scopes = new Set(r.body.checks.map((c) => c.scope));
  expect([...scopes].sort()).toEqual(['goods', 'money']);
  const keys = r.body.checks.map((c) => c.key);
  // The third leg. Reconciliation compares the MANIFEST against what arrived, and the
  // manifest is the buyer's own account of what they packed; this one compares the
  // RECEIPT against what arrived and takes nobody's word for anything.
  expect(keys).toContain('receipt_vs_received');
  // And a case that is still costing the company money holds the request open.
  expect(keys).toContain('exceptions');
});

test('anyone who can reach the request can attach the receipt — the buyer, PH, or a hand', async ({ request }) => {
  // The attach is a presigned R2 upload; with no bucket the server answers 503 by design
  // (receiving-v6.spec.js proves that), so there is nothing here to assert on CI.
  test.skip(!process.env.R2_ACCOUNT_ID, 'R2 is not configured in this env — file-sign answers 503');
  const cartId = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '3131414151516161', balance: 200 } });
  await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });

  // Attaching EVIDENCE is not the same act as stating what it says. Whoever has the
  // paper should be able to put it on the record — a request that waits because the one
  // person with the button is asleep in another timezone is the problem this exists to
  // solve. The buyer, the card desk and a staff member holding NO buying privilege at
  // all can each do it.
  for (const who of ['buyer', 'issuer', 'bystander']) {
    const r = await call(request, who, 'cart/file-sign', { cartId, kind: 'receipt', contentType: 'image/jpeg' });
    expect(r.status, `${who} should be able to attach a receipt`).toBe(200);
    expect(r.body.key).toMatch(/^buy-carts\/BC-\d+\/receipt-\d+\.jpg$/);
  }

  // A card image is still the issuing desk's alone: crossing them would let anyone add
  // "gift cards" nobody issued, which is a line in the ledger with no money behind it.
  const cardShot = await call(request, 'bystander', 'cart/file-sign', { cartId, kind: 'gift_card', contentType: 'image/jpeg' });
  expect(cardShot.status).toBe(403);

  // And a buyer still only ever reaches their OWN request.
  const other = await call(request, 'buyer2', 'cart/file-sign', { cartId, kind: 'receipt', contentType: 'image/jpeg' });
  expect(other.status).toBe(403);
});

test('filed is not read: the audit refuses a request with no receipt total, and says so on screen', async ({ page, request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '7171717171717171', balance: 108.25 } });
  await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
  // What finding an email leaves behind: the file, the status moved, no lines and no total.
  const fileId = Number((await pool.query(
    `INSERT INTO buy_cart_files (cart_id, kind, r2_key, name, content_type) VALUES ($1, 'receipt', 'e2e/none.txt', 'Email receipt T0K.txt', 'text/plain') RETURNING id`,
    [cartId])).rows[0].id);
  await pool.query(`UPDATE buy_carts SET status = 'receipted', receipt_at = now() WHERE id = $1`, [cartId]);

  const card = (await read_(request, 'issuer', `cart/get?id=${cartId}`)).body.cart.giftCards[0];
  const refused = await call(request, 'auditor', 'cart/audit', { cartId, cards: [{ id: card.id, spent: 0, remaining: 0 }] });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toMatch(/no total to audit/);

  // The filed email can be read again without typing the number — by those who may, only.
  expect((await call(request, 'buyer2', 'cart/receipt-email', { cartId, fileId })).status).toBe(403);
  expect((await call(request, 'buyer', 'cart/receipt-email', { cartId, fileId: 999999999 })).status).toBe(404);
  await pool.query(`UPDATE buy_cart_files SET content_type = 'image/jpeg' WHERE id = $1`, [fileId]);
  expect((await call(request, 'buyer', 'cart/receipt-email', { cartId, fileId })).status).toBe(409);
  await pool.query(`UPDATE buy_cart_files SET content_type = 'text/plain' WHERE id = $1`, [fileId]);

  await as(page, 'buyer');
  await page.goto(`/buying?request=${cartId}`);
  await expect(page.getByRole('button', { name: 'Read this email' })).toBeVisible();
  await expect(page.locator('body')).toContainText('its lines have not been saved');
  await as(page, 'auditor');
  await page.goto(`/buy-carts?request=${cartId}`);
  await expect(page.locator('.bc-audit')).toContainText('not read in yet');
  await expect(page.locator('.bc-audit')).not.toContainText('balanced');
  await expect(page.getByRole('button', { name: 'Record the audit' })).toBeDisabled();
});

test('a filed email is read back by our own parser: every pair, the printed totals, and a pair with no code stays', async () => {
  const { readingFromEmailText, splitFiledEmail } = await import('../api/cart/receipt-email.js');
  const filed = splitFiledEmail([
    'Transaction: T0K1', 'Subject: Your receipt from Nike Store, Nike Factory Store - Round Rock', 'From: Nikenoreply@nike.com',
    'Date: 2026-11-04T18:19:19.000Z', 'Folder: [Gmail]/All Mail', '', 'Order #', 'T0K1', 'Your Purchase', 'In-Store Items', '(2)',
    'KD19', '$109.99T', '00000000000000', 'Item Percent Discount 40%', '-$44.00', 'Final Price', '$65.99T',
    'W NIKE V5 RNR', '$69.97T', '00000000000001', 'Item Percent Discount 40%', '-$27.99', 'Final Price', '$41.98T',
    'Subtotal', '$107.97', 'Sales Tax', '$8.91', 'Total', '$116.88', 'Number of Item(s) Sold:', '2',
  ].join('\n'));
  expect(filed).toMatchObject({ transactionId: 'T0K1', from: 'Nikenoreply@nike.com', folder: '[Gmail]/All Mail' });
  const r = await readingFromEmailText(filed);
  expect(r.rows).toHaveLength(2);
  expect(r.rows.map((x) => x.totalPrice)).toEqual([65.99, 41.98]);
  expect(r).toMatchObject({ subtotal: 107.97, tax: 8.91, statedTotal: 116.88 });
});

test('a receipt found by its number in the mailbox lands in the same review table', async ({ request }) => {
  const { readingFromPayload } = await import('../api/cart/receipt-email.js');

  // The scenario's answer, in the shape the Make session documented (id 6282792). A
  // Nike line is keyed on the style id from its UPC lookup, an adidas line on its
  // article number; a Champs line has only the store's own code. `final_price` is the
  // line total after discounts, so the unit price is derived, not taken from list.
  const r = readingFromPayload({
    ok: true, transaction_id: '179364', store: 'nike', mailbox: 'gmail',
    email: { subject: 'Your Nike Purchase', from: 'nike@notifications.nike.com', date: 'Mon, 14 Sep 2026 18:02:11 -0400', date_iso: '2026-09-14T18:02:11-04:00', folder: 'Footlocker', text: 'Thanks for shopping…' },
    item_count: 3,
    items: [
      { name: 'Air Jordan 1 Low', sku: null, upc: '196604935555', style_id: 'FJ6245-106', size: '9.5', qty: 2, list_price: 115, discount: 30, final_price: 200, raw_code: 'x' },
      { name: 'Samba OG', sku: 'IH8223', upc: null, style_id: 'IH8223', size: '7.5', qty: 1, list_price: 100, discount: null, final_price: 100, raw_code: 'y' },
      { name: 'Unreadable', sku: null, upc: null, style_id: null, size: null, qty: 1, final_price: 50, raw_code: 'z' },
    ],
    totals: { subtotal: 350, tax: 18, shipping: null, total: 368, item_count_stated: 4 },
    warnings: ['upc_not_found:1 (http 200)'],
  });
  // A pair with no code stays as a row, with the reason on it: it is a pair on the receipt, and
  // cart/receipt refuses to save until someone types its code. Dropping it hid money.
  expect(r.rows.map((x) => x.sku)).toEqual(['FJ6245-106', 'IH8223', '']);
  expect(r.rows[2].note).toMatch(/no style code found/);
  expect(r.rows[0]).toMatchObject({ size: '9.5', qty: 2, totalPrice: 200, unitPrice: 100, source: 'email' });
  expect(r.email).toMatchObject({ subject: 'Your Nike Purchase', date: '2026-09-14T18:02:11-04:00', folder: 'Footlocker' });
  expect(r.statedTotal).toBe(368);
  expect(r.check.ok).toBe(false);                      // the sums agree; the row with no code is what is named
  expect(r.check.problems.join(' ')).toMatch(/style code/);
  expect(r.warnings).toEqual(['upc_not_found:1 (http 200)']);

  // Without printed totals there is nothing to check and nothing is claimed: no
  // subtotal, no stated total — never 0, which would read as "the shop charged nothing".
  const bare = readingFromPayload({ ok: true, items: [{ style_id: 'A', qty: 1, final_price: 10, raw_code: '' }] });
  expect(bare.subtotal).toBeNull(); expect(bare.statedTotal).toBeNull(); expect(bare.tax).toBeNull();
  expect(bare.email.text).toBeNull();

  // The suite runs with MAKE_RECEIPT_PARSER_URL blanked (playwright.config.js), so the
  // endpoint is UNCONFIGURED here: it must say so, and it must still gate before it
  // says so — a stranger's request and a bad number are refused ahead of the 503.
  const cartId = await newRequest(request, { lines: [LINE] });
  const stranger = await call(request, 'buyer2', 'cart/receipt-email', { cartId, transactionId: '179364' });
  expect(stranger.status).toBe(403);
  const own = await call(request, 'buyer', 'cart/receipt-email', { cartId, transactionId: '179364' });
  expect(own.status).toBe(503);
  expect(own.body.error).toMatch(/not configured/);

  // A value pasted with a newline is still the URL; a value that is not a URL at all is
  // a misconfiguration, said as one. Neither is "could not search".
  const { hookUrl, receiptEmailMisconfigured } = await import('../api/cart/receipt-email.js');
  const prev = process.env.MAKE_RECEIPT_PARSER_URL;
  try {
    process.env.MAKE_RECEIPT_PARSER_URL = ' https://hook.us2.make.com/abc\n';
    expect(hookUrl()).toBe('https://hook.us2.make.com/abc');
    expect(receiptEmailMisconfigured()).toBe(false);
    process.env.MAKE_RECEIPT_PARSER_URL = 'MAKE_RECEIPT_PARSER_URL=https://hook.us2.make.com/abc';
    expect(receiptEmailMisconfigured()).toBe(true);
    process.env.MAKE_RECEIPT_PARSER_URL = 'http://hook.us2.make.com/abc';
    expect(receiptEmailMisconfigured()).toBe(true);
  } finally { process.env.MAKE_RECEIPT_PARSER_URL = prev; }
});

test('a request links to its order on the screen that can open it, per role (pure)', async () => {
  const { poHref } = await import('../src/lib/poLink.js');
  // PH's order link used to go to /ph/purchase-orders — the CREATE form, which ignores
  // ?po= and opened a blank "New batch". PO status is the screen that reads it.
  expect(poHref({ role: 'ph_team' }, 39)).toBe('/ph/po-status?po=39');
  expect(poHref({ role: 'supplier' }, 39)).toBe('/orders?po=39');
  expect(poHref({ role: 'warehouse' }, 39)).toBe('/reconcile?po=39');
  expect(poHref({ role: 'admin' }, 39)).toBe('/reconcile?po=39');
  expect(poHref({ role: 'ph_team' }, null)).toBe('');
});

test('the receipt checks the reading against its own arithmetic', async () => {
  const { checkReceiptRead } = await import('../src/lib/receiptCheck.js');
  const real = [
    { sku: 'IM4613-400', size: '8', qty: 3, totalPrice: 120 },
    { sku: 'HJ5996-001', size: '12.5', qty: 5, totalPrice: 475 },
  ];

  // A clean read SAYS it was checked. Silence and success must not look the same — a
  // reviewer deciding how hard to check every row needs to know which one they have.
  const good = checkReceiptRead({ rows: real, subtotal: 595, itemsSold: 8, statedTotal: 634.19, tax: 39.19 });
  expect(good.ok).toBe(true);
  expect(good.checked.join(' ')).toMatch(/add up to the printed subtotal/);
  expect(good.checked.join(' ')).toMatch(/quantities add up/);

  // The failure this exists for. A vision model fails CLEANLY: a well-formed row with a
  // plausible style code and a plausible price, indistinguishable from a real one. The
  // till's own subtotal is what catches it.
  const invented = checkReceiptRead({
    rows: [...real, { sku: 'DD1391-100', size: '10', qty: 1, totalPrice: 90 }],
    subtotal: 595, itemsSold: 8,
  });
  expect(invented.ok).toBe(false);
  expect(invented.problems.join(' ')).toMatch(/\$685\.00 but the receipt's own subtotal says \$595\.00/);

  // A DROPPED line is caught by the same arithmetic, from the other direction.
  const missed = checkReceiptRead({ rows: [real[0]], subtotal: 595, itemsSold: 8 });
  expect(missed.ok).toBe(false);
  expect(missed.problems.join(' ')).toMatch(/cover 3 items but the receipt says 8/);

  // A misread QUANTITY leaves the money looking perfectly reasonable and silently
  // misstates every unit price on the line. Only the item count sees it.
  const badQty = checkReceiptRead({
    rows: [{ ...real[0], qty: 1 }, real[1]], subtotal: 595, itemsSold: 8,
  });
  expect(badQty.ok).toBe(false);
  expect(badQty.problems.join(' ')).toMatch(/cover 6 items but the receipt says 8/);

  // A receipt that prints no totals cannot be checked, and says so rather than passing.
  const unverifiable = checkReceiptRead({ rows: real });
  expect(unverifiable.ok).toBe(false);
  expect(unverifiable.problems.join(' ')).toMatch(/nothing to check the lines against/);
});

test('the receipt parser reads a discounting till: net price, not the ticket price', async () => {
  const { parseReceipt } = await import('../src/lib/receiptParse.js');
  // The Athlete's Foot shape, from a real receipt. Three things it got wrong at once:
  // the columnar quantity was dropped (3 pairs read as 1), the GROSS was taken as the
  // spend, and the unit price was therefore the ticket price of the whole line.
  const text = [
    'W NIKE AIR MAX 90, in UNIVERSITY',
    'BLUE/STAR BLUE-HYDROGEN BLUE',
    '    IM4613-400 8        3      405.00',
    '        Discount              -285.00',
    '        Net Price              120.00',
    'W NIKE AIR MAX 95 OG, in BLACK/PINK',
    '    HJ5996-001 12.5     5      950.00',
    '        Discount 50.00%       -475.00',
    '        Net Price              475.00',
    '                Subtotal:    1,395.00',
    '                TAX:            39.19',
    '                Total:       1,434.19',
  ].join('\n');
  const r = parseReceipt(text, { source: 'paste' });

  expect(r.rows).toHaveLength(2);
  // The quantity is a bare column with nothing labelling it. Read wrong, it divides the
  // total by the wrong number and misstates every unit price on the receipt.
  expect(r.rows[0]).toMatchObject({ sku: 'IM4613-400', size: '8', qty: 3, totalPrice: 120, unitPrice: 40 });
  expect(r.rows[1]).toMatchObject({ sku: 'HJ5996-001', size: '12.5', qty: 5, totalPrice: 475, unitPrice: 95 });
  // What the till actually charged, not what the tickets added up to. Taking the gross
  // would have stated $1,355 of spend against $595 really paid.
  expect(r.total).toBe(595);
  expect(r.statedTotal).toBe(1434.19);
});

test('a stray net price cannot reach back and rewrite an earlier item', async () => {
  const { parseReceipt } = await import('../src/lib/receiptParse.js');
  const r = parseReceipt([
    '    IM4613-400 8        3      405.00',
    'Cashier: 13',
    'Store #1178',
    'Thank you for shopping',
    '        Net Price               12.00',
  ].join('\n'), { source: 'paste' });
  // Out of reach and behind noise: the row keeps what it was printed with rather than
  // being rewritten by an unrelated number further down the paper.
  expect(r.rows[0].totalPrice).toBe(405);
});

test('a draft offers no approve controls, and says which kind of "not now" it is', async ({ page, request }) => {
  // Seeded, not created through the API: this is a test about what the screen DRAWS
  // and what the endpoint refuses, and the suite sits exactly on `cart/create`'s
  // 30-a-minute limit. That limit is a real control and there is deliberately no
  // environment switch to turn it off — one that could be turned off would be off
  // somewhere it mattered.
  const { rows: cr } = await pool.query(
    `INSERT INTO buy_carts (gc_merchant, buyer_user_id, buyer_name, retailer, purpose, status)
     VALUES ('nike', $1, $2, 'E2E Store', 'E2E: draft with nothing to approve', 'draft') RETURNING id`,
    [people.buyer.uid, people.buyer.name],
  );
  const cartId = Number(cr[0].id);
  await pool.query(
    `INSERT INTO buy_cart_lines (cart_id, sku, size, qty, shelf_price, verdict, status)
     VALUES ($1, $2, $3, $4, $5, 'buy', 'pending')`,
    [cartId, LINE.sku, LINE.size, LINE.qty, LINE.shelfPrice],
  );
  await as(page, 'approver');
  await page.goto('/buy-carts');
  await page.locator('.bc-row').filter({ hasText: 'nothing to approve' }).first().click();
  await page.locator('.bc-lines').waitFor();

  // The server has always refused a draft. The screen used to draw the checkboxes,
  // "Approve selected" and "Approve all" anyway, so the only possible outcome of a full
  // set of controls was a red line underneath them.
  await expect(page.locator('.bc-decide')).toHaveCount(0);
  await expect(page.locator('.bc-lines input[type="checkbox"]')).toHaveCount(0);
  await expect(page.locator('.bc-no-decide')).toContainText('hasn’t asked about anything yet');

  // Correcting a misread shelf ticket is a COST-side act and stays open on a draft —
  // which is the state where a typo is most likely still to be there.
  await expect(page.locator('.bc-line-actions').first()).toBeVisible();

  // And the endpoint still refuses, in the same words, for a stale tab.
  const r = await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  expect(r.status).toBe(409);
  expect(r.body.error).toMatch(/hasn’t asked about anything yet/);
});

test('the queue filters by buyer, and a buyer cannot use it to widen their own scope', async ({ request }) => {
  // Seeded with SQL rather than through `cart/create`. This is a test about READING a
  // filtered list, and the suite already sits exactly on the endpoint's own 30-a-minute
  // rate limit — one more creation here pushed an unrelated test at the end of the run
  // into a 429. The limit is a real control and the fix is not to spend it here.
  const { rows } = await pool.query(
    `INSERT INTO buy_carts (gc_merchant, buyer_user_id, buyer_name, retailer, purpose, status)
     VALUES ('nike', $1, $2, 'E2E Store', 'E2E: filter fixture', 'submitted') RETURNING id`,
    [people.buyer2.uid, people.buyer2.name],
  );
  const theirs = Number(rows[0].id);

  // Staff see every buyer who has ever raised a request — built from the whole table,
  // not from the capped page above it, so nobody whose requests have scrolled off is
  // missing from the dropdown that is supposed to find them.
  const all = await read_(request, 'approver', 'cart/list');
  const ids = all.body.buyers.map((b) => b.id);
  expect(ids).toContain(people.buyer.uid);
  expect(ids).toContain(people.buyer2.uid);
  // A display name is not an identity, so the username comes back to disambiguate.
  expect(all.body.buyers.every((b) => 'username' in b)).toBe(true);

  const filtered = await read_(request, 'approver', `cart/list?buyer=${people.buyer.uid}`);
  expect(filtered.body.carts.length).toBeGreaterThan(0);
  expect(filtered.body.carts.map((c) => Number(c.id))).not.toContain(theirs);
  expect(filtered.body.carts.every((c) => Number(c.buyer_user_id) === people.buyer.uid)).toBe(true);

  const mineToo = await read_(request, 'approver', `cart/list?buyer=${people.buyer2.uid}`);
  expect(mineToo.body.carts.map((c) => Number(c.id))).toContain(theirs);

  // A BUYER's own scoping comes off the token and the parameter is dropped on the
  // floor for them — otherwise `?buyer=` reads as a way to widen it, and one buyer's
  // spending history becomes a URL anybody can edit.
  const asOther = await read_(request, 'buyer2', `cart/list?buyer=${people.buyer.uid}`);
  expect(asOther.body.carts.every((c) => Number(c.buyer_user_id) === people.buyer2.uid)).toBe(true);
  expect(asOther.body.carts.every((c) => Number(c.buyer_user_id) !== people.buyer.uid)).toBe(true);
  // And they are told about nobody else.
  expect(asOther.body.buyers ?? null).toBeNull();
});

test('the list finds requests by SKU, spelt any way, and a buyer only ever searches their own', async ({ request }) => {
  // One style on two buyers' requests, plus a request of another shoe. Seeded with SQL, like
  // the filter test above, so it spends none of cart/create's rate limit.
  const style = `SR${Date.now() % 1e7}-101`;
  const seed = async (who, sku) => {
    const id = Number((await pool.query(
      `INSERT INTO buy_carts (gc_merchant, buyer_user_id, buyer_name, retailer, purpose, status)
       VALUES ('nike', $1, $2, 'E2E Store', 'E2E: sku search fixture', 'submitted') RETURNING id`,
      [people[who].uid, people[who].name])).rows[0].id);
    await pool.query(`INSERT INTO buy_cart_lines (cart_id, sku, size, qty, shelf_price) VALUES ($1, $2, '9', 1, 50)`, [id, sku]);
    return id;
  };
  const mine = await seed('buyer', style);
  const theirs = await seed('buyer2', style.toLowerCase());
  const other = await seed('buyer', `XO${Date.now() % 1e7}-001`);
  const ids = (r) => r.body.carts.map((c) => Number(c.id));

  // Staff find both, however the code is typed — case, dashes and spaces don't matter.
  for (const typed of [style, style.toLowerCase(), style.replace('-', ' '), style.replace('-', '')]) {
    const r = await read_(request, 'approver', `cart/list?sku=${encodeURIComponent(typed)}`);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(expect.arrayContaining([mine, theirs]));
    expect(ids(r)).not.toContain(other);
  }
  // Part of the code is a search too; two characters is not (it would match nearly everything).
  expect(ids(await read_(request, 'approver', `cart/list?sku=${style.slice(0, 7)}`))).toEqual(expect.arrayContaining([mine, theirs]));
  expect(ids(await read_(request, 'approver', `cart/list?sku=${style.slice(0, 2)}`))).toContain(other);

  // The buyer's scope is applied BEFORE the search: the other buyer's request never comes back.
  const asBuyer = await read_(request, 'buyer', `cart/list?sku=${style}`);
  expect(ids(asBuyer)).toContain(mine);
  expect(ids(asBuyer)).not.toContain(theirs);
  expect(ids(await read_(request, 'buyer2', `cart/list?sku=${style}&buyer=${people.buyer.uid}`))).toEqual([theirs]);
});

test('on screen: Back from inside a request lands on the list, with the SKU search still in it', async ({ page, request }) => {
  const style = `BK${Date.now() % 1e7}-202`;
  const cartId = await newRequest(request, { lines: [{ ...LINE, sku: style }] });
  const code = (await pool.query(`SELECT cart_code FROM buy_carts WHERE id = $1`, [cartId])).rows[0].cart_code;
  await as(page, 'approver');
  await page.goto('/buy-carts');
  await page.getByLabel('Search requests by SKU').fill(style.toLowerCase());
  await expect(page.locator('.bc-sku-found')).toContainText('1 request with');
  await expect(page).toHaveURL(new RegExp(`sku=${style.toLowerCase()}`));
  await page.locator('.bc-table-wrap tr.bc-row', { hasText: code }).click();
  await expect(page.locator('.bc-code')).toHaveText(code);
  await expect(page).toHaveURL(new RegExp(`request=${cartId}`));

  // The in-page button goes to the list, not home…
  await page.getByRole('button', { name: '← Buying requests' }).click();
  await expect(page.locator('.bc-table-wrap tr.bc-row', { hasText: code })).toBeVisible();
  await expect(page.getByLabel('Search requests by SKU')).toHaveValue(style.toLowerCase());
  await expect(page).not.toHaveURL(/request=/);

  // …and so does the browser's Back button.
  await page.locator('.bc-table-wrap tr.bc-row', { hasText: code }).click();
  await expect(page.locator('.bc-code')).toHaveText(code);
  await page.goBack();
  await expect(page.locator('.bc-table-wrap tr.bc-row', { hasText: code })).toBeVisible();
  await expect(page).toHaveURL(/\/buy-carts\?/);
  await expect(page.getByLabel('Search requests by SKU')).toHaveValue(style.toLowerCase());

  // Opened straight from a link, there is no list entry behind it — the button still lands on the list.
  await page.goto(`/buy-carts?request=${cartId}`);
  await page.getByRole('button', { name: '← Buying requests' }).click();
  await expect(page.locator('.bc-list')).toBeVisible();
  await expect(page).toHaveURL(/\/buy-carts$/);
});

test('on screen: a buyer searches their own requests, and Back from one goes to their list (supplier app)', async ({ page, request }) => {
  const style = `BY${Date.now() % 1e7}-303`;
  const cartId = await newRequest(request, { lines: [{ ...LINE, sku: style }] });
  const code = (await pool.query(`SELECT cart_code FROM buy_carts WHERE id = $1`, [cartId])).rows[0].cart_code;
  await as(page, 'buyer');
  await page.goto(`/buying?sku=${style}`);
  await page.locator('.bc-table-wrap tr.bc-row', { hasText: code }).click();
  await expect(page.locator('.bc-code')).toHaveText(code);
  await page.goBack();
  await expect(page.locator('.bc-list')).toBeVisible();
  await expect(page.getByLabel('Search requests by SKU')).toHaveValue(style);
  await expect(page).toHaveURL(/\/buying\?sku=/);
});

test('a company card request can actually be funded, and then take a receipt', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });

  // Recording the authorised charge IS the release of company funds. Without that a
  // card-funded request stayed at `approved` forever — and every step after it is gated
  // on `funded`, so the receipt could never be uploaded, read or reconciled. The whole
  // route was a dead end from the step after the one that created it.
  const set = await call(request, 'approver', 'cart/control', {
    cartId, funding: { method: 'company_card', cardReference: 'AX-4417', cardAuthorized: 63.02 },
  });
  expect(set.status).toBe(200);
  expect(set.body.cart.status).toBe('funded');
  expect(set.body.cart.funded_by).toBeTruthy();

  const receipt = await call(request, 'buyer', 'cart/receipt', {
    cartId, receiptTotal: 63.02,
    lines: [{ sku: LINE.sku, size: LINE.size, qty: 1, unitPrice: 63.02, totalPrice: 63.02, source: 'paste' }],
  });
  expect(receipt.status).toBe(200);

  // A reference with no amount is not an authorisation, so it must not fund anything.
  const cart2 = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId: cart2, all: true, action: 'approve', qtyAll: LINE.qty });
  const noAmount = await call(request, 'approver', 'cart/control', {
    cartId: cart2, funding: { method: 'company_card', cardReference: 'AX-9999' },
  });
  expect(noAmount.body.cart.status).toBe('approved');
});

test('a case needs an owner and a date, and a return closes on the refund not the parcel', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });

  // "Owner + next action + due date + evidence" is the rule, so it is enforced rather
  // than printed on a slide: an item with no owner and no date is a hope, not a task.
  const bare = await call(request, 'approver', 'cart/task', { cartId, task: { kind: 'return', title: 'Wrong colourway' } });
  expect(bare.status).toBe(400);
  expect(bare.body.error).toMatch(/owner and a due date/i);

  const opened = await call(request, 'approver', 'cart/task', {
    cartId,
    task: { kind: 'return', title: '2 x 10W wrong colourway', ownerName: 'Ops', dueDate: '2026-09-30', costAtRisk: 296 },
  });
  expect(opened.status).toBe(200);
  const taskId = opened.body.task.id;

  // Closing with no account of how it ended records that somebody ticked a box.
  const silent = await call(request, 'approver', 'cart/task', { cartId, taskId, close: { status: 'resolved' } });
  expect(silent.status).toBe(400);

  const done = await call(request, 'approver', 'cart/task', {
    cartId, taskId, close: { status: 'resolved', resolution: 'Credit posted 12 Sep', refundAmount: 296 },
  });
  expect(done.status).toBe(200);
  const task = done.body.cart.tasks.find((t) => Number(t.id) === Number(taskId));
  // Returned is not refunded: only a resolved return stamps the money as actually back.
  expect(task.status).toBe('resolved');
  expect(task.refund_verified_at).toBeTruthy();
});

test('the receipt becomes the order, and the buyer still packs it box by box', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  // A receipt belongs to a request that has been funded, so the cards go out first.
  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '1212343456567878', balance: 200 } });
  await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
  await call(request, 'approver', 'cart/receipt', {
    cartId, receiptTotal: 63.02,
    lines: [{ sku: LINE.sku, size: LINE.size, qty: 1, unitPrice: 63.02, totalPrice: 63.02, source: 'paste' }],
  });
  const raised = await call(request, 'approver', 'cart/raise-po', { cartId, boxes: 1 });
  expect(raised.status).toBe(200);

  // TWO LISTS, and they mean different things. The receipt is written onto the ORDER, so
  // from this moment the order can say what it is owed — before a single box is filled.
  // The boxes are still empty, because which carton a pair goes in is the buyer's to say.
  const poId = Number(raised.body.po.id);
  const scope = (await pool.query('SELECT manifest_scope FROM purchase_orders WHERE id = $1', [poId])).rows[0];
  expect(scope.manifest_scope).toBe('order+box');
  const orderLines = (await pool.query(
    'SELECT sku, size, qty_expected, unit_cost FROM po_lines WHERE po_id = $1 AND po_box_id IS NULL', [poId])).rows;
  expect(orderLines).toHaveLength(1);
  expect(orderLines[0].sku).toBe(LINE.sku);
  expect(Number(orderLines[0].qty_expected)).toBe(1);
  // The till price rides along, so a shortage has a value without anybody looking it up.
  expect(Number(orderLines[0].unit_cost)).toBeCloseTo(63.02);

  const after = await read_(request, 'approver', `cart/get?id=${cartId}`);
  const pack = after.body.cart.pack;
  expect(pack.poId).toBeTruthy();
  expect(pack.totalQty).toBe(1);
  expect(pack.unpacked).toBe(1);
  expect(pack.boxes.every((b) => b.units === 0)).toBe(true);

  // Nothing may be packed that the receipt does not have — otherwise the box manifest
  // becomes a second, independently-typed list that can disagree with what was paid for.
  const wrong = await call(request, 'approver', 'cart/pack', {
    cartId, poBoxId: pack.boxes[0].id, sku: 'ZZ0000-999', size: '10', qty: 1,
  });
  expect(wrong.status).toBe(409);
  expect(wrong.body.error).toMatch(/receipt has no/i);

  const packed = await call(request, 'approver', 'cart/pack', {
    cartId, poBoxId: pack.boxes[0].id, sku: LINE.sku, size: LINE.size, qty: 1,
  });
  expect(packed.status).toBe(200);
  expect(packed.body.cart.pack.unpacked).toBe(0);

  // And not one more than it has.
  const over = await call(request, 'approver', 'cart/pack', {
    cartId, poBoxId: pack.boxes[0].id, sku: LINE.sku, size: LINE.size, qty: 1,
  });
  expect(over.status).toBe(409);
  expect(over.body.error).toMatch(/already packed/i);

  // THE HANDOFF. "Every pair is in a box" used to be the end of the panel and a dead
  // end: asking for labels lived on the order's own screen and nothing led there. The
  // buyer asks from the request now — the same po/request-labels the supplier portal
  // makes — and the request carries the order's answer back so the panel can say so.
  const asked = await call(request, 'buyer', 'po/request-labels', { poId: pack.poId, requested: true });
  expect(asked.status).toBe(200);
  const withAsk = await read_(request, 'buyer', `cart/get?id=${cartId}`);
  expect(withAsk.body.cart.po.labels_requested_at).toBeTruthy();
  // And it shows up where PH look for it.
  const queue = await read_(request, 'issuer', 'po/get?id=' + pack.poId);
  expect(queue.body.po.labels_requested_at).toBeTruthy();
});

// A shop till often prints no style code at all. These lines used to be DROPPED at save
// time — survivable while the receipt was only a pick list, and not now: they become the
// order's own account of what it is owed, so one discarded quietly is a pair nothing ever
// expects, counts short, or chases.
test('a receipt line with no SKU is refused, not quietly dropped', async ({ request }) => {
  // Seeded straight at `funded`, which is all this test needs to reach the receipt — and
  // it spends none of `cart/create`'s 30-a-minute budget, which this suite sits on.
  const cartId = Number((await pool.query(
    `INSERT INTO buy_carts (gc_merchant, buyer_user_id, buyer_name, retailer, purpose, status, approved_amount, gc_total)
     VALUES ('nike', $1,$2,'E2E Store','E2E: a receipt with a nameless row','funded',100,200) RETURNING id`,
    [people.buyer.uid, people.buyer.name])).rows[0].id);
  const saved = await call(request, 'approver', 'cart/receipt', {
    cartId, receiptTotal: 126.04,
    lines: [
      { sku: LINE.sku, size: LINE.size, qty: 1, unitPrice: 63.02, totalPrice: 63.02, source: 'paste' },
      { sku: '', size: '', qty: 1, unitPrice: 63.02, totalPrice: 63.02, source: 'paste' },
    ],
  });
  expect(saved.status).toBe(400);
  expect(saved.body.error).toMatch(/no SKU/i);
  // Refused whole. A half-saved receipt would be the same bug with an audit trail.
  const after = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(after.body.cart.receiptLines).toHaveLength(0);

  // Fill the code in and the same receipt saves, with BOTH pairs on it.
  const fixed = await call(request, 'approver', 'cart/receipt', {
    cartId, receiptTotal: 126.04,
    lines: [
      { sku: LINE.sku, size: LINE.size, qty: 1, unitPrice: 63.02, totalPrice: 63.02, source: 'paste' },
      { sku: 'DD1391-100', size: '10', qty: 1, unitPrice: 63.02, totalPrice: 63.02, source: 'paste' },
    ],
  });
  expect(fixed.status).toBe(200);
  expect(fixed.body.cart.receiptLines).toHaveLength(2);

  await pool.query('DELETE FROM buy_cart_receipt_lines WHERE cart_id = $1', [cartId]);
  await pool.query('DELETE FROM buy_cart_events WHERE cart_id = $1', [cartId]);
  await pool.query('DELETE FROM buy_carts WHERE id = $1', [cartId]);
});

// A pair the desk will turn down is still recorded, not blocked: the buyer may know
// something the market doesn't, and the disagreement belongs in front of the approver
// rather than in a chat app. What CHANGED (2026-09-10) is that the buyer no longer sees
// the call while deciding — so this now checks both halves on one request: the buyer
// builds it and sends it with no verdict anywhere on their screen, and the desk opening
// the same request sees the calls in full.
test('the buyer builds a request, sees no call on it, and the desk sees both', async ({ page, request }) => {
  const cartId = await newRequest(request, {
    lines: [
      { ...LINE, verdict: 'buy', profit: 20, roi: 30, finalCost: 63.02, bestPlatform: 'alias' },
      { sku: 'DD1391-100', size: '10', qty: 1, shelfPrice: 130, verdict: 'pass', profit: -50, roi: -40, finalCost: 142.69, bestPlatform: 'alias' },
    ],
    submit: false,
  });
  await as(page, 'buyer');
  await page.goto('/buying');
  await page.locator('.bc-row').first().click();
  await expect(page.locator('.bc-lines tbody tr.bc-line')).toHaveCount(2);
  // Not one verdict chip anywhere on the buyer's screen, and no column claiming to
  // hold one. The payload has none either — that half is asserted below.
  await expect(page.locator('.bc-verdict')).toHaveCount(0);
  await expect(page.locator('.bc-lines thead')).not.toContainText('Buy call');
  // Nor what a pair lands at — that is the desk's cost stack one subtraction away.
  await expect(page.locator('.bc-lines thead')).not.toContainText('Lands at');
  // What IS theirs: the price they read off the ticket.
  await expect(page.locator('.bc-lines thead')).toContainText('Shelf');
  // No "send": every add already went to the desk. The buyer CLOSES the list.
  await expect(page.locator('.bc-head-chips')).toContainText('Buyer still adding');
  await page.getByRole('button', { name: 'Close the request' }).click();
  await expect(page.locator('.bc-head-chips')).toContainText('Waiting on approval');
  await expect(page.locator('.bc-head-chips')).toContainText('List closed');

  // The same two lines, opened by the desk.
  await as(page, 'approver');
  await page.goto('/buy-carts');
  await page.locator('.bc-table-wrap tr.bc-row').first().click();
  await expect(page.locator('.bc-verdict.buy')).toBeVisible();
  await expect(page.locator('.bc-verdict.pass')).toBeVisible();
  expect(cartId).toBeGreaterThan(0);
});

test('every row a reader produced has to be ticked by a person before the lines save', async ({ page }) => {
  const cartId = Number((await pool.query(
    `INSERT INTO buy_carts (gc_merchant, buyer_user_id, buyer_name, retailer, purpose, status, approved_amount, gc_total)
     VALUES ('nike', $1,$2,'E2E Store','E2E: ticking the receipt rows','funded',100,400) RETURNING id`,
    [people.buyer.uid, people.buyer.name])).rows[0].id);
  // The desk that funded it states what the receipt says (an approver's say is over
  // once the request is funded).
  await as(page, 'issuer');
  await page.goto('/ph/gift-card-buying');
  await page.locator('.bc-table-wrap tr.bc-row', { hasText: 'ticking the receipt rows' }).first().click();
  const card = page.locator('.bc-receipt');
  await expect(card).toBeVisible();

  // Two lines read from pasted text: both land PENDING, and Save waits.
  await card.locator('.bc-paste-box').fill('CT4838-004  8   1   195.00\nDD1391-100  10  1   195.00\nSubtotal 390.00\nTax 32.18\nTotal 422.18');
  await card.getByRole('button', { name: 'Read it' }).click();
  const rows = card.locator('.bc-review-table tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveClass(/bc-row-pending/);
  await expect(card).toContainText('2 of 2 still to check');
  const save = card.getByRole('button', { name: /Check 2 more rows to save/ });
  await expect(save).toBeDisabled();

  // Editing a field does not tick the row — the tick is a separate, deliberate act.
  await rows.nth(0).locator('input').nth(1).fill('8.5');
  await expect(rows.nth(0)).toHaveClass(/bc-row-pending/);

  await rows.nth(0).locator('.bc-row-tick').click();
  await expect(rows.nth(0)).toHaveClass(/bc-row-ok/);
  await expect(card.getByRole('button', { name: /Check 1 more row to save/ })).toBeDisabled();
  await rows.nth(1).locator('.bc-row-tick').click();
  await expect(card).not.toContainText('still to check');
  // A row somebody adds by hand is checked by construction.
  await card.getByRole('button', { name: 'Add a row' }).click();
  await expect(rows.nth(2)).toHaveClass(/bc-row-ok/);
  await rows.nth(2).locator('input').first().fill('CW2288-111');
  await rows.nth(2).locator('input').nth(1).fill('9');
  await rows.nth(2).locator('input').nth(4).fill('10');

  await card.getByRole('button', { name: 'Save these lines' }).click();
  await expect(card.getByRole('button', { name: 'Re-read the receipt' })).toBeVisible();
  const saved = await pool.query('SELECT sku, size, source FROM buy_cart_receipt_lines WHERE cart_id = $1 ORDER BY id', [cartId]);
  expect(saved.rows.map((r) => `${r.sku}:${r.size}:${r.source}`)).toEqual(['CT4838-004:8.5:paste', 'DD1391-100:10:paste', 'CW2288-111:9:manual']);

  await pool.query('DELETE FROM buy_cart_receipt_lines WHERE cart_id = $1', [cartId]);
  await pool.query('DELETE FROM buy_cart_events WHERE cart_id = $1', [cartId]);
  await pool.query('DELETE FROM buy_carts WHERE id = $1', [cartId]);
});

// Delete, as distinct from cancel (2026-09-16). Anyone who can reach a request may
// delete it — until money is on it. From then the buyer who asked for the money cannot
// erase the record; only an approver can. Both halves are the server's, not a button's.
test('a request can be deleted by whoever can reach it — until cards are issued, then only an approver', async ({ request }) => {
  // `list_closed_at` is stamped because the carded case issues a card, and the desk
  // records nothing against a list the buyer has not closed.
  const seed = async (purpose, status = 'submitted') => Number((await pool.query(
    `INSERT INTO buy_carts (gc_merchant, buyer_user_id, buyer_name, retailer, purpose, status, approved_amount, gc_total, list_closed_at)
     VALUES ('nike', $1,$2,'E2E Store',$3,$4,100,0,now()) RETURNING id`,
    [people.buyer.uid, people.buyer.name, purpose, status])).rows[0].id);

  // No money on it: the buyer deletes their own, and a tombstone is left.
  const mine = await seed('E2E delete: buyer, no cards');
  const notMine = await call(request, 'buyer2', 'cart/delete', { cartId: mine, reason: 'nope' });
  expect(notMine.status).toBe(403);
  const gone = await call(request, 'buyer', 'cart/delete', { cartId: mine, reason: 'Raised twice' });
  expect(gone.status).toBe(200);
  expect((await pool.query('SELECT 1 FROM buy_carts WHERE id = $1', [mine])).rowCount).toBe(0);
  const tomb = (await pool.query('SELECT cart_json, reason, deleted_by, card_count FROM deleted_buy_carts WHERE cart_id = $1', [mine])).rows[0];
  expect(tomb.reason).toBe('Raised twice');
  expect(tomb.deleted_by).toBe(people.buyer.name);
  expect(tomb.cart_json.purpose).toBe('E2E delete: buyer, no cards');
  expect(tomb.card_count).toBe(0);

  // Money on it: a card was issued. The buyer is refused and told who can; so is the
  // issuing desk (not an approver); the approver can.
  const carded = await seed('E2E delete: carded', 'approved');
  await call(request, 'issuer', 'cart/gift-card', { cartId: carded, card: { code: '9999888877776666', balance: 100 } });
  const buyerTry = await call(request, 'buyer', 'cart/delete', { cartId: carded, reason: 'x' });
  expect(buyerTry.status).toBe(403);
  expect(buyerTry.body.error).toMatch(/only an approver/i);
  const issuerTry = await call(request, 'issuer', 'cart/delete', { cartId: carded, reason: 'x' });
  expect(issuerTry.status).toBe(403);
  const approverGo = await call(request, 'approver', 'cart/delete', { cartId: carded, reason: 'Test card, never used' });
  expect(approverGo.status).toBe(200);
  expect((await pool.query('SELECT 1 FROM buy_cart_gift_cards WHERE cart_id = $1', [carded])).rowCount).toBe(0);
  const tomb2 = (await pool.query('SELECT cart_json, card_count FROM deleted_buy_carts WHERE cart_id = $1', [carded])).rows[0];
  expect(tomb2.card_count).toBe(1);
  // The archive keeps the card's last four and never its code.
  expect(tomb2.cart_json.giftCards[0].code_last4).toBe('6666');
  expect(JSON.stringify(tomb2.cart_json)).not.toMatch(/code_enc|9999888877776666/);

  // A request that raised an order is refused: the order has its own delete.
  const withPo = await seed('E2E delete: has PO', 'funded');
  const po = (await pool.query(`INSERT INTO purchase_orders (po_code, supplier_name, status) VALUES ($1, 'E2E', 'draft') RETURNING id`, [`PO-E2EDEL-${Date.now() % 100000}`])).rows[0];
  await pool.query('UPDATE buy_carts SET po_id = $1 WHERE id = $2', [po.id, withPo]);
  const poTry = await call(request, 'approver', 'cart/delete', { cartId: withPo, reason: 'x' });
  expect(poTry.status).toBe(409);
  expect(poTry.body.error).toMatch(/purchase order/i);

  await pool.query('DELETE FROM buy_carts WHERE id = $1', [withPo]);
  await pool.query('DELETE FROM purchase_orders WHERE id = $1', [po.id]);
  await pool.query('DELETE FROM deleted_buy_carts WHERE cart_id = ANY($1)', [[mine, carded]]);
});

test('a request needs a store before it can be closed, but no written purpose', async ({ request }) => {
  const { body } = await call(request, 'buyer', 'cart/create', { merchant: 'nike' });
  const cartId = Number(body.cart.id);
  await call(request, 'approver', 'cart/line', { cartId, line: LINE });
  const r = await call(request, 'buyer', 'cart/submit', { cartId });
  expect(r.status).toBe(400);
  // The store is still required — the cards have to be for the right retailer.
  expect(r.body.error).toMatch(/which store/i);

  // With the store answered it closes, with the purpose column never filled in. What is
  // being bought is not knowable before the trip; the lines are what say it.
  await pool.query('UPDATE buy_carts SET retailer = $2 WHERE id = $1', [cartId, 'E2E Store']);
  await shoePhotos(cartId, [LINE.sku]);
  const ok = await call(request, 'buyer', 'cart/submit', { cartId });
  expect(ok.status).toBe(200);
  const row = (await pool.query('SELECT purpose, list_closed_at FROM buy_carts WHERE id = $1', [cartId])).rows[0];
  expect(row.purpose).toBeNull();
  expect(row.list_closed_at).not.toBeNull();
});

test('the funding target carries the declared tax, the supplier sees it, and only the tax moves it', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  const { body } = await read_(request, 'issuer', `cart/get?id=${cartId}`);
  expect(body.cart.approved_amount).toBe(100);
  expect(body.cart.funding_target).toBeCloseTo(108.25, 2);
  // The supplier sees the tax and the exact total — and still nothing else off the stack.
  const mine = await read_(request, 'buyer', `cart/get?id=${cartId}`);
  expect(mine.body.cart.funding_target).toBeCloseTo(108.25, 2);
  expect(mine.body.cart.funding_tax_pct).toBe(8.25);
  expect(mine.body.cart.cost_stack).toBeNull();
  // A corrected tax moves it. Tip and shipping never do.
  await call(request, 'approver', 'cart/costs', { cartId, stack: { taxPct: 6, giftPct: 8, tipAmt: 5, shippingAmt: 8.25 } });
  expect((await read_(request, 'issuer', `cart/get?id=${cartId}`)).body.cart.funding_target).toBeCloseTo(106, 2);
  await call(request, 'approver', 'cart/costs', { cartId, stack: { taxPct: 6, giftPct: 8, tipAmt: 50, shippingAmt: 99 } });
  expect((await read_(request, 'issuer', `cart/get?id=${cartId}`)).body.cart.funding_target).toBeCloseTo(106, 2);

  // Once released, an auditor correcting the rate states what it cost; it asks for no money.
  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6161616161616161', balance: 106 } });
  expect((await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true })).status).toBe(200);
  await call(request, 'auditor', 'cart/costs', { cartId, stack: { taxPct: 9, giftPct: 8, tipAmt: 5, shippingAmt: 8.25 } });
  const released = (await read_(request, 'issuer', `cart/get?id=${cartId}`)).body.cart;
  expect(released.funding_target).toBeCloseTo(106, 2);
  expect(released.checks.find((c) => c.key === 'cards_recorded').ok).toBe(true);
});

// Opening a request asks two things the buyer knows before the trip: which merchant's
// gift cards (a fixed list) and which store. "What are you buying, and why?" was asked
// here and is gone — a buyer works that out standing in the shop, so before the trip it
// was answered with a guess or not at all, and the lines say it better.
test('a request is started in one modal that asks for the gift card merchant and the store', async ({ page }) => {
  await as(page, 'buyer');
  await page.goto('/buying');
  await page.getByRole('button', { name: 'New request' }).click();

  const modal = page.locator('.modal.form-modal');
  await expect(modal).toBeVisible();
  // One text box (the store) and one pick list (the merchant). No purpose textarea.
  await expect(modal.getByRole('textbox')).toHaveCount(1);
  await expect(modal).not.toContainText(/what are you buying/i);
  const merchant = modal.getByRole('combobox');
  await expect(merchant.locator('option')).toHaveText([
    'Pick a merchant…', 'Nike', 'Foot Locker / Champs Sports', 'Adidas', 'Finish Line / JD Sports', "Dick's Sporting Goods",
  ]);

  // Both are required, and blank is refused in the modal, not by the server after the fact.
  await modal.getByRole('button', { name: 'Start the request' }).click();
  await expect(modal.locator('.error')).toContainText(/gift cards for is needed/i);
  await merchant.selectOption('footlocker');
  await modal.getByRole('button', { name: 'Start the request' }).click();
  await expect(modal.locator('.error')).toContainText(/which store\? is needed/i);
  await expect(modal).toBeVisible();

  await modal.getByRole('textbox').first().fill('E2E Modal Store');
  await modal.getByRole('button', { name: 'Start the request' }).click();

  // It lands on the new request, opened and ready for lines, naming the merchant.
  await expect(page.locator('.bc-lines')).toBeVisible();
  await expect(page.locator('.app')).toContainText('E2E Modal Store');
  await expect(page.locator('.bc-merchant select')).toHaveValue('footlocker');
});

// The merchant is a key off a fixed list, checked by the server. An older request (opened
// before the list) has none: it can't close its list until one is picked, and the pick is
// locked once the desk records a card.
test('gift card merchant: required on create, picked on an older request, locked once cards are on it', async ({ request }) => {
  const none = await call(request, 'buyer', 'cart/create', { retailer: 'E2E Store' });
  expect(none.status).toBe(400);
  expect(none.body.error).toMatch(/which merchant/i);
  const typo = await call(request, 'buyer', 'cart/create', { merchant: 'Footlocker #22', retailer: 'E2E Store' });
  expect(typo.status).toBe(400);

  // An older request: no merchant on the row.
  const cartId = await newRequest(request, { lines: [LINE], submit: false });
  await pool.query('UPDATE buy_carts SET gc_merchant = NULL WHERE id = $1', [cartId]);
  const refused = await call(request, 'buyer', 'cart/submit', { cartId });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatch(/which merchant/i);

  // Somebody with no part in the cards can't set it; the buyer can.
  expect((await call(request, 'shipper', 'cart/merchant', { cartId, merchant: 'nike' })).status).toBe(403);
  expect((await call(request, 'buyer', 'cart/merchant', { cartId, merchant: 'not-a-store' })).status).toBe(400);
  const set = await call(request, 'buyer', 'cart/merchant', { cartId, merchant: 'finishline' });
  expect(set.status).toBe(200);
  expect(set.body.cart.gc_merchant).toBe('finishline');
  const ev = (await pool.query(`SELECT body FROM buy_cart_events WHERE cart_id = $1 AND kind = 'merchant_set'`, [cartId])).rows;
  expect(ev.map((e) => e.body)).toEqual(['Gift card merchant: Finish Line / JD Sports']);
  expect((await call(request, 'buyer', 'cart/submit', { cartId })).status).toBe(200);

  // Cards recorded → the merchant is locked, and a card with no retailer typed is filed under it.
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  expect((await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '7272727272727272', balance: 50 } })).status).toBe(200);
  const card = (await pool.query('SELECT retailer FROM buy_cart_gift_cards WHERE cart_id = $1', [cartId])).rows[0];
  expect(card.retailer).toBe('Finish Line / JD Sports');
  const locked = await call(request, 'buyer', 'cart/merchant', { cartId, merchant: 'nike' });
  expect(locked.status).toBe(409);
  expect((await pool.query('SELECT gc_merchant FROM buy_carts WHERE id = $1', [cartId])).rows[0].gc_merchant).toBe('finishline');
});

// ---------------------------------------------------------------------------
// The cost stack — what a pair on a request actually costs the company.
//
// A request's stack is snapshotted from the BUYER'S payout preset when it is opened, and
// buyers do not manage their own presets. So a buyer who has never been given one opens
// a request where every pair lands at exactly its sticker, no payout clears a threshold,
// and no buy call can be made at all. The desk being asked to release the money can
// state it — and everything below is about that not becoming a hole of its own.

// The buyer writes it FIRST — they are the only person in the room with the information.
// What keeps that safe is not withholding the box: it is that the desk can overwrite it
// and both versions are named in the trail.
// The stack turns a shelf price into a profit, which makes it the basis for approving or
// turning a request down — the same kind of number as the buy call, and it belongs on the
// same side of the table. The buyer states ONE figure: what the ticket says.
test('the cost stack is the desk’s, and the buyer can neither write it nor read it', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  const buyer = await call(request, 'buyer', 'cart/costs', {
    cartId, stack: { storePct: 40, promoPct: 0, giftPct: 0, cashbackPct: 0, taxPct: 0, tipAmt: 0, shippingAmt: 0 },
  });
  expect(buyer.status).toBe(403);

  const desk = await call(request, 'approver', 'cart/costs', {
    cartId, stack: { storePct: 10, promoPct: 0, giftPct: 0, cashbackPct: 0, taxPct: 0, tipAmt: 0, shippingAmt: 0 },
  });
  expect(desk.status).toBe(200);

  const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(body.cart.cost_stack.storePct).toBe(10);
  const trail = body.cart.events.filter((e) => e.kind === 'costs_edited');
  expect(trail).toHaveLength(1);
  expect(trail[0].actor_name).toBe('E2E Approver');

  // And the buyer's copy carries no stack at all — discounts, cashback and the tip are
  // how the company buys, and a supplier who can read them can price against them.
  const mine = (await read_(request, 'buyer', `cart/get?id=${cartId}`)).body.cart;
  expect(mine.cost_stack).toBeNull();
  // Nor what a pair lands at, which is that stack one subtraction away.
  expect(mine.lines[0].final_cost).toBeNull();
  // The shelf price IS theirs — it is the one figure they stated.
  expect(Number(mine.lines[0].shelf_price)).toBe(LINE.shelfPrice);
});

test('but only on their own request, and never for staff holding neither privilege', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  // A different buyer's request is not theirs to cost, or even to read.
  const other = await call(request, 'buyer2', 'cart/costs', { cartId, stack: { storePct: 90 } });
  expect(other.status).toBe(403);
  // And no staff account gets it for free either — it is a privilege, not a job title.
  const b = await call(request, 'bystander', 'cart/costs', { cartId, stack: { storePct: 90 } });
  expect(b.status).toBe(403);
  const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(body.cart.cost_stack.storePct).toBe(0);
});

test('either desk can state the costs, and every line re-prices against them', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [{ ...LINE, aliasPrice: 120 }] });
  const before = await read_(request, 'approver', `cart/get?id=${cartId}`);
  // Nothing has costed it yet — the buyer's screen is what computes a landed cost, and
  // the API took the line without one rather than inventing a zero for it.
  expect(before.body.cart.lines[0].final_cost).toBeNull();

  // 50% off a $50 sticker, and nothing else at all.
  const r = await call(request, 'auditor', 'cart/costs', {
    cartId,
    stack: { storePct: 50, promoPct: 0, giftPct: 0, cashbackPct: 0, taxPct: 0, tipAmt: 0, shippingAmt: 0 },
  });
  expect(r.status).toBe(200);
  expect(r.body.repriced).toBe(1);

  const after = await read_(request, 'approver', `cart/get?id=${cartId}`);
  const line = after.body.cart.lines[0];
  expect(line.final_cost).toBe(25);
  // The MARKET half of the snapshot is untouched — the call still answers at the price
  // the buyer was quoted, which is the whole reason a snapshot exists.
  expect(line.alias_price).toBe(120);
  expect(line.best_platform).toBe('alias');

  // The funding target does NOT move: it is the sticker × qty, and a discount we hope
  // for is not money the cards can be short by.
  expect(after.body.cart.approved_amount).toBe(before.body.cart.approved_amount);

  // And the trail says which rate moved, from what, by whom. A number that decides
  // whether company money goes out must not be able to change silently.
  const ev = after.body.cart.events.find((e) => e.kind === 'costs_edited');
  expect(ev).toBeTruthy();
  expect(ev.actor_name).toBe('E2E Auditor');
  expect(ev.body).toMatch(/Store discount 0% → 50%/);
  expect(ev.body).toMatch(/1 line re-priced/);
});

// A line with no market price on it is not a Pass. "We didn't look" and "we looked and
// it's bad" are different answers to somebody deciding whether to spend.
test('a line nobody priced comes back with no call, not a zero one', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [{ sku: 'DZ5485-612', size: '10', qty: 1, shelfPrice: 63 }] });
  const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
  const line = body.cart.lines[0];
  expect(line.profit).toBeNull();
  expect(line.roi).toBeNull();
  expect(line.verdict).toBeNull();
});

test('the desk can correct a shelf price after submission, until the cards are out', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });          // 2 × $50, submitted
  const lineId = Number((await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0].id);

  // The approver can, because a misread shelf ticket used to mean rebuilding the whole
  // request to fix one number, which in practice meant approving it wrong instead.
  const fix = await call(request, 'approver', 'cart/line', { cartId, lineId, patch: { shelfPrice: 45 } });
  expect(fix.status).toBe(200);
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });

  // The buyer may fix their own pair only while it is unanswered (2026-11-02) — once it's
  // been decided, it is part of an approval and only the desk can move it.
  const buyer = await call(request, 'buyer', 'cart/line', { cartId, lineId, patch: { shelfPrice: 20 } });
  expect(buyer.status).toBe(409);
  expect(buyer.body.error).toMatch(/already been approved/i);

  const mid = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(mid.body.cart.approved_amount).toBe(90);                        // 2 × $45, recomputed
  const ev = mid.body.cart.events.find((e) => e.kind === 'line_edited');
  expect(ev.body).toMatch(/shelf \$50\.00 → \$45\.00/);

  // Once the cards are out, the sticker is what the money was released against and it
  // freezes. The COST stack does not — an auditor still has to be able to state what a
  // transaction they are closing actually cost.
  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '4111111111119999', balance: 108.25 } });
  await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
  const late = await call(request, 'approver', 'cart/line', { cartId, lineId, patch: { shelfPrice: 10 } });
  expect(late.status).toBe(409);
  expect(late.body.error).toMatch(/already been issued/i);
  const costs = await call(request, 'auditor', 'cart/costs', { cartId, stack: { taxPct: 7 } });
  expect(costs.status).toBe(200);
});

// A rate is corrected one at a time far more often than seven at a time — somebody reads
// the receipt and the tax is 6%, not 8.25%. Opening a seven-box form to change one number
// is a form you then have to re-read before you can trust you only changed the one.
test('a cost chip is the field: tap it, type, Enter', async ({ page, request }) => {
  const purpose = `E2E: chip edit ${Date.now()}`;
  const { body } = await call(request, 'buyer', 'cart/create', { merchant: 'nike', retailer: 'E2E Store', purpose });
  const cartId = Number(body.cart.id);
  await call(request, 'approver', 'cart/line', { cartId, line: LINE });
  await shoePhotos(cartId, [LINE.sku]);
  await call(request, 'buyer', 'cart/submit', { cartId });

  await as(page, 'approver');
  await page.goto('/buy-carts');
  await page.locator('.bc-table-wrap tr.bc-row', { hasText: purpose }).first().click();

  const card = page.locator('section.bc-costs');
  await expect(card).toBeVisible();
  // The buyer's own preset: 8.25% tax, and $50 × 2 landing at $147.99 on this stack.
  const chip = card.getByRole('button', { name: /Sales tax/ });
  await expect(chip).toContainText('8.25%');

  await chip.click();
  const input = card.locator('.bc-cost-input');
  await expect(input).toBeFocused();
  await input.fill('6');
  await input.press('Enter');

  await expect(card.getByRole('button', { name: /Sales tax/ })).toContainText('6%');
  const after = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(after.body.cart.cost_stack.taxPct).toBe(6);
  // The other six are untouched — a chip states the whole stack, it does not clear it.
  expect(after.body.cart.cost_stack.giftPct).toBe(8);
  expect(after.body.cart.cost_stack.tipAmt).toBe(5);
  // Exactly ONE write. Enter disables the input while it saves, which BLURS it — and the
  // blur handler commits too. Without a guard that is two identical rows in the trail.
  expect(after.body.cart.events.filter((e) => e.kind === 'costs_edited')).toHaveLength(1);

  // Escape leaves the rate as it was and writes nothing.
  await card.getByRole('button', { name: /Store discount/ }).click();
  await card.locator('.bc-cost-input').fill('99');
  await card.locator('.bc-cost-input').press('Escape');
  await expect(card.getByRole('button', { name: /Store discount/ })).toContainText('0%');
  const esc = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(esc.body.cart.cost_stack.storePct).toBe(0);
  expect(esc.body.cart.events.filter((e) => e.kind === 'costs_edited')).toHaveLength(1);
});

// The buyer gets the same tappable chips on their own request — they are the one in the
// shop who can read the tax off the register.
test('the supplier portal shows no cost card at all', async ({ page, request }) => {
  const purpose = `E2E: chip buyer ${Date.now()}`;
  const { body } = await call(request, 'buyer', 'cart/create', { merchant: 'nike', retailer: 'E2E Store', purpose });
  const cartId = Number(body.cart.id);
  await call(request, 'approver', 'cart/line', { cartId, line: LINE });

  await as(page, 'buyer');
  await page.goto('/buying');
  await page.locator('.bc-table-wrap tr.bc-row', { hasText: purpose }).first().click();
  await expect(page.locator('section.bc-lines')).toBeVisible();
  // Not read-only chips — nothing. A card of empty boxes explaining an arithmetic they
  // cannot see is worse than no card.
  await expect(page.locator('section.bc-costs')).toHaveCount(0);
  // And no "Lands at" column beside their own shelf price.
  await expect(page.locator('.bc-lines thead')).not.toContainText('Lands at');
  await expect(page.locator('.bc-lines thead')).toContainText('Shelf');
});

// The chips are a control over company money, so for anybody who may NOT write them they
// are drawn as plain text rather than as buttons that answer 403.
test('staff with neither privilege see the costs and cannot tap them', async ({ page, request }) => {
  const purpose = `E2E: chip readonly ${Date.now()}`;
  const { body } = await call(request, 'buyer', 'cart/create', { merchant: 'nike', retailer: 'E2E Store', purpose });
  await call(request, 'approver', 'cart/line', { cartId: Number(body.cart.id), line: LINE });
  await shoePhotos(Number(body.cart.id), [LINE.sku]);
  await call(request, 'buyer', 'cart/submit', { cartId: Number(body.cart.id) });

  // The bystander is ph_team, and PH has its own app — a ph_team account never reaches
  // the staff router at all (docs/context/buy-cart.md, "where each holder finds it").
  await as(page, 'bystander');
  await page.goto('/ph/gift-card-buying');
  await page.locator('.bc-table-wrap tr.bc-row', { hasText: purpose }).first().click();
  const card = page.locator('section.bc-costs');
  await expect(card).toContainText('Sales tax');
  await expect(card.locator('.bc-cost-chip.editable')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Edit all seven/ })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Pricing a line that was never priced
//
// The snapshot rule assumes there IS a call. A pair added while Alias was timing out
// stored no market price, reads "Not priced" forever, and there was no way back short of
// deleting the line and re-adding it — while the same SKU prices fine an hour later.

test('a line with no market price says why, and can be priced', async ({ page, request }) => {
  const purpose = `E2E: price it ${Date.now()}`;
  const { body } = await call(request, 'buyer', 'cart/create', { merchant: 'nike', retailer: 'E2E Store', purpose });
  const cartId = Number(body.cart.id);
  // No verdict and no market prices — exactly what a timed-out quote leaves behind.
  await call(request, 'approver', 'cart/line', { cartId, line: { sku: 'CW2288-111', size: '9', qty: 1, shelfPrice: 50 } });

  // Read by the DESK: "Not priced" and the way back from it are the approver's, since
  // the call is no longer shown to a buyer at all (`canSeeBuyCall`).
  await as(page, 'approver');
  await page.goto('/buy-carts');
  await page.locator('.bc-table-wrap tr.bc-row', { hasText: purpose }).first().click();

  const lines = page.locator('section.bc-lines');
  await expect(lines.locator('tr.bc-line')).toContainText('Not priced');
  // Opening the row says WHY, in the words of what happened. "Not priced" on its own
  // sends people looking for a setting that does not exist.
  await lines.locator('tr.bc-line').first().click();
  const detail = lines.locator('tr.bc-line-detail');
  await expect(detail).toContainText(/no call could be made/i);
  await expect(detail).toContainText('Alias');
  await expect(detail.getByRole('button', { name: /Price it/ })).toBeVisible();
});

test('pricing a line is an explicit act, and it is named in the trail', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [{ ...LINE, aliasPrice: 0 }], submit: false });
  const lineId = Number((await read_(request, 'buyer', `cart/get?id=${cartId}`)).body.cart.lines[0].id);

  // Staff holding neither privilege cannot write the number an approval is judged on.
  const b = await call(request, 'bystander', 'cart/price-line', { cartId, lineId });
  expect(b.status).toBe(403);
  // Nor can a different buyer.
  const other = await call(request, 'buyer2', 'cart/price-line', { cartId, lineId });
  expect(other.status).toBe(403);

  // The line as it stands BEFORE, so the "found nothing" branch can assert that nothing
  // moved rather than assuming what was there. This one carries the buyer's own snapshot
  // (verdict 'buy'), and a lookup that finds no market must leave it exactly alone.
  const was = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];

  const r = await call(request, 'approver', 'cart/price-line', { cartId, lineId });
  expect(r.status).toBe(200);

  // BOTH branches are asserted, and which one runs depends on whether this environment
  // has upstream credentials — CI is hermetic and deliberately has none. A test that
  // only asserted the happy path would be a test of somebody else's API being up.
  const after = await read_(request, 'approver', `cart/get?id=${cartId}`);
  const now = after.body.cart.lines[0];
  const ev = after.body.cart.events.find((e) => e.kind === 'line_priced');
  if (r.body.priced) {
    expect(ev).toBeTruthy();
    expect(ev.actor_name).toBe('E2E Approver');
    // The prices it found and what the call was before it — an approver re-pricing has
    // chosen to look at today's market instead of the buyer's, and the record says so.
    expect(ev.body).toMatch(/Alias /);
    expect(ev.body).toMatch(/was (not priced|buy|watch|pass)/);
    expect(now.alias_price ?? now.stockx_price).toBeTruthy();
  } else {
    // Neither source answered. That is not an error and must not be written as one: it
    // says so in words, writes no event, and — the point — does not touch the snapshot.
    // Storing another pair of zeros here is exactly what left lines reading "Not priced"
    // forever, and blanking a call the buyer legitimately made would be worse still.
    expect(r.body.error).toMatch(/no alias or stockx price|style code/i);
    expect(ev).toBeUndefined();
    expect(now.verdict).toBe(was.verdict);
    expect(now.alias_price).toBe(was.alias_price);
    expect(now.stockx_price).toBe(was.stockx_price);
    expect(now.quoted_at).toBe(was.quoted_at);
  }
});

// An edit that changes nothing must not leave a row saying something changed.
test('a no-op line edit writes nothing to the trail', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
  const before = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.events.length;

  const r = await call(request, 'approver', 'cart/line', {
    cartId, lineId: Number(line.id),
    patch: { size: line.size, qty: line.qty, shelfPrice: line.shelf_price },
  });
  expect(r.status).toBe(200);
  expect(r.body.unchanged).toBe(true);
  const after = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(after.body.cart.events).toHaveLength(before);
});

// StockX's catalogue search falls back to its first result when nothing carries the
// style code. On the calculator that is shown to a person; here it would be STORED as
// the call an approval is judged on. Probed with a code no shop has ever sold and it
// came back a confident "$264, BUY" off an unrelated shoe.
test('a style code nothing carries is refused, not priced off the nearest shoe', async ({ request }) => {
  const cartId = await newRequest(request, { submit: false });
  const { body } = await call(request, 'approver', 'cart/line', {
    cartId, line: { sku: 'ZZ0000-999', size: '10', qty: 1, shelfPrice: 63 },
  });
  const lineId = Number(body.line.id);

  const r = await call(request, 'approver', 'cart/price-line', { cartId, lineId });
  expect(r.status).toBe(200);
  expect(r.body.priced).toBe(false);
  expect(r.body.error).toMatch(/no .*price|style code/i);

  // Nothing stored, and nothing in the trail. A refusal that still wrote a row would be
  // the same bug in a different place.
  const after = await read_(request, 'approver', `cart/get?id=${cartId}`);
  const line = after.body.cart.lines.find((l) => Number(l.id) === lineId);
  expect(line.verdict).toBeNull();
  expect(line.alias_price).toBeNull();
  expect(line.stockx_price).toBeNull();
  expect(after.body.cart.events.some((e) => e.kind === 'line_priced')).toBe(false);
});

// ---------------------------------------------------------------------------
// What we already hold  (api/cart/stock.js)
//
// The request answers what a pair costs and what it sells for, and says nothing about
// the six already on our own shelves. These pin the arithmetic that answer rests on,
// because every way of getting it wrong reads as a plausible number.
//
// The style below is one nothing has ever sold, so Shopify's own answer for it is a
// REAL zero from a live call — which means `we_hold` is our unlisted half alone, and
// any pair that leaked in from the other half shows up immediately.
const HELD_SKU = `E2EHOLD-${Date.now().toString(36).toUpperCase()}`;
let heldBatchId = null;
// ONE request for all three assertions. Its ROW is inserted rather than posted:
// `cart/create` is rate limited to 30 a minute per IP and route, and this suite already
// spends that budget, so even a single extra create down here answers 429 — which reads
// as a broken feature rather than a spent allowance. Nothing below is a test of creating
// a request; the lines and every read still go through the real endpoints.
let heldCartId = null;
let sizedLineId = null;
let unsizedLineId = null;

// ── What a pair from a request costs ─────────────────────────────────────────────
test.describe('what a pair from a request costs', () => {
  test('the sums: gift card off, tax on, tip on, shipping per label shared across the pairs', async () => {
    const { landedFromShelf, requestShipping } = await import('../src/lib/costs.js');
    expect(requestShipping({ perLabel: 8.25, labels: 3, pairs: 30 })).toEqual({ total: 24.75, each: 0.825 });
    expect(requestShipping({ perLabel: 8.25, labels: 0, pairs: 30 })).toBeNull();
    const base = { taxPct: 8.25, tipAmt: 5, shippingAmt: 0.825 };
    expect(landedFromShelf(100, null, { ...base, giftPct: 0 })).toBe(114.08);
    // 100 − 8% = 92, + 8.25% tax = 99.59, + 5 + 0.825 = 105.42
    expect(landedFromShelf(100, null, { ...base, giftPct: 8 })).toBe(105.42);
    // Each shoe its own shelf price and approved tip, whatever the receipt said.
    const preset = { ...base, giftPct: 0, requestLines: [
      { sku: 'AB1-100', size: '10', shelf: 120, tip: 7 }, { sku: 'CD2-200', size: '9', shelf: 80, tip: 0 },
    ] };
    expect(landedFromShelf(100, null, preset, { sku: 'AB1 100', size: '10W' })).toBe(142.73);
    expect(landedFromShelf(100, null, preset, { sku: 'CD2-200', size: '9' })).toBe(92.43);
    // Not on the request: the receipt's price, with the request's costs.
    expect(landedFromShelf(100, null, preset, { sku: 'ZZ9-999', size: '9' })).toBe(114.08);
  });

  async function raised(request, { boxes = 3, pairs = 30 } = {}) {
    const cartId = await newRequest(request, { lines: [{ ...LINE, shelfPrice: 100 }] });
    await pool.query(`UPDATE buy_carts SET cost_stack = $2 WHERE id = $1`,
      [cartId, JSON.stringify({ taxPct: 8.25, tipAmt: 5, giftPct: 8, shippingAmt: 8.25 })]);
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: 30 });
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6060100000000005656', balance: 9000 } });
    await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
    await call(request, 'buyer', 'cart/receipt', { cartId, receiptTotal: 3000, lines: [
      { sku: LINE.sku, size: LINE.size, qty: pairs, unitPrice: 90, totalPrice: 90 * pairs, source: 'paste' },
    ] });
    const po = await call(request, 'buyer', 'cart/raise-po', { cartId, boxes });
    expect(po.status).toBe(200);
    return { cartId, poId: po.body.po.id };
  }
  const shipmentCost = (request, who, poId) => request.get(`/api/payout/presets?for=shipment&po=${poId}`, { headers: { Authorization: `Bearer ${tokenFor(people[who])}` } });

  test('receiving gets the request’s costs: its stack, 3 labels shared by 30 pairs, the shoe’s own shelf', async ({ request }) => {
    const { landedFromShelf } = await import('../src/lib/costs.js');
    const { poId } = await raised(request);
    const out = await (await shipmentCost(request, 'approver', poId)).json();
    expect(out.via).toBe('request');
    expect(out.preset).toMatchObject({ perLabel: 8.25, labels: 3, pairs: 30, shippingAmt: 0.825, giftPct: 8, taxPct: 8.25 });
    // The approved $100 shelf, not the $90 on the receipt: 92 + 7.59 + 5 + 0.825 = 105.42
    expect(landedFromShelf(90, null, out.preset, { sku: LINE.sku, size: LINE.size })).toBe(105.42);
    // A supplier doesn't get to read it.
    expect((await shipmentCost(request, 'buyer', poId)).status()).toBe(403);
  });

  test('a replacement label costs the pairs nothing, and an order from no request keeps the preset', async ({ request }) => {
    const { poId } = await raised(request);
    await pool.query(`INSERT INTO po_boxes (po_id, box_number, kind, status) VALUES ($1, 99, 'replacement', 'pending')`, [poId]);
    expect((await (await shipmentCost(request, 'approver', poId)).json()).preset.labels).toBe(3);
    await pool.query(`UPDATE buy_carts SET po_id = NULL WHERE po_id = $1`, [poId]);
    expect((await (await shipmentCost(request, 'approver', poId)).json()).via).not.toBe('request');
  });

  test('a premium tip counts once approved, and removed shoes stop sharing the shipping', async ({ request }) => {
    const { cartId, poId } = await raised(request, { boxes: 1, pairs: 10 });
    await pool.query(`UPDATE buy_cart_lines SET tip_status = 'proposed', tip_proposed = 9 WHERE cart_id = $1`, [cartId]);
    expect((await (await shipmentCost(request, 'approver', poId)).json()).preset.requestLines[0].tip).toBe(0);
    await pool.query(`UPDATE buy_cart_lines SET tip_status = 'approved', tip_approved = 9 WHERE cart_id = $1`, [cartId]);
    expect((await (await shipmentCost(request, 'approver', poId)).json()).preset.requestLines[0].tip).toBe(9);
    await pool.query(`INSERT INTO buy_cart_receipt_lines (cart_id, sku, size, qty, unit_price, total_price, removed_at)
       VALUES ($1, 'THEIRS-1', '9', 10, 50, 500, now())`, [cartId]);
    expect((await (await shipmentCost(request, 'approver', poId)).json()).preset.pairs).toBe(10);
  });

  test('at approval the cost has no shipping in it yet', async () => {
    const { repriceLine } = await import('../api/_lib/buycart.js');
    const out = repriceLine({ shelf_price: 100 }, { taxPct: 8.25, tipAmt: 5, shippingAmt: 8.25 });
    expect(out.finalCost).toBe(113.25);
  });
});

// ── The buyer's own cards at the till ────────────────────────────────────────────
test.describe('cards and notes the auditor adds', () => {
  const rows = [
    { sku: LINE.sku, size: LINE.size, qty: 1, unitPrice: 100, totalPrice: 100, source: 'paste' },
    { sku: 'THEIRS-1', size: '10', qty: 1, unitPrice: 100, totalPrice: 100, source: 'paste' },
  ];
  async function receipted(request) {
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6060100000000008181', balance: 108.25 } });
    await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
    const saved = await call(request, 'buyer', 'cart/receipt', { cartId, receiptTotal: 216.5, subtotal: 200, tax: 16.5, lines: rows });
    expect(saved.status).toBe(200);
    return { cartId, company: saved.body.cart.giftCards[0], lines: saved.body.cart.receiptLines };
  }
  const extras = (request, who, cartId, data) => call(request, who, 'cart/audit-extras', { cartId, ...data });
  const personal = { code: '6060100000000008282', spent: 108.25, remark: "Andrew's personal gift card" };
  const spendCheck = (r) => r.body.checks.find((k) => k.key === 'spend_reconciled');

  test('a personal card reconciles the receipt without touching what we funded', async ({ request }) => {
    const { cartId, company } = await receipted(request);
    const before = (await read_(request, 'auditor', `cart/get?id=${cartId}`)).body.cart;
    expect(Number(before.balance_remaining)).toBe(-108.25);

    const added = await extras(request, 'auditor', cartId, { action: 'add_card', card: personal });
    expect(added.status).toBe(200);
    const c = added.body.cart;
    expect(Number(c.gc_total)).toBe(108.25);                     // still only ours
    expect(Number(c.balance_remaining)).toBe(0);
    const theirs = c.giftCards.find((g) => g.personal);
    expect(theirs).toMatchObject({ code_last4: '8282', remark: personal.remark });
    expect(Number(theirs.spent_amount)).toBe(108.25);
    expect(Number(theirs.remaining)).toBe(0);
    expect(JSON.stringify(c)).not.toContain('6060100000000008282');

    const audited = await call(request, 'auditor', 'cart/audit', { cartId, cards: [
      { id: company.id, spent: 108.25, remaining: 0 }, { id: theirs.id, spent: 108.25, remaining: 0 },
    ] });
    expect(audited.status).toBe(200);
    expect(spendCheck(audited).ok).toBe(true);
    expect((await pool.query(`SELECT body FROM buy_cart_events WHERE cart_id = $1 AND kind = 'gc_personal_added'`, [cartId])).rows[0].body)
      .toMatch(/Personal card •••• 8282 · \$108\.25 spent · Andrew's personal gift card/);
  });

  test('taking the buyer’s rows off as well does not count the money twice', async ({ request }) => {
    const { cartId, company, lines } = await receipted(request);
    await extras(request, 'auditor', cartId, { action: 'add_card', card: personal });
    const off = await call(request, 'auditor', 'cart/receipt-remove', { cartId, lineIds: [Number(lines[1].id)], reason: 'Buyer own purchase' });
    expect(off.body.cart.receipt_total).toBe(108.25);
    expect(Number(off.body.cart.balance_remaining)).toBe(0);
    const theirs = off.body.cart.giftCards.find((g) => g.personal);
    const audited = await call(request, 'auditor', 'cart/audit', { cartId, cards: [
      { id: company.id, spent: 108.25, remaining: 0 }, { id: theirs.id, spent: 108.25, remaining: 0 },
    ] });
    expect(spendCheck(audited).ok).toBe(true);
  });

  test('just taking the rows off, with no personal card, still balances against the lower total', async ({ request }) => {
    const { cartId, company, lines } = await receipted(request);
    await call(request, 'auditor', 'cart/receipt-remove', { cartId, lineIds: [Number(lines[1].id)], reason: 'Buyer own purchase' });
    const audited = await call(request, 'auditor', 'cart/audit', { cartId, cards: [{ id: company.id, spent: 108.25, remaining: 0 }] });
    expect(spendCheck(audited).ok).toBe(true);
  });

  test('a card that doesn’t make up the difference leaves the gap showing', async ({ request }) => {
    const { cartId, company } = await receipted(request);
    const added = await extras(request, 'auditor', cartId, { action: 'add_card', card: { ...personal, spent: 50 } });
    const theirs = added.body.cart.giftCards.find((g) => g.personal);
    const audited = await call(request, 'auditor', 'cart/audit', { cartId, cards: [
      { id: company.id, spent: 108.25, remaining: 0 }, { id: theirs.id, spent: 50, remaining: 0 },
    ] });
    expect(spendCheck(audited).ok).toBe(false);
    expect(spendCheck(audited).detail).toMatch(/\$58\.25 gap/);
  });

  test('who may, and what a remark must say', async ({ request }) => {
    const { cartId } = await receipted(request);
    for (const who of ['buyer', 'bystander', 'issuer']) {
      expect((await extras(request, who, cartId, { action: 'add_card', card: personal })).status, who).toBe(403);
      expect((await extras(request, who, cartId, { action: 'note', note: 'hello there' })).status, who).toBe(403);
    }
    // Whoever approved it can't audit it, here as on the audit itself.
    expect((await extras(request, 'approver', cartId, { action: 'note', note: 'hello there' })).status).toBe(403);
    expect((await extras(request, 'auditor', cartId, { action: 'add_card', card: { ...personal, remark: '' } })).status).toBe(400);
    expect((await extras(request, 'auditor', cartId, { action: 'add_card', card: { ...personal, spent: 0 } })).status).toBe(400);
    expect((await extras(request, 'auditor', cartId, { action: 'add_card', card: { ...personal, code: '12' } })).status).toBe(400);
    expect((await extras(request, 'auditor', cartId, { action: 'note', note: ' ' })).status).toBe(400);
    // Before the receipt there is nothing to reconcile.
    const early = await newRequest(request, { lines: [LINE] });
    expect((await extras(request, 'auditor', early, { action: 'add_card', card: personal })).status).toBe(409);
  });

  test('the supplier sees no personal card or note; it stays out of Show code and the PDF', async ({ request }) => {
    const { PDFDocument } = await import('pdf-lib');
    const { cartId } = await receipted(request);
    const added = await extras(request, 'auditor', cartId, { action: 'add_card', card: personal });
    const theirs = added.body.cart.giftCards.find((g) => g.personal);
    await extras(request, 'auditor', cartId, { action: 'note', note: 'Andrew confirmed these 10 pairs are his.' });

    const buyer = await read_(request, 'buyer', `cart/get?id=${cartId}`);
    const raw = JSON.stringify(buyer.body);
    expect(buyer.body.cart.giftCards).toHaveLength(1);
    for (const hidden of ['8282', 'personal gift card', 'Andrew confirmed']) expect(raw).not.toContain(hidden);

    const staff = await read_(request, 'auditor', `cart/get?id=${cartId}`);
    expect(staff.body.cart.events.find((e) => e.kind === 'audit_note').body).toContain('Andrew confirmed');

    expect((await call(request, 'issuer', 'cart/gc-reveal', { cartId, gcId: theirs.id })).status).toBe(404);
    const pdf = await request.get(`/api/cart/gift-cards-pdf?cartId=${cartId}`, { headers: { Authorization: `Bearer ${tokenFor(people.issuer)}` } });
    expect((await PDFDocument.load(await pdf.body())).getPageCount()).toBe(1);

    // Taken off by the auditor; the desk's cards can't be taken off this way.
    const company = staff.body.cart.giftCards.find((g) => !g.personal);
    expect((await extras(request, 'auditor', cartId, { action: 'remove_card', id: Number(company.id) })).status).toBe(404);
    const gone = await extras(request, 'auditor', cartId, { action: 'remove_card', id: Number(theirs.id), reason: 'Wrong card' });
    expect(gone.status).toBe(200);
    expect(gone.body.cart.giftCards.find((g) => g.id === theirs.id).voided_at).toBeTruthy();
    expect(Number(gone.body.cart.balance_remaining)).toBe(-108.25);
  });

  test('an unticked card is a company card the auditor found', async ({ request }) => {
    const { cartId } = await receipted(request);
    const r = await extras(request, 'auditor', cartId, { action: 'add_card', card: { ...personal, personal: false, remark: 'Found in the desk pile' } });
    expect(Number(r.body.cart.gc_total)).toBe(216.5);
  });

  test('on screen: the auditor adds the card and a note, and the audit balances', async ({ page, request }) => {
    const { cartId } = await receipted(request);
    await as(page, 'auditor');
    await page.goto(`/buy-carts?request=${cartId}`);
    const audit = page.locator('.bc-audit');
    await expect(audit).toContainText('$216.50');
    await audit.getByRole('button', { name: 'Add a card with a remark' }).click();
    await audit.getByLabel('Card number').fill('6060100000000008282');
    await audit.locator('.bc-audit-card-form .ph-price').fill('108.25');
    await audit.getByLabel('Remark').fill("Andrew's personal gift card");
    await audit.getByRole('button', { name: 'Add the card' }).click();
    const row = audit.locator('.bc-audit-list li', { hasText: '8282' });
    await expect(row).toContainText('Personal');
    await expect(row).toContainText("Andrew's personal gift card");
    await audit.locator('.bc-audit-list li', { hasNotText: '8282' }).locator('.ph-price').first().fill('108.25');
    await audit.locator('.bc-audit-list li', { hasNotText: '8282' }).locator('.ph-price').nth(1).fill('0');
    await expect(audit.locator('.bc-audit-foot')).toContainText('($108.25 on personal cards)');
    await expect(audit.locator('.bc-audit-foot')).toContainText('balanced');
    await expect(audit).toContainText('still on the receipt and the order');
    await audit.getByRole('button', { name: 'Record the audit' }).click();
    await expect(audit.locator('.bc-audit-saved')).toBeVisible();

    await audit.getByLabel('Audit note').fill('Andrew confirmed these 10 pairs are his.');
    await audit.getByRole('button', { name: 'Add note' }).click();
    await expect(audit.locator('.bc-audit-notes li')).toContainText('Andrew confirmed');
    await expect(audit.locator('.bc-audit-notes li')).toContainText('E2E Auditor');
    // Not one of the desk's cards.
    await expect(page.locator('#bc-sec-cards')).not.toContainText('8282');
  });
});

test.describe('what we already hold', () => {
  test.beforeAll(async ({ request }) => {
    const b = (await pool.query(
      `INSERT INTO batches (batch_code, status, kind, supplier_name)
       VALUES ($1,'committed','receiving','E2E Council') RETURNING id`,
      [`B-HOLD-${Date.now().toString(36)}`])).rows[0];
    heldBatchId = b.id;
    // Size 9, and every state that has ever been mistaken for another one:
    //   2 listed on Shopify      — the half Shopify itself is supposed to report
    //   3 not listed             — the half Shopify cannot see
    //   1 no-box                 — real stock, never listable, must not be dropped
    //   2 pre_sold               — on our floor and already somebody else's
    //   1 sold                   — gone
    // Plus one pair in size 10, which must NOT land in the size-9 figure.
    const rows = [
      ['L1', '9', 'needs_shelf', true], ['L2', '9', 'needs_shelf', true],
      ['U1', '9', 'needs_shelf', false], ['U2', '9', 'needs_shelf', false], ['U3', '9', 'in_stock', false],
      ['NB', '9', 'no_box', false],
      ['P1', '9', 'pre_sold', false], ['P2', '9', 'pre_sold', false],
      ['S1', '9', 'sold', true],
      ['O1', '10', 'needs_shelf', false],
    ];
    for (const [tag, size, status, listed] of rows) {
      await pool.query(
        `INSERT INTO items (vin, batch_id, name, sku, size, status, synced_shopify)
         VALUES ($1,$2,'E2E Held Shoe',$3,$4,$5,$6)`,
        [`SBM-HOLD-${HELD_SKU}-${tag}`, heldBatchId, HELD_SKU, size, status, listed]);
    }
    heldCartId = Number((await pool.query(
      `INSERT INTO buy_carts (gc_merchant, buyer_user_id, buyer_name, retailer, purpose, status, cost_stack)
       VALUES ('nike', $1,$2,'E2E Store','E2E: what do we already hold','draft',$3) RETURNING id`,
      [people.buyer.uid, people.buyer.name,
       JSON.stringify({ taxPct: 8.25, tipAmt: 5, giftPct: 8, shippingAmt: 8.25 })])).rows[0].id);
    sizedLineId = Number((await call(request, 'approver', 'cart/line', {
      cartId: heldCartId, line: { sku: HELD_SKU, size: '9', qty: 1, shelfPrice: 60 },
    })).body.line.id);
    // Written directly: a new line can't have no size, but one saved before that rule can.
    unsizedLineId = Number((await pool.query(
      `INSERT INTO buy_cart_lines (cart_id, sku, qty, shelf_price) VALUES ($1, $2, 1, 60) RETURNING id`,
      [heldCartId, HELD_SKU])).rows[0].id);
    await shoePhotos(heldCartId, [HELD_SKU]);
    await call(request, 'buyer', 'cart/submit', { cartId: heldCartId });
  });

  test.afterAll(async () => {
    await pool.query('DELETE FROM items WHERE sku = $1', [HELD_SKU]);
    if (heldBatchId) await pool.query('DELETE FROM batches WHERE id = $1', [heldBatchId]);
    if (heldCartId) {
      await pool.query('DELETE FROM buy_cart_events WHERE cart_id = $1', [heldCartId]);
      await pool.query('DELETE FROM buy_cart_lines WHERE cart_id = $1', [heldCartId]);
      await pool.query('DELETE FROM buy_carts WHERE id = $1', [heldCartId]);
    }
  });

  const lineOf = (body, id) => body.lines.find((l) => Number(l.lineId) === id);

  test('the count is Shopify plus what is not listed — and never the same pair twice', async ({ request }) => {
    const r = await call(request, 'approver', 'cart/stock', { cartId: heldCartId });
    expect(r.status).toBe(200);
    const line = lineOf(r.body, sizedLineId);
    expect(line.checked).toBe(true);

    // Our own half, first. These are the buckets the headline is built from, and each
    // of them is a thing somebody has counted wrongly before.
    expect(line.ours.listed_shopify).toBe(2);
    expect(line.ours.not_listed).toBe(4);      // 3 unlisted + the no-box pair
    expect(line.ours.no_box).toBe(1);
    expect(line.ours.on_hand).toBe(6);         // sold is gone, pre_sold is not ours to sell
    // Spoken for, and reported BESIDE the count rather than inside it: "we have 6" and
    // "we have 6, 2 of them pre-sold" lead to opposite decisions.
    expect(line.ours.pre_sold).toBe(2);
    // The other size stays in the other size.
    expect(line.other_sizes).toBe(1);
    expect(line.style_on_hand).toBe(7);

    // And the headline itself. Whichever source answered, the arithmetic is stated —
    // the failure this guards is adding OUR listed pairs on top of Shopify's count of
    // the very same shelf.
    if (line.basis === 'shopify_plus_unlisted') {
      expect(line.shopify.qty).not.toBeNull();
      expect(line.we_hold).toBe(line.shopify.qty + line.ours.not_listed);
    } else {
      // Shopify unavailable: our own records for both halves, and it must SAY so.
      expect(line.basis).toBe('our_records_only');
      expect(line.shopify.unavailable).toBeTruthy();
      expect(line.we_hold).toBe(line.ours.on_hand);
    }
    // A style nothing has ever sold: Shopify's zero for it is real, so the answer is
    // our unlisted half alone and cannot be less than it.
    expect(line.we_hold).toBeGreaterThanOrEqual(4);
  });

  test('a line with no size gets the style total, never a per-size figure it cannot have', async ({ request }) => {
    const r = await call(request, 'approver', 'cart/stock', { cartId: heldCartId });
    const line = lineOf(r.body, unsizedLineId);
    expect(line.basis).toBe('no_size');
    // Null, not zero. "We hold none of that size" is an answer; "there is no size on
    // this line" is a different one, and only one of them argues for buying.
    expect(line.we_hold).toBeNull();
    expect(line.style_on_hand).toBe(7);
  });

  test('a buyer cannot read the stock behind somebody else’s request', async ({ request }) => {
    const r = await call(request, 'buyer2', 'cart/stock', { cartId: heldCartId });
    expect(r.status).toBe(403);
    expect(r.body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The buy call is the approver's  (`canSeeBuyCall`)
//
// Two guarantees, and they are different ones:
//   · a buyer never SEES our call — not on a line, not in the trail, not by pricing;
//   · a buyer never WRITES it either. Their browser used to compute the verdict and
//     post it, which meant the party asking for the money supplied the figures that
//     justified releasing it.
// The first is visibility and the second is a control. Both are enforced on the server,
// so a screen is not what is being tested here.
let callCartId = null;
let staffLineId = null;
let buyerLineId = null;

test.describe('the buy call is the approver’s', () => {
  test.beforeAll(async ({ request }) => {
    // Seeded rather than posted — `cart/create` is capped at 30 a minute per IP and
    // route, and this suite already spends it (see the note on newRequest).
    callCartId = Number((await pool.query(
      `INSERT INTO buy_carts (gc_merchant, buyer_user_id, buyer_name, retailer, purpose, status, cost_stack)
       VALUES ('nike', $1,$2,'E2E Store','E2E: who may see the call','draft',$3) RETURNING id`,
      [people.buyer.uid, people.buyer.name,
       JSON.stringify({ taxPct: 8.25, tipAmt: 5, giftPct: 8, shippingAmt: 8.25 })])).rows[0].id);

    // Before any line: the buyer's add now REFUSES a shoe with no photo, because for
    // them adding is asking and the approver decides on the picture.
    await shoePhotos(callCartId, [LINE.sku, 'CW2288-111']);

    // Staff line: the snapshot their own screen derived, stored as posted.
    staffLineId = Number((await call(request, 'approver', 'cart/line', {
      cartId: callCartId,
      line: { ...LINE, aliasPrice: 210, stockxPrice: 205, profit: 77.5, roi: 40, bestPlatform: 'alias', liquidity: 'fast' },
    })).body.line.id);

    // Buyer line, posting a flattering call nobody computed. The server must throw all
    // of it away and read the market itself — the one live upstream call in this file's
    // buyer-authored path.
    buyerLineId = Number((await call(request, 'buyer', 'cart/line', {
      cartId: callCartId,
      line: {
        sku: 'CW2288-111', size: '9', qty: 1, shelfPrice: 50,
        verdict: 'buy', profit: 999.99, roi: 500, bestPlatform: 'alias', bestPayout: 1049.99,
        aliasPrice: 9999, stockxPrice: 9999, liquidity: 'fast',
      },
    })).body.line.id);

    await call(request, 'buyer', 'cart/submit', { cartId: callCartId });
    await call(request, 'approver', 'cart/price-line', { cartId: callCartId, lineId: staffLineId });
  });

  test.afterAll(async () => {
    if (!callCartId) return;
    await pool.query('DELETE FROM buy_cart_events WHERE cart_id = $1', [callCartId]);
    await pool.query('DELETE FROM buy_cart_lines WHERE cart_id = $1', [callCartId]);
    await pool.query('DELETE FROM buy_carts WHERE id = $1', [callCartId]);
  });

  test('a buyer’s copy of the request carries no call at all', async ({ request }) => {
    const mine = (await read_(request, 'buyer', `cart/get?id=${callCartId}`)).body.cart;
    for (const l of mine.lines) {
      for (const f of ['verdict', 'profit', 'roi', 'best_platform', 'best_payout',
        'alias_price', 'stockx_price', 'liquidity', 'final_cost']) {
        expect(l[f], `${f} leaked to the buyer on line ${l.id}`).toBeNull();
      }
      // `final_cost` goes with the stack it is derived from (2026-09-11): once the
      // stack moved to the desk, what a pair lands at was a figure computed entirely
      // from rates the buyer cannot see.
      expect(l.final_cost).toBeNull();
      // The shelf price stays — it is the one number they stated themselves.
      expect(Number(l.shelf_price)).toBeGreaterThan(0);
    }
    // And the same request, read by the desk, still has everything.
    const theirs = (await read_(request, 'approver', `cart/get?id=${callCartId}`)).body.cart;
    const staffLine = theirs.lines.find((l) => Number(l.id) === staffLineId);
    expect(staffLine.verdict).toBeTruthy();
    expect(Number(staffLine.alias_price)).toBeGreaterThan(0);
  });

  test('and the trail does not print it either', async ({ request }) => {
    const mine = (await read_(request, 'buyer', `cart/get?id=${callCartId}`)).body.cart;
    const bodies = mine.events.map((e) => String(e.body || ''));
    // `line_added` used to end "— buy"; `line_priced` used to spell out both market
    // prices and the profit. A trail is not a safe place to leave what a payload strips.
    expect(bodies.some((b) => /\b(buy|watch|pass)\s*$/i.test(b))).toBe(false);
    for (const e of mine.events) {
      if (e.kind === 'line_priced') {
        expect(e.body).toBe('Priced. The figures are on the approver’s copy of this request.');
      }
    }
    // The record still EXISTS for them — a control that vanishes for one reader is
    // worse than one that is brief. Only when a market answered: with no Alias key (CI)
    // price-line comes back `priced:false` and writes no event at all, by design.
    if (!process.env.ALIAS_API_KEY) return;
    expect(mine.events.some((e) => e.kind === 'line_priced')).toBe(true);
    // The desk's copy keeps the numbers.
    const theirs = (await read_(request, 'approver', `cart/get?id=${callCartId}`)).body.cart;
    expect(theirs.events.find((e) => e.kind === 'line_priced').body).toMatch(/Alias \$/);
  });

  test('a buyer cannot price a line', async ({ request }) => {
    const r = await call(request, 'buyer', 'cart/price-line', { cartId: callCartId, lineId: buyerLineId });
    expect(r.status).toBe(403);
    expect(r.body.ok).toBe(false);
  });

  test('a call a buyer posts is thrown away, and the market read here instead', async ({ request }) => {
    const theirs = (await read_(request, 'approver', `cart/get?id=${callCartId}`)).body.cart;
    const line = theirs.lines.find((l) => Number(l.id) === buyerLineId);

    // None of what they sent survived. Asserted on the NUMBERS rather than on the
    // verdict: our own market read could legitimately land on "buy" too, and a test
    // that went red for the right answer would get deleted.
    expect(Number(line.profit)).not.toBeCloseTo(999.99);
    expect(Number(line.roi)).not.toBeCloseTo(500);
    expect(line.alias_price == null || Number(line.alias_price) !== 9999).toBe(true);
    expect(line.stockx_price == null || Number(line.stockx_price) !== 9999).toBe(true);
    expect(line.best_payout == null || Number(line.best_payout) !== 1049.99).toBe(true);

    // Priced or not, the pair still lands at something — derived from the shelf price
    // and the cart's cost stack, so a market outage costs the call and not the column.
    expect(Number(line.final_cost)).toBeGreaterThan(50);

    // A verdict, if there is one, was computed from prices we read: it cannot exist
    // without one of them on the row.
    if (line.verdict) {
      expect(Number(line.alias_price) > 0 || Number(line.stockx_price) > 0).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The floor's actual workflow (2026-09-11)
//
// The buyer HUNTS a shop and reports what they found — size, price, a photo of the shoe.
// They do not say how many: that is the decision being asked for, and it belongs to
// whoever approves. And one approver sometimes reverses another's call, which the system
// must permit and must never let the last write hide.
test.describe('the buyer reports, the approver decides how many', () => {
  test('the buyer states no quantity, and approving without one is refused by name', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [{ sku: 'IO8116-600', size: '10', shelfPrice: 63 }] });
    const before = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    // NULL, not 1 and not 0. A number nobody stated is what the funding total would
    // otherwise have quietly valued the line at.
    expect(before.lines[0].qty).toBeNull();

    const bare = await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve' });
    expect(bare.status).toBe(400);
    // Named, so a twelve-line request does not send somebody hunting for the blank one.
    expect(bare.body.error).toMatch(/IO8116-600 size 10/);

    const ok = await call(request, 'approver', 'cart/decide', {
      cartId, lineIds: [Number(before.lines[0].id)], action: 'approve', qty: { [before.lines[0].id]: 4 },
    });
    expect(ok.status).toBe(200);
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].qty).toBe(4);
    // And the money follows the approver's number, not the buyer's silence.
    expect(after.approved_amount).toBe(252);
  });

  test('turning a line down needs no quantity — there is nothing to buy', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [{ sku: 'IO8116-600', size: '9', shelfPrice: 63 }] });
    const r = await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'reject', reason: 'Too close to retail' });
    expect(r.status).toBe(200);
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].status).toBe('rejected');
    expect(after.lines[0].qty).toBeNull();
  });

  test('one approver can override another, and the first decision survives it', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    await call(request, 'approver', 'cart/decide', {
      cartId, lineIds: [Number(line.id)], action: 'approve', qty: { [line.id]: 3 },
    });

    // A second approver reverses it. The floor says this happens; a system that refuses
    // it just moves the conversation somewhere nobody can audit.
    const alex = signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' });
    const over = await request.post('/api/cart/decide', {
      headers: { Authorization: `Bearer ${alex}` },
      data: { cartId, lineIds: [Number(line.id)], action: 'reject', reason: 'We already hold six' },
    });
    expect(over.status()).toBe(200);

    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    const l = after.lines[0];
    expect(l.status).toBe('rejected');
    expect(l.decided_by).toBe('Alex');
    // THE FIRST DECISION IS STILL THERE. The last write must not be able to present
    // itself as the only one that ever happened.
    expect(l.overrode_by).toBe(people.approver.name);
    expect(l.overrode_status).toBe('approved');
    expect(l.overrode_qty).toBe(3);
    // And the money moved with it.
    expect(after.approved_amount).toBe(0);
    // THE REVERSED LINE CARRIES NO QUANTITY. Quantity IS the approval here, so a
    // rejected line still reading "3" is a row that says buy three of something nobody
    // approved — and the row is what somebody checks before spending. The 3 survives as
    // `overrode_qty` above, which is where a reversed decision belongs.
    expect(l.qty).toBeNull();
    // The trail says what it reversed, rather than printing the quantity as if it stood.
    const trail = after.events.find((e) => e.kind === 'line_rejected');
    expect(trail.body).not.toContain('×3');
    expect(trail.body).not.toContain('×null');
  });

  test('a request cannot be sent until every shoe carries a photo, one per SKU', async ({ request }) => {
    const cartId = await newRequest(request, { submit: false });
    for (const size of ['10', '8', '9']) {
      await call(request, 'approver', 'cart/line', { cartId, line: { sku: 'IO8116-600', size, shelfPrice: 63 } });
    }
    const bare = await call(request, 'buyer', 'cart/submit', { cartId });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toMatch(/photo/i);
    expect(bare.body.error).toMatch(/IO8116-600/);

    // ONE photo for the style code covers all three sizes — a buyer sending a run of a
    // shoe photographs it once, not once per size.
    await shoePhotos(cartId, ['IO8116-600']);
    const ok = await call(request, 'buyer', 'cart/submit', { cartId });
    expect(ok.status).toBe(200);
  });

  test('a second shoe needs its own photo', async ({ request }) => {
    const cartId = await newRequest(request, { submit: false });
    await call(request, 'approver', 'cart/line', { cartId, line: { sku: 'IO8116-600', size: '10', shelfPrice: 63 } });
    await call(request, 'approver', 'cart/line', { cartId, line: { sku: 'DD1391-100', size: '9', shelfPrice: 63 } });
    await shoePhotos(cartId, ['IO8116-600']);
    const r = await call(request, 'buyer', 'cart/submit', { cartId });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/DD1391-100/);
    expect(r.body.error).not.toMatch(/IO8116-600/);
  });
});

// ---------------------------------------------------------------------------
// A Telegram tap is a decision  (`api/cart/telegram-decide.js`)
//
// Approvals arrive from a group where EVERYONE can press a button, and the API key only
// proves the request came from the scenario — never who tapped. So the whole endpoint
// turns on one question: which real person is this? An unlinked Telegram account has
// nobody to record the decision against, and is refused.
test.describe('a Telegram tap is a decision', () => {
  // The endpoint is key-gated and answers 503 without BUYING_API_KEY on the server —
  // CI has none, so the whole block is moot there rather than a wall of 503s.
  test.skip(!process.env.BUYING_API_KEY, 'BUYING_API_KEY is not set in this env — telegram-decide answers 503');
  const TG = 771002003;
  test.beforeAll(async () => {
    await pool.query('UPDATE users SET telegram_user_id = $1 WHERE id = $2', [TG, people.approver.uid]);
    // The bystander holds NO privilege but IS linked — the case that proves the key is
    // not what authorises, and that a linked account still has to be allowed to approve.
    await pool.query('UPDATE users SET telegram_user_id = $1 WHERE id = $2', [TG + 1, people.bystander.uid]);
  });
  test.afterAll(async () => {
    await pool.query('UPDATE users SET telegram_user_id = NULL WHERE telegram_user_id IN ($1, $2)', [TG, TG + 1]);
  });

  const tap = (request, body) => request.post('/api/cart/telegram-decide', {
    headers: { 'x-api-key': process.env.BUYING_API_KEY || '' },
    data: body,
  }).then(async (r) => ({ status: r.status(), body: await r.json() }));

  test('the key alone approves nothing — an unlinked account is refused', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const r = await tap(request, {
      telegramUserId: 999000999, telegramName: 'Nobody In Particular',
      cartId, lineIds: [Number(line.id)], action: 'approve', qty: 2,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/isn.t linked/i);
    // And nothing moved.
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].status).toBe('pending');

    // THE REFUSAL CAPTURES THE ID. Nobody can read their own numeric Telegram id off
    // their phone, so "go and find it" was a dead end for the tapper and the admin
    // alike. The id is noted, the refusal names it, and linking becomes one click.
    expect(r.body.telegramUserId).toBe(999000999);
    expect(r.body.needsLink).toBe(true);
    const waiting = (await pool.query(
      'SELECT telegram_user_id, name, taps FROM telegram_link_requests WHERE telegram_user_id = $1',
      [999000999])).rows[0];
    expect(waiting).toBeTruthy();
    expect(waiting.name).toBe('Nobody In Particular');
    await pool.query('DELETE FROM telegram_link_requests WHERE telegram_user_id = $1', [999000999]);
  });

  test('a linked account without the privilege is refused too', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const r = await tap(request, {
      telegramUserId: TG + 1, cartId, lineIds: [Number(line.id)], action: 'approve', qty: 2,
    });
    expect(r.status).toBe(403);
    // Named, so the group can see WHO cannot rather than being told "no".
    expect(r.body.error).toContain(people.bystander.name);
  });

  test('a tap carries the quantity, and is refused without one', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];

    const bare = await tap(request, {
      telegramUserId: TG, cartId, lineIds: [Number(line.id)], action: 'approve',
    });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toMatch(/how many/i);

    const ok = await tap(request, {
      telegramUserId: TG, cartId, lineIds: [Number(line.id)], action: 'approve', qty: 3,
    });
    expect(ok.status).toBe(200);
    // Recorded under the PERSON who tapped, not under a shared robot — "Alex overrode JK"
    // only means something if both names are real.
    expect(ok.body.by).toBe(people.approver.name);
    // One line, already worded, so Make can edit the original message instead of sending
    // a second one into the group.
    expect(ok.body.outcome).toContain('3 pairs');

    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].status).toBe('approved');
    expect(after.lines[0].qty).toBe(3);
    expect(after.lines[0].decided_by).toBe(people.approver.name);
    expect(after.approved_amount).toBe(150);   // 3 × $50
  });

  test('a rejection needs no quantity, and carries the reason into the trail', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const r = await tap(request, {
      telegramUserId: TG, cartId, lineIds: [Number(line.id)], action: 'reject', reason: 'We hold six already',
    });
    expect(r.status).toBe(200);
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].status).toBe('rejected');
    expect(after.lines[0].decided_reason).toBe('We hold six already');
    // The buyer reads that reason on their own screen — it is why they are standing in a
    // shop not buying something.
    expect(r.body.outcome).toContain('We hold six already');
  });

  test('two taps landing AT ONCE still decide once', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const body = { telegramUserId: TG, cartId, lineIds: [Number(line.id)], action: 'approve', qty: 2 };

    // Telegram redelivers a callback it does not get answered fast enough, so the second
    // arrives while the first is still in flight — both read the line as pending. The
    // guard has to be in the UPDATE, not in a read-then-write: with the check above the
    // write, real data carried the same approval TWICE under the same name.
    const [a, b] = await Promise.all([tap(request, body), tap(request, body)]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);

    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].qty).toBe(2);
    expect(after.approved_amount).toBe(100);
    // ONE event, not two. The trail is the thing that has to be right.
    expect(after.events.filter((e) => e.kind === 'line_approved')).toHaveLength(1);
  });

  test('the same tap twice does not decide twice', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const body = { telegramUserId: TG, cartId, lineIds: [Number(line.id)], action: 'approve', qty: 2 };
    expect((await tap(request, body)).status).toBe(200);
    // Telegram redelivers a callback that is not answered fast enough, and a double tap
    // lands while the first is in flight. The second must not invent a second decision.
    const again = await tap(request, body);
    expect(again.status).toBe(409);
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].qty).toBe(2);
    expect(after.approved_amount).toBe(100);
  });

  test('a bad key gets nowhere near a decision', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const r = await request.post('/api/cart/telegram-decide', {
      headers: { 'x-api-key': 'not-the-key' },
      data: { telegramUserId: TG, cartId, lineIds: [Number(line.id)], action: 'approve', qty: 2 },
    });
    expect(r.status()).toBe(401);
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// The suite creates real requests and then deletes them. Adding a line is what sends a
// Telegram card, so every local run was posting approval cards to the real group for
// pairs nobody is buying — and tapping one afterwards answered "that buying request does
// not exist", because teardown had removed it. BC-2923 was one of these.
//
// Stopped by blanking MAKE_WEBHOOK_URL for the server playwright starts, the same way
// TRACKING_API_KEY is. NOT by a check on APP_ENV: that guard shipped for half an hour and
// swallowed every card from a developer's own `npm run dev` too, which looked exactly
// like the Make scenario dropping them — two rounds of chasing the wrong half of the
// system with someone waiting. A control that cannot tell a test run from a person doing
// their job is an outage with a rationale.
test.describe('the suite cannot put a card in the Telegram group', () => {
  test('a blank webhook refuses the card, and says so rather than going quiet', async () => {
    const { notifyLineAsked, notifyConfigured } = await import('../api/_lib/notify.js');
    const keep = process.env.MAKE_WEBHOOK_URL;
    const keepTg = process.env.TELEGRAM_BOT_TOKEN;
    try {
      process.env.MAKE_WEBHOOK_URL = '';
      process.env.TELEGRAM_BOT_TOKEN = '';
      expect(notifyConfigured()).toBe(false);
      const out = await notifyLineAsked(1, 1);
      expect(out.sent).toBe(false);
      expect(out.reason).toMatch(/not configured/);

      // And a configured server still sends — the refusal must come from the blank, not
      // from something that would also be true in production.
      process.env.MAKE_WEBHOOK_URL = 'https://hook.invalid/never-called';
      expect(notifyConfigured()).toBe(true);
    } finally {
      if (keep === undefined) delete process.env.MAKE_WEBHOOK_URL;
      else process.env.MAKE_WEBHOOK_URL = keep;
      if (keepTg === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = keepTg;
    }
  });

  // NOT TESTED HERE: that the server this suite talks to actually has it blanked. The
  // env lives in the SERVER's process and this one is the runner, so any assertion from
  // here would be reading its own environment and calling it proof. The real exposure is
  // the `reuseExistingServer` caveat above — a hand-started server on this port carries a
  // real .env — and the honest guard for that is the comment, not a test that cannot see
  // the thing it names.
});

// ---------------------------------------------------------------------------
// Telegram, DIRECT (api/_lib/telegram.js + api/telegram/webhook.js) — what the two Make
// scenarios used to do. The server playwright starts points its Bot API at a FAKE on
// 127.0.0.1:5198 (playwright.config.js); this block runs that fake and reads what the
// server said to "Telegram", then plays Telegram back at the webhook.
test.describe('Telegram, direct: the card, the tap, and "More…"', () => {
  test.describe.configure({ mode: 'serial' });
  const TG = 771009001;
  const CHAT = -100777;               // TELEGRAM_CHAT_ID in playwright.config.js
  const SECRET = 'e2e-telegram-secret';
  const calls = [];
  let fake;
  let msgSeq = 5000;

  test.beforeAll(async () => {
    const http = await import('node:http');
    fake = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const method = req.url.split('/').pop();
        const raw = Buffer.concat(chunks);
        let body = {};
        if (String(req.headers['content-type'] || '').includes('json')) body = JSON.parse(raw.toString() || '{}');
        else body = { multipart: true, text: raw.toString('latin1').slice(0, 4000) };
        calls.push({ method, body });
        msgSeq += 1;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result: method === 'answerCallbackQuery' || method === 'setMessageReaction' ? true : { message_id: msgSeq, chat: { id: CHAT } } }));
      });
    });
    await new Promise((r) => fake.listen(5198, '127.0.0.1', r));
    await pool.query('UPDATE users SET telegram_user_id = $1 WHERE id = $2', [TG, people.approver.uid]);
  });
  test.afterAll(async () => {
    await pool.query('UPDATE users SET telegram_user_id = NULL WHERE telegram_user_id = $1', [TG]);
    await pool.query('DELETE FROM telegram_pending_qty WHERE telegram_user_id IN ($1, $2)', [TG, 999000777]);
    await pool.query(`DELETE FROM telegram_group_cards WHERE chat_id = $1`, [CHAT]);
    await new Promise((r) => fake.close(r));
  });

  const hook = (request, update, secret = SECRET) => request.post('/api/telegram/webhook', {
    headers: { 'x-telegram-bot-api-secret-token': secret },
    data: update,
  });
  const tapUpdate = (data, { from = TG, messageId = 42, chat = CHAT } = {}) => ({
    update_id: Date.now(),
    callback_query: {
      id: `cq-${Date.now()}`, data, from: { id: from, first_name: 'Tapper' },
      message: { message_id: messageId, chat: { id: chat } },
    },
  });
  // By POSITION, not by clock: a call recorded in the same millisecond as the mark
  // would otherwise count as "after" it.
  const since = (i) => calls.slice(i);

  // The card itself, built and sent from THIS process against the fake — the trigger (a
  // buyer's add → background market read → notify) is unchanged and waits on a live Alias
  // read measured in minutes, which is not what this test is about.
  // The gift card desk is told in a PRIVATE chat, not the group, the moment the request
  // can take cards — who is waiting, which request, how much (shelf price + declared tax).
  test('the gift card issuer gets a direct message when a request is ready for cards — once per amount', async ({ request }) => {
    const ISSUER_TG = 771009002;
    await pool.query('UPDATE users SET telegram_user_id = $1 WHERE id = $2', [ISSUER_TG, people.issuer.uid]);
    try {
      const cartId = await newRequest(request, { lines: [LINE] });        // 2 × $50, list closed
      const code = (await pool.query('SELECT cart_code FROM buy_carts WHERE id = $1', [cartId])).rows[0].cart_code;
      const t0 = calls.length;
      expect((await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty })).status).toBe(200);
      const dmTo = (from) => since(from).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(ISSUER_TG));
      await expect.poll(() => dmTo(t0).length, { timeout: 10_000 }).toBe(1);
      const dm = dmTo(t0)[0];
      expect(dm.body.text).toContain(`${people.buyer.name} is waiting for gift cards on ${code} — $108.25`);
      expect(dm.body.text).toContain('$108.25 to fund ($100.00 shelf + $8.25 tax)');
      // Nothing went to the group for this.
      expect(since(t0).some((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAT) && /waiting for gift cards/.test(c.body.text || ''))).toBe(false);
      await expect.poll(async () => (await pool.query(`SELECT count(*)::int AS n FROM buy_cart_events WHERE cart_id = $1 AND kind = 'cards_requested'`, [cartId])).rows[0].n).toBe(1);

      // The same amount is not announced twice.
      const { notifyIssuersIfReady } = await import('../api/_lib/notify.js');
      const keep = { ...process.env };
      Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'e2e-fake-token', TELEGRAM_CHAT_ID: String(CHAT), TELEGRAM_API_BASE: 'http://127.0.0.1:5198' });
      try {
        const again = await notifyIssuersIfReady(cartId);
        expect(again.sent).toBe(false);
        expect(again.reason).toBe('already announced');
      } finally {
        for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API_BASE']) {
          if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
        }
      }
    } finally {
      await pool.query('UPDATE users SET telegram_user_id = NULL WHERE telegram_user_id = $1', [ISSUER_TG]);
    }
  });

  // HOW MANY of an approved pair, after the cards are out (cart/line-qty, owner 2026-11-13).
  // The one exception to "approvals are frozen once funded": the number on an approved pair,
  // never the decision. The target moves by the pairs changed, taxed at the rate of the day;
  // a shortfall asks the person whether the gift card desk is told.
  test.describe('changing how many after the cards are out', () => {
    const ISSUER_TG = 771009003;
    test.beforeAll(async () => {
      await pool.query('UPDATE users SET telegram_user_id = $1 WHERE id = $2', [ISSUER_TG, people.issuer.uid]);
    });
    test.afterAll(async () => {
      await pool.query('UPDATE users SET telegram_user_id = NULL WHERE telegram_user_id = $1', [ISSUER_TG]);
    });
    const dmTo = (from) => since(from).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(ISSUER_TG));
    const groupNotes = (from, re) => since(from).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAT) && re.test(c.body.text || ''));
    // 2 × $50 approved, $108.25 on one card, released: a funded request.
    async function fundedRequest(request, card) {
      const cartId = await newRequest(request, { lines: [LINE] });
      expect((await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty })).status).toBe(200);
      expect((await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: card, balance: 108.25 } })).status).toBe(200);
      expect((await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true })).body.cart.status).toBe('funded');
      const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
      return { cartId, lineId: Number(body.cart.lines[0].id), code: body.cart.cart_code };
    }
    const events = async (cartId, kind) => (await pool.query(
      'SELECT * FROM buy_cart_events WHERE cart_id = $1 AND kind = $2 ORDER BY id DESC', [cartId, kind])).rows;

    test('raising it moves the target by the taxed delta, and asking the desk sends them the top-up', async ({ request }) => {
      const { cartId, lineId, code } = await fundedRequest(request, '6161616161616161');
      // The DM for the first $108.25 goes out on the approval; wait for it so it isn't counted below.
      await expect.poll(async () => (await events(cartId, 'cards_requested')).length, { timeout: 10_000 }).toBe(1);
      const t0 = calls.length;

      // Short, and no choice made: refused with the figure, and nothing changed.
      const noChoice = await call(request, 'approver', 'cart/line-qty', { cartId, lineId, qty: 3, expectQty: 2 });
      expect(noChoice.status).toBe(400);
      expect(noChoice.body.needsChoice).toBe(true);
      expect(noChoice.body.short).toBeCloseTo(54.13, 2);
      expect((await pool.query('SELECT qty FROM buy_cart_lines WHERE id = $1', [lineId])).rows[0].qty).toBe(2);

      const r = await call(request, 'approver', 'cart/line-qty', { cartId, lineId, qty: 3, expectQty: 2, askCards: true });
      expect(r.status).toBe(200);
      expect(r.body.money.before).toBeCloseTo(108.25, 2);
      expect(r.body.money.after).toBeCloseTo(162.38, 2);          // $108.25 + $50 × 1.0825
      expect(r.body.money.short).toBeCloseTo(54.13, 2);
      expect(r.body.ask).toMatchObject({ choice: 'asked', sent: true });

      const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
      expect(body.cart.status).toBe('funded');
      expect(body.cart.approved_amount).toBe(150);
      expect(body.cart.funding_target).toBeCloseTo(162.38, 2);
      expect(body.cart.gc_total).toBeCloseTo(108.25, 2);            // the card is untouched
      const line = body.cart.lines.find((l) => Number(l.id) === lineId);
      expect(line).toMatchObject({ status: 'approved', qty: 3, decided_by: people.approver.name, overrode_qty: 2 });
      // Closing condition 2 still wants the cards to cover the new target.
      expect(body.cart.checks.find((c) => c.key === 'cards_recorded').ok).toBe(false);

      // The desk is DM'd for the top-up, once; the group hears the change.
      await expect.poll(() => dmTo(t0).length, { timeout: 10_000 }).toBe(1);
      expect(dmTo(t0)[0].body.text).toContain(`on ${code} — $54.13`);
      await expect.poll(() => groupNotes(t0, /×2 → ×3/).length, { timeout: 10_000 }).toBe(1);
      expect(groupNotes(t0, /×2 → ×3/)[0].body.text).toMatch(/Short \$54\.13 — the gift card desk has been asked/);

      // History: who, which pair, old → new, target before → after.
      const [ev] = await events(cartId, 'line_qty_changed');
      expect(ev.actor_name).toBe(people.approver.name);
      expect(ev.body).toContain(`${LINE.sku} size ${LINE.size} ×2 → ×3`);
      expect(ev.body).toContain('$108.25 → $162.38');
      expect((await events(cartId, 'cards_requested'))[0].body).toMatch(/^\$54\.13/);

      // The decision itself is still frozen: no override through cart/decide.
      const override = await call(request, 'approver', 'cart/decide', { cartId, lineIds: [lineId], action: 'reject', reason: 'no' });
      expect(override.status).toBe(409);
      expect(override.body.error).toMatch(/frozen/i);

      // The top-up card covers it.
      expect((await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6262626262626262', balance: 54.13 } })).body.short).toBe(0);
    });

    test('“Don’t ask now” sends nothing and says so in History; “Ask for more” sends it later', async ({ request }) => {
      const { cartId, lineId, code } = await fundedRequest(request, '6363636363636363');
      await expect.poll(async () => (await events(cartId, 'cards_requested')).length, { timeout: 10_000 }).toBe(1);
      const t0 = calls.length;

      const r = await call(request, 'approver', 'cart/line-qty', { cartId, lineId, qty: 4, expectQty: 2, askCards: false });
      expect(r.status).toBe(200);
      expect(r.body.money.after).toBeCloseTo(216.5, 2);             // $108.25 + $100 × 1.0825
      expect(r.body.ask).toMatchObject({ choice: 'not_asked' });
      const [held] = await events(cartId, 'cards_not_asked');
      // Keyed by what is owed AND what is on the cards: this $108.25 top-up is the same figure
      // as the first funding, and must not read as "already announced".
      expect(held.body).toMatch(/^\$108\.25 owed, \$108\.25 on cards — E2E Approver chose not to ask/);
      expect(held.actor_name).toBe(people.approver.name);
      // The group note goes out; the desk's DM does not.
      await expect.poll(() => groupNotes(t0, /×2 → ×4/).length, { timeout: 10_000 }).toBe(1);
      expect(groupNotes(t0, /×2 → ×4/)[0].body.text).toMatch(/NOT been asked/);
      expect(dmTo(t0)).toHaveLength(0);

      // An automatic send (any later write) stays quiet for the same amount.
      const { notifyIssuersIfReady } = await import('../api/_lib/notify.js');
      const keep = { ...process.env };
      Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'e2e-fake-token', TELEGRAM_CHAT_ID: String(CHAT), TELEGRAM_API_BASE: 'http://127.0.0.1:5198' });
      try {
        expect((await notifyIssuersIfReady(cartId)).reason).toBe('not asked — held back on purpose');
      } finally {
        for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API_BASE']) {
          if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
        }
      }
      expect(dmTo(t0)).toHaveLength(0);
      // Still short wherever the funding shows; closing condition 2 is not weakened.
      let { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
      expect(body.cart.funding_target - body.cart.gc_total).toBeCloseTo(108.25, 2);
      expect(body.cart.checks.find((c) => c.key === 'cards_recorded').ok).toBe(false);

      // Asked later: the buyer can't; an approver can, once per amount.
      expect((await call(request, 'buyer', 'cart/ask-cards', { cartId })).status).toBe(403);
      const ask = await call(request, 'approver', 'cart/ask-cards', { cartId });
      expect(ask.status).toBe(200);
      await expect.poll(() => dmTo(t0).length, { timeout: 10_000 }).toBe(1);
      expect(dmTo(t0)[0].body.text).toContain(`on ${code} — $108.25`);
      const again = await call(request, 'approver', 'cart/ask-cards', { cartId });
      expect(again.status).toBe(409);
      expect(again.body.error).toMatch(/already been asked/);
      ({ body } = await read_(request, 'approver', `cart/get?id=${cartId}`));
      expect(body.cart.events[0].kind).toBe('cards_requested');
      expect(body.cart.events[0].body).toMatch(/^\$108\.25 owed, \$108\.25 on cards — gift card desk told/);
    });

    test('on the screen: Change qty on an approved row shows the shortfall and asks the question', async ({ page, request }) => {
      const { cartId } = await fundedRequest(request, '6666666666666666');
      await as(page, 'approver');
      await page.goto(`/buy-carts?request=${cartId}`);
      // Approved rows on a funded request offer only the quantity — no approve/turn down Change.
      await expect(page.getByRole('button', { name: 'Change', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: `Change how many of ${LINE.sku} size ${LINE.size}` }).click();
      const dlg = page.getByRole('dialog');
      await expect(dlg).toContainText('The gift cards are already out, so only the number can change here');
      await dlg.getByRole('spinbutton').fill('3');
      await expect(dlg).toContainText('Gift cards needed $108.25 → $162.38');
      await expect(dlg).toContainText('Cards now short by $54.13');
      // No choice made → it says so and saves nothing.
      await dlg.getByRole('button', { name: 'Save the new quantity' }).click();
      await expect(dlg).toContainText('Choose whether to ask the gift card desk');
      await dlg.getByLabel(/Don’t ask now/).check();
      await dlg.getByRole('button', { name: 'Save the new quantity' }).click();
      await expect(dlg).toHaveCount(0);
      await expect(page.locator('.bc-lines')).toContainText('is now ×3');
      // Still short, wherever the funding shows, with a way to ask later.
      await expect(page.locator('.bc-money')).toContainText('Short $54.13');
      await expect(page.locator('.bc-cards')).toContainText('$54.13 short');
      await expect(page.locator('.bc-cards')).toContainText(`${people.approver.name} chose not to ask the gift card desk for this yet`);
      await expect(page.getByRole('button', { name: 'Ask for $54.13 more' })).toBeVisible();
      // Lowering within the cards: nothing to choose.
      await page.getByRole('button', { name: `Change how many of ${LINE.sku} size ${LINE.size}` }).click();
      await dlg.getByRole('spinbutton').fill('1');
      await expect(dlg).toContainText('The cards cover it');
      await expect(dlg.locator('.bc-qty-choice')).toHaveCount(0);
    });

    test('lowering it moves the target down and leaves the cards alone', async ({ request }) => {
      const { cartId, lineId } = await fundedRequest(request, '6464646464646464');
      const r = await call(request, 'approver', 'cart/line-qty', { cartId, lineId, qty: 1, expectQty: 2 });
      expect(r.status).toBe(200);
      expect(r.body.ask.choice).toBe(null);
      const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
      expect(body.cart.approved_amount).toBe(50);
      expect(body.cart.funding_target).toBeCloseTo(54.12, 2);      // $108.25 − $50 × 1.0825
      expect(body.cart.giftCards).toHaveLength(1);
      expect(Number(body.cart.giftCards[0].balance)).toBeCloseTo(108.25, 2);
      expect(body.cart.checks.find((c) => c.key === 'cards_recorded').ok).toBe(true);
      expect((await events(cartId, 'line_qty_changed'))[0].body).toContain('×2 → ×1');
      expect(await events(cartId, 'cards_not_asked')).toHaveLength(0);
    });

    test('refused: for the buyer, before the cards, after the receipt, on a pending pair, on a stale number', async ({ request }) => {
      const { cartId, lineId } = await fundedRequest(request, '6565656565656565');

      // The buyer cannot change how many — that is the approver's answer.
      expect((await call(request, 'buyer', 'cart/line-qty', { cartId, lineId, qty: 3, expectQty: 2, askCards: true })).status).toBe(403);
      expect((await call(request, 'bystander', 'cart/line-qty', { cartId, lineId, qty: 3, expectQty: 2, askCards: true })).status).toBe(403);
      expect((await call(request, 'approver', 'cart/line-qty', { cartId, lineId, qty: 0, expectQty: 2 })).status).toBe(400);

      // Stale tab: the number moved under it.
      expect((await call(request, 'approver', 'cart/line-qty', { cartId, lineId, qty: 1, expectQty: 2 })).status).toBe(200);
      const stale = await call(request, 'approver', 'cart/line-qty', { cartId, lineId, qty: 3, expectQty: 2, askCards: true });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(/approved ×1 now/);
      expect((await pool.query('SELECT qty FROM buy_cart_lines WHERE id = $1', [lineId])).rows[0].qty).toBe(1);

      // A pending pair (added after re-opening) is an ordinary decision, not this path.
      expect((await call(request, 'buyer', 'cart/submit', { cartId, reopen: true })).status).toBe(200);
      expect((await call(request, 'approver', 'cart/line', { cartId, line: { sku: LINE.sku, size: '8', shelfPrice: 50, verdict: 'buy' } })).status).toBe(200);
      const pendingId = Number((await pool.query(`SELECT id FROM buy_cart_lines WHERE cart_id = $1 AND status = 'pending'`, [cartId])).rows[0].id);
      await pool.query('UPDATE buy_cart_lines SET qty = 1 WHERE id = $1', [pendingId]);
      const onPending = await call(request, 'approver', 'cart/line-qty', { cartId, lineId: pendingId, qty: 2, expectQty: 1, askCards: true });
      expect(onPending.status).toBe(409);
      expect(onPending.body.error).toMatch(/hasn’t been answered yet/);

      // From the receipt on, the purchase has happened.
      await pool.query(`UPDATE buy_carts SET status = 'receipted' WHERE id = $1`, [cartId]);
      const late = await call(request, 'approver', 'cart/line-qty', { cartId, lineId, qty: 2, expectQty: 1, askCards: true });
      expect(late.status).toBe(409);
      expect(late.body.error).toMatch(/receipt is already in/i);

      // Before the cards go out, the ordinary Change (cart/decide) is the way.
      const early = await newRequest(request, { lines: [LINE] });
      await call(request, 'approver', 'cart/decide', { cartId: early, all: true, action: 'approve', qtyAll: LINE.qty });
      const earlyLine = Number((await pool.query('SELECT id FROM buy_cart_lines WHERE cart_id = $1', [early])).rows[0].id);
      const notYet = await call(request, 'approver', 'cart/line-qty', { cartId: early, lineId: earlyLine, qty: 3, expectQty: 2 });
      expect(notYet.status).toBe(409);
      expect(notYet.body.error).toMatch(/aren’t out yet/);
    });
  });

  test('a card goes straight to the group, with the same buttons Make sent', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const keep = { ...process.env };
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: 'e2e-fake-token', TELEGRAM_CHAT_ID: String(CHAT),
      TELEGRAM_API_BASE: 'http://127.0.0.1:5198', MAKE_WEBHOOK_URL: '',
      STOCKX_API_KEY: '',   // no real StockX call from a test: the SKU links to a StockX search
    });
    try {
      const { notifyLineAsked } = await import('../api/_lib/notify.js');
      const t0 = calls.length;
      const out = await notifyLineAsked(cartId, Number(line.id));
      expect(out.sent).toBe(true);
      const card = since(t0).find((c) => c.method === 'sendMessage');
      expect(String(card.body.chat_id)).toBe(String(CHAT));
      expect(card.body.text).toContain('CW2288-111');
      expect(card.body.text).toContain('Size: 9');
      // Same callback shapes the Make scenario used — cards sent before the switch
      // still work when tapped after it.
      const buttons = card.body.reply_markup.inline_keyboard.flat().map((b) => `${b.text}=${b.callback_data}`);
      const env = process.env.APP_ENV === 'dev' ? 'dev' : 'prod';
      expect(buttons).toEqual([
        `✓ Buy 1=approve:${cartId}:${line.id}:1:${env}`,
        `✓ Buy 2=approve:${cartId}:${line.id}:2:${env}`,
        `✓ Buy 3=approve:${cartId}:${line.id}:3:${env}`,
        `More…=more:${cartId}:${line.id}:${env}`,
        `✕ Turn it down=reject:${cartId}:${line.id}:${env}`,
      ]);
    } finally {
      for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API_BASE', 'MAKE_WEBHOOK_URL', 'STOCKX_API_KEY']) {
        if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
      }
    }
  });

  // ONE size keeps the tap-button card even when premium (owner, 2026-10-27) — the tip gets
  // its own two buttons, and a tap on one is the same decision a "tip ok" reply makes.
  test('a one-size premium pair: Buy buttons as ever, plus Approve / Decline tip', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [{ ...LINE, premium: true, tipProposed: 10 }] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const keep = { ...process.env };
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: 'e2e-fake-token', TELEGRAM_CHAT_ID: String(CHAT),
      TELEGRAM_API_BASE: 'http://127.0.0.1:5198', MAKE_WEBHOOK_URL: '',
      STOCKX_API_KEY: '',   // no real StockX call from a test: the SKU links to a StockX search
    });
    let card;
    try {
      const { notifyLineAsked } = await import('../api/_lib/notify.js');
      const t0 = calls.length;
      expect((await notifyLineAsked(cartId, Number(line.id))).sent).toBe(true);
      card = since(t0).find((c) => c.method === 'sendMessage');
    } finally {
      for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API_BASE', 'MAKE_WEBHOOK_URL', 'STOCKX_API_KEY']) {
        if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
      }
    }
    expect(card.body.text).toContain(`⭐ PREMIUM — ${people.buyer.name} is proposing a $10.00 tip per pair`);
    expect(card.body.text).toContain('use the tip buttons below');
    const env = process.env.APP_ENV === 'dev' ? 'dev' : 'prod';
    const buttons = card.body.reply_markup.inline_keyboard.flat().map((b) => `${b.text}=${b.callback_data}`);
    expect(buttons).toContain(`✓ Buy 1=approve:${cartId}:${line.id}:1:${env}`);
    expect(buttons).toContain(`💵 Approve $10.00 tip=tipok:${cartId}:${line.id}:${env}`);
    expect(buttons).toContain(`✕ Decline tip=tipno:${cartId}:${line.id}:${env}`);
    const link = (card.body.entities || []).find((e) => e.type === 'text_link');
    expect(card.body.text.slice(link.offset, link.offset + link.length)).toBe('CW2288-111');

    const t1 = calls.length;
    await hook(request, tapUpdate(`tipok:${cartId}:${line.id}:dev`, { messageId: 4242 }));
    const tip = (await pool.query('SELECT tip_status, tip_approved, status FROM buy_cart_lines WHERE id = $1', [line.id])).rows[0];
    expect(tip).toMatchObject({ tip_status: 'approved', tip_approved: '10.00', status: 'pending' });
    const said = since(t1).find((c) => c.method === 'sendMessage');
    expect(said.body.text).toBe(`💵 ${people.approver.name} approved the tip for CW2288-111: $10.00 per pair · [dev]`);
    expect(said.body.reply_parameters.message_id).toBe(4242);
  });

  test('without the secret, the webhook refuses — a tap has to come from Telegram', async ({ request }) => {
    const r = await hook(request, tapUpdate('approve:1:1:1:dev'), 'wrong');
    expect(r.status()).toBe(401);
  });

  test('a Buy tap records the decision under the tapper, replies, and stamps 👍', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const t0 = calls.length;
    const r = await hook(request, tapUpdate(`approve:${cartId}:${line.id}:2:dev`, { messageId: 4242 }));
    expect(r.status()).toBe(200);
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].status).toBe('approved');
    const got = since(t0);
    expect(got.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
    const reply = got.find((c) => c.method === 'sendMessage');
    expect(reply.body.text).toBe(`${people.approver.name} approved · 2 pairs · [dev]`);
    expect(reply.body.reply_parameters.message_id).toBe(4242);
    const react = got.find((c) => c.method === 'setMessageReaction');
    expect(react.body.reaction[0].emoji).toBe('👍');
    expect(react.body.message_id).toBe(4242);
  });

  // Floor feedback, 2026-11-04: tapping Buy 1 on a pair already approved ×1 came back as
  // "⚠️ Nothing was still awaiting a decision — someone may have got there first", twice.
  // Same answer again = "already recorded", not an error; a DIFFERENT answer still overrides.
  test('tapping the answer the pair already has says "already recorded", and a different tap still overrides', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const row = async () => (await pool.query('SELECT status, qty, overrode_status FROM buy_cart_lines WHERE id = $1', [line.id])).rows[0];
    const lastReply = (from) => since(from).filter((c) => c.method === 'sendMessage').pop();
    await hook(request, tapUpdate(`approve:${cartId}:${line.id}:1:dev`, { messageId: 4343 }));
    expect(await row()).toMatchObject({ status: 'approved', qty: 1 });

    let t0 = calls.length;
    await hook(request, tapUpdate(`approve:${cartId}:${line.id}:1:dev`, { messageId: 4343 }));
    let reply = lastReply(t0);
    expect(reply.body.text).toBe(`✅ Already recorded — nothing changed (size ${line.size} ×1, approved by ${people.approver.name}). · [dev]`);
    expect(reply.body.text).not.toMatch(/got there first/);
    expect(reply.body.reply_parameters.message_id).toBe(4343);
    // Nothing written: no override invented by the repeat.
    expect(await row()).toMatchObject({ status: 'approved', qty: 1, overrode_status: null });

    // A different quantity is a real change, and goes through as an override.
    t0 = calls.length;
    await hook(request, tapUpdate(`approve:${cartId}:${line.id}:2:dev`, { messageId: 4343 }));
    expect(lastReply(t0).body.text).toBe(`${people.approver.name} approved · 2 pairs · [dev]`);
    expect(await row()).toMatchObject({ status: 'approved', qty: 2, overrode_status: 'approved' });

    // Turn it down twice: the second one is "already recorded" too, with 👎.
    await hook(request, tapUpdate(`reject:${cartId}:${line.id}:dev`, { messageId: 4343 }));
    t0 = calls.length;
    await hook(request, tapUpdate(`reject:${cartId}:${line.id}:dev`, { messageId: 4343 }));
    reply = lastReply(t0);
    expect(reply.body.text).toBe(`✅ Already recorded — nothing changed (size ${line.size} turned down by ${people.approver.name}). · [dev]`);
    expect(since(t0).find((c) => c.method === 'setMessageReaction').body.reaction[0].emoji).toBe('👎');
  });

  test('an unlinked tapper is refused OUT LOUD in the group, and nothing is recorded', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const t0 = calls.length;
    await hook(request, tapUpdate(`approve:${cartId}:${line.id}:1:dev`, { from: 999000777 }));
    const reply = since(t0).find((c) => c.method === 'sendMessage');
    // No status code in the group (2026-11-02) — it means nothing to the person who tapped.
    expect(reply.body.text).toMatch(/^⚠️ .*isn’t linked.* · \[dev\]$/);
    expect(reply.body.text).not.toContain('HTTP');
    expect(since(t0).some((c) => c.method === 'setMessageReaction')).toBe(false);
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].status).toBe('pending');
    await pool.query('DELETE FROM telegram_link_requests WHERE telegram_user_id = $1', [999000777]);
  });

  test('"More…" asks how many, and the number typed back approves that many — once', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    let t0 = calls.length;
    await hook(request, tapUpdate(`more:${cartId}:${line.id}:dev`, { messageId: 777 }));
    const ask = since(t0).find((c) => c.method === 'sendMessage');
    expect(ask.body.text).toMatch(/^Tapper, how many pairs\?/);
    // A PICKER — with group privacy on, a plain typed "10" never reaches the bot, so the
    // common quantities are buttons: ordinary approve taps, answered on the CARD.
    const picks = ask.body.reply_markup.inline_keyboard.flat().map((x) => x.callback_data);
    expect(picks).toContain(`approve:${cartId}:${line.id}:10:dev`);
    expect(picks).toContain(`cancel:${cartId}:${line.id}:dev`);

    // Somebody ELSE typing a number answers nothing.
    t0 = calls.length;
    await hook(request, { update_id: 1, message: { message_id: 900, text: '4', from: { id: 999000777 }, chat: { id: CHAT } } });
    expect(since(t0).length).toBe(0);

    t0 = calls.length;
    const typed = { update_id: 2, message: { message_id: 901, text: ' 5 ', from: { id: TG, first_name: 'Tapper' }, chat: { id: CHAT } } };
    await hook(request, typed);
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].status).toBe('approved');
    const reply = since(t0).find((c) => c.method === 'sendMessage');
    expect(reply.body.text).toContain('5 pairs');
    // Answered under the CARD, not under the typed number.
    expect(reply.body.reply_parameters.message_id).toBe(777);

    // Telegram redelivers; the second delivery must find the question already spent.
    t0 = calls.length;
    await hook(request, typed);
    expect(since(t0).length).toBe(0);
  });

  // ONE CARD PER SHOE (docs/context/buy-cart.md → "One card per shoe"): several sizes go out
  // as one card, answered by replying "size x qty" lines; sizes left out are turned down.
  const RUN = ['9', '9.5', '10'].map((size) => ({ ...LINE, size }));
  async function groupCard(request, run = RUN) {
    const cartId = await newRequest(request, { lines: run });
    const lines = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines;
    const keep = { ...process.env };
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: 'e2e-fake-token', TELEGRAM_CHAT_ID: String(CHAT),
      TELEGRAM_API_BASE: 'http://127.0.0.1:5198', MAKE_WEBHOOK_URL: '',
      STOCKX_API_KEY: '',   // no real StockX call from a test: the SKU links to a StockX search
    });
    try {
      const { notifyGroupAsked } = await import('../api/_lib/notify.js');
      const t0 = calls.length;
      expect((await notifyGroupAsked(cartId, lines.map((l) => Number(l.id)))).sent).toBe(true);
      const sent = since(t0).filter((c) => c.method === 'sendMessage' || c.method === 'sendPhoto');
      expect(sent.length).toBe(1);
      const row = (await pool.query('SELECT * FROM telegram_group_cards WHERE cart_id = $1', [cartId])).rows[0];
      return { cartId, lines, card: sent[0].body, row };
    } finally {
      for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API_BASE', 'MAKE_WEBHOOK_URL', 'STOCKX_API_KEY']) {
        if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
      }
    }
  }
  const replyUpdate = (row, text, { replyId = Date.now() % 1e9, from = TG } = {}) => ({
    update_id: Date.now(),
    message: {
      message_id: replyId, chat: { id: CHAT, type: 'supergroup' }, from: { id: from, first_name: 'Tapper' }, text,
      reply_to_message: {
        message_id: Number(row.message_id), chat: { id: CHAT },
        reply_markup: { inline_keyboard: [[{ text: '✕ Turn them all down', callback_data: `grpreject:${row.id}:dev` }]] },
      },
    },
  });
  const statuses = async (cartId) => Object.fromEntries((await pool.query(
    'SELECT size, status, qty FROM buy_cart_lines WHERE cart_id = $1', [cartId])).rows.map((r) => [r.size, `${r.status}${r.qty ? ` ×${r.qty}` : ''}`]));

  test('several sizes of one shoe go out as ONE card, every size on it with its own call', async ({ request }) => {
    const { card, row, lines } = await groupCard(request);
    expect(card.text).toContain('CW2288-111');
    expect(card.text).toContain('Sizes (3):');
    // The SKU line is a link to the shoe on StockX (a search when StockX isn't set up).
    const link = (card.entities || []).find((e) => e.type === 'text_link');
    expect(card.text.slice(link.offset, link.offset + link.length)).toBe('CW2288-111');
    expect(link.url).toBe('https://stockx.com/search?s=CW2288-111');
    expect(card.text).toMatch(/^9 · Did not count · BUY$/m);
    expect(card.text).toMatch(/^10 · Did not count · BUY$/m);
    expect(card.text).toContain('Sizes you leave out are turned down.');
    expect(card.text).toContain('e.g.:\n9 x 1\n9.5 x 1\n');   // its own sizes; nothing counted → 1
    expect(card.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([expect.stringMatching(new RegExp(`^grpreject:${row.id}:`))]);
    expect(row.line_ids).toBe(lines.map((l) => l.id).join(','));
    expect(row.message_id).not.toBeNull();
  });

  // Sizes go out smallest first whatever order they were tapped in, and the example reply is
  // built from THIS card's sizes and counts — a made-up "9 x 5" under 10.5 / 11 read as real.
  test('the card lists sizes smallest first, and its example reply uses its own sizes', async ({ request }) => {
    const tapped = [['10.5', 3], ['11.5', 3], ['11', 2]].map(([size, availableQty]) => ({ ...LINE, size, availableQty }));
    const { card } = await groupCard(request, tapped);
    const rows = card.text.split('\n').filter((l) => /^\d+(\.5)? · /.test(l)).map((l) => l.split(' · ')[0]);
    expect(rows).toEqual(['10.5', '11', '11.5']);
    expect(card.text).toContain('To approve, REPLY to this card — one size per line, e.g.:\n10.5 x 3\n11 x 2\n');
    expect(card.text).toContain('take all except 10.5');
    expect(card.text).toContain('A range works too: 10.5-11.5 x 1 · or "all x 1".');
    expect(card.text).not.toContain('9 x 5');
  });

  test('a "size x qty" reply approves those sizes, turns the rest down — once', async ({ request }) => {
    const { cartId, row } = await groupCard(request);
    const update = replyUpdate(row, '10 x 1\n9 x 2');
    let t0 = calls.length;
    expect((await hook(request, update)).status()).toBe(200);
    expect(await statuses(cartId)).toEqual({ 9: 'approved ×2', '9.5': 'rejected', 10: 'approved ×1' });
    const reply = since(t0).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAT)).pop();
    expect(reply.body.text).toBe(`${people.approver.name} approved 9 ×2, 10 ×1 (3 pairs)\nTurned down: 9.5 · [dev]`);
    expect(reply.body.reply_parameters.message_id).toBe(Number(row.message_id));
    expect(since(t0).find((c) => c.method === 'setMessageReaction').body.reaction[0].emoji).toBe('👍');
    // Telegram redelivers; the second copy records and says nothing.
    t0 = calls.length;
    await hook(request, update);
    expect(since(t0).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAT)).length).toBe(0);
  });

  test('a reply naming a size that is not on the card records NOTHING and says why', async ({ request }) => {
    const { cartId, row } = await groupCard(request);
    const t0 = calls.length;
    await hook(request, replyUpdate(row, '9 x 2\n13 x 1'));
    expect(await statuses(cartId)).toEqual({ 9: 'pending', '9.5': 'pending', 10: 'pending' });
    const warn = since(t0).find((c) => c.method === 'sendMessage');
    expect(warn.body.text).toMatch(/^⚠️ 13 isn’t on this card .*Nothing was recorded\. · \[dev\]$/);
  });

  test('"Turn them all down" rejects every size on the card', async ({ request }) => {
    const { cartId, row } = await groupCard(request);
    await hook(request, tapUpdate(`grpreject:${row.id}:dev`, { messageId: Number(row.message_id) }));
    expect(await statuses(cartId)).toEqual({ 9: 'rejected', '9.5': 'rejected', 10: 'rejected' });
  });

  test('a second reply replaces the first, and says which approval it reversed and what is over the count', async ({ request }) => {
    const { cartId, row } = await groupCard(request);
    await hook(request, replyUpdate(row, '9 x 2', { replyId: 700001 }));
    expect(await statuses(cartId)).toEqual({ 9: 'approved ×2', '9.5': 'rejected', 10: 'rejected' });
    await pool.query(`UPDATE buy_cart_lines SET available_qty = 1 WHERE cart_id = $1 AND size = '10'`, [cartId]);
    const t0 = calls.length;
    await hook(request, replyUpdate(row, '10 x 3', { replyId: 700002 }));
    expect(await statuses(cartId)).toEqual({ 9: 'rejected', '9.5': 'rejected', 10: 'approved ×3' });
    const reply = since(t0).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAT)).pop();
    expect(reply.body.text).toContain(`↩️ Replaced the earlier decision: 9 was ×2 (${people.approver.name}) → turned down`);
    expect(reply.body.text).toContain('⚠️ 10 ×3 is more than the 1 counted in store.');
  });

  // Alex's actual replies (floor feedback, 2026-11-02): "take all", "Yes", "Two each size
  // max", "$5 tip" — every one came back as an error. Now they are answers.
  test('plain words answer the card: "take all" = what is in store, "two each size max" caps at it, "no" = none', async ({ request }) => {
    const { cartId, row } = await groupCard(request);
    await pool.query(`UPDATE buy_cart_lines SET available_qty = CASE size WHEN '9' THEN 2 WHEN '9.5' THEN 3 ELSE NULL END WHERE cart_id = $1`, [cartId]);
    let t0 = calls.length;
    await hook(request, replyUpdate(row, 'Take all', { replyId: 730001 }));
    expect(await statuses(cartId)).toEqual({ 9: 'approved ×2', '9.5': 'approved ×3', 10: 'approved ×1' });
    let reply = since(t0).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAT)).pop();
    expect(reply.body.text).toContain('Read "Take all" as every size, as many as were counted in store (1 of 10 — not counted).');

    await hook(request, replyUpdate(row, 'Two each size max', { replyId: 730002 }));
    expect(await statuses(cartId)).toEqual({ 9: 'approved ×2', '9.5': 'approved ×2', 10: 'approved ×2' });

    // Saying it again is not an error — no "someone got there first · HTTP 409".
    t0 = calls.length;
    await hook(request, replyUpdate(row, '2 each', { replyId: 730003 }));
    reply = since(t0).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAT)).pop();
    expect(reply.body.text).toMatch(/^✅ Already recorded — nothing changed/);
    expect(reply.body.text).not.toContain('HTTP');

    // All except a size: that size is turned down, the rest are what's in store.
    t0 = calls.length;
    await hook(request, replyUpdate(row, 'take all except 9.5', { replyId: 730004 }));
    expect(await statuses(cartId)).toEqual({ 9: 'approved ×2', '9.5': 'rejected', 10: 'approved ×1' });
    reply = since(t0).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAT)).pop();
    expect(reply.body.text).toContain('Turned down: 9.5');
    expect(reply.body.text).toContain('Read "take all except 9.5" as every size except 9.5');

    // A size that isn't on the card records nothing.
    t0 = calls.length;
    await hook(request, replyUpdate(row, 'take all except 13', { replyId: 730005 }));
    expect(await statuses(cartId)).toEqual({ 9: 'approved ×2', '9.5': 'rejected', 10: 'approved ×1' });
    reply = since(t0).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAT)).pop();
    expect(reply.body.text).toMatch(/^⚠️ 13 isn’t on this card/);

    await hook(request, replyUpdate(row, 'no', { replyId: 730006 }));
    expect(await statuses(cartId)).toEqual({ 9: 'rejected', '9.5': 'rejected', 10: 'rejected' });

    // Still strict about what it can't read — nothing recorded, and it says what works.
    t0 = calls.length;
    await hook(request, replyUpdate(row, 'hmm maybe later', { replyId: 730007 }));
    reply = since(t0).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAT)).pop();
    expect(reply.body.text).toMatch(/Reply "take all", "2 each", "no"/);
    expect(await statuses(cartId)).toEqual({ 9: 'rejected', '9.5': 'rejected', 10: 'rejected' });
    // …and it is kept, so what to teach the reader next comes from real replies.
    const miss = (await pool.query(`SELECT * FROM telegram_reply_misses WHERE cart_id = $1 ORDER BY id DESC LIMIT 1`, [cartId])).rows[0];
    expect(miss).toMatchObject({ reply_text: 'hmm maybe later', card_kind: 'shoe', sizes: '9, 9.5, 10' });
    expect(miss.error).toMatch(/Couldn't read/);
  });

  test('the card says what is approved, bought or on its way but not in the warehouse yet', async ({ request }) => {
    const sku = `NH${Date.now() % 1e7}-001`;
    const shoe = { ...LINE, sku };
    const first = await newRequest(request, { lines: [{ ...shoe, size: '8' }, { ...shoe, size: '9' }, { ...shoe, size: '11' }] });
    const firstLines = (await read_(request, 'approver', `cart/get?id=${first}`)).body.cart.lines;
    const bySize = Object.fromEntries(firstLines.map((l) => [l.size, Number(l.id)]));
    await call(request, 'approver', 'cart/decide', { cartId: first, lineIds: [bySize[8], bySize[9]], action: 'approve', qty: { [bySize[8]]: 2, [bySize[9]]: 2 } });
    await call(request, 'approver', 'cart/decide', { cartId: first, lineIds: [bySize[11]], action: 'reject', reason: 'E2E' });

    // An order with one box on its way, one still being packed, and one already received.
    const po = Number((await pool.query(`INSERT INTO purchase_orders (supplier_name, status) VALUES ('E2E Not Here', 'shipped') RETURNING id`)).rows[0].id);
    const box = async (n, status) => Number((await pool.query(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1,$2,$3,$4) RETURNING id`, [po, n, `NH${po}B${n}`, status])).rows[0].id);
    const lineIn = (boxId, size, qty) => pool.query(`INSERT INTO po_lines (po_id, po_box_id, sku, size, qty_expected) VALUES ($1,$2,$3,$4,$5)`, [po, boxId, sku, size, qty]);
    await lineIn(await box(1, 'in_transit'), '8', 1);
    await lineIn(await box(2, 'pending'), '10', 1);
    await lineIn(await box(3, 'delivered'), '12', 1);
    const batch = Number((await pool.query(`INSERT INTO batches (batch_code, supplier_name, status, kind, po_id) VALUES ($1,'E2E Not Here','committed','receiving',$2) RETURNING id`, [`NH-${po}`, po])).rows[0].id);
    await pool.query(`INSERT INTO items (vin, batch_id, sku, size, name, status) VALUES ($1,$2,$3,'12','E2E','needs_shelf')`, [`SBM-NH-${po}`, batch, sku]);
    const order = Number((await pool.query(`INSERT INTO online_orders (store, order_number) VALUES ('E2E Shop', $1) RETURNING id`, [`NH-${po}`])).rows[0].id);
    await pool.query(`INSERT INTO online_order_lines (order_id, sku, size, qty, unit_price) VALUES ($1,$2,'9',1,100), ($1,$2,'13',1,100)`, [order, sku]);
    await pool.query(`UPDATE online_order_lines SET cancelled_at = now() WHERE order_id = $1 AND size = '13'`, [order]);

    // The approved pairs name the request they are on, the way everyone calls it ("BC-13").
    const code = (await pool.query(`SELECT cart_code FROM buy_carts WHERE id = $1`, [first])).rows[0].cart_code;
    expect(code).toMatch(/^BC-\d+$/);
    const { card } = await groupCard(request, [{ ...shoe, size: '8' }, { ...shoe, size: '9' }]);
    expect(card.text).toContain([
      'Not in warehouse yet: 8 ×3, 9 ×3, 10 ×1',
      `Approved, not bought yet: 8 ×2, 9 ×2 (From ${code})`,
      'Bought, not shipped yet: 10 ×1',
      'Shipped: 8 ×1',
      'Online orders: 9 ×1',
    ].join('\n'));
    expect(card.text).toContain('No quantity means 1.');

    // Once there is a receipt, the receipt says what was bought, not the approval.
    await pool.query(`INSERT INTO buy_cart_receipt_lines (cart_id, sku, size, qty, source) VALUES ($1,$2,'8',1,'manual')`, [first, sku]);
    const { card: next } = await groupCard(request, [{ ...shoe, size: '8' }, { ...shoe, size: '9' }]);
    expect(next.text).toContain('Not in warehouse yet: 8 ×2, 9 ×1, 10 ×1');
    expect(next.text).not.toContain('Approved, not bought yet');
    // The receipt's pair names its request; the order's unpacked pair is said to be beside it.
    expect(next.text).toContain(`Bought, not shipped yet: 8 ×1, 10 ×1 (From ${code} + a purchase order)`);
    expect(next.text).toContain('Shipped: 8 ×1\n');

    // Older than 30 days is stuck rather than coming.
    await pool.query(`UPDATE online_orders SET created_at = now() - interval '31 days' WHERE id = $1`, [order]);
    await pool.query(`UPDATE purchase_orders SET created_at = now() - interval '29 days' WHERE id = $1`, [po]);
    const { card: month } = await groupCard(request, [{ ...shoe, size: '8' }, { ...shoe, size: '9' }]);
    expect(month.text).toContain('Not in warehouse yet: 8 ×2, 10 ×1');
    expect(month.text).not.toContain('Online orders');

    // The website says the same, to staff and not to a supplier.
    const page_ = await call(request, 'approver', 'cart/not-here', { cartId: first });
    expect(page_.status).toBe(200);
    expect(page_.body.shoes.find((x) => x.sku === sku).summary.sizes).toEqual([{ size: '8', qty: 2 }, { size: '10', qty: 1 }]);
    expect((await call(request, 'buyer', 'cart/not-here', { cartId: first })).status).toBe(403);

    const { card: quiet } = await groupCard(request, [{ ...LINE, sku: `NH${Date.now() % 1e7}-002`, size: '8' }, { ...LINE, sku: `NH${Date.now() % 1e7}-002`, size: '9' }]);
    expect(quiet.text).toContain('Not in warehouse yet: none.');
  });

  test('a reply with sizes and no quantity buys one of each and says so', async ({ request }) => {
    const { cartId, row } = await groupCard(request);
    const t0 = calls.length;
    await hook(request, replyUpdate(row, '9, 10', { replyId: 720101 }));
    expect(await statuses(cartId)).toEqual({ 9: 'approved ×1', '9.5': 'rejected', 10: 'approved ×1' });
    const reply = since(t0).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(CHAT)).pop();
    expect(reply.body.text).toContain('approved 9 ×1, 10 ×1 (2 pairs)');
    expect(reply.body.text).toContain('No quantity on 9, 10, so 1 pair each.');
  });

  test('replying the size itself to a one-size card buys one, not that many', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [{ ...LINE, size: '9' }] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const onCard = (text, replyId) => ({
      update_id: Date.now(),
      message: {
        message_id: replyId, chat: { id: CHAT, type: 'supergroup' }, from: { id: TG, first_name: 'Tapper' }, text,
        reply_to_message: { message_id: 4344, chat: { id: CHAT },
          reply_markup: { inline_keyboard: [[{ text: '✓ Buy 1', callback_data: `approve:${cartId}:${line.id}:1:dev` }],
            [{ text: '✕ Turn it down', callback_data: `reject:${cartId}:${line.id}:dev` }]] } },
      },
    });
    const now = async () => (await pool.query('SELECT status, qty FROM buy_cart_lines WHERE id = $1', [line.id])).rows[0];
    await hook(request, onCard('9', 740101));
    expect(await now()).toMatchObject({ status: 'approved', qty: 1 });
    await hook(request, onCard('2', 740102));                     // any other number is how many
    expect(await now()).toMatchObject({ status: 'approved', qty: 2 });
    await hook(request, onCard('9 pairs', 740103));               // and it can always be said outright
    expect(await now()).toMatchObject({ status: 'approved', qty: 9 });
  });

  test('the buyer finds more: a pending count goes up, an approved pair stays and a new question goes out', async ({ request }) => {
    // The card waits on the background market read (Alias can take 20 s+ locally).
    test.setTimeout(90_000);
    const cartId = await newRequest(request, { lines: [LINE], submit: false });
    await pool.query(`UPDATE buy_carts SET status = 'submitted' WHERE id = $1`, [cartId]);
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const lineId = Number(line.id);
    const more = (who, n, id = lineId) => call(request, who, 'cart/line', { cartId, lineId: id, more: n });
    const cardSaying = (t0, text) => since(t0).find((c) => ['sendMessage', 'sendPhoto'].includes(c.method) && String(c.body.text || c.body.caption || '').includes(text));

    expect((await more('approver', 2)).status).toBe(403);
    expect((await more('buyer', 0)).status).toBe(400);
    expect((await more('buyer', 1.5)).status).toBe(400);

    // Still a question: the shop's count goes up, and the group is told what moved.
    let t0 = calls.length;
    expect((await more('buyer', 2)).body.line.available_qty).toBe(2);
    expect((await more('buyer', 3)).body.line.available_qty).toBe(5);
    await expect.poll(() => !!cardSaying(t0, '➕ FOUND MORE') && !!cardSaying(t0, 'in store 2 → 5')).toBe(true);
    expect((await pool.query('SELECT qty, status FROM buy_cart_lines WHERE id = $1', [lineId])).rows[0]).toMatchObject({ qty: null, status: 'pending' });

    // Approved: that decision is untouched and the extra pairs are a new, unanswered line.
    await call(request, 'approver', 'cart/decide', { cartId, lineIds: [lineId], action: 'approve', qty: { [lineId]: 2 } });
    const before = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.approved_amount;
    t0 = calls.length;
    const asked = await more('buyer', 3);
    expect(asked.status).toBe(200);
    expect(Number(asked.body.line.id)).not.toBe(lineId);
    expect(asked.body.line).toMatchObject({ sku: LINE.sku, size: LINE.size, status: 'pending', available_qty: 3, qty: null });
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines.find((l) => Number(l.id) === lineId)).toMatchObject({ status: 'approved', qty: 2 });
    expect(after.approved_amount).toBe(before);
    await expect.poll(() => !!cardSaying(t0, `3 more of size ${LINE.size}. Already approved ×2`), { timeout: 60_000 }).toBe(true);
    const fresh = Number(asked.body.line.id);
    await call(request, 'approver', 'cart/decide', { cartId, lineIds: [fresh], action: 'reject', reason: 'Enough' });
    expect((await more('buyer', 1, fresh)).status).toBe(409);

    // A closed list has to be re-opened first, as with any other add.
    await pool.query(`UPDATE buy_carts SET list_closed_at = now() WHERE id = $1`, [cartId]);
    const closed = await more('buyer', 1);
    expect(closed.status).toBe(409);
    expect(closed.body.error).toMatch(/re-open/);
  });

  // Andrew, 2026-11-10: Found more of a DIFFERENT size of the same shoe.
  test('the buyer finds more of another size: a new size is a new ask, a size already there is that size’s Found more', async ({ request }) => {
    // The card waits on the background market read (Alias can take 20 s+ locally).
    test.setTimeout(90_000);
    const cartId = await newRequest(request, { lines: [{ ...LINE, upc: '000000000009' }], submit: false });
    await pool.query(`UPDATE buy_carts SET status = 'submitted' WHERE id = $1`, [cartId]);
    const nine = Number((await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0].id);
    const more = (n, extra = {}, id = nine) => call(request, 'buyer', 'cart/line', { cartId, lineId: id, more: n, ...extra });
    const cardSaying = (t0, text) => since(t0).find((c) => ['sendMessage', 'sendPhoto'].includes(c.method) && String(c.body.text || c.body.caption || '').includes(text));
    const bySize = async (size) => (await pool.query('SELECT * FROM buy_cart_lines WHERE cart_id = $1 AND size = $2 ORDER BY id', [cartId, size])).rows;

    expect((await more(1, { size: 'n/a' })).status).toBe(400);

    // A size not on the request: a new pending line, the shoe's price carried over (or the
    // one typed), never the other size's UPC, and its own card saying it's a new size.
    let t0 = calls.length;
    const fresh = await more(2, { size: '10' });
    expect(fresh.status).toBe(200);
    expect(fresh.body.line).toMatchObject({ sku: LINE.sku, size: '10', status: 'pending', available_qty: 2, qty: null });
    expect((await bySize('10'))[0]).toMatchObject({ shelf_price: '50.00', upc: null });
    await expect.poll(() => !!cardSaying(t0, 'a new size of this shoe, size 10'), { timeout: 60_000 }).toBe(true);
    expect((await more(1, { size: '11', shelfPrice: 64 })).status).toBe(200);
    expect((await bySize('11'))[0].shelf_price).toBe('64.00');

    // That size is already there and unanswered: its count goes up, no second line.
    t0 = calls.length;
    expect((await more(3, { size: '10' })).body.line.available_qty).toBe(5);
    expect(await bySize('10')).toHaveLength(1);
    await expect.poll(() => !!cardSaying(t0, 'size 10, in store 2 → 5')).toBe(true);

    // Turned down: nothing to add to, from any row. A turned-down row can still find another size.
    const tenId = Number((await bySize('10'))[0].id);
    await call(request, 'approver', 'cart/decide', { cartId, lineIds: [tenId], action: 'reject', reason: 'E2E: no' });
    const refused = await more(1, { size: '10' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/turned down/);
    expect((await more(1, { size: '12' }, tenId)).status).toBe(200);
    expect((await bySize('12'))[0]).toMatchObject({ status: 'pending', available_qty: 1 });
    // Its card goes out after a background market read. Wait for it (and size 11's) here, or
    // it lands in the next test's capture and that test reads the wrong card.
    await expect.poll(() => !!cardSaying(t0, 'size 12 (1 in the shop)') && !!cardSaying(0, 'size 11 (1 in the shop)'), { timeout: 60_000 }).toBe(true);
  });

  test('a typed reply to a ONE-size card is read too, not dropped', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    const onCard = (text, replyId) => ({
      update_id: Date.now(),
      message: {
        message_id: replyId, chat: { id: CHAT, type: 'supergroup' }, from: { id: TG, first_name: 'Tapper' }, text,
        reply_to_message: { message_id: 4343, chat: { id: CHAT },
          reply_markup: { inline_keyboard: [[{ text: '✓ Buy 1', callback_data: `approve:${cartId}:${line.id}:1:dev` }],
            [{ text: '✕ Turn it down', callback_data: `reject:${cartId}:${line.id}:dev` }]] } },
      },
    });
    const now = async () => (await pool.query('SELECT status, qty FROM buy_cart_lines WHERE id = $1', [line.id])).rows[0];
    await hook(request, onCard('Yes', 740001));
    expect(await now()).toMatchObject({ status: 'approved', qty: 1 });
    await hook(request, onCard('3', 740002));
    expect(await now()).toMatchObject({ status: 'approved', qty: 3 });
    await hook(request, onCard('pass', 740003));
    expect(await now()).toMatchObject({ status: 'rejected' });
  });

  test('two replies to one card at once never mix — the newer one stands whole', async ({ request }) => {
    const { cartId, row } = await groupCard(request);
    await Promise.all([
      hook(request, replyUpdate(row, '9 x 2', { replyId: 710001 })),
      hook(request, replyUpdate(row, '10 x 1', { replyId: 710002 })),
    ]);
    expect(await statuses(cartId)).toEqual({ 9: 'rejected', '9.5': 'rejected', 10: 'approved ×1' });
  });

  // PREMIUM + a PROPOSED TIP (docs/context/buy-cart.md "Premium shoes"): the card says who is
  // proposing what, and "tip ok" / "tip no" / "tip 5" in a reply answers it for the whole shoe.
  const PREMIUM_RUN = RUN.map((l) => ({ ...l, premium: true, tipProposed: 10 }));
  const costs = async (cartId) => Object.fromEntries((await pool.query(
    'SELECT size, final_cost FROM buy_cart_lines WHERE cart_id = $1', [cartId])).rows.map((r) => [r.size, Number(r.final_cost)]));

  test('a premium shoe with a proposed tip: the card names who proposes what, and the cost carries it', async ({ request }) => {
    const { cartId, card } = await groupCard(request, PREMIUM_RUN);
    expect(card.text).toContain(`⭐ PREMIUM — ${people.buyer.name} is proposing a $10.00 tip per pair`);
    expect(card.text).toContain('reply "tip ok" to approve it, "tip no" to decline, or "tip 5"');
    // The tip is part of what the pair costs us: $50 through the fixture's stack is $54.80
    // (gift 8 %, tax 8.25 %, tip $5; shipping joins later) — plus this shoe's $10 tip.
    expect((await costs(cartId))['9']).toBeCloseTo(64.80, 2);   // shipping joins at the end, when the labels are known
    const line = (await pool.query(`SELECT premium, tip_proposed, tip_status FROM buy_cart_lines WHERE cart_id = $1 AND size = '9'`, [cartId])).rows[0];
    expect(line).toMatchObject({ premium: true, tip_proposed: '10.00', tip_status: 'proposed' });
  });

  // Whoever holds `premium_ping` (Alex, 2026-11-04) is @-mentioned on a PREMIUM shoe's card —
  // a Telegram mention by user id, so it pings them even with no public @username.
  test('a premium shoe pings the people holding "Tagged on premium shoes"; an ordinary one pings nobody', async ({ request }) => {
    await pool.query(`UPDATE users SET privileges = array_append(privileges, 'premium_ping') WHERE id = $1`, [people.approver.uid]);
    try {
      const tgId = Number((await pool.query('SELECT telegram_user_id FROM users WHERE id = $1', [people.approver.uid])).rows[0].telegram_user_id);
      expect(tgId).toBeGreaterThan(0);
      const { card } = await groupCard(request, PREMIUM_RUN);
      const ping = card.text.split('\n').find((l) => l.startsWith('🔔 '));
      expect(ping).toContain(`${people.approver.name}`);
      expect(ping).toMatch(/— premium shoe, please take a look$/);
      const m = (card.entities || []).find((e) => e.type === 'text_mention' && e.user.id === tgId);
      expect(m).toBeTruthy();
      expect(card.text.slice(m.offset, m.offset + m.length)).toBe(people.approver.name);
      const plain = await groupCard(request);
      expect(plain.card.text).not.toContain('🔔');
      expect((plain.card.entities || []).some((e) => e.type === 'text_mention')).toBe(false);
    } finally {
      await pool.query(`UPDATE users SET privileges = array_remove(privileges, 'premium_ping') WHERE id = $1`, [people.approver.uid]);
    }
  });

  test('"tip 7" beside the sizes approves the sizes AND a $7 tip — and re-prices the run', async ({ request }) => {
    const { cartId, row } = await groupCard(request, PREMIUM_RUN);
    const before = await costs(cartId);
    const t0 = calls.length;
    await hook(request, replyUpdate(row, '9 x 1\ntip 7'));
    expect(await statuses(cartId)).toEqual({ 9: 'approved ×1', '9.5': 'rejected', 10: 'rejected' });
    const tips = (await pool.query('SELECT tip_status, tip_approved, tip_decided_by FROM buy_cart_lines WHERE cart_id = $1', [cartId])).rows;
    expect(tips.every((t) => t.tip_status === 'approved' && t.tip_approved === '7.00' && t.tip_decided_by === people.approver.name)).toBe(true);
    expect((await costs(cartId))['9'] - before['9']).toBeCloseTo(-3, 2);
    const said = since(t0).filter((c) => c.method === 'sendMessage').map((c) => c.body.text);
    expect(said).toContain(`💵 ${people.approver.name} approved the tip for CW2288-111: $7.00 per pair (proposed $10.00) · [dev]`);
  });

  test('"tip ok" on a card with no tip records nothing and says so', async ({ request }) => {
    const { cartId, row } = await groupCard(request);
    const t0 = calls.length;
    await hook(request, replyUpdate(row, 'tip ok'));
    expect(await statuses(cartId)).toEqual({ 9: 'pending', '9.5': 'pending', 10: 'pending' });
    expect(since(t0).find((c) => c.method === 'sendMessage').body.text).toBe('⚠️ This shoe isn’t premium and has no tip proposed, so nothing was recorded. · [dev]');
  });

  // Premium with the tip box left BLANK: the tip is the desk's call. "tip 8" sets it;
  // "tip ok" has nothing to approve and says so.
  test('a premium shoe with no tip proposed: the desk sets one with "tip 8"', async ({ request }) => {
    const { cartId, row, card } = await groupCard(request, RUN.map((l) => ({ ...l, premium: true })));
    expect(card.text).toContain(`⭐ PREMIUM — ${people.buyer.name} proposed no tip, so the tip is the desk’s call`);
    expect(card.text).toContain('To set one, reply "tip 10"');
    let t0 = calls.length;
    await hook(request, replyUpdate(row, 'tip ok', { replyId: 720001 }));
    expect(since(t0).find((c) => c.method === 'sendMessage').body.text).toBe('⚠️ No tip was proposed for this shoe — say the amount, like "tip 10". · [dev]');
    t0 = calls.length;
    await hook(request, replyUpdate(row, 'tip 8', { replyId: 720002 }));
    expect(since(t0).find((c) => c.method === 'sendMessage').body.text).toBe(`💵 ${people.approver.name} set a $8.00 tip per pair for CW2288-111 (none was proposed) · [dev]`);
    const tips = (await pool.query('SELECT tip_status, tip_approved, tip_proposed FROM buy_cart_lines WHERE cart_id = $1', [cartId])).rows;
    expect(tips.every((t) => t.tip_status === 'approved' && t.tip_approved === '8.00' && t.tip_proposed == null)).toBe(true);
    // $50 through the fixture's stack is $63.05 — plus the $8 the desk set.
    expect((await costs(cartId))['9']).toBeCloseTo(62.80, 2);   // no shipping until the labels are known
    expect(await statuses(cartId)).toEqual({ 9: 'pending', '9.5': 'pending', 10: 'pending' });
  });

  test('the request page answers the tip too — approvers only — and a declined tip leaves the cost', async ({ request }) => {
    const { cartId } = await groupCard(request, PREMIUM_RUN);
    const before = await costs(cartId);
    expect((await call(request, 'buyer', 'cart/tip', { cartId, sku: 'CW2288-111', action: 'approve' })).status).toBe(403);
    const out = await call(request, 'approver', 'cart/tip', { cartId, sku: 'CW2288-111', action: 'decline' });
    expect(out.status).toBe(200);
    expect(out.body.outcome).toBe(`${people.approver.name} declined the $10.00 tip for CW2288-111`);
    expect((await costs(cartId))['10'] - before['10']).toBeCloseTo(-10, 2);
    const view = (await read_(request, 'buyer', `cart/get?id=${cartId}`)).body.cart.lines[0];
    expect(view).toMatchObject({ premium: true, tip_status: 'declined', tip_proposed: 10 });
  });

  test('cart/line refuses the same size twice in one ask — the card could not tell them apart', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [], submit: false });
    const out = await call(request, 'approver', 'cart/line', { cartId, lines: [LINE, { ...LINE }] });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/twice/);
  });

  test('cart/line takes several sizes of ONE shoe in one call, and refuses two shoes', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [], submit: false });
    const ok = await call(request, 'approver', 'cart/line', { cartId, lines: RUN });
    expect(ok.status).toBe(200);
    expect(ok.body.lines.map((l) => l.size)).toEqual(['9', '9.5', '10']);
    const mixed = await call(request, 'approver', 'cart/line', { cartId, lines: [LINE, { ...LINE, sku: 'DZ5485-201' }] });
    expect(mixed.status).toBe(400);
    expect(mixed.body.error).toMatch(/One shoe per ask/);
  });

  test('a quantity tapped on the picker is answered on the CARD, and spends the question', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    await hook(request, tapUpdate(`more:${cartId}:${line.id}:dev`, { messageId: 880 }));
    let t0 = calls.length;
    // The picker message (id 881) replies to the card (880); the tap lands on the picker.
    const pick = tapUpdate(`approve:${cartId}:${line.id}:8:dev`, { messageId: 881 });
    pick.callback_query.message.reply_to_message = { message_id: 880 };
    await hook(request, pick);
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].status).toBe('approved');
    const reply = since(t0).find((c) => c.method === 'sendMessage');
    expect(reply.body.text).toContain('8 pairs');
    expect(reply.body.reply_parameters.message_id).toBe(880);
    expect(since(t0).find((c) => c.method === 'setMessageReaction').body.message_id).toBe(880);
    // The question is spent: a number typed afterwards decides nothing.
    t0 = calls.length;
    await hook(request, { update_id: 3, message: { message_id: 902, text: '3', from: { id: TG }, chat: { id: CHAT } } });
    expect(since(t0).length).toBe(0);
  });

  // A buyer's own PREMIUM group (users.premium_chat_id — "Andrew's Premium Shoes", 2026-11-04):
  // their premium cards go there, the rest stays in the main group, and the group is answered.
  test('a card too long to be a caption still gets its picture: photo first, then the card with its buttons', async ({ request }) => {
    test.skip(!process.env.R2_ACCOUNT_ID, 'needs real storage to hold a real photo');
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#336' } }).jpeg().toBuffer();
    const { sendApprovalCard } = await import('../api/_lib/telegram.js');
    const cartId = await newRequest(request, { submit: false, lines: [] });
    const signed = await call(request, 'buyer', 'cart/file-sign', { cartId, kind: 'shoe', contentType: 'image/jpeg', sku: LINE.sku });
    expect((await fetch(signed.body.uploadUrl, { method: 'PUT', body: jpeg })).ok).toBe(true);
    const attached = await call(request, 'buyer', 'cart/file-attach', { cartId, kind: 'shoe', key: signed.body.key, sku: LINE.sku, name: 's.jpg', contentType: 'image/jpeg', sizeBytes: jpeg.length });
    expect(attached.status).toBe(200);
    const keep = { ...process.env };
    process.env.TELEGRAM_BOT_TOKEN = 'test'; process.env.TELEGRAM_CHAT_ID = String(CHAT); process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:5198';
    const t0 = calls.length;
    try {
      const msg = await sendApprovalCard({ caption: 'x'.repeat(1500), keyboard: { inline_keyboard: [] }, photoFileId: Number(attached.body.file.id), chatId: CHAT });
      const sent = since(t0).filter((c) => ['sendPhoto', 'sendMessage'].includes(c.method));
      expect(sent.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
      expect(sent[1].body.text).toBe('x'.repeat(1500));     // no "unavailable" warning
      expect(sent[1].body.reply_markup).toBeTruthy();
      expect(msg.message_id).toBeTruthy();                  // what replies attach to
    } finally {
      for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API_BASE']) {
        if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
      }
      await call(request, 'approver', 'cart/file-delete', { cartId, fileId: Number(attached.body.file.id) });
    }
  });

  // "⚠️ Photo unavailable (fetch failed)" in Andrew's premium group, 2026-11-12: one dropped
  // connection on the R2 read cost the card its picture. A dropped READ is now tried again.
  test('a dropped connection reading the photo is tried again — the card still gets its picture', async ({ request }) => {
    test.skip(!process.env.R2_ACCOUNT_ID, 'needs real storage to hold a real photo');
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#363' } }).jpeg().toBuffer();
    const { sendApprovalCard } = await import('../api/_lib/telegram.js');
    const cartId = await newRequest(request, { submit: false, lines: [] });
    const signed = await call(request, 'buyer', 'cart/file-sign', { cartId, kind: 'shoe', contentType: 'image/jpeg', sku: LINE.sku });
    expect((await fetch(signed.body.uploadUrl, { method: 'PUT', body: jpeg })).ok).toBe(true);
    const attached = await call(request, 'buyer', 'cart/file-attach', { cartId, kind: 'shoe', key: signed.body.key, sku: LINE.sku, name: 's.jpg', contentType: 'image/jpeg', sizeBytes: jpeg.length });
    expect(attached.status).toBe(200);
    const keep = { ...process.env };
    const realFetch = globalThis.fetch;
    let dropped = 0;
    globalThis.fetch = (url, opts) => {
      if (String(url).includes(signed.body.key.split('/').pop()) && dropped === 0) {
        dropped += 1;
        return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }));
      }
      return realFetch(url, opts);
    };
    process.env.TELEGRAM_BOT_TOKEN = 'test'; process.env.TELEGRAM_CHAT_ID = String(CHAT); process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:5198';
    const t0 = calls.length;
    try {
      await sendApprovalCard({ caption: 'retry me', keyboard: { inline_keyboard: [] }, photoFileId: Number(attached.body.file.id), chatId: CHAT });
      expect(dropped).toBe(1);
      const sent = since(t0).filter((c) => ['sendPhoto', 'sendMessage'].includes(c.method));
      expect(sent.map((c) => c.method)).toEqual(['sendPhoto']); // the picture, with the card on it
    } finally {
      globalThis.fetch = realFetch;
      for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API_BASE']) {
        if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
      }
      await call(request, 'approver', 'cart/file-delete', { cartId, fileId: Number(attached.body.file.id) });
    }
  });

  test('a long card whose photo cannot be read says so, and still goes', async ({ request }) => {
    const { sendApprovalCard } = await import('../api/_lib/telegram.js');
    const keep = { ...process.env };
    process.env.TELEGRAM_BOT_TOKEN = 'test'; process.env.TELEGRAM_CHAT_ID = String(CHAT); process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:5198';
    const t0 = calls.length;
    try {
      await sendApprovalCard({ caption: 'y'.repeat(1500), keyboard: { inline_keyboard: [] }, photoFileId: 999999999, chatId: CHAT });
      const sent = since(t0).filter((c) => ['sendPhoto', 'sendMessage'].includes(c.method));
      expect(sent.map((c) => c.method)).toEqual(['sendMessage']);
      expect(sent[0].body.text).toMatch(/^⚠️ Photo unavailable/);
    } finally {
      for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API_BASE']) {
        if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
      }
    }
  });

  test('a buyer’s premium group gets their PREMIUM cards; replies there count; the rest stays in the main group', async ({ request }) => {
    const PREMIUM_CHAT = -1007770001;
    const H = () => ({ Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Admin', role: 'admin' })}` });
    const setChat = await request.post('/api/admin/review', { headers: H('admin'), data: { userId: people.buyer.uid, decision: 'premium_chat', premiumChatId: String(PREMIUM_CHAT) } });
    expect(setChat.ok(), await setChat.text()).toBeTruthy();
    expect((await request.post('/api/admin/review', { headers: H('admin'), data: { userId: people.buyer.uid, decision: 'premium_chat', premiumChatId: '12345' } })).status()).toBe(400);
    try {
      const prem = await groupCard(request, PREMIUM_RUN);
      expect(String(prem.card.chat_id)).toBe(String(PREMIUM_CHAT));
      expect(String(prem.row.chat_id)).toBe(String(PREMIUM_CHAT));
      // A reply IN the premium group is read like one in the main group.
      const upd = replyUpdate(prem.row, '9 x 1');
      upd.message.chat.id = PREMIUM_CHAT; upd.message.reply_to_message.chat.id = PREMIUM_CHAT;
      await hook(request, upd);
      expect(await statuses(prem.cartId)).toEqual({ 9: 'approved ×1', '9.5': 'rejected', 10: 'rejected' });
      // An ordinary shoe from the same buyer stays in the main group.
      const plain = await groupCard(request);
      expect(String(plain.card.chat_id)).toBe(String(CHAT));
    } finally {
      await request.post('/api/admin/review', { headers: H('admin'), data: { userId: people.buyer.uid, decision: 'premium_chat', premiumChatId: '' } });
    }
  });

  test('a tap from another chat is ignored', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    await hook(request, tapUpdate(`approve:${cartId}:${line.id}:1:dev`, { chat: -1009999 }));
    const after = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(after.lines[0].status).toBe('pending');
  });
});

// A run of one shoe is usually one ticket price, but it often breaks — the 12.5 and the
// 13 sit higher — and before this the only way to send those was a second request at a
// second price. The per-size boxes are the exception to the field above them, so the
// thing worth testing is that a BLANK box still sends the shelf price: a buyer who types
// nothing must not send $0.00, and a size they did type must not be overwritten by the
// common one.
//
// Driven through the real form on purpose. This arithmetic lives in the component, and a
// ReferenceError there builds perfectly cleanly — `setSizes is not defined` shipped once
// and only a rendered page ever found it.
test.describe('one price for the run, and the sizes that break it', () => {
  test('a blank box sends the shelf price, a typed one sends its own', async ({ page, request }) => {
    const cartId = await newRequest(request, { lines: [], submit: false });
    await shoePhotos(cartId, ['HV4091-006']);

    // The catalogue is an upstream call measured at 16-45s; stubbed so this test is about
    // the price arithmetic and not about whether Alias is awake.
    await page.route('**/api/sku-search', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        product: { sku: 'HV4091-006', name: "Air Jordan 1 Mid 'Patent Bred Toe'", colorway: 'Red', sizes: ['11', '12', '12.5'] },
      }),
    }));

    await as(page, 'buyer');
    await page.goto('/buying');
    await page.locator('.bc-row', { hasText: `BC-${cartId}` }).first().click();

    await page.getByPlaceholder('SKU or style code').fill('HV4091-006');
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.locator('.bc-sizes .size-chip').first()).toBeVisible();

    // ONE size is not a run: the per-size list stays out of the way until there is a rule
    // to make an exception to.
    await page.locator('.bc-sizes .size-chip').filter({ hasText: /^11$/ }).click();
    await page.locator('.bc-add-row .ph-price').fill('48');
    await expect(page.locator('.bc-size-prices')).toHaveCount(0);

    await page.locator('.bc-sizes .size-chip').filter({ hasText: /^12\.5$/ }).click();
    await expect(page.locator('.bc-size-prices')).toBeVisible();

    // 12.5 is ticketed higher. 11 is left blank, and the placeholder has to show what a
    // blank box will actually send — a row reading $0.00 beside a size is the kind of
    // thing somebody "fixes" by typing a zero.
    await page.getByLabel('Price for size 12.5').fill('58');
    expect(await page.getByLabel('Price for size 11').inputValue()).toBe('');
    expect(await page.getByLabel('Price for size 11').getAttribute('placeholder')).toBe('48.00');
    await expect(page.locator('.bc-sizes-note')).toContainText('1 priced differently');

    // And the button still speaks in sizes, not prices.
    await expect(page.getByRole('button', { name: 'Ask about 2 sizes' })).toBeEnabled();

    // SENDING CLEARS THE WHOLE FORM — code, shoe, sizes, price, photo count. The first
    // version kept the shoe for "the next size of the same style"; the buyer's report
    // was the opposite: a form still showing the last shoe was getting re-sent.
    await page.getByRole('button', { name: 'Ask about 2 sizes' }).click();
    await expect(page.locator('.bc-add-body')).toHaveCount(0);
    expect(await page.getByPlaceholder('SKU or style code').inputValue()).toBe('');
    await expect(page.locator(".bc-lines").filter({ hasText: "HV4091-006" })).toBeVisible();

    // The open request rides in the URL: a refresh inside it stays inside it, rather
    // than landing back on the queue.
    expect(page.url()).toContain(`request=${cartId}`);
    await page.reload();
    await expect(page.locator('.bc-code')).toHaveText(`BC-${cartId}`);
  });

  // What the supplier actually sends — "100000317 / Sizes 8-12 $50" — pasted. It FILLS THE
  // FORM for review and asks nothing until the buyer presses Ask (owner, 2026-10-24).
  test('a pasted "Sizes 11-13 $50" fills the form for review, and one press asks in one call', async ({ page, request }) => {
    const cartId = await newRequest(request, { lines: [], submit: false });
    await shoePhotos(cartId, ['HV4091-006']);
    await page.route('**/api/sku-search', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, product: { sku: 'HV4091-006', name: 'AJ1 Mid', sizes: ['11', '11.5', '12', '12.5'] } }),
    }));
    const posts = [];
    page.on('request', (r) => { if (r.url().includes('/api/cart/line') && r.method() === 'POST') posts.push(r.postDataJSON()); });

    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    await page.getByRole('button', { name: 'Paste' }).click();
    await page.getByPlaceholder(/100000317/).fill('HV4091-006\nSizes 11-13 $50');
    await page.getByRole('button', { name: 'Fill in the form' }).click();

    // Every half size selected, the price typed, and nothing sent yet.
    await expect(page.locator('.bc-paste-review')).toContainText('5 sizes at $50.00');
    await expect(page.locator('.bc-paste-review')).toContainText('Not in this shoe’s size list: 13');
    await expect(page.locator('.bc-sizes .size-chip.on')).toHaveText(['11', '11.5', '12', '12.5', '13']);
    expect(await page.locator('.bc-add-row .ph-price').inputValue()).toBe('50');
    expect(posts.length).toBe(0);

    // The buyer unticks the misread 13, then asks — ONE call for the four sizes.
    await page.locator('.bc-sizes .size-chip').filter({ hasText: /^13$/ }).click();
    await page.getByRole('button', { name: 'Ask about 4 sizes' }).click();
    await expect(page.locator('.bc-add-body')).toHaveCount(0);
    expect(posts.length).toBe(1);
    expect(posts[0].lines.map((l) => [l.size, l.shelfPrice])).toEqual([['11', 50], ['11.5', 50], ['12', 50], ['12.5', 50]]);
  });

  // PREMIUM → PROPOSE A TIP → the amount, each asked only after the one before is ticked
  // (docs/context/buy-cart.md "Premium shoes"); then the desk answers it on the request page.
  test('a premium shoe with a proposed tip: asked step by step, sent with the pair, answered by the desk', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const cartId = await newRequest(request, { lines: [], submit: false });
    await shoePhotos(cartId, ['IX8478-410']);
    await page.route('**/api/sku-search', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, product: { sku: 'IX8478-410', name: "Air Jordan 1 Low OG 'Howard University'", sizes: ['9', '10'] } }),
    }));
    const posts = [];
    page.on('request', (r) => { if (r.url().includes('/api/cart/line') && r.method() === 'POST') posts.push(r.postDataJSON()); });

    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    await page.getByPlaceholder('SKU or style code').fill('IX8478-410');
    await page.getByRole('button', { name: 'Look up' }).click();
    await page.locator('.bc-sizes .size-chip').filter({ hasText: /^9$/ }).click();
    await page.locator('.bc-sizes .size-chip').filter({ hasText: /^10$/ }).click();
    await page.locator('.bc-add-row .ph-price').fill('140');

    // The tip box waits for Premium, then comes straight up — optional, no extra tick
    // (2026-10-27): blank means the desk decides it.
    await expect(page.getByLabel('Tip per pair')).toHaveCount(0);
    await page.getByLabel('Premium shoe?').check();
    await expect(page.getByText('Leave it blank and the desk decides the tip.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ask about 2 sizes' })).toBeEnabled();
    await page.getByLabel('Tip per pair').fill('10');
    await page.locator('.bc-premium').screenshot({ path: 'test-results/premium-form.png' });
    await page.getByRole('button', { name: 'Ask about 2 sizes' }).click();
    await expect(page.locator('.bc-add-body')).toHaveCount(0);
    expect(posts[0].lines.map((l) => [l.size, l.premium, l.tipProposed])).toEqual([['9', true, 10], ['10', true, 10]]);

    // The desk: one set of buttons for the shoe, and the chip says what became of it.
    await as(page, 'approver');
    await page.goto(`/buy-carts?request=${cartId}`);
    await expect(page.locator('.bc-premium-tag .po-chip', { hasText: 'Tip $10.00/pair proposed' })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Approve tip' })).toHaveCount(1);
    await page.locator('.bc-lines').screenshot({ path: 'test-results/premium-desk.png' });
    await page.getByRole('button', { name: 'Approve tip' }).click();
    await expect(page.locator('.bc-premium-tag .po-chip', { hasText: 'Tip $10.00/pair approved' })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Approve tip' })).toHaveCount(0);
  });

  test('the endpoint takes a different price per size on one request', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [], submit: false });
    for (const [size, shelfPrice] of [['11', 48], ['12.5', 58], ['13', 58]])
      await call(request, 'approver', 'cart/line', { cartId, line: { ...LINE, size, shelfPrice, qty: null } });

    const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
    const byPrice = Object.fromEntries(body.cart.lines.map((l) => [l.size, Number(l.shelf_price)]));
    expect(byPrice['11']).toBe(48);
    expect(byPrice['12.5']).toBe(58);
    expect(byPrice['13']).toBe(58);
  });
});

// Buying is switched on PER SUPPLIER. Most suppliers only ship us boxes; a portal that
// showed every one of them a "Buying Requests" card would invite requests from people
// nobody decided may spend company money. The gate is a privilege, read fresh, so it
// closes on the next call — and it is the only privilege a supplier can hold.
test('a supplier not switched on for buying sees no card, and every cart call is refused', async ({ page, request }) => {
  const { status, body } = await call(request, 'shipper', 'cart/create', { merchant: 'nike', retailer: 'E2E Store', purpose: 'E2E: should never open' });
  expect(status).toBe(403);
  expect(body.error).toMatch(/raise buying requests/i);
  expect((await read_(request, 'shipper', 'cart/list')).status).toBe(403);

  await as(page, 'shipper');
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'Purchase Orders' })).toBeVisible();
  await expect(page.locator('.home-card', { hasText: 'Buying Requests' })).toHaveCount(0);
  // A typed /buying lands back on home rather than on a screen of 403s.
  await page.goto('/buying');
  await expect(page.locator('.home-card', { hasText: 'Purchase Orders' })).toBeVisible();
  await expect(page.locator('.bc-table-wrap')).toHaveCount(0);

  // The one privilege a supplier CAN hold is this one; the staff duties never stick.
  await pool.query(`UPDATE users SET privileges = '{}' WHERE id = $1`, [people.buyer.uid]);
  try {
    expect((await read_(request, 'buyer', 'cart/list')).status).toBe(403); // revoked underneath a live token
    const sneaky = await request.post('/api/admin/review', {
      headers: { Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' })}` },
      data: { userId: people.buyer.uid, decision: 'privileges', privileges: ['approve_buying', 'request_buying', 'audit_buying'] },
    });
    expect(sneaky.status()).toBe(200);
    const after = await sneaky.json();
    expect(after.user.privileges).toEqual(['request_buying']);
    expect(after.note).toMatch(/only hold/i);
    expect((await read_(request, 'buyer', 'cart/list')).status).toBe(200);
  } finally {
    await pool.query(`UPDATE users SET privileges = $2 WHERE id = $1`, [people.buyer.uid, people.buyer.privileges]);
  }
});

// ---------------------------------------------------------------------------
// The buyer's list is OPEN until they close it (2026-09-16).
//
// Every add is its own question — the desk decides pair by pair — and "Close the
// request" is what says the list is complete. The gift-card desk funds nothing against a
// list still growing; the buyer can re-open it (the group is told) until the receipt is
// in, and a re-opened, funded request keeps its cards and takes a top-up.
test('pair tally: pairs are the decided quantity, SKUs are distinct style codes (pure)', async () => {
  const { pairTally, pairTallyText } = await import('../src/lib/buycartRules.js');
  const t = pairTally([
    { sku: 'DD1391-100', size: '9', qty: 2 }, { sku: 'dd1391-100 ', size: '10', qty: 1 },
    { sku: 'FD9082-102', size: '8.5', qty: 3 }, { sku: 'FD9082-102', size: '9', qty: null },
  ]);
  expect(t).toEqual({ pairs: 6, skus: 2, lines: 4, undecided: 1 });
  expect(pairTallyText(t)).toBe('6 pairs (2 SKUs)');
  expect(pairTallyText(pairTally([{ sku: 'A', qty: 1 }]))).toBe('1 pair (1 SKU)');
  expect(pairTally([])).toEqual({ pairs: 0, skus: 0, lines: 0, undecided: 0 });
});

test('a size with no quantity is one pair, and the answer says so (pure)', async () => {
  const { parseApprovalReply } = await import('../src/lib/buyPaste.js');
  const L = ['8', '9', '10', '10.5W'].map((size, i) => ({ id: i + 1, size }));
  const q = (t) => { const r = parseApprovalReply(t, L); return r.ok ? r.approve.map((a) => `${a.line.size}x${a.qty}`).join(' ') : r.error; };
  for (const said of ['8, 9', '8 9', '8 and 9', '8\n9', '8-9']) expect(q(said)).toBe('8x1 9x1');
  expect(q('8-10')).toBe('8x1 9x1 10x1');
  expect(q('8 to 9')).toBe('8x1 9x1');
  expect(q('10.5')).toBe('10.5Wx1');
  expect(q('8\n9 x 2')).toBe('8x1 9x2');            // a mix keeps the number that was said
  expect(q('9-3')).toBe('9x3');                     // falling numbers are still size, then quantity
  expect(q('8-9 x 2')).toBe('8x2 9x2');
  expect(parseApprovalReply('8, 9', L).reject.map((l) => l.size)).toEqual(['10', '10.5W']);
  expect(parseApprovalReply('8', L).note).toBe('No quantity on 8, so 1 pair.');
  expect(parseApprovalReply('8, 9', L).note).toBe('No quantity on 8, 9, so 1 pair each.');
  expect(parseApprovalReply('8 x 2', L).note).toBeNull();
  // Still strict about everything else: nothing recorded.
  expect(q('13')).toMatch(/13 isn’t on this card/);
  expect(q('8 13')).toMatch(/13 isn’t on this card/);
  expect(q('8, 8')).toMatch(/Size 8 is in the reply twice/);
  expect(q('8 maybe')).toMatch(/Couldn't read/);
});

test('each pair not here yet is counted once, at the furthest point it has reached (pure)', async () => {
  const { notHereSummary, notHereLines } = await import('../src/lib/notHere.js');
  const line = (po_id, size, qty, po_box_id = null, box_status = null, box_kind = 'original') => ({ po_id, size, qty, po_box_id, box_status, box_kind });
  const words = (input) => notHereLines(notHereSummary(input));
  expect(notHereLines(null)).toEqual(['Not in warehouse yet: could not be read.']);
  expect(words({})).toEqual(['Not in warehouse yet: none.']);
  expect(words({ approved: [{ size: '9', qty: 2 }, { size: '8', qty: 2 }] })).toEqual([
    'Not in warehouse yet: 8 ×2, 9 ×2', 'Approved, not bought yet: 8 ×2, 9 ×2',
  ]);
  // Which request(s) the pairs are on: each once, oldest first, whatever order the rows came in.
  expect(words({ approved: [
    { size: '11', qty: 2, cart_id: 14, cart_code: 'BC-14' },
    { size: '9.5', qty: 1, cart_id: 13, cart_code: 'BC-13' },
    { size: '11', qty: 1, cart_id: 13, cart_code: 'BC-13' },
  ] })).toEqual([
    'Not in warehouse yet: 9.5 ×1, 11 ×3', 'Approved, not bought yet: 9.5 ×1, 11 ×3 (From BC-13, BC-14)',
  ]);
  expect(words({ approved: [{ size: '9.5', qty: 1, cart_id: 13 }] })[1]).toBe('Approved, not bought yet: 9.5 ×1 (From BC-13)');
  // A receipt names its request too; an order's pairs in the same stage are counted beside it,
  // and the stages an order or an online buy fills name no request.
  expect(words({
    receipts: [{ size: '11', qty: 1, cart_id: 13, cart_code: 'BC-13' }],
    poLines: [line(1, '10', 1), line(2, '12', 2, 21, 'shipped')],
    online: [{ size: '9', qty: 1 }],
  })).toEqual([
    'Not in warehouse yet: 9 ×1, 10 ×1, 11 ×1, 12 ×2',
    'Bought, not shipped yet: 10 ×1, 11 ×1 (From BC-13 + a purchase order)',
    'Shipped: 12 ×2',
    'Online orders: 9 ×1',
  ]);
  // The order's list is what was paid for, so its boxes aren't added on top of it.
  expect(words({ poLines: [line(1, '9', 5), line(1, '9', 2, 11, 'in_transit')] })).toEqual([
    'Not in warehouse yet: 9 ×5', 'Bought, not shipped yet: 9 ×3', 'Shipped: 9 ×2',
  ]);
  // Arrival counted two ways is still one arrival.
  const arrived = { poLines: [line(1, '9', 2, 11, 'delivered'), line(1, '9', 2, 12, 'in_transit')], receivedBoxIds: [11], received: [{ po_id: 1, size: '9', qty: 2 }] };
  expect(notHereSummary(arrived).total).toBe(2);
  // Received in full is gone; a replacement label re-sends what is already expected.
  expect(notHereSummary({ poLines: [line(1, '9', 2, 11, 'delivered')], received: [{ po_id: 1, size: '9', qty: 2 }] }).total).toBe(0);
  expect(notHereSummary({ poLines: [line(1, '9', 2, 11, 'pending'), line(1, '9', 2, 12, 'shipped', 'replacement')] }).total).toBe(2);
  // More received than listed on one order doesn't cancel what another order still owes.
  expect(notHereSummary({ poLines: [line(1, '9', 1, 11, 'delivered'), line(2, '9', 2, 21, 'shipped')], received: [{ po_id: 1, size: '9', qty: 3 }] }).total).toBe(2);
  // The warehouse's 7.5W is the order's 7.5.
  expect(notHereSummary({ poLines: [line(1, '7.5', 1, 11, 'delivered')], received: [{ po_id: 1, size: '7.5W', qty: 1 }] }).total).toBe(0);
});

test.describe('the list stays open until the buyer closes it', () => {
  test('cards wait for the close; the close is the send; re-opening lets the buyer add again', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE], submit: false });
    // The staff-added line is data entry; the request is still a draft. The buyer's
    // own add is the question — it goes to `submitted` with no button pressed.
    await shoePhotos(cartId, ['DD1391-100']);
    const add = await call(request, 'buyer', 'cart/line', { cartId, line: { sku: 'DD1391-100', size: '10', shelfPrice: 130 } });
    expect(add.status).toBe(200);
    expect(add.body.cart.status).toBe('submitted');
    expect(add.body.cart.list_closed_at).toBeNull();

    // Approved line by line while the list is open…
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: 1 });
    let { body } = await read_(request, 'issuer', `cart/get?id=${cartId}`);
    expect(body.cart.status).toBe('approved');
    // …but the desk cannot fund a total that is still growing, and is told why.
    const early = await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '1212121212121212', balance: 500 } });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/still adding/i);

    // The buyer closes the list. Same checks as the old send (store, lines, photos).
    const closed = await call(request, 'buyer', 'cart/submit', { cartId });
    expect(closed.status).toBe(200);
    expect(closed.body.cart.list_closed_at).not.toBeNull();
    expect(closed.body.cart.list_closed_by).toBe(people.buyer.name);
    // Closing twice is a no-op refusal, not a second event.
    expect((await call(request, 'buyer', 'cart/submit', { cartId })).status).toBe(409);
    // Adding to a closed list is refused in the buyer's own words.
    const late = await call(request, 'buyer', 'cart/line', { cartId, line: { sku: 'DD1391-100', size: '11', shelfPrice: 130 } });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/re-open/i);

    // Now the desk can.
    const card = await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '1212121212121212', balance: 500 } });
    expect(card.status).toBe(200);

    // The buyer re-opens — the cards already recorded stay — and adds one more.
    const reopened = await call(request, 'buyer', 'cart/submit', { cartId, reopen: true });
    expect(reopened.status).toBe(200);
    expect(reopened.body.cart.list_closed_at).toBeNull();
    expect(reopened.body.cart.giftCards).toHaveLength(1);
    const more = await call(request, 'buyer', 'cart/line', { cartId, line: { sku: 'DD1391-100', size: '11', shelfPrice: 130 } });
    expect(more.status).toBe(200);
    // Something undecided again: the request is honest about it, and the desk is
    // refused a further card until the list is closed AND the new line decided.
    ({ body } = await read_(request, 'issuer', `cart/get?id=${cartId}`));
    expect(body.cart.status).toBe('submitted');
    expect(body.cart.pending_count).toBe(1);
    const again = await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '3434343434343434', balance: 10 } });
    expect(again.status).toBe(409);

    // The trail says both things happened, under the buyer's name.
    const kinds = body.cart.events.map((e) => e.kind);
    expect(kinds).toContain('list_closed');
    expect(kinds).toContain('list_reopened');
    expect(body.cart.events.find((e) => e.kind === 'list_reopened').actor_name).toBe(people.buyer.name);
  });

  test('a funded request can be re-opened for more: the cards stay, the new line is decided, the target grows', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });          // $108.25 to fund
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '5656565656565656', balance: 108.25 } });
    expect((await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true })).body.cart.status).toBe('funded');

    // Short at the till — the buyer re-opens and asks about one more pair.
    expect((await call(request, 'buyer', 'cart/submit', { cartId, reopen: true })).status).toBe(200);
    const more = await call(request, 'buyer', 'cart/line', { cartId, line: { sku: LINE.sku, size: '8', shelfPrice: 50 } });
    expect(more.status).toBe(200);
    let { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
    // Still FUNDED — the money that went out is still out — with one line pending.
    expect(body.cart.status).toBe('funded');
    expect(body.cart.pending_count).toBe(1);
    const newId = Number(body.cart.lines.find((l) => l.status === 'pending').id);
    const oldId = Number(body.cart.lines.find((l) => l.status === 'approved').id);

    // The approvals the cards were issued against are FROZEN — an override is refused —
    // while the new line can be decided.
    const override = await call(request, 'approver', 'cart/decide', { cartId, lineIds: [oldId], action: 'reject', reason: 'changed my mind' });
    expect(override.status).toBe(409);
    expect(override.body.error).toMatch(/frozen/i);
    const decided = await call(request, 'approver', 'cart/decide', { cartId, lineIds: [newId], action: 'approve', qty: { [newId]: 1 } });
    expect(decided.status).toBe(200);
    ({ body } = await read_(request, 'approver', `cart/get?id=${cartId}`));
    expect(body.cart.status).toBe('funded');
    expect(body.cart.approved_amount).toBe(150);
    expect(body.cart.funding_target).toBeCloseTo(162.38, 2);               // $108.25 + $50 × 1.0825
    expect(body.cart.lines.find((l) => Number(l.id) === oldId).status).toBe('approved');

    // The desk records the top-up once the buyer closes the list again; the first
    // card is untouched and the funding check reads the sum.
    expect((await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '7878787878787878', balance: 50 } })).status).toBe(409);
    expect((await call(request, 'buyer', 'cart/submit', { cartId })).status).toBe(200);
    const topUp = await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '7878787878787878', balance: 54.13 } });
    expect(topUp.status).toBe(200);
    expect(topUp.body.short).toBe(0);
    ({ body } = await read_(request, 'approver', `cart/get?id=${cartId}`));
    expect(body.cart.giftCards).toHaveLength(2);
    expect(body.cart.checks.find((c) => c.key === 'cards_recorded').ok).toBe(true);
  });

  test('once the receipt is in, the list cannot be re-opened', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    await pool.query(`UPDATE buy_carts SET status = 'receipted' WHERE id = $1`, [cartId]);
    const r = await call(request, 'buyer', 'cart/submit', { cartId, reopen: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/receipt is already in/i);
  });

  test('a pending pair is the buyer’s to withdraw while the list is open; a decided one is not', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE, { ...LINE, size: '8' }], submit: false });
    const { body: b } = await read_(request, 'buyer', `cart/get?id=${cartId}`);
    const [first, second] = b.cart.lines.map((l) => Number(l.id));
    // A draft takes no decisions; the buyer's own add is what opens it to the desk.
    await call(request, 'buyer', 'cart/line', { cartId, line: { sku: LINE.sku, size: '7', shelfPrice: 50 } });
    expect((await call(request, 'approver', 'cart/decide', { cartId, lineIds: [first], action: 'approve', qty: { [first]: 1 } })).status).toBe(200);

    const noGo = await call(request, 'buyer', 'cart/line', { cartId, lineId: first, remove: true });
    expect(noGo.status).toBe(409);
    expect(noGo.body.error).toMatch(/already been approved/);
    const ok = await call(request, 'buyer', 'cart/line', { cartId, lineId: second, remove: true });
    expect(ok.status).toBe(200);
    // Closed list: withdrawing is refused until it is re-opened.
    await call(request, 'buyer', 'cart/submit', { cartId });
    const { body: c } = await read_(request, 'buyer', `cart/get?id=${cartId}`);
    const pendingId = Number(c.cart.lines.find((l) => l.status === 'pending').id);
    const closedNoGo = await call(request, 'buyer', 'cart/line', { cartId, lineId: pendingId, remove: true });
    expect(closedNoGo.status).toBe(409);
    expect(closedNoGo.body.error).toMatch(/re-open/i);
  });

  test('lines come back grouped by the shoe in the order it was first asked about, sizes small to large', async ({ request }) => {
    const cartId = await newRequest(request, { submit: false });
    const add = (sku, size) => call(request, 'approver', 'cart/line', { cartId, line: { sku, size, shelfPrice: 50 } });
    await add('CW2288-111', '10');
    await add('DD1391-100', '9.5W');
    await add('CW2288-111', '8');
    await add('DD1391-100', '7');
    await add('CW2288-111', '9');
    await add('DD1391-100', '10.5W');
    const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
    expect(body.cart.lines.map((l) => `${l.sku} ${l.size}`)).toEqual([
      'CW2288-111 8', 'CW2288-111 9', 'CW2288-111 10',
      'DD1391-100 7', 'DD1391-100 9.5W', 'DD1391-100 10.5W',
    ]);
  });

  test('closing and re-opening each tell the group, in plain text, and never make the buyer wait', async () => {
    // Same rule as the line card: a blank webhook refuses and says so, rather than
    // going quiet — the suite runs with it blanked (playwright.config.js).
    const { notifyRequestEvent } = await import('../api/_lib/notify.js');
    const keep = process.env.MAKE_WEBHOOK_URL;
    const keepTg = process.env.TELEGRAM_BOT_TOKEN;
    try {
      process.env.MAKE_WEBHOOK_URL = '';
      process.env.TELEGRAM_BOT_TOKEN = '';
      const r = await notifyRequestEvent(1, 'buying_request_closed');
      expect(r.sent).toBe(false);
      expect(r.reason).toMatch(/not configured/);
    } finally {
      process.env.MAKE_WEBHOOK_URL = keep;
      if (keepTg === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = keepTg;
    }
  });
});

// ---------------------------------------------------------------------------
// Gift cards read off a file (2026-09-17). The image path costs a model call and is
// exercised by hand against real cardwell cards; what is pinned here is the text
// parser the PDF path runs, the gate, and that nothing is ever recorded by the read.
test.describe('reading a supplier paste and an approver reply', () => {
  test('a code on the same line as its sizes keeps both; a second price stays with its sizes', async () => {
    const { parseBuyPaste } = await import('../src/lib/buyPaste.js');
    expect(parseBuyPaste('100000317 10-12 $50')).toMatchObject({ sku: '100000317', sizes: ['10', '10.5', '11', '11.5', '12'], price: 50 });
    expect(parseBuyPaste('IB4025100 10.5 $90')).toMatchObject({ sku: 'IB4025100', sizes: ['10.5'] });
    expect(parseBuyPaste('DZ5485 201 8-9').sku).toBe('DZ5485-201');
    expect(parseBuyPaste('X100000317\n8-10 $50\n11-12 $60')).toMatchObject({ price: 50, sizePrice: { 11: 60, '11.5': 60, 12: 60 } });
    expect(parseBuyPaste('Sizes 40-44 $50').sizes).toEqual([]);          // EU sizing, not nine US sizes
    expect(parseBuyPaste('$1,050\nsizes 9').price).toBe(1050);
    expect(parseBuyPaste('9-10 $50 11 $60').warnings.length).toBe(1);
  });
  test('a reply may say "9" for the card\'s only 9, and a card with one size twice is refused', async () => {
    const { parseApprovalReply } = await import('../src/lib/buyPaste.js');
    const out = parseApprovalReply('9 x 2', [{ id: 1, size: '9W' }, { id: 2, size: '10W' }]);
    expect(out.ok).toBe(true);
    expect(out.approve.map((a) => [a.line.id, a.qty])).toEqual([[1, 2]]);
    expect(parseApprovalReply('9 x 2', [{ id: 1, size: '9' }, { id: 2, size: '9W' }]).approve.map((a) => a.line.id)).toEqual([1]);
    expect(parseApprovalReply('9 x 2', [{ id: 1, size: '9' }, { id: 2, size: '9' }]).ok).toBe(false);
  });
});

// ── A shoe photo is required ─────────────────────────────────────────────────────
test.describe('a shoe photo is required', () => {
  test('the buyer cannot add a shoe with no photo, even with a size and a price', async ({ request }) => {
    const cartId = await newRequest(request, { submit: false, lines: [] });
    const r = await call(request, 'buyer', 'cart/line', { cartId, line: LINE });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Add a photo/);
    expect((await read_(request, 'buyer', `cart/get?id=${cartId}`)).body.cart.lines).toHaveLength(0);
  });

  test('a shoe with no photo cannot be approved, one at a time or all at once, and can once it has one', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const lineId = Number((await pool.query(
      `INSERT INTO buy_cart_lines (cart_id, sku, size, shelf_price) VALUES ($1, 'NO-PHOTO-1', '9', 50) RETURNING id`, [cartId])).rows[0].id);
    const one = await call(request, 'approver', 'cart/decide', { cartId, lineIds: [lineId], action: 'approve', qtyAll: 1 });
    expect(one.status).toBe(409);
    expect(one.body.error).toMatch(/No photo of NO-PHOTO-1/);
    const all = await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: 1 });
    expect(all.status).toBe(409);
    // Turning it down needs no picture.
    await shoePhotos(cartId, ['NO-PHOTO-1']);
    expect((await call(request, 'approver', 'cart/decide', { cartId, lineIds: [lineId], action: 'approve', qtyAll: 1 })).status).toBe(200);
  });

  test('a shoe with no photo can still be turned down', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const lineId = Number((await pool.query(
      `INSERT INTO buy_cart_lines (cart_id, sku, size, shelf_price) VALUES ($1, 'NO-PHOTO-2', '9', 50) RETURNING id`, [cartId])).rows[0].id);
    const r = await call(request, 'approver', 'cart/decide', { cartId, lineIds: [lineId], action: 'reject', reason: 'no' });
    expect(r.status).toBe(200);
  });

  test('on screen: ten rows of one shoe fetch its photo once, and a failed fetch retries', async ({ page, request }) => {
    const sizes = ['7', '7.5', '8', '8.5', '9', '9.5', '10', '10.5', '11', '11.5'];
    const cartId = await newRequest(request, { lines: sizes.map((size) => ({ ...LINE, size, qty: null })) });
    let hits = 0;
    await page.route('**/api/cart/file?**', async (route) => {
      hits += 1;
      if (hits === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"blip"}' });
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    });
    await as(page, 'approver');
    await page.goto(`/buy-carts?request=${cartId}`);
    await expect(page.locator('img.bc-shot-thumb').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.bc-shot-bad')).toHaveCount(0);
    expect(hits).toBe(2);   // the failure and its one retry, not one per row
  });

  test('the only photo of a live shoe cannot be removed; a spare can', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const files = async () => (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.files.filter((f) => f.kind === 'shoe');
    const [only] = await files();
    const refused = await call(request, 'approver', 'cart/file-delete', { cartId, fileId: Number(only.id) });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/only photo/);
    await shoePhotos(cartId, [LINE.sku]);
    expect((await files()).length).toBe(2);
    const second = (await files())[1];
    const removed = await call(request, 'approver', 'cart/file-delete', { cartId, fileId: Number(second.id) });
    expect(removed.status).not.toBe(409);
  });

  test('a photo has to be a picture the desk can open, judged by its bytes', async () => {
    const { shoePhotoProblem } = await import('../api/cart/file-attach.js');
    const pad = Buffer.alloc(32);
    expect(shoePhotoProblem(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad]))).toBeNull();
    expect(shoePhotoProblem(Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), pad]))).toBeNull();
    expect(shoePhotoProblem(Buffer.concat([Buffer.from('RIFF0000WEBP'), pad]))).toBeNull();
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic0000heicmif1'), pad]);
    expect(shoePhotoProblem(heic)).toMatch(/HEIC/);
    expect(shoePhotoProblem(Buffer.from('this is not a picture of a shoe at all'))).toMatch(/isn’t a photo/);
    expect(shoePhotoProblem(Buffer.alloc(0))).toMatch(/isn’t a photo/);
  });
});

test.describe('gift cards read off a file', () => {
  test('a table of cards parses one card a row: balance, number, PIN', async () => {
    const { cardsFromText } = await import('../api/cart/gift-card-read.js');
    const rows = cardsFromText([
      'Balance Card number PIN',
      '$200.00 6060108832351571987 081658',
      '$200.00   6060104712351572009   129060',
      'Nike 6060102302351241112 241909',       // no balance printed
      'nothing here 1234',                     // no long run → skipped
    ]);
    expect(rows).toEqual([
      { number: '6060108832351571987', pin: '081658', balance: 200, retailer: '' },
      { number: '6060104712351572009', pin: '129060', balance: 200, retailer: '' },
      { number: '6060102302351241112', pin: '241909', balance: null, retailer: '' },
    ]);
  });

  test('only the issuing desk may read, and a file that is not a card image is refused', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const [receipt] = (await pool.query(
      `INSERT INTO buy_cart_files (cart_id, kind, r2_key, name, content_type, size_bytes, uploaded_by)
       VALUES ($1,'receipt',$2,'r.jpg','image/jpeg',10,'E2E') RETURNING id`, [cartId, `buy-carts/e2e/${cartId}-r.jpg`])).rows;
    expect((await call(request, 'approver', 'cart/gift-card-read', { cartId, fileId: Number(receipt.id) })).status).toBe(403);
    const wrong = await call(request, 'issuer', 'cart/gift-card-read', { cartId, fileId: Number(receipt.id) });
    expect(wrong.status).toBe(404);
    expect(wrong.body.error).toMatch(/not on this request/);
  });

  // The cardwell card face: an image, no labels beside the values, and the balance added
  // as "BALANCE = $200". It reads with the OpenAI account empty, on this server.
  test('a card face image reads number, PIN and balance here, and two readings must agree', async () => {
    const { cardFromTwoReadings, cardsFromPages } = await import('../api/cart/gift-card-read.js');
    const face = (number, pin) => `(mm) cardwell\nNike\nCARD NUMBER PIN\n${number} ${pin}\nBALANCE = $200\n`;
    const good = face('6060100000000004444', '444444');
    expect(cardFromTwoReadings(good, good)).toEqual({ number: '6060100000000004444', pin: '444444', balance: 200, retailer: '' });
    // A single digit of difference is not a card we can vouch for: it goes to the AI reader.
    expect(cardFromTwoReadings(good, face('6060100000000004445', '444444'))).toBeNull();
    expect(cardFromTwoReadings(good, face('6060100000000004444', '444445'))).toBeNull();
    // No balance on one reading: the other's stands. Different balances: a person types it.
    expect(cardFromTwoReadings(good, good.replace('BALANCE = $200', '')).balance).toBe(200);
    expect(cardFromTwoReadings(good, good.replace('$200', '$300')).balance).toBeNull();
    // A table is not a card face.
    const table = '$200.00 6060100000000005555 555555\n$200.00 6060100000000006666 666666';
    expect(cardFromTwoReadings(table, table)).toBeNull();
    // The same face as a PDF keeps its PIN once the balance label is recognised.
    expect(cardsFromPages([good.trim().split('\n')])).toEqual([{ number: '6060100000000004444', pin: '444444', balance: 200, retailer: '' }]);
  });

  test('a card face image really reads, end to end, off a made-up card', async () => {
    const sharp = (await import('sharp')).default;
    const { readCardsLocally } = await import('../api/cart/gift-card-read.js');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1208" height="767"><rect width="1208" height="767" fill="#2c6652"/>
      <text x="72" y="100" font-family="sans-serif" font-size="28" font-weight="bold" fill="#fff">cardwell</text>
      <text x="72" y="250" font-family="sans-serif" font-size="80" font-weight="bold" fill="#fff">Nike</text>
      <text x="72" y="350" font-family="monospace" font-size="16" fill="#cde">CARD NUMBER</text><text x="933" y="350" font-family="monospace" font-size="16" fill="#cde">PIN</text>
      <text x="72" y="392" font-family="monospace" font-size="28" font-weight="bold" fill="#fff">6060100000000007777</text><text x="933" y="392" font-family="monospace" font-size="28" font-weight="bold" fill="#fff">777777</text>
      <text x="505" y="472" font-family="serif" font-size="40" font-weight="bold" fill="#fff">BALANCE = $200</text></svg>`;
    const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer();
    expect(await readCardsLocally(jpeg)).toEqual([{ number: '6060100000000007777', pin: '777777', balance: 200, retailer: '' }]);
  });

  test('a card face uploaded to a request comes back from Read the cards, read here', async ({ request }) => {
    test.skip(!process.env.R2_ACCOUNT_ID, 'R2 is not configured in this env — file-sign answers 503');
    const sharp = (await import('sharp')).default;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1208" height="767"><rect width="1208" height="767" fill="#2c6652"/>
      <text x="72" y="350" font-family="monospace" font-size="16" fill="#cde">CARD NUMBER</text><text x="933" y="350" font-family="monospace" font-size="16" fill="#cde">PIN</text>
      <text x="72" y="392" font-family="monospace" font-size="28" font-weight="bold" fill="#fff">6060100000000008888</text><text x="933" y="392" font-family="monospace" font-size="28" font-weight="bold" fill="#fff">888888</text>
      <text x="505" y="472" font-family="serif" font-size="40" font-weight="bold" fill="#fff">BALANCE = $150</text></svg>`;
    const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer();
    const cartId = await newRequest(request, { lines: [LINE] });
    const signed = await call(request, 'issuer', 'cart/file-sign', { cartId, kind: 'gift_card', contentType: 'image/jpeg' });
    expect(signed.status).toBe(200);
    expect((await fetch(signed.body.uploadUrl, { method: 'PUT', body: jpeg })).ok).toBe(true);
    const attached = await call(request, 'issuer', 'cart/file-attach', { cartId, kind: 'gift_card', key: signed.body.key, name: 'face.jpg', contentType: 'image/jpeg', sizeBytes: jpeg.length });
    expect(attached.status).toBe(200);
    const fileId = Number((await pool.query(`SELECT id FROM buy_cart_files WHERE cart_id = $1 AND r2_key = $2`, [cartId, signed.body.key])).rows[0].id);
    try {
      const read = await call(request, 'issuer', 'cart/gift-card-read', { cartId, fileId });
      expect(read.status).toBe(200);
      expect(read.body.source).toBe('local');
      expect(read.body.cards).toEqual([{ number: '6060100000000008888', pin: '888888', balance: 150, retailer: null, already: false }]);
      // On the trail: how many and how, never a digit.
      const ev = (await pool.query(`SELECT body FROM buy_cart_events WHERE cart_id = $1 AND kind = 'gc_read'`, [cartId])).rows;
      expect(ev.length).toBe(1);
      expect(ev[0].body).toContain('this server, read twice');
      expect(ev[0].body).not.toMatch(/\d{4,}/);
    } finally {
      await call(request, 'issuer', 'cart/file-delete', { cartId, fileId });
    }
  });

  // cardwell's own PDF: a card face a page, as a picture with transparent corners, and no text
  // at all. Every page read as nothing until 2026-11-06. Made-up cards, never the real file.
  test('a PDF of pictures reads card by card, and says which pages it could not', async () => {
    const sharp = (await import('sharp')).default;
    const { PDFDocument } = await import('pdf-lib');
    const { cardsFromPdf } = await import('../api/cart/gift-card-read.js');
    const face = (number, pin) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><rect width="1200" height="760" rx="40" fill="#2c6652"/>
      <text x="66" y="345" font-family="monospace" font-size="16" fill="#cde">CARD NUMBER</text><text x="930" y="345" font-family="monospace" font-size="16" fill="#cde">PIN</text>
      <text x="66" y="388" font-family="monospace" font-size="30" font-weight="bold" fill="#fff">${number}</text><text x="930" y="388" font-family="monospace" font-size="30" font-weight="bold" fill="#fff">${pin}</text></svg>`)).png().toBuffer();
    const blank = await sharp({ create: { width: 400, height: 300, channels: 4, background: '#fff' } }).png().toBuffer();
    const doc = await PDFDocument.create();
    for (const bytes of [await face('6060100000000006161', '616161'), blank, await face('6060100000000006262', '626262')]) {
      const img = await doc.embedPng(bytes);
      doc.addPage([842, 595]).drawImage(img, { x: 0, y: 0, width: 842, height: 595 });
    }
    const out = await cardsFromPdf(Buffer.from(await doc.save()));
    expect(out.cards.map((c) => [c.number, c.pin, c.balance])).toEqual([
      ['6060100000000006161', '616161', null], ['6060100000000006262', '626262', null],
    ]);
    expect(out.unread).toBe(1);
    expect(out.pictures).toBe(3);
  });

  test('the reader uses no AI, even with a key set', async () => {
    const fs = await import('node:fs');
    for (const f of ['api/cart/gift-card-read.js', 'api/cart/gift-cards-pdf.js', 'api/cart/gift-card-reads.js', 'api/_lib/gc-read-worker.js', 'api/_lib/gcCards.js'])
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/openai|OPENAI_API_KEY|chat\/completions/i);
  });

  // Cardwell's download: a ZIP of pictures, named 001-nike-4832.png. Made-up cards only.
  test('a ZIP opens into its card files: in order, junk ignored, others counted, full numbers masked', async () => {
    const sharp = (await import('sharp')).default;
    const { zipSync } = await import('fflate');
    const { cardFilesFromZip, MAX_ZIP_FILES } = await import('../api/_lib/gcCards.js');
    const png = new Uint8Array(await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer());
    const jpg = new Uint8Array(await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    const text = (t) => new TextEncoder().encode(t);
    const { files, skipped } = cardFilesFromZip(Buffer.from(zipSync({
      'cards/010-nike-4832.png': png,
      'cards/002-nike-4815.jpeg': jpg,
      'cards/6060100000000001111.png': png,
      'cards/list.csv': text('number,pin\n6060100000000002222,123456\n'),
      'cards/notes.txt': text('not a card'),
      'cards/fake.png': text('not really a picture, whatever the name says'),
      '__MACOSX/cards/._010-nike-4832.png': png,
      'cards/.DS_Store': text('x'),
    })));
    expect(files.map((f) => [f.name, f.ext, f.contentType])).toEqual([
      ['002-nike-4815.jpeg', 'jpg', 'image/jpeg'],
      ['010-nike-4832.png', 'png', 'image/png'],
      ['••••1111.png', 'png', 'image/png'],
      ['list.csv', 'csv', 'text/csv'],
    ]);
    expect(skipped).toBe(2);
    expect(() => cardFilesFromZip(Buffer.from('this is not a zip file at all, not even close'))).toThrow();
    const many = Object.fromEntries(Array.from({ length: MAX_ZIP_FILES + 1 }, (_, i) => [`${i}.png`, png]));
    expect(() => cardFilesFromZip(Buffer.from(zipSync(many)))).toThrow(/more than/);
  });

  test('many files make one table: one row a card, a CSV fills a picture\'s balance, a disagreement is held', async () => {
    const { mergeCardReads } = await import('../api/_lib/gcCards.js');
    const card = (number, pin, balance = null) => ({ number, pin, balance, retailer: null, already: false });
    const rows = mergeCardReads([
      { fileId: 1, fileName: '001.png', cards: [card('6060100000000001111', '111111')] },
      { fileId: 2, fileName: '002.png', cards: [card('6060100000000002222', '222222')] },
      { fileId: 3, fileName: 'list.csv', cards: [card('6060100000000001111', '111111', 200), card('6060100000000002222', '999999', 50), card('6060100000000003333', null, 100)] },
    ], ['3333']);
    expect(rows.map((r) => [r.number.slice(-4), r.pin, r.balance, r.conflict, r.already, r.fileName])).toEqual([
      ['1111', '111111', 200, false, false, '001.png'],
      ['2222', '222222', 50, true, false, '002.png'],
      ['3333', null, 100, false, true, 'list.csv'],
    ]);
  });

  // Cardwell's export, column for column (made-up cards). The balance is only here: their card
  // pictures and PDF don't print one, and a used card is worth less than the rest.
  test('Cardwell\'s CSV gives each card its own balance, and a ZIP\'s picture of the same card picks it up', async () => {
    const { cardsFromCsv } = await import('../api/cart/gift-card-read.js');
    const { cleanCards, mergeCardReads } = await import('../api/_lib/gcCards.js');
    const csv = `Retailer,Card number,PIN,Added,Balance
"Nike","6060100000000005511","551155","2026-11-06T17:21:04.123Z","200.00"
"Nike","6060100000000005522","552255","2026-11-06T17:21:05.456Z","20.86"
"Nike","6060100000000005533","553355","2026-11-06T17:21:06.789Z","200.00"`;
    const { cards, mangled } = cardsFromCsv(csv);
    expect(mangled).toBe(0);
    expect(cleanCards(cards).map((c) => [c.number, c.pin, c.balance, c.retailer])).toEqual([
      ['6060100000000005511', '551155', 200, 'Nike'],
      ['6060100000000005522', '552255', 20.86, 'Nike'],
      ['6060100000000005533', '553355', 200, 'Nike'],
    ]);
    const picture = (number, pin) => ({ number, pin, balance: null, retailer: null, already: false });
    const rows = mergeCardReads([
      { fileId: 1, fileName: '001-nike-5511.png', cards: [picture('6060100000000005511', '551155')] },
      { fileId: 2, fileName: '002-nike-5522.png', cards: [picture('6060100000000005522', '552255')] },
      { fileId: 3, fileName: 'cardwell-selected-gift-cards.csv', cards: cleanCards(cards) },
    ]);
    expect(rows.map((r) => [r.number.slice(-4), r.balance, r.retailer, r.conflict, r.fileName])).toEqual([
      ['5511', 200, 'Nike', false, '001-nike-5511.png'],
      ['5522', 20.86, 'Nike', false, '002-nike-5522.png'],
      ['5533', 200, 'Nike', false, 'cardwell-selected-gift-cards.csv'],
    ]);
  });

  test('a picture\'s file name names its card only when it clearly does', async () => {
    const { cardTailFromFileName: t } = await import('../src/lib/buycartRules.js');
    expect(t('001-nike-4832.png')).toBe('4832');
    expect(t('002-nike-0007.JPG')).toBe('0007');
    for (const none of ['IMG_20241.png', 'photo.png', 'WhatsApp Image 2026-11-05 at 04.42.06.jpeg', '4832.pdf', '', null]) expect(t(none), String(none)).toBeNull();
  });

  // The stored readings, seeded straight in: CI has no file storage for the worker to read from.
  async function seedReads(cartId, readings) {
    const { encryptSecret } = await import('../api/_lib/secrets.js');
    for (const [i, { name, cards, status = 'done' }] of readings.entries()) {
      const file = (await pool.query(
        `INSERT INTO buy_cart_files (cart_id, kind, r2_key, name, content_type) VALUES ($1, 'gift_card', $2, $3, 'image/png') RETURNING id`,
        [cartId, `buy-carts/e2e/gift_card-${cartId}${i}.png`, name],
      )).rows[0];
      await pool.query(
        `INSERT INTO buy_cart_card_reads (file_id, cart_id, status, card_count, enc) VALUES ($1, $2, $3, $4, $5)`,
        [file.id, cartId, status, (cards || []).length, cards?.length ? encryptSecret(JSON.stringify(cards)) : null],
      );
    }
  }
  const readCard = (number, pin, balance = null) => ({ number, pin, balance, retailer: null, already: false });
  async function fundable(request) {
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
    return cartId;
  }

  test('the readings go to the desk alone: digits only on request, on the trail, and never in the cart', async ({ request }) => {
    const cartId = await fundable(request);
    await seedReads(cartId, [
      { name: '001-nike-1111.png', cards: [readCard('6060100000000001111', '111111')] },
      { name: '002-nike-2222.png', cards: [readCard('6060100000000002222', '222222')] },
      { name: '003-nike-blur.png', cards: [] },
    ]);
    for (const who of ['approver', 'buyer'])
      expect((await call(request, who, 'cart/gift-card-reads', { cartId, action: 'results' })).status).toBe(403);

    // The cart says how far reading has got, without a digit or the ciphertext.
    const got = await read_(request, 'issuer', `cart/get?id=${cartId}`);
    const raw = JSON.stringify(got.body);
    expect(raw).not.toContain('6060100000000001111');
    expect(raw).not.toContain('"enc"');
    const files = got.body.cart.files.filter((f) => f.kind === 'gift_card');
    expect(files.map((f) => [f.read_status, f.read_count])).toEqual([['done', 1], ['done', 1], ['done', 0]]);
    // A supplier sees neither the files nor their reading.
    const theirs = await read_(request, 'buyer', `cart/get?id=${cartId}`);
    expect(JSON.stringify(theirs.body)).not.toContain('001-nike-1111');

    const out = await call(request, 'issuer', 'cart/gift-card-reads', { cartId, action: 'results' });
    expect(out.status).toBe(200);
    expect(out.body.cards.map((c) => [c.number, c.pin, c.fileName])).toEqual([
      ['6060100000000001111', '111111', '001-nike-1111.png'],
      ['6060100000000002222', '222222', '002-nike-2222.png'],
    ]);
    const ev = (await pool.query(`SELECT body FROM buy_cart_events WHERE cart_id = $1 AND kind = 'gc_read_all'`, [cartId])).rows;
    expect(ev.length).toBe(1);
    expect(ev[0].body).toContain('2 cards opened for review');
    expect(ev[0].body).not.toMatch(/\d{4,}/);

    // Once recorded, the stored digits are gone.
    expect((await call(request, 'issuer', 'cart/gift-card-reads', { cartId, action: 'clear' })).status).toBe(200);
    const left = (await pool.query(`SELECT count(*)::int AS n FROM buy_cart_card_reads WHERE cart_id = $1 AND enc IS NOT NULL`, [cartId])).rows[0];
    expect(left.n).toBe(0);
    expect((await call(request, 'issuer', 'cart/gift-card-reads', { cartId, action: 'results' })).body.cards).toEqual([]);
  });

  test('a file that failed or never got read can be queued; a recorded one is not read again', async ({ request }) => {
    const cartId = await fundable(request);
    await seedReads(cartId, [
      { name: 'recorded.png', cards: [readCard('6060100000000005151', '515151')], status: 'cleared' },
      { name: 'failed.png', status: 'failed' },
    ]);
    await pool.query(`INSERT INTO buy_cart_files (cart_id, kind, r2_key, name, content_type) VALUES ($1, 'gift_card', $2, 'never.png', 'image/png')`, [cartId, `buy-carts/e2e/gift_card-${cartId}9.png`]);
    expect((await call(request, 'approver', 'cart/gift-card-reads', { cartId, action: 'queue' })).status).toBe(403);
    const out = await call(request, 'issuer', 'cart/gift-card-reads', { cartId, action: 'queue' });
    expect(out.status).toBe(200);
    expect(out.body.queued).toBe(2);
    const cleared = (await pool.query(`SELECT r.status FROM buy_cart_card_reads r JOIN buy_cart_files f ON f.id = r.file_id WHERE f.name = 'recorded.png' AND r.cart_id = $1`, [cartId])).rows[0];
    expect(cleared.status).toBe('cleared');
  });

  test('after a restart a file mid-read goes back in the queue, and one that keeps failing stops', async ({ request }) => {
    const { requeueStuckCardReads } = await import('../api/_lib/db.js');
    const cartId = await fundable(request);
    await seedReads(cartId, [{ name: 'cut-short.png', status: 'reading' }, { name: 'keeps-dying.png', status: 'reading' }, { name: 'still-going.png', status: 'reading' }]);
    await pool.query(`UPDATE buy_cart_card_reads r SET attempts = CASE f.name WHEN 'keeps-dying.png' THEN 3 ELSE 1 END, started_at = CASE f.name WHEN 'still-going.png' THEN now() ELSE now() - interval '1 hour' END FROM buy_cart_files f WHERE f.id = r.file_id AND r.cart_id = $1`, [cartId]);
    await requeueStuckCardReads(30);
    const rows = (await pool.query(`SELECT f.name, r.status FROM buy_cart_card_reads r JOIN buy_cart_files f ON f.id = r.file_id WHERE r.cart_id = $1 ORDER BY f.id`, [cartId])).rows;
    expect(rows.map((r) => r.status)).toEqual(['queued', 'failed', 'reading']);
    // Off the shared queue again, so this test's made-up files aren't left for the worker.
    await pool.query(`DELETE FROM buy_cart_card_reads WHERE cart_id = $1`, [cartId]);
  });

  test('on screen: the desk is warned about a card with no barcode picture, until there is one', async ({ page, request }) => {
    const cartId = await fundable(request);
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6060100000000008181', pin: '818181', balance: 500 } });
    await as(page, 'issuer');
    await page.goto(`/ph/gift-card-buying?request=${cartId}`);
    const section = page.locator('.bc-cards');
    await expect(section).toContainText('No barcode picture for 1 card: •••• 8181');
    await expect(section).toContainText('upload the CSV, then the ZIP');
    await pool.query(`INSERT INTO buy_cart_files (cart_id, kind, r2_key, name, content_type) VALUES ($1, 'gift_card', $2, '001-nike-8181.png', 'image/png')`, [cartId, `buy-carts/e2e/gift_card-${cartId}1.png`]);
    await page.reload();
    await expect(section.locator('.bc-gc-list')).toContainText('8181');
    await expect(section).not.toContainText('No barcode picture');
  });

  test('recording many at once is one call: all or nothing on a bad row, and says how many landed', async ({ request }) => {
    const cartId = await fundable(request);
    const code = (i) => `60601000000000${String(70000 + i)}`;
    const bad = await call(request, 'issuer', 'cart/gift-card', { cartId, cards: [{ code: code(1), balance: 200 }, { code: code(2), balance: '' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Nothing was recorded/);
    const none = (await pool.query(`SELECT count(*)::int AS n FROM buy_cart_gift_cards WHERE cart_id = $1`, [cartId])).rows[0];
    expect(none.n).toBe(0);
    expect((await call(request, 'approver', 'cart/gift-card', { cartId, cards: [{ code: code(1), balance: 200 }] })).status).toBe(403);

    // More than the one-a-call rate limit allows in a minute, in a single press.
    const out = await call(request, 'issuer', 'cart/gift-card', { cartId, cards: Array.from({ length: 70 }, (_, i) => ({ code: code(i), pin: '123456', balance: 5, label: `${i}.png` })) });
    expect(out.status).toBe(200);
    expect(out.body.recorded).toBe(70);
    const row = (await pool.query(`SELECT count(*)::int AS n, sum(balance)::numeric AS total, min(code_enc) AS enc FROM buy_cart_gift_cards WHERE cart_id = $1`, [cartId])).rows[0];
    expect(row.n).toBe(70);
    expect(Number(row.total)).toBe(350);
    expect(row.enc).not.toContain('6060100');
  });

  test('on screen: Review opens every card, typing 200 fills the blanks with 200, Record files them', async ({ page, request }) => {
    const cartId = await fundable(request);
    await seedReads(cartId, [
      { name: '001-nike-3131.png', cards: [readCard('6060100000000003131', '313131')] },
      { name: '002-nike-3232.png', cards: [readCard('6060100000000003232', '323232')] },
      { name: '003-nike-3333.png', cards: [readCard('6060100000000003333', '333333')] },
      { name: '004-nike-blur.png', cards: [] },
    ]);
    await as(page, 'issuer');
    await page.goto(`/ph/gift-card-buying?request=${cartId}`);
    const section = page.locator('.bc-cards');
    // No digit on the page until someone asks.
    await expect(section.getByRole('button', { name: 'Review the 3 cards read' })).toBeVisible();
    await expect(section.locator('.bc-gc-bulk')).toContainText('Nothing read from 1 file: 004-nike-blur.png');
    await expect(page.locator('body')).not.toContainText('6060100000000003131');
    await section.getByRole('button', { name: 'Review the 3 cards read' }).click();

    const rows = section.locator('.bc-gc-read-list li');
    await expect(rows).toHaveCount(3);
    await expect(section.locator('.bc-gc-read-h')).toContainText('3 cards read from 3 files');

    // Typed key by key, as a person does: this used to leave every row at $2.
    await section.getByLabel('Set every blank balance').pressSequentially('200');
    const balances = () => rows.locator('.ph-price').evaluateAll((els) => els.map((e) => e.value));
    await expect.poll(balances).toEqual(['200', '200', '200']);
    // A row changed by hand keeps its own number when the fill changes.
    await rows.nth(1).locator('.ph-price').fill('50');
    await section.getByLabel('Set every blank balance').fill('100');
    await expect.poll(balances).toEqual(['100', '50', '100']);

    await section.getByRole('button', { name: 'Record 3 cards' }).click();
    await expect(section.locator('.bc-gc-read')).toHaveCount(0);
    await expect(section.locator('.bc-gc-list li')).toHaveCount(3);
    const saved = (await pool.query(`SELECT code_last4, balance::numeric AS balance, label FROM buy_cart_gift_cards WHERE cart_id = $1 ORDER BY id`, [cartId])).rows;
    expect(saved.map((r) => [r.code_last4, Number(r.balance), r.label])).toEqual([
      ['3131', 100, '001-nike-3131.png'], ['3232', 50, '002-nike-3232.png'], ['3333', 100, '003-nike-3333.png'],
    ]);
    // Spent: no button to open them again, and nothing left stored.
    await expect(section.getByRole('button', { name: /Review the/ })).toHaveCount(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM buy_cart_card_reads WHERE cart_id = $1 AND enc IS NOT NULL`, [cartId])).rows[0].n).toBe(0);
  });

  // The desk's real flow. The pictures here hold no readable text at all, so if anything still
  // depended on OCR, they would come back unmatched and the PDF would print no pictures.
  test('the CSV, then the ZIP: details from the CSV, no OCR, and the supplier\'s PDF carries each picture', async ({ request }) => {
    test.skip(!process.env.R2_ACCOUNT_ID, 'R2 is not configured in this env — file-sign answers 503');
    const sharp = (await import('sharp')).default;
    const { zipSync } = await import('fflate');
    const { PDFDocument } = await import('pdf-lib');
    const blank = async (c) => new Uint8Array(await sharp({ create: { width: 600, height: 380, channels: 3, background: c } }).png().toBuffer());
    const face = new Uint8Array(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><rect width="1200" height="760" fill="#2c6652"/>
      <text x="66" y="345" font-family="monospace" font-size="16" fill="#cde">CARD NUMBER</text><text x="930" y="345" font-family="monospace" font-size="16" fill="#cde">PIN</text>
      <text x="66" y="388" font-family="monospace" font-size="30" font-weight="bold" fill="#fff">6060100000000009393</text><text x="930" y="388" font-family="monospace" font-size="30" font-weight="bold" fill="#fff">939393</text></svg>`)).png().toBuffer());
    const cartId = await fundable(request);
    const put = async (bytes, name, contentType) => {
      const signed = await call(request, 'issuer', 'cart/file-sign', { cartId, kind: 'gift_card', contentType });
      expect((await fetch(signed.body.uploadUrl, { method: 'PUT', body: bytes })).ok).toBe(true);
      expect((await call(request, 'issuer', 'cart/file-attach', { cartId, kind: 'gift_card', key: signed.body.key, name, contentType, sizeBytes: bytes.length })).status).toBe(200);
    };
    const files = async () => (await read_(request, 'issuer', `cart/get?id=${cartId}`)).body.cart.files.filter((f) => f.kind === 'gift_card');
    try {
      await put(Buffer.from(`Retailer,Card number,PIN,Added,Balance
"Nike","6060100000000009191","919191","2026-11-06T17:21:04.123Z","300.00"
"Nike","6060100000000009292","929292","2026-11-06T17:21:05.456Z","20.86"`), 'cardwell-selected-gift-cards.csv', 'text/csv');
      await expect.poll(async () => (await files()).map((f) => f.read_status), { timeout: 30_000, intervals: [300] }).toEqual(['done']);
      await put(Buffer.from(zipSync({
        '001-nike-9191.png': await blank('#112233'),
        '002-nike-9292.png': await blank('#445566'),
        '003-nike-9393.png': face,    // on no CSV: read, so it can't vanish
      })), 'nike_gift_cards.zip', 'application/zip');
      await expect.poll(async () => (await files()).map((f) => `${f.name}:${f.read_status}:${f.gc_last4}`), { timeout: 60_000, intervals: [500] }).toEqual([
        'cardwell-selected-gift-cards.csv:done:null',
        '001-nike-9191.png:picture:9191',
        '002-nike-9292.png:picture:9292',
        '003-nike-9393.png:done:9393',
      ]);
      const out = await call(request, 'issuer', 'cart/gift-card-reads', { cartId, action: 'results' });
      expect(out.body.cards.map((c) => [c.number.slice(-4), c.pin, c.balance])).toEqual([
        ['9191', '919191', 300], ['9292', '929292', 20.86], ['9393', '939393', null],
      ]);
      const rec = await call(request, 'issuer', 'cart/gift-card', { cartId, cards: out.body.cards.slice(0, 2).map((c) => ({ code: c.number, pin: c.pin, balance: c.balance, label: c.fileName })) });
      expect(rec.body.recorded).toBe(2);
      expect((await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true })).status).toBe(200);
      // What the supplier takes to the till: a page a card, each with its own picture.
      const down = await request.get(`/api/cart/gift-cards-pdf?cartId=${cartId}`, { headers: { Authorization: `Bearer ${tokenFor(people.buyer)}` } });
      expect(down.status()).toBe(200);
      const body = await down.body();
      expect((await PDFDocument.load(body)).getPageCount()).toBe(2);
      expect((body.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length).toBe(2);
    } finally {
      for (const f of await files()) await call(request, 'issuer', 'cart/file-delete', { cartId, fileId: Number(f.id) }).catch(() => {});
    }
  });

  test('a ZIP uploaded to a request is unpacked and read by the server with nobody pressing anything', async ({ request }) => {
    test.skip(!process.env.R2_ACCOUNT_ID, 'R2 is not configured in this env — file-sign answers 503');
    const sharp = (await import('sharp')).default;
    const { zipSync } = await import('fflate');
    const face = async (number, pin) => new Uint8Array(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><rect width="1200" height="760" fill="#2c6652"/>
      <text x="66" y="345" font-family="monospace" font-size="16" fill="#cde">CARD NUMBER</text><text x="930" y="345" font-family="monospace" font-size="16" fill="#cde">PIN</text>
      <text x="66" y="388" font-family="monospace" font-size="30" font-weight="bold" fill="#fff">${number}</text><text x="930" y="388" font-family="monospace" font-size="30" font-weight="bold" fill="#fff">${pin}</text></svg>`)).png().toBuffer());
    const zip = Buffer.from(zipSync({
      '001-nike-4141.png': await face('6060100000000004141', '414141'),
      '002-nike-4242.png': await face('6060100000000004242', '424242'),
    }));
    const cartId = await fundable(request);
    const signed = await call(request, 'issuer', 'cart/file-sign', { cartId, kind: 'gift_card', contentType: 'application/zip' });
    expect(signed.status).toBe(200);
    expect((await fetch(signed.body.uploadUrl, { method: 'PUT', body: zip })).ok).toBe(true);
    expect((await call(request, 'issuer', 'cart/file-attach', { cartId, kind: 'gift_card', key: signed.body.key, name: 'nike_gift_cards.zip', contentType: 'application/zip', sizeBytes: zip.length })).status).toBe(200);
    const files = async () => (await read_(request, 'issuer', `cart/get?id=${cartId}`)).body.cart.files.filter((f) => f.kind === 'gift_card');
    try {
      await expect.poll(async () => (await files()).map((f) => `${f.name}:${f.read_status}:${f.read_count}`), { timeout: 60_000, intervals: [500] })
        .toEqual(['001-nike-4141.png:done:1', '002-nike-4242.png:done:1']);   // the ZIP itself is gone
      const out = await call(request, 'issuer', 'cart/gift-card-reads', { cartId, action: 'results' });
      expect(out.body.cards.map((c) => [c.number, c.pin])).toEqual([['6060100000000004141', '414141'], ['6060100000000004242', '424242']]);
      const trail = (await pool.query(`SELECT body FROM buy_cart_events WHERE cart_id = $1 AND kind IN ('gc_read_all', 'file_added')`, [cartId])).rows.map((r) => r.body).join(' | ');
      expect(trail).toContain('unpacked into 2 files');
      expect(trail).toContain('2 cards read from 2 files on this server');
      expect(trail).not.toMatch(/\d{8,}/);
    } finally {
      for (const f of await files()) await call(request, 'issuer', 'cart/file-delete', { cartId, fileId: Number(f.id) });
    }
  });

  test('the supplier gets no card files or their names; the desk keeps them and can delete them', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6060100000000007373', balance: 200, label: 'WhatsApp Image bad-upload.jpeg' } });
    const fileId = Number((await pool.query(
      `INSERT INTO buy_cart_files (cart_id, kind, r2_key, name, content_type, uploaded_by)
       VALUES ($1, 'gift_card', $2, 'bad-upload.pdf', 'application/pdf', 'E2E') RETURNING id`, [cartId, `buy-carts/e2e/${cartId}-gc.pdf`])).rows[0].id);
    await pool.query(`INSERT INTO buy_cart_events (cart_id, kind, body) VALUES ($1, 'file_added', 'gift_card: bad-upload.pdf'), ($1, 'gc_read', '0 cards read from “bad-upload.pdf”')`, [cartId]);
    await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });

    const buyer = await read_(request, 'buyer', `cart/get?id=${cartId}`);
    const raw = JSON.stringify(buyer.body);
    expect(raw).not.toContain('bad-upload');
    expect(raw).not.toContain('WhatsApp');
    expect(buyer.body.cart.files.filter((f) => f.kind === 'gift_card')).toHaveLength(0);
    expect(buyer.body.cart.giftCards[0].code_last4).toBe('7373');   // the card itself is still theirs
    const shoe = buyer.body.cart.files.filter((f) => f.kind === 'shoe');
    expect(shoe.length).toBeGreaterThan(0);                          // their own photos stay
    const direct = await request.get(`/api/cart/file?cartId=${cartId}&fileId=${fileId}`, { headers: { Authorization: `Bearer ${tokenFor(people.buyer)}` } });
    expect(direct.status()).toBe(403);

    const desk = await read_(request, 'issuer', `cart/get?id=${cartId}`);
    expect(JSON.stringify(desk.body)).toContain('bad-upload');

    // A PH or warehouse login needs the duty, not just the job title. Refused by the link as well as
    // left off the page. The storage answer differs in test, so "allowed" means "not refused".
    const fileAs = (who) => request.get(`/api/cart/file?cartId=${cartId}&fileId=${fileId}`, { headers: { Authorization: `Bearer ${tokenFor(people[who])}` } });
    expect((await fileAs('bystander')).status()).toBe(403);
    expect((await fileAs('approver')).status()).toBe(403);
    expect((await fileAs('issuer')).status()).not.toBe(403);
    expect((await fileAs('auditor')).status()).not.toBe(403);
    const staffView = await read_(request, 'bystander', `cart/get?id=${cartId}`);
    if (staffView.status === 200) expect(staffView.body.cart.files.filter((f) => f.kind === 'gift_card')).toHaveLength(0);

    // A supplier can't delete one; the desk can, whoever uploaded it, and the card stays.
    expect((await call(request, 'buyer', 'cart/file-delete', { cartId, fileId })).status).toBe(403);
    const gone = await call(request, 'issuer', 'cart/file-delete', { cartId, fileId });
    expect(gone.status).toBe(200);
    expect(gone.body.cart.files.filter((f) => f.kind === 'gift_card')).toHaveLength(0);
    expect(gone.body.cart.giftCards).toHaveLength(1);
  });

  test('on screen: the supplier sees Download all and no files; the desk gets a two-tap Delete', async ({ page, request, browser }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6060100000000007474', balance: 200, label: 'hidden-name.jpeg' } });
    await pool.query(`INSERT INTO buy_cart_files (cart_id, kind, r2_key, name, content_type, uploaded_by)
       VALUES ($1, 'gift_card', $2, 'hidden-name.pdf', 'application/pdf', 'E2E')`, [cartId, `buy-carts/e2e/${cartId}-gc2.pdf`]);
    await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });

    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    const cards = page.locator('#bc-sec-cards');
    await expect(cards.getByRole('button', { name: /Download all 1 card/ })).toBeVisible();
    await expect(cards).not.toContainText('hidden-name');
    await expect(cards.locator('.bc-gc-files')).toHaveCount(0);

    const ctx = await browser.newContext({ baseURL: page.url().split('/buying')[0] });
    const desk = await ctx.newPage();
    await as(desk, 'issuer');
    await desk.goto(`/ph/gift-card-buying?request=${cartId}`);
    const files = desk.locator('.bc-gc-files');
    await expect(files).toContainText('hidden-name.pdf');
    await files.getByRole('button', { name: 'Delete' }).click();
    await expect(files).toContainText('Recorded cards stay');
    await files.getByRole('button', { name: 'Keep' }).click();
    await files.getByRole('button', { name: 'Delete' }).click();
    await files.getByRole('button', { name: 'Delete' }).click();
    await expect(files).not.toContainText('hidden-name.pdf');
    await expect(desk.locator('#bc-sec-cards')).toContainText('7474');
    await ctx.close();
  });

  test('a PDF of pictures: read, recorded, and printed with its picture; the unrecorded card stays out', async ({ request }) => {
    test.skip(!process.env.R2_ACCOUNT_ID, 'needs real storage to hold the file');
    const sharp = (await import('sharp')).default;
    const { PDFDocument } = await import('pdf-lib');
    const face = (number, pin) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><rect width="1200" height="760" rx="40" fill="#2c6652"/>
      <text x="66" y="345" font-family="monospace" font-size="16" fill="#cde">CARD NUMBER</text><text x="930" y="345" font-family="monospace" font-size="16" fill="#cde">PIN</text>
      <text x="66" y="388" font-family="monospace" font-size="30" font-weight="bold" fill="#fff">${number}</text><text x="930" y="388" font-family="monospace" font-size="30" font-weight="bold" fill="#fff">${pin}</text></svg>`)).png().toBuffer();
    const src = await PDFDocument.create();
    for (const bytes of [await face('6060100000000006363', '636363'), await face('6060100000000006464', '646464')]) {
      const img = await src.embedPng(bytes);
      src.addPage([842, 595]).drawImage(img, { x: 0, y: 0, width: 842, height: 595 });
    }
    const pdf = Buffer.from(await src.save());
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
    const signed = await call(request, 'issuer', 'cart/file-sign', { cartId, kind: 'gift_card', contentType: 'application/pdf' });
    expect((await fetch(signed.body.uploadUrl, { method: 'PUT', body: pdf })).ok).toBe(true);
    const attached = await call(request, 'issuer', 'cart/file-attach', { cartId, kind: 'gift_card', key: signed.body.key, name: 'cards.pdf', contentType: 'application/pdf', sizeBytes: pdf.length });
    const fileId = Number(attached.body.file.id);
    try {
      const read = await call(request, 'issuer', 'cart/gift-card-read', { cartId, fileId });
      expect(read.status).toBe(200);
      expect(read.body.source).toBe('local');
      expect(read.body.cards.map((c) => c.number)).toEqual(['6060100000000006363', '6060100000000006464']);
      // Only the first is recorded, so the PDF is one page, and it carries that card's picture.
      expect((await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: read.body.cards[0].number, pin: read.body.cards[0].pin, balance: 200 } })).status).toBe(200);
      const down = await request.get(`/api/cart/gift-cards-pdf?cartId=${cartId}`, { headers: { Authorization: `Bearer ${tokenFor(people.issuer)}` } });
      expect(down.status()).toBe(200);
      const body = await down.body();
      expect((await PDFDocument.load(body)).getPageCount()).toBe(1);
      expect(body.toString('latin1')).not.toContain('No picture of this card');
      expect(body.length).toBeGreaterThan(5000);
    } finally {
      await call(request, 'issuer', 'cart/file-delete', { cartId, fileId });
    }
  });

  test('the all-cards PDF is the recorded cards only, with no file names on it', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const { buildGiftCardPdf } = await import('../api/cart/gift-cards-pdf.js');
    const bytes = await buildGiftCardPdf({
      cards: [{ id: 1, code: '6060100000000007575', pin: '757575', balance: 200, retailer: 'Nike', label: 'secret-file-name.jpeg' }],
      cartCode: 'BC-1', printedFor: 'e2e',
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('secret-file-name');
  });

  // Nike's e-gift PDF: one card a page, "Pin:" and "Gift Card Value:" on lines of their
  // own. The row reader found every number in such a file and not one PIN or balance.
  test('an e-gift PDF, one card a page, reads its PIN and value off their labels', async () => {
    const { cardsFromPages } = await import('../api/cart/gift-card-read.js');
    const nikePage = (value, number, pin) => [
      'Nike Gift Card', `Gift Card Value: ${value}`, `Card Number: ${number}`, `Pin: ${pin}`,
      'Simply enter the card number and PIN number displayed on this eGift Card at checkout.',
      'and Puerto Rico or by phone at 1-800-806-6453.',
      'For Internal Use: Id: NG-0000001 Order: 1234567',
    ];
    const rows = cardsFromPages([
      nikePage('200.00', '6060100000000001111', '111111'),
      nikePage('150.00', '6060100000000002222', '222222'),
      // A table page still reads row by row.
      ['Balance Card number PIN', '$50.00 6060100000000003333 333333'],
    ]);
    expect(rows).toEqual([
      { number: '6060100000000001111', pin: '111111', balance: 200, retailer: '' },
      { number: '6060100000000002222', pin: '222222', balance: 150, retailer: '' },
      { number: '6060100000000003333', pin: '333333', balance: 50, retailer: '' },
    ]);
  });

  test('a CSV of cards reads by its header, or by its cells, and says when Excel ate a number', async () => {
    const { cardsFromCsv } = await import('../api/cart/gift-card-read.js');
    const pick = (r) => r.cards.map((c) => [c.number, c.pin, c.balance]);
    expect(pick(cardsFromCsv('Card Number,PIN,Balance\n6060100000000001111,111111,$200.00\n"6060100000000002222","222222","150"\n')))
      .toEqual([['6060100000000001111', '111111', 200], ['6060100000000002222', '222222', 150]]);
    // Columns in another order, semicolons, no header at all.
    expect(pick(cardsFromCsv('Amount;Pin;Gift Card\n100.00;1234;6060100000000003333\n'))).toEqual([['6060100000000003333', '1234', 100]]);
    expect(pick(cardsFromCsv('6060100000000004444,4321,25.00\n'))).toEqual([['6060100000000004444', '4321', 25]]);
    // cardwell's own export: a Retailer column, an Added timestamp, a 12-digit PIN.
    const cw = cardsFromCsv('Retailer,Card number,PIN,Added,Balance\n"Finishline/JD Sports","5896000000001111","208900000001","2026-09-29T11:09:40.345Z","65.00"\n');
    expect(cw.cards).toEqual([{ number: '5896000000001111', pin: '208900000001', balance: 65, retailer: 'Finishline/JD Sports' }]);
    // 6.06E+18: the digits are gone. Counted, never guessed.
    const m = cardsFromCsv('Card Number,PIN,Balance\n6.06011E+18,111111,200\n6060100000000005555,555555,200\n');
    expect(m.mangled).toBe(1);
    expect(pick(m)).toEqual([['6060100000000005555', '555555', 200]]);
  });

  // Every live card as one PDF. It prints every code on the request, so it follows
  // gc-reveal's rules exactly: the desk, or the buyer once released; trail row first.
  test('all the cards as one PDF: the desk any time, the buyer only once released, and it is on the trail', async ({ request }) => {
    const { PDFDocument } = await import('pdf-lib');
    const cartId = await newRequest(request, { lines: [LINE] });          // $108.25 to fund
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6060100000000001111', pin: '111111', balance: 100 } });
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6060100000000002222', balance: 8.25 } });
    const get = (who) => request.get(`/api/cart/gift-cards-pdf?cartId=${cartId}`, { headers: { Authorization: `Bearer ${tokenFor(people[who])}` } });

    expect((await get('approver')).status()).toBe(403);
    expect((await get('buyer')).status()).toBe(409);                      // not released yet

    const desk = await get('issuer');
    expect(desk.status()).toBe(200);
    expect(desk.headers()['content-type']).toContain('application/pdf');
    expect(desk.headers()['cache-control']).toContain('no-store');
    expect((await PDFDocument.load(await desk.body())).getPageCount()).toBe(2);   // a page a card

    expect((await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true })).status).toBe(200);
    expect((await get('buyer')).status()).toBe(200);

    const { rows } = await pool.query(`SELECT body FROM buy_cart_events WHERE cart_id = $1 AND kind = 'gc_pdf' ORDER BY id`, [cartId]);
    expect(rows.length).toBe(2);
    expect(rows[0].body).toMatch(/2 cards · \$108\.25/);
    expect(rows.map((r) => r.body).join(' ')).not.toMatch(/\d{8,}/);  // never a card number
  });
});

// ── How many the shop has, per size ──────────────────────────────────────────────
// The buyer states no quantity to BUY — that is the decision being asked for — but
// "there are two left" and "there is a wall of them" are different requests, and the
// approver setting a number could not tell them apart. `available_qty` is the buyer's
// COUNT, deliberately optional: a blank means they didn't count, which must never be
// read as "the shop has none" (only one of those argues against buying).
test('the buyer states how many the shop has, and blank stays blank', async ({ request }) => {
  const cartId = await newRequest(request, {
    submit: false,
    lines: [
      { sku: 'CW2288-111', size: '9', shelfPrice: 50, availableQty: 3 },
      { sku: 'CW2288-111', size: '10', shelfPrice: 50 },                 // didn't count
      { sku: 'CW2288-111', size: '11', shelfPrice: 50, availableQty: 0 }, // 0 is not an answer
    ],
  });
  const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
  const bySize = Object.fromEntries(body.cart.lines.map((l) => [l.size, l]));

  expect(bySize['9'].available_qty).toBe(3);
  // NULL, not 0. `Number(null) || 0` is exactly the coercion that makes "nobody counted"
  // look like an answer, and it is the same trap `qty` was fixed for.
  expect(bySize['10'].available_qty).toBeNull();
  expect(bySize['11'].available_qty).toBeNull();

  // And it never becomes the quantity: that is still the approver's, still NULL here.
  expect(bySize['9'].qty).toBeNull();
});

test('the count is the buyer’s observation — approving above it is allowed, not blocked', async ({ request }) => {
  const cartId = await newRequest(request, {
    lines: [{ sku: 'CW2288-111', size: '9', shelfPrice: 50, availableQty: 2 }],
  });
  // Deliberately more than the shelf held. Stock moves between the buyer walking the
  // aisle and the desk deciding, and refusing here would strand a legitimate "take more
  // if they restock" — the screen and the Telegram card flag it instead.
  const r = await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: 5 });
  expect(r.status).toBe(200);

  const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
  const line = body.cart.lines[0];
  expect(line.qty).toBe(5);
  // The count is NOT rewritten to match the decision: it is what the buyer saw, and the
  // gap between the two is the thing worth being able to read afterwards.
  expect(line.available_qty).toBe(2);
  // Funding still follows the approved quantity, so the over-approval is really funded —
  // which is exactly why it has to be visible rather than silent. 5 × $50 = $250.
  expect(body.cart.approved_amount).toBe(250);
});

test('the count can be corrected, and cleared back to "didn’t count"', async ({ request }) => {
  const cartId = await newRequest(request, {
    submit: false,
    lines: [{ sku: 'CW2288-111', size: '9', shelfPrice: 50, availableQty: 3 }],
  });
  const { body: before } = await read_(request, 'approver', `cart/get?id=${cartId}`);
  const lineId = before.cart.lines[0].id;

  const fixed = await call(request, 'approver', 'cart/line', { cartId, lineId, patch: { availableQty: 6 } });
  expect(fixed.status).toBe(200);
  expect(fixed.body.line.available_qty).toBe(6);

  // An explicit empty string UNSETS it. Every other field here follows the coalesce rule
  // (absent = leave alone), which has no way to say "make it empty" — and empty is a
  // real value for this one.
  const cleared = await call(request, 'approver', 'cart/line', { cartId, lineId, patch: { availableQty: '' } });
  expect(cleared.status).toBe(200);
  expect(cleared.body.line.available_qty).toBeNull();
});

test('a tip answer is read strictly — ok / no / an amount, and nothing else', async () => {
  const { splitTipReply } = await import('../src/lib/buyPaste.js');
  expect(splitTipReply('tip ok')).toEqual({ tip: { action: 'approve', amount: null }, rest: '' });
  expect(splitTipReply('Approved tip request').tip).toEqual({ action: 'approve', amount: null });
  expect(splitTipReply('tip $7.50').tip).toEqual({ action: 'approve', amount: 7.5 });
  expect(splitTipReply('decline tip').tip).toEqual({ action: 'decline', amount: null });
  expect(splitTipReply('9 x 2, tip no')).toEqual({ tip: { action: 'decline', amount: null }, rest: '9 x 2' });
  expect(splitTipReply('tip maybe').error).toMatch(/Couldn't read "tip maybe"/);
  expect(splitTipReply('tip ok\ntip no').error).toMatch(/twice/);
  expect(splitTipReply('9 x 2')).toEqual({ tip: null, rest: '9 x 2' });
});

test('a photo that could not be sent says which step broke, and only a safe step is tried again', async () => {
  const { isNetDrop, mayRetryPhoto, photoWhy, netCode } = await import('../api/_lib/telegram.js');
  const drop = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
  const answered = Object.assign(new Error('sendPhoto: Bad Request: IMAGE_PROCESS_FAILED'), { status: 400 });
  expect(isNetDrop(drop('ECONNRESET'))).toBe(true);
  expect(isNetDrop(answered)).toBe(false);                      // Telegram said no — not a drop
  expect(isNetDrop(new Error('R2 GET k failed (403)'))).toBe(false);
  expect(netCode(drop('UND_ERR_SOCKET'))).toBe('UND_ERR_SOCKET');
  // Reading is safe to repeat on any drop; an upload only when it never left the building.
  expect(mayRetryPhoto('read', drop('ECONNRESET'))).toBe(true);
  expect(mayRetryPhoto('upload', drop('ECONNRESET'))).toBe(false); // may have landed — no second card
  expect(mayRetryPhoto('upload', drop('ECONNREFUSED'))).toBe(true);
  // Not a drop — the same answer three times, holding up the one Telegram queue (#401 CI).
  expect(mayRetryPhoto('read', drop('ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE'))).toBe(false);
  expect(mayRetryPhoto('read', drop('ENOTFOUND'))).toBe(false);
  expect(mayRetryPhoto('read', drop(undefined))).toBe(false);
  expect(mayRetryPhoto('read', answered)).toBe(false);
  expect(photoWhy('read', drop('ECONNRESET'))).toBe('fetch failed · ECONNRESET — reading it from storage');
  expect(photoWhy('upload', drop('UND_ERR_SOCKET'))).toBe('fetch failed · UND_ERR_SOCKET — uploading it to Telegram');
});

test('a card link sits exactly on its line, whatever comes before it', async () => {
  const { lineLinks } = await import('../api/_lib/telegram.js');
  const at = (text, line) => { const [e] = lineLinks(text, [{ line, url: 'https://stockx.com/x' }]); return e ? text.slice(e.offset, e.offset + e.length) : null; };
  expect(at('Air Jordan 1\nDO9328-004\nShelf $50', 'DO9328-004')).toBe('DO9328-004');
  expect(at('DO9328-004\nShelf $50', 'DO9328-004')).toBe('DO9328-004');            // no name line
  expect(at('⚠️ Photo unavailable (x)\n\n⭐ Nike\nDO9328-004\nmore', 'DO9328-004')).toBe('DO9328-004'); // emoji before it
  expect(at('Shelf DO9328-004 x\nmore', 'DO9328-004')).toBe(null);                  // only a WHOLE line
});

test('a reply can name a RANGE of sizes — the card sizes between them, one quantity each', async () => {
  const { parseApprovalReply } = await import('../src/lib/buyPaste.js');
  const lines = ['10.5', '11', '11.5', '13.5', '14'].map((size, i) => ({ id: i + 1, size }));
  const read = (t) => { const r = parseApprovalReply(t, lines); return r.ok ? r.approve.map((a) => `${a.line.size}×${a.qty}`) : r.error; };
  expect(read('10.5-11.5 x 2')).toEqual(['10.5×2', '11×2', '11.5×2']);
  expect(read('10.5 - 11.5 x 2\n14 x 1')).toEqual(['10.5×2', '11×2', '11.5×2', '14×1']);
  expect(read('11 to 14 x 3')).toEqual(['11×3', '11.5×3', '13.5×3', '14×3']);
  expect(read('10.5-11.5 x 2\n11 x 1')).toMatch(/Size 11 is in the reply twice/);
  expect(read('5-6 x 1')).toMatch(/5-6 isn’t on this card/);
});

// ---------------------------------------------------------------------------
// Floor feedback, 2026-11-02 (docs/context/buy-cart.md "Floor feedback, November"):
// change a decision (James), market sales per size (Alex), full box / edit after sending /
// X out a pair (Andrew).
test.describe('floor feedback, November', () => {
  const lineIdsOf = async (request, cartId) =>
    (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines.map((l) => Number(l.id));

  test('the buyer fixes their own pair after sending it — never the quantity, never once answered', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [{ ...LINE, size: '10' }] });
    const [lineId] = await lineIdsOf(request, cartId);
    const fix = await call(request, 'buyer', 'cart/line', { cartId, lineId,
      patch: { shelfPrice: 55, availableQty: 3, fullBox: true, premium: true, tipProposed: 10, qty: 7 } });
    expect(fix.status).toBe(200);
    expect(fix.body.line.shelf_price).toBe(55);
    expect(fix.body.line.available_qty).toBe(3);
    expect(fix.body.line.full_box).toBe(true);
    expect(fix.body.line.premium).toBe(true);
    expect(fix.body.line.tip_proposed).toBe(10);
    expect(fix.body.line.tip_status).toBe('proposed');
    expect(fix.body.line.qty).toBeNull();                       // the approver's, ignored
    const ev = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.events.find((e) => e.kind === 'line_edited');
    expect(ev.body).toMatch(/shelf \$50\.00 → \$55\.00/);
    expect(ev.body).toMatch(/full box/);
    expect(ev.body).toMatch(/tip proposed \$10\.00\/pair/);

    // Un-premium clears the tip with it.
    const plain = await call(request, 'buyer', 'cart/line', { cartId, lineId, patch: { premium: false } });
    expect(plain.body.line.premium).toBe(false);
    expect(plain.body.line.tip_proposed).toBeNull();
    expect(plain.body.line.tip_status).toBeNull();

    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: 1 });
    const late = await call(request, 'buyer', 'cart/line', { cartId, lineId, patch: { shelfPrice: 60 } });
    expect(late.status).toBe(409);
  });

  test('a pair can be marked full box when it is asked about', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [{ ...LINE, fullBox: true }] });
    const cart = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(cart.lines[0].full_box).toBe(true);
    expect(cart.events.find((e) => e.kind === 'line_added').body).toMatch(/full box/);
  });

  test('X out: the buyer drops an approved pair before the cards, and the target follows', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE, { ...LINE, size: '10' }] });   // 2 sizes × 2 × $50
    const [a, b] = await lineIdsOf(request, cartId);
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: 2 });

    // A pending pair can't be X'd out (that is the × remove) — only an approved one.
    const out = await call(request, 'buyer', 'cart/line', { cartId, lineId: b, skip: true });
    expect(out.status).toBe(200);
    expect(out.body.line.status).toBe('skipped');
    expect(out.body.cart.approved_amount).toBe(100);
    expect(out.body.cart.skipped_count).toBe(1);
    expect(out.body.cart.status).toBe('approved');

    // An approver can't re-decide it — not one line, not "approve all", not "turn down all".
    const forced = await call(request, 'approver', 'cart/decide', { cartId, lineIds: [b], action: 'approve', qty: { [b]: 2 } });
    expect(forced.status).toBe(409);
    expect(forced.body.error).toMatch(/X’d it out/);
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'reject', reason: 'e2e' });
    let cart = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    expect(cart.lines.find((l) => Number(l.id) === b).status).toBe('skipped');
    expect(cart.events.some((e) => e.kind === 'line_skipped')).toBe(true);

    // Undo puts it back as it was approved — and the turned-down one stays turned down.
    await call(request, 'approver', 'cart/decide', { cartId, lineIds: [a], action: 'approve', qty: { [a]: 2 } });
    const back = await call(request, 'buyer', 'cart/line', { cartId, lineId: b, skip: false });
    expect(back.status).toBe(200);
    expect(back.body.line.status).toBe('approved');
    expect(back.body.line.qty).toBe(2);
    expect(back.body.cart.approved_amount).toBe(200);

    // Once a card is recorded, the cards were sized for it — refused, and says what to do.
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '4111111111118888', balance: 50 } });
    const late = await call(request, 'buyer', 'cart/line', { cartId, lineId: b, skip: true });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/gift cards are already out/i);
  });

  test('another buyer cannot X out someone else’s pair', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const [a] = await lineIdsOf(request, cartId);
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: 1 });
    const r = await call(request, 'buyer2', 'cart/line', { cartId, lineId: a, skip: true });
    expect([403, 404]).toContain(r.status);
  });

  test('an approver can change their mind until the cards go out', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const [a] = await lineIdsOf(request, cartId);
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: 2 });
    const no = await call(request, 'approver', 'cart/decide', { cartId, lineIds: [a], action: 'reject', reason: 'changed my mind' });
    expect(no.status).toBe(200);
    let line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    expect(line.status).toBe('rejected');
    expect(line.overrode_status).toBe('approved');
    expect(line.overrode_qty).toBe(2);
    const yes = await call(request, 'approver', 'cart/decide', { cartId, lineIds: [a], action: 'approve', qty: { [a]: 3 } });
    expect(yes.status).toBe(200);
    line = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    expect(line.status).toBe('approved');
    expect(line.qty).toBe(3);
  });

  test('market sales are the approver’s — a buyer’s copy never carries them', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const [a] = await lineIdsOf(request, cartId);
    await pool.query(`UPDATE buy_cart_lines SET market_sales = $2::jsonb, market_sales_at = now() WHERE id = $1`,
      [a, JSON.stringify({ source: 'alias', sold_7d: 2, sold_30d: 9, avg_30d: 120, high_30d: 140, low_30d: 100, last: [], read_at: new Date().toISOString() })]);
    const desk = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart.lines[0];
    expect(desk.market_sales.sold_30d).toBe(9);
    const buyer = (await read_(request, 'buyer', `cart/get?id=${cartId}`)).body.cart.lines[0];
    expect(buyer.market_sales).toBeNull();
  });

  test('the sales summary counts 7 and 30 days and says when it is a floor (pure)', async () => {
    const { summarizeSales, salesSentence } = await import('../api/_lib/marketSales.js');
    const now = Date.parse('2026-11-02T12:00:00Z');
    const at = (days) => new Date(now - days * 86_400_000).toISOString();
    const s = summarizeSales([{ at: at(1), price: 236 }, { at: at(3), price: 241 }, { at: at(10), price: 326 }, { at: at(40), price: 200 }], { now });
    expect(s).toMatchObject({ sold_7d: 2, sold_30d: 3, avg_30d: 267.67, high_30d: 326, low_30d: 236, capped: false });
    expect(s.last).toHaveLength(4);
    expect(salesSentence(s)).toBe('3 sold in 30 days (2 this week) · avg $268 · $236–$326');
    const full = summarizeSales(Array.from({ length: 3 }, (_, i) => ({ at: at(i + 1), price: 100 })), { now, limit: 3 });
    expect(full.capped).toBe(true);
    expect(salesSentence(full)).toMatch(/^3\+ sold/);
    expect(salesSentence(summarizeSales([], { now }))).toBe('No recent sales');
  });

  test('on screen: the supplier sees the tax and the exact gift card total', async ({ page, request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: 2 });
    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    const strip = page.locator('.bc-money');
    await expect(strip).toContainText('Approved $100.00');
    await expect(strip).toContainText('Tax (8.25%) $8.25');
    await expect(strip).toContainText('Gift cards needed $108.25');
  });

  test('on screen: an empty Qty box approves one, and the buyer can say they found more', async ({ page, request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    await pool.query(`UPDATE buy_carts SET list_closed_at = NULL WHERE id = $1`, [cartId]);
    await as(page, 'approver');
    await page.goto(`/buy-carts?request=${cartId}`);
    await page.locator('.bc-lines tbody input[type="checkbox"]').first().check();
    await expect(page.locator('.bc-qty-in').first()).toHaveAttribute('placeholder', '1');
    await page.getByRole('button', { name: 'Approve selected' }).click();
    await expect(page.locator('.bc-line-status.approved')).toBeVisible();
    expect((await pool.query('SELECT qty FROM buy_cart_lines WHERE cart_id = $1', [cartId])).rows[0].qty).toBe(1);
    // The approved pair is counted on the page without a refresh, and the supplier never sees it.
    await expect(page.locator('.bc-not-here-total')).toContainText('Not in warehouse yet:');
    await expect(page.locator('.bc-not-here').getByText(/Approved, not bought yet: .*9 ×/)).toBeVisible();

    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    await expect(page.locator('.bc-lines')).toBeVisible();
    await expect(page.locator('.bc-not-here')).toHaveCount(0);
    await page.getByRole('button', { name: /Found more of CW2288-111 size 9/ }).first().click();
    await expect(page.getByText('Size 9 is approved ×1, and that stays.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Size', exact: true })).toHaveValue('9');
    await page.getByLabel('How many did you find?').fill('2');
    await page.getByRole('button', { name: 'Send to the desk' }).click();
    await expect(page.getByText('2 in store', { exact: true })).toBeVisible();
    const rows = (await pool.query('SELECT status, qty, available_qty FROM buy_cart_lines WHERE cart_id = $1 ORDER BY id', [cartId])).rows;
    expect(rows).toEqual([expect.objectContaining({ status: 'approved', qty: 1 }), expect.objectContaining({ status: 'pending', qty: null, available_qty: 2 })]);

    // Andrew: Found more of a DIFFERENT size, from the same button.
    await page.getByRole('button', { name: /Found more of CW2288-111 size 9/ }).first().click();
    await page.getByRole('textbox', { name: 'Size', exact: true }).fill('10.5');
    await page.getByLabel('How many did you find?').fill('3');
    await page.getByRole('button', { name: 'Send to the desk' }).click();
    await expect(page.locator('tr.bc-line').filter({ hasText: '10.5' })).toBeVisible();
    const ten = (await pool.query(`SELECT status, qty, available_qty, shelf_price FROM buy_cart_lines WHERE cart_id = $1 AND size = '10.5'`, [cartId])).rows;
    expect(ten).toEqual([expect.objectContaining({ status: 'pending', qty: null, available_qty: 3, shelf_price: '50.00' })]);
  });

  // Andrew: "the approved stuff on top and the rejected stuff on the bottom". Approved, then
  // waiting on an answer, then turned down / not buying; a shoe's sizes stay in order inside each.
  test('on screen: lines are listed approved first, then pending, then turned down and not buying', async ({ page, request }) => {
    const sizes = ['8', '9', '10', '11', '12'];
    const cartId = await newRequest(request, { lines: sizes.map((size) => ({ ...LINE, size })) });
    const ids = Object.fromEntries((await pool.query('SELECT id, size FROM buy_cart_lines WHERE cart_id = $1', [cartId])).rows.map((r) => [r.size, Number(r.id)]));
    await call(request, 'approver', 'cart/decide', { cartId, lineIds: [ids['8']], action: 'reject', reason: 'E2E: too close to retail' });
    await call(request, 'approver', 'cart/decide', { cartId, lineIds: [ids['11'], ids['10']], action: 'approve', qty: { [ids['11']]: 1, [ids['10']]: 1 } });
    await call(request, 'approver', 'cart/decide', { cartId, lineIds: [ids['12']], action: 'approve', qty: { [ids['12']]: 1 } });
    await call(request, 'buyer', 'cart/line', { cartId, lineId: ids['12'], skip: true });
    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    const order = page.locator('tr.bc-line td[data-label="Size"]');

    // The section is the APPROVED list (owner, 2026-11-14): approved pairs straight under
    // "Approved shoes" (no group row of their own), then "Waiting for a decision" (open),
    // then "Declined or not buying" (shut). A tap shows it, at the bottom.
    const heads = page.locator('tr.bc-group-row');
    await expect(page.locator('.bc-lines h3.bc-h').first()).toContainText('Approved shoes');
    await expect(heads).toHaveCount(2);
    await expect(heads.nth(0)).toContainText('Waiting for a decision');
    await expect(heads.nth(1)).toContainText('Declined or not buying');
    await expect(heads.nth(1)).toContainText('1 declined · 1 not buying');
    // How much each group adds up to (owner, 2026-11-13): pairs and SKUs, not just rows.
    // The "not buying" size 12 was approved and then dropped, so it is NOT in the total.
    await expect(heads.nth(0)).toContainText('1 line · 1 SKU');
    await expect(page.locator('.bc-approved-total')).toHaveText(' · 2 pairs (1 SKU)');
    await expect(order).toHaveText(['10', '11', '9']);
    await heads.nth(1).getByRole('button').click();
    await expect(order).toHaveText(['10', '11', '9', '8', '12']);
    await heads.nth(0).getByRole('button').click();          // waiting can be hidden too
    await expect(order).toHaveText(['10', '11', '8', '12']);

    // Grouped while the buyer is still adding too (owner, 2026-11-14) — same order.
    await pool.query('UPDATE buy_carts SET list_closed_at = NULL WHERE id = $1', [cartId]);
    await page.reload();
    await expect(heads).toHaveCount(2);
    await expect(order).toHaveText(['10', '11', '9']);

    // A pair approved while the page is open arrives by itself (live update) and is lit;
    // once nothing waits, "Waiting for a decision" is gone.
    await call(request, 'approver', 'cart/decide', { cartId, lineIds: [ids['9']], action: 'approve', qty: { [ids['9']]: 2 } });
    await expect(order).toHaveText(['9', '10', '11'], { timeout: 15000 });
    await expect(page.locator('tr.bc-line.bc-fresh')).toContainText('9');
    await expect(page.locator('.bc-approved-total')).toHaveText(' · 4 pairs (1 SKU)');
    await expect(heads).toHaveCount(1);
    await expect(heads.nth(0)).toContainText('Declined or not buying');
  });

  test('on screen: the approver has Change on a decided pair, the buyer ✕ Not buying', async ({ page, request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: 2 });
    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    await page.getByRole('button', { name: /Not buying CW2288-111 size 9/ }).click();
    await expect(page.locator('.bc-line-status.skipped')).toHaveText('not buying');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.bc-line-status.approved')).toBeVisible();
  });
});

test('plain-words replies and amount-first tips are read; anything else is still refused (pure)', async () => {
  const { parseApprovalReply, splitTipReply } = await import('../src/lib/buyPaste.js');
  const L = [{ id: 1, size: '14', available_qty: 2 }, { id: 2, size: '15', available_qty: 3 }];
  const q = (t) => { const r = parseApprovalReply(t, L); return r.ok ? r.approve.map((a) => `${a.line.size}x${a.qty}`).join(' ') + (r.reject.length ? ` -${r.reject.map((l) => l.size).join(',')}` : '') : 'ERR'; };
  expect(q('take all')).toBe('14x2 15x3');
  expect(q('Yes')).toBe('14x2 15x3');
  expect(q('Two each size max')).toBe('14x2 15x2');
  expect(q('max 1 each')).toBe('14x1 15x1');
  expect(q('3 each')).toBe('14x2 15x3');                // never more than the store has
  expect(q('nah')).toBe(' -14,15');
  expect(q('size 15 x two')).toBe('15x2 -14');
  expect(q('y')).toBe('ERR');                           // one letter is a typo, not a decision
  expect(q('take all of the blue ones')).toBe('ERR');
  for (const t of ['$5 tip', '5 tip', '5$ tip', '5 dollar tip', 'tip 5'])
    expect(splitTipReply(t).tip).toEqual({ action: 'approve', amount: 5 });
  expect(splitTipReply('take all, $5 tip')).toMatchObject({ tip: { action: 'approve', amount: 5 }, rest: 'take all' });
});

test('"take all except" turns down the sizes named and takes the rest (pure)', async () => {
  const { parseApprovalReply, splitTipReply } = await import('../src/lib/buyPaste.js');
  const L = [
    { id: 1, size: '8', available_qty: 3 }, { id: 2, size: '8.5', available_qty: 1 },
    { id: 3, size: '9', available_qty: null }, { id: 4, size: '10W', available_qty: 2 },
  ];
  const q = (t) => { const r = parseApprovalReply(t, L); return r.ok ? `${r.approve.map((a) => `${a.line.size}x${a.qty}`).join(' ')} -${r.reject.map((l) => l.size).join(',')}` : r.error; };
  const without85 = '8x3 9x1 10Wx2 -8.5';
  const without859 = '8x3 10Wx2 -8.5,9';
  expect(q('take all except 8.5')).toBe(without85);
  expect(q('Take all except 8.5.')).toBe(without85);
  expect(q('take all, except for size 8.5')).toBe(without85);
  expect(q('all but 8.5')).toBe(without85);
  expect(q('take everything except 8.5')).toBe(without85);
  expect(q('take all except 8.5 and 9')).toBe(without859);
  expect(q('take all except 8.5 9')).toBe(without859);
  expect(q('take all except 8.5, 9')).toBe(without859);
  expect(q('take all except\n8.5\n9')).toBe(without859);
  expect(q('take all except 8.5 8.5')).toBe(without85);       // said twice is still one size
  expect(q('take all except 10')).toBe('8x3 8.5x1 9x1 -10W'); // 10 = the only 10 on the card
  expect(q('2 each except 8.5')).toBe('8x2 9x2 10Wx2 -8.5');  // still capped at the store's count
  expect(parseApprovalReply('take all except 8.5', L).note)
    .toBe('Read "take all except 8.5" as every size except 8.5, as many as were counted in store (1 of 9 — not counted).');

  // A misread spends money: anything unclear records nothing.
  expect(q('take all except 11')).toMatch(/^11 isn’t on this card .*Nothing was recorded\.$/);
  expect(q('take all except 8.5, 11')).toMatch(/^11 isn’t on this card/);
  expect(q('take all except')).toMatch(/^Which sizes/);
  expect(q('take all except 8-9')).toMatch(/^Couldn't read "8-9" as a size/);
  expect(q('take all except the blue ones')).toMatch(/^Couldn't read/);
  expect(q('take all except 8 8.5 9 10')).toMatch(/^That leaves no sizes/);
  expect(q('no except 8.5')).toMatch(/^Couldn't read "no except 8.5"/);
  expect(q('except 8.5')).toMatch(/^Couldn't read "except 8.5"/);
  expect(q('8 x 2, 9 x 1 except 10')).toMatch(/^Couldn't read/);

  // Beside a tip, the webhook hands over the rest of the reply split onto lines.
  const split = splitTipReply('take all except 8.5, 9, tip ok');
  expect(split.tip).toEqual({ action: 'approve', amount: null });
  expect(q(split.rest)).toBe(without859);
});

// ── Shoes on the receipt that aren't ours ────────────────────────────────────────
// The cashier rang the buyer's own pairs up with the approved ones.
test.describe('taking shoes off a receipt', () => {
  const rows = [
    { sku: LINE.sku, size: LINE.size, qty: 1, unitPrice: 100, totalPrice: 100, source: 'paste' },
    { sku: 'DD1391-100', size: '10', qty: 1, unitPrice: 100, totalPrice: 100, source: 'paste' },
    { sku: 'DD1391-100', size: '11', qty: 1, unitPrice: 100, totalPrice: 100, source: 'paste' },
  ];
  async function receipted(request) {
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6060100000000009999', balance: 400 } });
    await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
    const saved = await call(request, 'buyer', 'cart/receipt', { cartId, receiptTotal: 324.75, subtotal: 300, tax: 24.75, lines: rows });
    expect(saved.status).toBe(200);
    return { cartId, lines: saved.body.cart.receiptLines };
  }

  test('the auditor or approver removes shoes, the total follows with their tax, and it can be undone', async ({ request }) => {
    const { cartId, lines } = await receipted(request);
    const [, his, his2] = lines.map((l) => Number(l.id));

    // Never the buyer: it lowers what they have to account for.
    expect((await call(request, 'buyer', 'cart/receipt-remove', { cartId, lineIds: [his], reason: 'mine' })).status).toBe(403);
    expect((await call(request, 'bystander', 'cart/receipt-remove', { cartId, lineIds: [his], reason: 'mine' })).status).toBe(403);
    expect((await call(request, 'auditor', 'cart/receipt-remove', { cartId, lineIds: [his] })).status).toBe(400);

    const one = await call(request, 'auditor', 'cart/receipt-remove', { cartId, lineIds: [his], reason: 'Buyer own purchase' });
    expect(one.status).toBe(200);
    expect(one.body.cart.receipt_total).toBe(216.5);          // 2/3 of 324.75, tax and all
    expect(Number(one.body.cart.receipt_subtotal)).toBe(200);
    expect(Number(one.body.cart.receipt_tax)).toBe(16.5);
    expect(one.body.cart.receipt_printed_total).toBe(324.75);
    expect(Number(one.body.cart.balance_remaining)).toBe(183.5);
    expect(one.body.cart.receiptLines).toHaveLength(2);
    expect(one.body.cart.removedReceiptLines[0]).toMatchObject({ removed_reason: 'Buyer own purchase', sku: 'DD1391-100', size: '10' });

    // A second removal, by the approver, still works from the printed figures.
    const two = await call(request, 'approver', 'cart/receipt-remove', { cartId, lineIds: [his2], reason: 'Buyer own purchase' });
    expect(two.body.cart.receipt_total).toBe(108.25);
    // Not the last row: a receipt with nothing on it isn't a receipt.
    const last = Number(two.body.cart.receiptLines[0].id);
    expect((await call(request, 'auditor', 'cart/receipt-remove', { cartId, lineIds: [last], reason: 'Buyer own purchase' })).status).toBe(409);

    // Saving replaces every row, which would quietly bring them back.
    const again = await call(request, 'buyer', 'cart/receipt', { cartId, receiptTotal: 324.75, lines: rows });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/Put them back/);

    // The trail says who, why and what the total did.
    const ev = (await pool.query(`SELECT body FROM buy_cart_events WHERE cart_id = $1 AND kind = 'receipt_lines_removed' ORDER BY id`, [cartId])).rows;
    expect(ev[0].body).toMatch(/Buyer own purchase.*\$324\.75 → \$216\.50/);

    const back = await call(request, 'auditor', 'cart/receipt-remove', { cartId, lineIds: [his, his2], restore: true });
    expect(back.status).toBe(200);
    expect(back.body.cart.receipt_total).toBe(324.75);
    expect(Number(back.body.cart.receipt_tax)).toBe(24.75);
    expect(back.body.cart.receipt_printed_total).toBeNull();
    expect(back.body.cart.removedReceiptLines).toHaveLength(0);
    expect((await call(request, 'buyer', 'cart/receipt', { cartId, receiptTotal: 324.75, subtotal: 300, tax: 24.75, lines: rows })).status).toBe(200);
  });

  test('the audit gap follows the adjusted total', async ({ request }) => {
    const { cartId, lines } = await receipted(request);
    await call(request, 'auditor', 'cart/receipt-remove', { cartId, lineIds: [Number(lines[1].id), Number(lines[2].id)], reason: 'Buyer own purchase' });
    const { body } = await read_(request, 'auditor', `cart/get?id=${cartId}`);
    const card = body.cart.giftCards[0];
    const audited = await call(request, 'auditor', 'cart/audit', { cartId, cards: [{ id: card.id, spent: 108.25, remaining: 291.75 }] });
    expect(audited.status).toBe(200);
    expect(audited.body.checks.find((k) => k.key === 'spend_reconciled').ok).toBe(true);
  });

  test('the order stops expecting the pair, and a packed pair is refused', async ({ request }) => {
    const { cartId, lines } = await receipted(request);
    const raised = await call(request, 'buyer', 'cart/raise-po', { cartId });
    expect(raised.status).toBe(200);
    const poId = raised.body.po.id;
    const expected = async (size) => (await pool.query(
      `SELECT qty_expected FROM po_lines WHERE po_id = $1 AND po_box_id IS NULL AND sku = 'DD1391-100' AND size = $2`, [poId, size])).rows[0]?.qty_expected;
    expect(await expected('10')).toBe(1);

    const gone = await call(request, 'auditor', 'cart/receipt-remove', { cartId, lineIds: [Number(lines[1].id)], reason: 'Buyer own purchase' });
    expect(gone.status).toBe(200);
    expect(await expected('10')).toBeUndefined();
    expect(gone.body.cart.pack.totalQty).toBe(2);

    const back = await call(request, 'auditor', 'cart/receipt-remove', { cartId, lineIds: [Number(lines[1].id)], restore: true });
    expect(back.status).toBe(200);
    expect(await expected('10')).toBe(1);

    // On a box's packing list: it's on its way to us, so it can't quietly be the buyer's.
    const box = (await pool.query(`SELECT id FROM po_boxes WHERE po_id = $1 LIMIT 1`, [poId])).rows[0].id;
    await pool.query(`INSERT INTO po_lines (po_id, po_box_id, sku, size, qty_expected) VALUES ($1, $2, 'DD1391-100', '11', 1)`, [poId, box]);
    const packed = await call(request, 'auditor', 'cart/receipt-remove', { cartId, lineIds: [Number(lines[2].id)], reason: 'Buyer own purchase' });
    expect(packed.status).toBe(409);
    expect(packed.body.error).toMatch(/packing list/);
  });

  test('on screen: the auditor ticks a row, sees the new total first, and can put it back', async ({ page, request }) => {
    const { cartId } = await receipted(request);
    await as(page, 'auditor');
    await page.goto(`/buy-carts?request=${cartId}`);
    const row = page.locator('#bc-sec-receipt tr').filter({ has: page.getByRole('cell', { name: '10', exact: true }) });
    await row.getByRole('checkbox').check();
    await expect(page.locator('.bc-receipt-remove')).toContainText('$108.25');
    await expect(page.locator('.bc-receipt-remove')).toContainText('$216.50');
    const remove = page.getByRole('button', { name: 'Remove from the receipt' });
    await expect(remove).toBeDisabled();                       // no reason yet
    await page.getByLabel('Why these shoes are not ours').fill('Buyer own purchase');
    await remove.click();
    await expect(page.locator('.bc-receipt-removed')).toContainText('Buyer own purchase');
    await expect(page.locator('#bc-sec-receipt')).toContainText('printed $324.75');
    await page.getByRole('button', { name: 'Put back' }).click();
    await expect(page.locator('.bc-receipt-removed')).toHaveCount(0);
  });

  test('on screen: the buyer has no tick boxes', async ({ page, request }) => {
    const { cartId } = await receipted(request);
    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    await expect(page.locator('#bc-sec-receipt table')).toBeVisible();
    await expect(page.locator('#bc-sec-receipt table input[type=checkbox]')).toHaveCount(0);
  });

  test('the auditor can download the cards once they are released, and it is on the trail', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6060100000000001212', pin: '121212', balance: 108.25 } });
    const get = (who) => request.get(`/api/cart/gift-cards-pdf?cartId=${cartId}`, { headers: { Authorization: `Bearer ${tokenFor(people[who])}` } });
    expect((await get('auditor')).status()).toBe(409);        // not released yet
    await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
    const pdf = await get('auditor');
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    expect((await get('bystander')).status()).toBe(403);
    expect((await get('approver')).status()).toBe(403);
    const { rows: ev } = await pool.query(`SELECT body FROM buy_cart_events WHERE cart_id = $1 AND kind = 'gc_pdf'`, [cartId]);
    expect(ev.length).toBe(1);
    // The single-card reveal stays with the desk and the buyer.
    const gcId = (await read_(request, 'auditor', `cart/get?id=${cartId}`)).body.cart.giftCards[0].id;
    expect((await call(request, 'auditor', 'cart/gc-reveal', { cartId, gcId })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The cost stack must not reach a supplier by ANY route. These assert on the raw JSON a
// buyer's browser receives (the whole response, stringified), not on the one field a
// screen happens to read: a hidden column is not a control. The stack's other keys are
// searched for by NAME, so a copy sitting under a different property would still fail.
test.describe('the cost stack never reaches a supplier’s browser', () => {
  const STACK_KEYS = ['cashbackPct', 'shippingAmt', 'tipAmt', 'storePct', 'promoPct', 'giftPct', 'presetName'];
  const noStack = (body) => {
    const raw = JSON.stringify(body);
    for (const k of STACK_KEYS) expect(raw, `response leaks "${k}"`).not.toContain(k);
  };

  test('cart/list: a buyer’s rows carry the tax and the total, never the stack; staff still get it', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });

    const mine = await read_(request, 'buyer', 'cart/list');
    expect(mine.status).toBe(200);
    const row = mine.body.carts.find((c) => Number(c.id) === cartId);
    expect(row).toBeTruthy();
    noStack(mine.body);
    expect(row.cost_stack).toBeNull();
    expect(row.preset_id).toBeNull();
    // The Needed column: shelf + declared tax, exactly.
    expect(row.funding_tax_pct).toBe(8.25);
    expect(row.funding_target).toBeCloseTo(108.25, 2);
    expect(row.approved_amount).toBe(100);
    // The queue's rows are still bare rows (no invented lines/events arrays).
    expect(row.lines).toBeUndefined();

    for (const who of ['approver', 'auditor', 'issuer']) {
      const staff = await read_(request, who, 'cart/list');
      const s = staff.body.carts.find((c) => Number(c.id) === cartId);
      expect(s.cost_stack.cashbackPct, who).toBe(0);
      expect(s.cost_stack.shippingAmt, who).toBe(8.25);
      expect(s.funding_target, who).toBeCloseTo(108.25, 2);
    }
  });

  test('cart/create: the new request a buyer gets back has no stack; staff opening one for them do', async ({ request }) => {
    const mine = await call(request, 'buyer', 'cart/create', { merchant: 'nike', retailer: 'E2E Leak Store' });
    expect(mine.status).toBe(200);
    noStack(mine.body);
    expect(mine.body.cart.cost_stack).toBeNull();
    expect(mine.body.cart.funding_tax_pct).toBe(8.25);   // the preset's rate, kept for the cards

    const staff = await call(request, 'approver', 'cart/create', { merchant: 'nike', retailer: 'E2E Leak Store', buyerUserId: people.buyer.uid });
    expect(staff.status).toBe(200);
    expect(staff.body.cart.cost_stack.shippingAmt).toBe(8.25);
  });

  test('cart/costs: a buyer is refused with no cart in the answer; the desk’s answer keeps the stack', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    const buyer = await call(request, 'buyer', 'cart/costs', { cartId, stack: { storePct: 40, taxPct: 8.25 } });
    expect(buyer.status).toBe(403);
    expect(buyer.body.cart).toBeUndefined();
    noStack(buyer.body);

    const desk = await call(request, 'approver', 'cart/costs', { cartId, stack: { storePct: 10, taxPct: 8.25, tipAmt: 5, shippingAmt: 8.25 } });
    expect(desk.status).toBe(200);
    expect(desk.body.cart.cost_stack.storePct).toBe(10);
    // The no-change early return is the other `cart` the endpoint sends.
    const again = await call(request, 'approver', 'cart/costs', { cartId, stack: { storePct: 10, taxPct: 8.25, tipAmt: 5, shippingAmt: 8.25 } });
    expect(again.body.cart.cost_stack.storePct).toBe(10);
  });

  test('the trail does not replay the stack: costs_edited is redacted for a buyer on every cart read', async ({ request }) => {
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
    await call(request, 'approver', 'cart/costs', { cartId, stack: { storePct: 12, cashbackPct: 3, taxPct: 8.25, tipAmt: 7, shippingAmt: 9 } });

    // Staff keep the full before/after — it is the audit trail.
    const staff = (await read_(request, 'approver', `cart/get?id=${cartId}`)).body.cart;
    const edit = staff.events.find((e) => e.kind === 'costs_edited');
    expect(edit.body).toMatch(/→ 12%/);
    expect(edit.body).toMatch(/→ \$7\.00/);

    // The buyer sees THAT the desk updated the costs, not what moved.
    const mine = await read_(request, 'buyer', `cart/get?id=${cartId}`);
    noStack(mine.body);
    const seen = mine.body.cart.events.find((e) => e.kind === 'costs_edited');
    expect(seen).toBeTruthy();
    expect(seen.body).not.toMatch(/→|%|\$/);
    // …and the whole response has none of the new figures either.
    expect(JSON.stringify(mine.body)).not.toMatch(/→ 12%|→ \$7\.00|→ \$9\.00/);
  });

  test('redactCartForViewer (pure): bare queue rows stay bare, the tax survives, staff are untouched', async () => {
    const { redactCartForViewer } = await import('../api/_lib/buycart.js');
    const stack = { taxPct: 8.25, tipAmt: 5, shippingAmt: 8.25, cashbackPct: 2 };
    const row = { id: 1, cost_stack: stack, preset_id: 7, funding_tax_pct: 8.25, funding_target: 108.25 };
    const supplier = { role: 'supplier', uid: 1 };
    expect(redactCartForViewer(row, supplier)).toEqual({ id: 1, cost_stack: null, preset_id: null, funding_tax_pct: 8.25, funding_target: 108.25 });
    expect(redactCartForViewer(row, { role: 'warehouse', uid: 2 })).toBe(row);
    expect(redactCartForViewer(row, { role: 'admin', uid: 3 })).toBe(row);
    const ev = redactCartForViewer({ ...row, lines: [], events: [{ kind: 'costs_edited', body: 'Tip $ 5.00 → $ 9.00' }] }, supplier);
    expect(ev.events[0].body).not.toContain('9.00');
  });
});

// ── A size is required ───────────────────────────────────────────────────────────
// Pricing, the payout and the profit are all per size.
test.describe('a size is required', () => {
  test('the server refuses a line with no size, for the buyer and for staff, whole', async ({ request }) => {
    const cartId = await newRequest(request, { submit: false, lines: [] });
    const base = { sku: LINE.sku, shelfPrice: 50 };
    for (const size of [undefined, null, '', '   ', 'n/a', 'N/A', 'none', '-', '?']) {
      for (const who of ['buyer', 'approver']) {
        const r = await call(request, who, 'cart/line', { cartId, line: { ...base, size } });
        expect(r.status, `${who} size=${JSON.stringify(size)}`).toBe(400);
        expect(r.body.error).toMatch(/Pick a size/);
      }
    }
    // One blank in a run refuses the run, rather than asking about half of it.
    const run = await call(request, 'buyer', 'cart/line', { cartId, lines: [{ ...base, size: '9' }, { ...base }] });
    expect(run.status).toBe(400);
    expect((await read_(request, 'buyer', `cart/get?id=${cartId}`)).body.cart.lines).toHaveLength(0);
    for (const size of ['9', '10.5', '10W', '5Y', 'XL', 'OS']) {
      expect((await call(request, 'approver', 'cart/line', { cartId, line: { ...base, size } })).status, size).toBe(200);
    }
  });

  test('on screen: Ask waits for a size, and a shoe with no sizes listed can have one typed', async ({ page, request }) => {
    const cartId = await newRequest(request, { submit: false, lines: [] });
    await shoePhotos(cartId, ['HV4091-777']);
    await page.route('**/api/sku-search', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, product: { sku: 'HV4091-777', name: 'New Release', colorway: 'Red', sizes: [] } }),
    }));
    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    await page.getByPlaceholder('SKU or style code').fill('HV4091-777');
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.locator('.bc-sizes')).toContainText('Type the size off the box');
    await page.locator('.bc-add-row .ph-price').fill('48');

    const ask = page.getByRole('button', { name: 'Ask the desk about this' });
    await expect(ask).toBeDisabled();
    await expect(page.locator('.bc-add-actions')).toContainText('Pick a size');

    await page.getByLabel('Type a size').fill('10.5');
    await page.getByLabel('Type a size').press('Enter');
    await expect(page.locator('.bc-sizes .size-chip.on')).toHaveText('10.5');
    await expect(ask).toBeEnabled();

    // Tapping it off takes the button back with it.
    await page.locator('.bc-sizes .size-chip.on').click();
    await expect(ask).toBeDisabled();
    await page.locator('.bc-sizes .size-chip').filter({ hasText: /^10\.5$/ }).click();
    await ask.click();
    await expect(page.locator('.bc-lines').filter({ hasText: 'HV4091-777' })).toBeVisible();
    const line = (await read_(request, 'buyer', `cart/get?id=${cartId}`)).body.cart.lines[0];
    expect(line.size).toBe('10.5');
  });

  test('an edit cannot wipe a size or swap it for a stand-in', async ({ request }) => {
    const cartId = await newRequest(request, { submit: false, lines: [LINE] });
    const lineId = Number((await read_(request, 'buyer', `cart/get?id=${cartId}`)).body.cart.lines[0].id);
    const bad = await call(request, 'buyer', 'cart/line', { cartId, lineId, patch: { size: 'n/a' } });
    expect(bad.status).toBe(400);
    expect((await call(request, 'buyer', 'cart/line', { cartId, lineId, patch: { size: '' } })).status).not.toBe(500);
    const line = (await read_(request, 'buyer', `cart/get?id=${cartId}`)).body.cart.lines[0];
    expect(line.size).toBe(LINE.size);
  });

  test('a line saved before the rule can still be given its size by the buyer, and the edit is accepted', async ({ request }) => {
    const cartId = await newRequest(request, { submit: false, lines: [] });
    const lineId = Number((await pool.query(
      `INSERT INTO buy_cart_lines (cart_id, sku, shelf_price) VALUES ($1, $2, 50) RETURNING id`, [cartId, LINE.sku])).rows[0].id);
    const fixed = await call(request, 'buyer', 'cart/line', { cartId, lineId, patch: { size: '9' } });
    expect(fixed.status).toBe(200);
    const line = (await read_(request, 'buyer', `cart/get?id=${cartId}`)).body.cart.lines.find((l) => Number(l.id) === lineId);
    expect(line.size).toBe('9');
  });
});

// ── Reading a saved receipt again ────────────────────────────────────────────────
test.describe('re-reading a saved receipt', () => {
  const rows = [
    { sku: LINE.sku, size: LINE.size, qty: 1, unitPrice: 100, totalPrice: 100, source: 'paste' },
    { sku: 'DD1391-100', size: '10', qty: 1, unitPrice: 100, totalPrice: 100, source: 'paste' },
  ];
  async function receipted(request) {
    const cartId = await newRequest(request, { lines: [LINE] });
    await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
    await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '6060100000000003434', balance: 400 } });
    await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
    const saved = await call(request, 'buyer', 'cart/receipt', { cartId, receiptTotal: 216.5, subtotal: 200, tax: 16.5, lines: rows });
    expect(saved.status).toBe(200);
    return cartId;
  }

  test('on screen: it opens the saved rows, warns, and Cancel changes nothing', async ({ page, request }) => {
    const cartId = await receipted(request);
    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    await page.getByRole('button', { name: 'Re-read the receipt' }).click();

    const review = page.locator('.bc-review');
    await expect(review.locator('.bc-review-table tbody tr')).toHaveCount(2);
    await expect(review.locator('.bc-review-table tbody tr').nth(1).locator('input').first()).toHaveValue('DD1391-100');
    await expect(review).toContainText('Saving replaces the 2 saved rows and the $216.50 total');
    await expect(review.locator('.bc-totals input').nth(2)).toHaveValue('216.5');
    await expect(page.getByRole('button', { name: 'Save these lines' })).toBeEnabled();
    // The ways to read it are on offer, not only an upload.
    await expect(page.getByRole('button', { name: 'Find it in the email' })).toBeVisible();
    await expect(page.locator('.bc-paste-box')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.bc-paste-box')).toHaveCount(0);
    await expect(page.locator('#bc-sec-receipt table tbody tr')).toHaveCount(2);
    const { body } = await read_(request, 'buyer', `cart/get?id=${cartId}`);
    expect(body.cart.receiptLines).toHaveLength(2);
    expect(body.cart.receipt_total).toBe(216.5);
  });

  test('on screen: a corrected list replaces the old one at Save', async ({ page, request }) => {
    const cartId = await receipted(request);
    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    await page.getByRole('button', { name: 'Re-read the receipt' }).click();
    // One row corrected and saved: the list is replaced, with the other row kept.
    await page.locator('.bc-review-table tbody tr').nth(1).locator('input').nth(1).fill('11');
    await page.getByRole('button', { name: 'Save these lines' }).click();
    await expect(page.locator('.bc-review')).toHaveCount(0);
    const { body } = await read_(request, 'buyer', `cart/get?id=${cartId}`);
    expect(body.cart.receiptLines.map((l) => l.size)).toEqual([LINE.size, '11']);
    expect(body.cart.receipt_total).toBe(216.5);
    expect(Number(body.cart.receipt_tax)).toBe(16.5);
  });

  test('on screen: a new pasted reading takes over, unticked, and nothing moves until Save', async ({ page, request }) => {
    const cartId = await receipted(request);
    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    await page.getByRole('button', { name: 'Re-read the receipt' }).click();
    await page.locator('.bc-paste-box').fill('CT4838-004  8   1   195.00\nSubtotal 195.00\nTax 16.09\nTotal 211.09');
    await page.getByRole('button', { name: 'Read it' }).click();
    const rows = page.locator('.bc-review-table tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toHaveClass(/bc-row-pending/);   // a machine's reading is checked by a person
    await expect(page.getByRole('button', { name: /Check 1 more row to save/ })).toBeDisabled();
    expect((await read_(request, 'buyer', `cart/get?id=${cartId}`)).body.cart.receiptLines).toHaveLength(2);

    await rows.nth(0).locator('.bc-row-tick').click();
    await page.getByRole('button', { name: 'Save these lines' }).click();
    await expect(page.locator('.bc-review')).toHaveCount(0);
    const { body } = await read_(request, 'buyer', `cart/get?id=${cartId}`);
    expect(body.cart.receiptLines.map((l) => l.sku)).toEqual(['CT4838-004']);
    expect(body.cart.receipt_total).toBe(211.09);
  });

  test('once an order is raised it is refused, on screen and at the server', async ({ page, request }) => {
    const cartId = await receipted(request);
    expect((await call(request, 'buyer', 'cart/raise-po', { cartId })).status).toBe(200);
    const again = await call(request, 'buyer', 'cart/receipt', { cartId, receiptTotal: 108.25, lines: rows.slice(0, 1) });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/order was raised/);
    const { body } = await read_(request, 'buyer', `cart/get?id=${cartId}`);
    expect(body.cart.receiptLines).toHaveLength(2);

    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    await expect(page.locator('#bc-sec-receipt')).toContainText('The order was raised from this receipt');
    await expect(page.getByRole('button', { name: 'Re-read the receipt' })).toHaveCount(0);
  });

  test('on screen: after the audit the button gives way to the reason', async ({ page, request }) => {
    const cartId = await receipted(request);
    const card = (await read_(request, 'auditor', `cart/get?id=${cartId}`)).body.cart.giftCards[0];
    expect((await call(request, 'auditor', 'cart/audit', { cartId, cards: [{ id: card.id, spent: 216.5, remaining: 183.5 }] })).status).toBe(200);
    await as(page, 'buyer');
    await page.goto(`/buying?request=${cartId}`);
    await expect(page.locator('#bc-sec-receipt')).toContainText('has been audited');
    await expect(page.getByRole('button', { name: 'Re-read the receipt' })).toHaveCount(0);
  });
});
