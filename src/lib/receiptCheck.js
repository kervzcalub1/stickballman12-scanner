// Does a machine's reading of a receipt agree with the receipt's own arithmetic?
//
// This exists because of how the two readers FAIL differently. Tesseract garbles
// visibly — you get `fussssonn 12.8` and nobody mistakes it for data. A vision model
// fails cleanly: it returns a well-formed row with a plausible style code and a
// plausible price, and on a money screen a plausible wrong number is the worst possible
// output. It looks exactly like a right one.
//
// So the receipt is made to check itself. A till prints its own totals — a subtotal, and
// very often an item count — and those are a cross-check the paper hands us for free:
// ten rows that do not add up to the printed subtotal means a line was invented, missed
// or misread, whichever reader produced them. That is a fact about the reading, not an
// opinion about the model.
//
// Nothing here rejects anything. It produces sentences for the person reviewing the
// table, because the review step is still where a receipt becomes true.

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * `{ ok, problems: [string], checked: [string] }`.
 *
 * `checked` matters as much as `problems`: "we compared the rows against the printed
 * subtotal and they agree" is a much stronger statement than silence, and a person
 * deciding how hard to check every row needs to know which of the two they are looking
 * at. A receipt that prints no subtotal gets neither — and is told so.
 */
export function checkReceiptRead({ rows, subtotal, itemsSold, statedTotal, tax } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const problems = [];
  const checked = [];

  if (!list.length) return { ok: false, problems: ['Nothing was read from it.'], checked };

  // --- the rows against the printed subtotal --------------------------------
  const rowsTotal = r2(list.reduce((n, r) => n + (num(r.totalPrice) || 0), 0));
  const sub = num(subtotal);
  if (sub != null && sub > 0) {
    if (near(rowsTotal, sub)) {
      checked.push(`the ${list.length} lines add up to the printed subtotal of $${sub.toFixed(2)}`);
    } else {
      problems.push(
        `The lines add up to $${rowsTotal.toFixed(2)} but the receipt's own subtotal says $${sub.toFixed(2)}`
        + ` — a $${Math.abs(rowsTotal - sub).toFixed(2)} gap, so a line was missed, misread or invented.`);
    }
  } else {
    problems.push('No subtotal was found on it, so there is nothing to check the lines against.');
  }

  // --- the quantities against the printed item count -------------------------
  // The single most useful check on a discounting till: a wrongly-read quantity column
  // divides a line total by the wrong number and misstates the unit price on every row
  // it touches, while leaving the money looking perfectly reasonable.
  const pairs = list.reduce((n, r) => n + (num(r.qty) || 0), 0);
  const sold = num(itemsSold);
  if (sold != null && sold > 0) {
    if (pairs === sold) checked.push(`the quantities add up to the ${sold} items the receipt says were sold`);
    else problems.push(`The lines cover ${pairs} item${pairs === 1 ? '' : 's'} but the receipt says ${sold} were sold.`);
  }

  // --- subtotal + tax against the stated total --------------------------------
  // Weakest of the three and deliberately last: plenty of tills print no tax line at
  // all, and a mismatch here is as likely to be a fee or a rounding line as a misread.
  const total = num(statedTotal);
  const t = num(tax);
  if (total != null && sub != null && t != null) {
    if (near(r2(sub + t), total)) checked.push('the subtotal plus tax matches the total charged');
    else problems.push(`Subtotal $${sub.toFixed(2)} plus tax $${t.toFixed(2)} does not make the stated total of $${total.toFixed(2)}.`);
  }

  // --- rows that cannot be true ------------------------------------------------
  const bad = list.filter((r) => !String(r.sku || '').trim() || !(num(r.qty) > 0) || num(r.totalPrice) == null);
  if (bad.length) problems.push(`${bad.length} line${bad.length === 1 ? ' is' : 's are'} missing a style code, a quantity or a price.`);

  return { ok: problems.length === 0, problems, checked };
}

/** One sentence for the screen: what was verified, or what does not add up. */
export function receiptCheckSentence(check) {
  if (!check) return null;
  if (check.ok) {
    return check.checked.length
      ? `Checked against the receipt's own figures — ${check.checked.join(', and ')}. Still worth a look before saving.`
      : 'Read, but the receipt printed no totals to check it against. Check every row before saving.';
  }
  return `${check.problems.join(' ')} Check every row against the paper before saving.`;
}
