// Buying requests — "whose turn is it" (nextStep in src/lib/buycartRules.js) and the
// Open / Finished split on the list (api/cart/list.js `view`).
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import { nextStep } from '../src/lib/buycartRules.js';

loadEnv();
const admin = () => ({ Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' })}` });
const DONE = ['closed', 'cancelled', 'written_off', 'denied'];

const BUYER = { isBuyer: true, canDecide: false, canIssue: false, canAudit: false };
const APPROVER = { isBuyer: false, canDecide: true, canIssue: false, canAudit: false };
const DESK = { isBuyer: false, canDecide: false, canIssue: true, canAudit: false };
const AUDITOR = { isBuyer: false, canDecide: false, canIssue: false, canAudit: true };

test('each role is told when it is their turn, and pointed at the right section', () => {
  const pending = { status: 'submitted', pending_count: 2, buyer_name: 'Eric' };
  expect(nextStep(pending, APPROVER)).toMatchObject({ mine: true, target: 'lines' });
  expect(nextStep(pending, BUYER)).toMatchObject({ mine: false });

  const toFund = { status: 'approved', pending_count: 0, list_closed_at: '2026-09-25', funding_target: 162.38 };
  expect(nextStep(toFund, DESK)).toMatchObject({ mine: true, target: 'cards' });
  expect(nextStep(toFund, DESK).text).toContain('$162.38');
  expect(nextStep(toFund, APPROVER)).toMatchObject({ mine: false });

  const funded = { status: 'funded', buyer_name: 'Eric' };
  expect(nextStep(funded, BUYER)).toMatchObject({ mine: true, target: 'receipt' });
  expect(nextStep(funded, AUDITOR).text).toContain("Eric's receipt");

  const receipted = { status: 'receipted', po_id: 7, pack: { unpacked: 0 }, checks: [] };
  expect(nextStep(receipted, AUDITOR)).toMatchObject({ mine: true, target: 'audit' });
});

test('an open list is the buyer\'s to close, not the desk\'s to fund', () => {
  const stillAdding = { status: 'approved', pending_count: 0, list_closed_at: null, buyer_name: 'Eric' };
  expect(nextStep(stillAdding, BUYER)).toMatchObject({ mine: true });
  expect(nextStep(stillAdding, DESK)).toMatchObject({ mine: false });
  expect(nextStep(stillAdding, DESK).text).toContain('close the list');
});

test('the list splits into open and finished requests', async ({ request }) => {
  const open = (await (await request.get('/api/cart/list?view=open', { headers: admin() })).json()).carts;
  const done = (await (await request.get('/api/cart/list?view=done', { headers: admin() })).json()).carts;
  expect(open.every((c) => !DONE.includes(c.status))).toBe(true);
  expect(done.every((c) => DONE.includes(c.status))).toBe(true);
});
