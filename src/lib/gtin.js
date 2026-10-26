// UPC / EAN / GTIN check digits (GS1). Every barcode number carries its own last digit as a
// checksum, so a single misread digit — the commonest way a photo of a receipt goes wrong —
// is caught without asking anyone (docs/context/buy-cart.md "Receipts that print UPCs").

/** Digits only, or '' . */
export const upcDigits = (v) => String(v ?? '').replace(/\D/g, '');

/**
 * True when the number is a well-formed UPC-A / EAN-13 / GTIN-14 (12–14 digits, leading
 * zeros allowed) whose last digit matches the GS1 check. 8-digit codes are too short to
 * name a shoe and are refused.
 */
export function gtinValid(v) {
  const d = upcDigits(v);
  if (d.length < 12 || d.length > 14) return false;
  const body = d.slice(0, -1);
  let sum = 0;
  // From the RIGHT of the body: weights 3, 1, 3, 1, …
  for (let i = 0; i < body.length; i++) {
    const n = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? n * 3 : n;
  }
  return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
}
