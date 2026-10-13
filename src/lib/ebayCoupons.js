// eBay coded coupons — the pure half (docs/context/ebay-coupons.md). Shared by the page
// (to check the form as it's typed) and api/ebay/coupons.js (which checks it again and
// builds what eBay is sent). eBay's own limits, from the Marketing API spec:
//   couponCode       8–15 letters/digits, at most two dashes, unique across ALL of eBay
//   amountOffItem    only these dollar values (the "threshold discount" list)
//   maxCouponRedemptionPerUser  1–10 (blank = unlimited — we never send blank)
//   description      ≤ 50 (the tag line buyers see), name ≤ 90 (seller-only label)
//   listingIds       ≤ 500 per create call
//   promotionImageUrl  JPEG/PNG, at least 500×500
export const AMOUNTS = [5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 110, 120, 125, 150, 200, 250];
export const MIN_SPEND = [5, 10, 15, 20, 25, 30, 35, 40, 45, 49, 50, 55, 59, 60, 65, 69, 70, 75, 79, 80, 85, 89, 90, 95, 99, 100, 110, 120, 125, 149, 150, 175, 199, 200, 249, 250, 299, 300, 350, 399, 400, 450, 499, 500];
export const MAX_LISTINGS = 500;

export function codeProblem(code) {
  const c = String(code || '');
  if (!/^[A-Za-z0-9-]{8,15}$/.test(c)) return 'Code: 8–15 letters or digits (dashes allowed).';
  if ((c.match(/-/g) || []).length > 2) return 'Code: at most two dashes.';
  return null;
}

// A code nobody will guess: SBM + 8 characters, no look-alikes (0/O, 1/I/L).
export function randomCode(rand = Math.random) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = 'SBM';
  for (let i = 0; i < 8; i++) s += A[Math.floor(rand() * A.length)];
  return s;
}

// eBay photo URLs carry their size (…/s-l140.jpg); the coupon image must be ≥ 500 px, so
// ask for the 1600 version, as JPEG.
export function couponImage(url) {
  if (!url) return null;
  return String(url).replace(/^http:/, 'https:').replace(/\/s-l\d+\.(jpg|jpeg|png|webp)/i, '/s-l1600.jpg');
}

// The UTC instant an EST calendar day starts — 'YYYY-MM-DD' → Date. EST/EDT is −5/−4, so
// try both and keep the one New York calls midnight of that day.
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function nyParts(d) { const o = {}; for (const p of NY.formatToParts(d)) o[p.type] = p.value; return o; }
export function estDayStart(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  for (const h of [4, 5]) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], h));
    const p = nyParts(d);
    if (`${p.year}-${p.month}-${p.day}` === ymd && p.hour === '00') return d;
  }
  return null;
}
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// The form → { payload } for createItemPromotion, or { error }. `now` is passed in.
//   f = { name, description, code, amount, perUser, visibility: 'private'|'public',
//         startYmd, endYmd, minSpend?, budget?, listingIds:[…], imageUrl, todayYmd }
// The coupon starts at the chosen EST day (or in 5 minutes when that day is today — eBay
// refuses a start in the past) and runs to the END of the end day (EST).
export function buildCoupon(f, now) {
  const name = String(f.name || '').trim();
  const description = String(f.description || '').trim();
  const code = String(f.code || '').trim().toUpperCase();
  const amount = Number(f.amount);
  const perUser = Number(f.perUser);
  const ids = [...new Set((f.listingIds || []).map((x) => String(x).replace(/[^0-9]/g, '')).filter(Boolean))];
  if (!name || name.length > 90) return { error: 'Name: 1–90 characters (only you see it).' };
  if (!description || description.length > 50) return { error: 'Tag line: 1–50 characters (buyers see it).' };
  const cp = codeProblem(code);
  if (cp) return { error: cp };
  if (!AMOUNTS.includes(amount)) return { error: `Amount off: eBay allows only $${AMOUNTS.join(', $')}.` };
  if (!Number.isInteger(perUser) || perUser < 1 || perUser > 10) return { error: 'Uses per buyer: 1–10.' };
  if (!ids.length) return { error: 'Pick at least one listing.' };
  if (ids.length > MAX_LISTINGS) return { error: `At most ${MAX_LISTINGS} listings per coupon.` };
  if (!f.imageUrl) return { error: 'None of the picked listings has a photo — eBay needs one for the coupon.' };
  const minSpend = f.minSpend === '' || f.minSpend == null ? null : Number(f.minSpend);
  if (minSpend != null && !MIN_SPEND.includes(minSpend)) return { error: 'Minimum spend: pick one of eBay’s values.' };
  const budget = f.budget === '' || f.budget == null ? null : Number(f.budget);
  if (budget != null && (!Number.isFinite(budget) || budget < 100 || budget > 1000000)) return { error: 'Budget: $100–$1,000,000, or leave it blank.' };
  const s = estDayStart(f.startYmd);
  const e0 = estDayStart(f.endYmd);
  if (!s || !e0) return { error: 'Pick a start and an end date.' };
  const soon = new Date(now.getTime() + 5 * 60_000);
  const start = f.startYmd <= f.todayYmd || s < soon ? soon : s;
  const next = estDayStart(new Date(e0.getTime() + 30 * 3600_000).toISOString().slice(0, 10)) || new Date(e0.getTime() + 86400_000);
  const end = new Date(next.getTime() - 1000);   // 23:59:59 EST on the end day
  if (end <= start) return { error: 'The end date must be after the start.' };

  const rule = {
    discountBenefit: { amountOffItem: { value: String(amount), currency: 'USD' } },
    discountSpecification: minSpend != null ? { minAmount: { value: String(minSpend), currency: 'USD' } } : { minQuantity: 1 },
  };
  const payload = {
    name, description, marketplaceId: 'EBAY_US', promotionType: 'CODED_COUPON', promotionStatus: 'SCHEDULED',
    startDate: iso(start), endDate: iso(end),
    promotionImageUrl: couponImage(f.imageUrl),
    couponConfiguration: {
      couponCode: code,
      couponType: f.visibility === 'public' ? 'PUBLIC_SINGLE_SELLER_COUPON' : 'PRIVATE_SINGLE_SELLER_COUPON',
      maxCouponRedemptionPerUser: perUser,
    },
    discountRules: [rule],
    inventoryCriterion: { inventoryCriterionType: 'INVENTORY_BY_VALUE', listingIds: ids },
  };
  if (budget != null) payload.budget = { value: String(budget), currency: 'USD' };
  return { payload };
}

// What a coupon from eBay amounts to, in words: "$10 off · 1 use per buyer".
export function couponTerms(c) {
  const r = (c.discountRules || [])[0] || {};
  const b = r.discountBenefit || {};
  const off = b.amountOffItem ? `$${Number(b.amountOffItem.value)} off each item`
    : b.amountOffOrder ? `$${Number(b.amountOffOrder.value)} off the order`
      : b.percentageOffItem ? `${b.percentageOffItem}% off each item`
        : b.percentageOffOrder ? `${b.percentageOffOrder}% off the order` : null;
  const min = r.discountSpecification?.minAmount ? `min. spend $${Number(r.discountSpecification.minAmount.value)}` : null;
  const per = c.couponConfiguration?.maxCouponRedemptionPerUser;
  const uses = per ? `${per} use${per === 1 ? '' : 's'} per buyer` : c.couponConfiguration ? 'unlimited uses per buyer' : null;
  const vis = c.couponConfiguration?.couponType === 'PUBLIC_SINGLE_SELLER_COUPON' ? 'public' : c.couponConfiguration ? 'private' : null;
  return [off, min, uses, vis].filter(Boolean).join(' · ');
}
