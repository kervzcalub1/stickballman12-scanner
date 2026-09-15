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
    `INSERT INTO buy_carts (buyer_user_id, buyer_name, retailer, purpose, status, cost_stack)
     VALUES ($1,$2,'E2E Store','E2E: restocking for listings','draft',$3) RETURNING id`,
    [buyer.uid, buyer.name, JSON.stringify(stack)])).rows[0].id);
  for (const l of lines) await call(request, linesBy, 'cart/line', { cartId, line: l });
  await shoePhotos(cartId, lines.map((l) => l.sku));
  // The SEND is stamped, not posted, for the same reason the cart row is seeded: this
  // helper runs forty-odd times and `cart/submit` is capped at 30 a minute, so going
  // through the endpoint made unrelated tests 429 at the end of a run. The tests that
  // are actually ABOUT sending — a blank purpose, a missing store, a shoe with no photo
  // — call the endpoint directly and are unaffected.
  if (submit) {
    await pool.query(
      `UPDATE buy_carts SET status = 'submitted', submitted_at = now(), submitted_by = $2, updated_at = now()
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

test('gift cards must cover the approved total before anything is released', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });          // 2 × $50 = $100
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });

  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '1111222233334444', balance: 60 } });
  const short = await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
  expect(short.status).toBe(409);
  // The shortfall is NAMED — "not enough" without a number sends somebody to a
  // spreadsheet to work out what to add.
  expect(short.body.error).toContain('$40.00 short');

  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '5555666677778888', balance: 40 } });
  const ok = await call(request, 'issuer', 'cart/gift-card', { cartId, fund: true });
  expect(ok.status).toBe(200);
  expect(ok.body.cart.status).toBe('funded');
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
    totals: { subtotal: 300, tax: 18, shipping: null, total: 318, item_count_stated: 3 },
    warnings: ['upc_not_found:1 (http 200)'],
  });
  expect(r.rows.map((x) => x.sku)).toEqual(['FJ6245-106', 'IH8223']);   // no code → no row, never a blank one
  expect(r.rows[0]).toMatchObject({ size: '9.5', qty: 2, totalPrice: 200, unitPrice: 100, source: 'email' });
  expect(r.email).toMatchObject({ subject: 'Your Nike Purchase', date: '2026-09-14T18:02:11-04:00', folder: 'Footlocker' });
  expect(r.statedTotal).toBe(318);
  expect(r.check.ok).toBe(true);                       // 200 + 100 = the printed subtotal; 3 = the printed count
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
    `INSERT INTO buy_carts (buyer_user_id, buyer_name, retailer, purpose, status)
     VALUES ($1, $2, 'E2E Store', 'E2E: draft with nothing to approve', 'draft') RETURNING id`,
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
  await expect(page.locator('.bc-no-decide')).toContainText('hasn’t sent this yet');

  // Correcting a misread shelf ticket is a COST-side act and stays open on a draft —
  // which is the state where a typo is most likely still to be there.
  await expect(page.locator('.bc-line-actions').first()).toBeVisible();

  // And the endpoint still refuses, in the same words, for a stale tab.
  const r = await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  expect(r.status).toBe(409);
  expect(r.body.error).toMatch(/hasn’t sent this yet/);
});

test('the queue filters by buyer, and a buyer cannot use it to widen their own scope', async ({ request }) => {
  // Seeded with SQL rather than through `cart/create`. This is a test about READING a
  // filtered list, and the suite already sits exactly on the endpoint's own 30-a-minute
  // rate limit — one more creation here pushed an unrelated test at the end of the run
  // into a 429. The limit is a real control and the fix is not to spend it here.
  const { rows } = await pool.query(
    `INSERT INTO buy_carts (buyer_user_id, buyer_name, retailer, purpose, status)
     VALUES ($1, $2, 'E2E Store', 'E2E: filter fixture', 'submitted') RETURNING id`,
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
    `INSERT INTO buy_carts (buyer_user_id, buyer_name, retailer, purpose, status, approved_amount, gc_total)
     VALUES ($1,$2,'E2E Store','E2E: a receipt with a nameless row','funded',100,200) RETURNING id`,
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
  await expect(page.locator('.bc-lines tbody tr')).toHaveCount(2);
  // Not one verdict chip anywhere on the buyer's screen, and no column claiming to
  // hold one. The payload has none either — that half is asserted below.
  await expect(page.locator('.bc-verdict')).toHaveCount(0);
  await expect(page.locator('.bc-lines thead')).not.toContainText('Buy call');
  // Nor what a pair lands at — that is the desk's cost stack one subtraction away.
  await expect(page.locator('.bc-lines thead')).not.toContainText('Lands at');
  // What IS theirs: the price they read off the ticket.
  await expect(page.locator('.bc-lines thead')).toContainText('Shelf');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.locator('.bc-head .po-chip')).toContainText('Waiting on approval');

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
    `INSERT INTO buy_carts (buyer_user_id, buyer_name, retailer, purpose, status, approved_amount, gc_total)
     VALUES ($1,$2,'E2E Store','E2E: ticking the receipt rows','funded',100,400) RETURNING id`,
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
  const seed = async (purpose, status = 'submitted') => Number((await pool.query(
    `INSERT INTO buy_carts (buyer_user_id, buyer_name, retailer, purpose, status, approved_amount, gc_total)
     VALUES ($1,$2,'E2E Store',$3,$4,100,0) RETURNING id`,
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

test('a request needs a purpose and a store before it can be sent', async ({ request }) => {
  const { body } = await call(request, 'buyer', 'cart/create', {});
  const cartId = Number(body.cart.id);
  await call(request, 'approver', 'cart/line', { cartId, line: LINE });
  const r = await call(request, 'buyer', 'cart/submit', { cartId });
  expect(r.status).toBe(400);
  // "I'm just buying stuff" is the exact answer the written process refuses.
  expect(r.body.error).toMatch(/what you are buying/i);
});

test('the till-overrun warning fires when tax outruns the discount', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });
  const { body } = await read_(request, 'issuer', `cart/get?id=${cartId}`);
  // Funding at the sticker is generous almost always — but not when the discount is
  // small and the tax isn't. This buyer's stack is 0% off + 8.25% tax, so the register
  // asks $108.25 against the $100 approved, and the screen has to say so rather than
  // let somebody find out at a till.
  expect(body.cart.approved_amount).toBe(100);
  expect(body.cart.tillWarning).not.toBeNull();
  expect(body.cart.tillWarning.amount).toBeCloseTo(108.25, 2);
});

// window.prompt was doing real work here, and it could not validate, could not hold two
// questions at once, and threw the first answer away if you cancelled the second.
test('a request is started in one modal, and it will not accept a blank purpose', async ({ page }) => {
  await as(page, 'buyer');
  await page.goto('/buying');
  await page.getByRole('button', { name: 'New request' }).click();

  const modal = page.locator('.modal.form-modal');
  await expect(modal).toBeVisible();
  // Both questions in ONE dialog — as two chained prompts, cancelling the second binned
  // the first answer with nothing on screen to say so.
  await expect(modal.getByRole('textbox')).toHaveCount(2);

  // Blank is refused in the modal, not by the server after the fact.
  await modal.getByRole('button', { name: 'Start the request' }).click();
  await expect(modal.locator('.error')).toContainText(/needed/i);
  await expect(modal).toBeVisible();

  await modal.getByRole('textbox').first().fill('E2E: modal purpose');
  await modal.getByRole('textbox').nth(1).fill('E2E Modal Store');
  await modal.getByRole('button', { name: 'Start the request' }).click();

  // It lands on the new request, opened and ready for lines.
  await expect(page.locator('.bc-lines')).toBeVisible();
  await expect(page.locator('.app')).toContainText('E2E: modal purpose');
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

  // The buyer can no longer touch it — that half of the freeze is unchanged.
  const buyer = await call(request, 'buyer', 'cart/line', { cartId, lineId, patch: { shelfPrice: 20 } });
  expect(buyer.status).toBe(403);

  // The approver can, because a misread shelf ticket used to mean rebuilding the whole
  // request to fix one number, which in practice meant approving it wrong instead.
  const fix = await call(request, 'approver', 'cart/line', { cartId, lineId, patch: { shelfPrice: 45 } });
  expect(fix.status).toBe(200);
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve', qtyAll: LINE.qty });

  const mid = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(mid.body.cart.approved_amount).toBe(90);                        // 2 × $45, recomputed
  const ev = mid.body.cart.events.find((e) => e.kind === 'line_edited');
  expect(ev.body).toMatch(/shelf \$50\.00 → \$45\.00/);

  // Once the cards are out, the sticker is what the money was released against and it
  // freezes. The COST stack does not — an auditor still has to be able to state what a
  // transaction they are closing actually cost.
  await call(request, 'issuer', 'cart/gift-card', { cartId, card: { code: '4111111111119999', balance: 100 } });
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
  const { body } = await call(request, 'buyer', 'cart/create', { retailer: 'E2E Store', purpose });
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
  const { body } = await call(request, 'buyer', 'cart/create', { retailer: 'E2E Store', purpose });
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
  const { body } = await call(request, 'buyer', 'cart/create', { retailer: 'E2E Store', purpose });
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
  const { body } = await call(request, 'buyer', 'cart/create', { retailer: 'E2E Store', purpose });
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
      `INSERT INTO buy_carts (buyer_user_id, buyer_name, retailer, purpose, status, cost_stack)
       VALUES ($1,$2,'E2E Store','E2E: what do we already hold','draft',$3) RETURNING id`,
      [people.buyer.uid, people.buyer.name,
       JSON.stringify({ taxPct: 8.25, tipAmt: 5, giftPct: 8, shippingAmt: 8.25 })])).rows[0].id);
    sizedLineId = Number((await call(request, 'approver', 'cart/line', {
      cartId: heldCartId, line: { sku: HELD_SKU, size: '9', qty: 1, shelfPrice: 60 },
    })).body.line.id);
    unsizedLineId = Number((await call(request, 'approver', 'cart/line', {
      cartId: heldCartId, line: { sku: HELD_SKU, qty: 1, shelfPrice: 60 },
    })).body.line.id);
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
      `INSERT INTO buy_carts (buyer_user_id, buyer_name, retailer, purpose, status, cost_stack)
       VALUES ($1,$2,'E2E Store','E2E: who may see the call','draft',$3) RETURNING id`,
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
    try {
      process.env.MAKE_WEBHOOK_URL = '';
      expect(notifyConfigured()).toBe(false);
      const out = await notifyLineAsked(1, 1);
      expect(out.sent).toBe(false);
      expect(out.reason).toMatch(/MAKE_WEBHOOK_URL/);

      // And a configured server still sends — the refusal must come from the blank, not
      // from something that would also be true in production.
      process.env.MAKE_WEBHOOK_URL = 'https://hook.invalid/never-called';
      expect(notifyConfigured()).toBe(true);
    } finally {
      if (keep === undefined) delete process.env.MAKE_WEBHOOK_URL;
      else process.env.MAKE_WEBHOOK_URL = keep;
    }
  });

  // NOT TESTED HERE: that the server this suite talks to actually has it blanked. The
  // env lives in the SERVER's process and this one is the runner, so any assertion from
  // here would be reading its own environment and calling it proof. The real exposure is
  // the `reuseExistingServer` caveat above — a hand-started server on this port carries a
  // real .env — and the honest guard for that is the comment, not a test that cannot see
  // the thing it names.
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
  const { status, body } = await call(request, 'shipper', 'cart/create', { retailer: 'E2E Store', purpose: 'E2E: should never open' });
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
