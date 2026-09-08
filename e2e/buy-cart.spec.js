// Gift-card buying requests — the CONTROLS, not the happy path.
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
  buyer: { username: 'e2e_bc_buyer', name: 'E2E Buyer', role: 'supplier', privileges: [] },
  approver: { username: 'e2e_bc_appr', name: 'E2E Approver', role: 'warehouse', privileges: ['approve_buying'] },
  issuer: { username: 'e2e_bc_iss', name: 'E2E Issuer', role: 'ph_team', privileges: ['issue_gift_cards'] },
  auditor: { username: 'e2e_bc_aud', name: 'E2E Auditor', role: 'warehouse', privileges: ['audit_buying'] },
  // A staff account with NO privilege — proves the gates are real rather than just
  // "is this person staff", which is what a role check would have amounted to.
  bystander: { username: 'e2e_bc_none', name: 'E2E Bystander', role: 'ph_team', privileges: [] },
  // A second buyer, so "the buyer may set the costs" can be shown to mean THEIR OWN
  // request and not anybody's.
  buyer2: { username: 'e2e_bc_buyer2', name: 'E2E Other Buyer', role: 'supplier', privileges: [] },
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

async function newRequest(request, { lines = [], submit = true } = {}) {
  const { body } = await call(request, 'buyer', 'cart/create', {
    retailer: 'E2E Store', purpose: 'E2E: restocking for listings',
  });
  const cartId = Number(body.cart.id);
  for (const l of lines) await call(request, 'buyer', 'cart/line', { cartId, line: l });
  if (submit) await call(request, 'buyer', 'cart/submit', { cartId });
  return cartId;
}

const LINE = { sku: 'CW2288-111', size: '9', qty: 2, shelfPrice: 50, verdict: 'buy' };

test('a buyer cannot approve their own request', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  const r = await call(request, 'buyer', 'cart/decide', { cartId, all: true, action: 'approve' });
  expect(r.status).toBe(403);
  expect(r.body.ok).toBe(false);
  // And nothing half-applied: every line is still awaiting a decision.
  const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(body.cart.lines.every((l) => l.status === 'pending')).toBe(true);
  expect(body.cart.approved_amount).toBe(0);
});

test('gift cards must cover the approved total before anything is released', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });          // 2 × $50 = $100
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve' });

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
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve' });
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

  const approve = await call(request, 'bystander', 'cart/decide', { cartId, all: true, action: 'approve' });
  expect(approve.status).toBe(403);
  expect(approve.body.error).toMatch(/approve buying requests/i);

  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve' });

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
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve' });
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
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve' });
  const byApprover = await call(request, 'approver', 'cart/audit', { cartId, cards: [] });
  expect(byApprover.status).toBe(403);
  expect(byApprover.body.error).toMatch(/audit privilege/i);

  // The other half: an ADMIN can reach both, so the guard has to refuse on identity.
  // The env admin has no users row, which is exactly the case an id comparison missed.
  const cart2 = await newRequest(request, { lines: [LINE] });
  const adminToken = signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' });
  const approve = await request.post('/api/cart/decide', {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { cartId: cart2, all: true, action: 'approve' },
  });
  expect(approve.status()).toBe(200);
  const audit = await request.post('/api/cart/audit', {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { cartId: cart2, cards: [{ id: 1, spent: 1, remaining: 0 }] },
  });
  expect(audit.status()).toBe(403);
  expect((await audit.json()).error).toMatch(/you approved this request/i);
});

test('a request cannot be closed until all ten conditions are true', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve' });
  const r = await call(request, 'auditor', 'cart/close', { cartId });
  expect(r.status).toBe(409);
  // The refusal NAMES what is outstanding. A gate that only says no is a gate people
  // learn to route around.
  expect(r.body.error).toMatch(/of the 10 checks are still outstanding/);
  expect(r.body.error).toContain('receipt was received');
  expect(r.body.checks).toHaveLength(10);
  expect(r.body.checks.filter((c) => c.ok).map((c) => c.key)).toContain('approved');
});

test('the buyer builds a request and a Pass can still be added', async ({ page, request }) => {
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
  await expect(page.locator('.bc-verdict.buy')).toBeVisible();
  // A Pass is recorded, not blocked: the buyer may know something the market doesn't,
  // and the disagreement belongs in front of the approver rather than in a chat app.
  await expect(page.locator('.bc-verdict.pass')).toBeVisible();
  await expect(page.locator('.bc-lines tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.locator('.bc-head .po-chip')).toContainText('Waiting on approval');
  expect(cartId).toBeGreaterThan(0);
});

test('a request needs a purpose and a store before it can be sent', async ({ request }) => {
  const { body } = await call(request, 'buyer', 'cart/create', {});
  const cartId = Number(body.cart.id);
  await call(request, 'buyer', 'cart/line', { cartId, line: LINE });
  const r = await call(request, 'buyer', 'cart/submit', { cartId });
  expect(r.status).toBe(400);
  // "I'm just buying stuff" is the exact answer the written process refuses.
  expect(r.body.error).toMatch(/what you are buying/i);
});

test('the till-overrun warning fires when tax outruns the discount', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve' });
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
test('the buyer sets the costs, and the desk can overwrite them', async ({ request }) => {
  const cartId = await newRequest(request, { lines: [LINE] });
  const buyer = await call(request, 'buyer', 'cart/costs', {
    cartId, stack: { storePct: 40, promoPct: 0, giftPct: 0, cashbackPct: 0, taxPct: 0, tipAmt: 0, shippingAmt: 0 },
  });
  expect(buyer.status).toBe(200);

  const over = await call(request, 'approver', 'cart/costs', {
    cartId, stack: { storePct: 10, promoPct: 0, giftPct: 0, cashbackPct: 0, taxPct: 0, tipAmt: 0, shippingAmt: 0 },
  });
  expect(over.status).toBe(200);

  const { body } = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(body.cart.cost_stack.storePct).toBe(10);
  // Two versions, each under the name that set it — a favourable stack is visible AS the
  // buyer's, beside the number the approver replaced it with.
  const trail = body.cart.events.filter((e) => e.kind === 'costs_edited');
  expect(trail).toHaveLength(2);
  expect(trail[0].actor_name).toBe('E2E Approver');
  expect(trail[0].body).toMatch(/Store discount 40% → 10%/);
  expect(trail[1].actor_name).toBe('E2E Buyer');
  expect(trail[1].body).toMatch(/Store discount 0% → 40%/);
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
  await call(request, 'approver', 'cart/decide', { cartId, all: true, action: 'approve' });

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
  await call(request, 'buyer', 'cart/line', { cartId, line: LINE });
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
test('the buyer gets the chips too, on the supplier portal', async ({ page, request }) => {
  const purpose = `E2E: chip buyer ${Date.now()}`;
  const { body } = await call(request, 'buyer', 'cart/create', { retailer: 'E2E Store', purpose });
  const cartId = Number(body.cart.id);
  await call(request, 'buyer', 'cart/line', { cartId, line: LINE });

  await as(page, 'buyer');
  await page.goto('/buying');
  await page.locator('.bc-table-wrap tr.bc-row', { hasText: purpose }).first().click();
  const card = page.locator('section.bc-costs');
  await card.getByRole('button', { name: /Shipping/ }).click();
  const input = card.locator('.bc-cost-input');
  await input.fill('14');
  await input.press('Enter');
  await expect(card.getByRole('button', { name: /Shipping/ })).toContainText('$14.00');

  const after = await read_(request, 'approver', `cart/get?id=${cartId}`);
  expect(after.body.cart.cost_stack.shippingAmt).toBe(14);
  expect(after.body.cart.events.find((e) => e.kind === 'costs_edited').actor_name).toBe('E2E Buyer');
});

// The chips are a control over company money, so for anybody who may NOT write them they
// are drawn as plain text rather than as buttons that answer 403.
test('staff with neither privilege see the costs and cannot tap them', async ({ page, request }) => {
  const purpose = `E2E: chip readonly ${Date.now()}`;
  const { body } = await call(request, 'buyer', 'cart/create', { retailer: 'E2E Store', purpose });
  await call(request, 'buyer', 'cart/line', { cartId: Number(body.cart.id), line: LINE });
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
  await call(request, 'buyer', 'cart/line', { cartId, line: { sku: 'CW2288-111', size: '9', qty: 1, shelfPrice: 50 } });

  await as(page, 'buyer');
  await page.goto('/buying');
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

  const r = await call(request, 'approver', 'cart/price-line', { cartId, lineId });
  expect(r.status).toBe(200);
  const after = await read_(request, 'approver', `cart/get?id=${cartId}`);
  const ev = after.body.cart.events.find((e) => e.kind === 'line_priced');
  expect(ev).toBeTruthy();
  expect(ev.actor_name).toBe('E2E Approver');
  // The prices it found and what the call was before it — an approver re-pricing has
  // chosen to look at today's market instead of the buyer's, and the record says so.
  expect(ev.body).toMatch(/Alias /);
  expect(ev.body).toMatch(/was (not priced|buy|watch|pass)/);
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
