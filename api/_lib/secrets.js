// Symmetric encryption for the one class of data in this app that is money in the
// hand: **gift card codes**. A card number plus its PIN is a bearer instrument — a
// database dump, a stray log line or a screenshot of a list view is enough to spend
// it — so unlike every other column here, these are never stored as typed.
//
// AES-256-GCM, which authenticates as well as encrypts: a tampered ciphertext fails
// to decrypt rather than returning plausible-looking garbage.
//
// Stored shape: `v1:<iv b64>:<tag b64>:<ciphertext b64>`
// The version prefix is what makes a key rotation possible later — a `v2:` reader can
// tell the two apart without a migration flag or a guess at the format.
//
// **Fails CLOSED.** With no key configured `secretsConfigured()` is false and the
// endpoints that write a card refuse with a clear message. The alternative — quietly
// storing the codes in the clear because an env var wasn't set — is exactly the
// failure this file exists to prevent, and it would be invisible until it mattered.
// Uploading a gift-card image still works without the key: a file lives in R2 behind an
// authorised proxy, which is its own control.
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;   // 96-bit nonce, the GCM standard
const KEY_LEN = 32;  // AES-256

// 32 bytes, given as 64 hex characters or as base64. Anything else is a
// misconfiguration worth throwing on rather than padding into a weak key.
function loadKey() {
  const raw = String(process.env.BUY_GC_KEY || '').trim();
  if (!raw) return null;
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
  else {
    try { buf = Buffer.from(raw, 'base64'); } catch { return null; }
  }
  return buf && buf.length === KEY_LEN ? buf : null;
}

export function secretsConfigured() {
  return loadKey() !== null;
}

// Why a distinct message per cause: "not configured" is an ops task for the person
// deploying, and "wrong length" is a typo in the value they just pasted. One generic
// error sends them looking in the wrong place.
function requireKey() {
  const raw = String(process.env.BUY_GC_KEY || '').trim();
  if (!raw) throw Object.assign(new Error('BUY_GC_KEY is not set.'), { notConfigured: true });
  const key = loadKey();
  if (!key) throw Object.assign(
    new Error('BUY_GC_KEY must be 32 bytes — 64 hex characters, or base64.'),
    { notConfigured: true },
  );
  return key;
}

// Returns null for null/empty in, so an optional field (a card with no PIN) stays
// null in the column rather than becoming the ciphertext of an empty string — which
// would read back as "there is a PIN" and be indistinguishable from a real one.
export function encryptSecret(plain) {
  const text = plain == null ? '' : String(plain);
  if (!text) return null;
  const key = requireKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(blob) {
  if (!blob) return null;
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1')
    throw new Error('That stored value is not in a format this server can read.');
  const key = requireKey();
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

// What a LIST is allowed to show. Never the code — a list payload reaches every screen
// that renders the cart, and a code on screen is a code someone can photograph. The
// last four are enough to say "that one" out loud without being enough to spend.
export function maskTail(code, keep = 4) {
  const s = String(code ?? '').replace(/[\s-]/g, '');
  if (!s) return null;
  return s.length <= keep ? s : s.slice(-keep);
}

// A brand-new key, printed for whoever is setting the env var up. Not used at runtime.
export const generateKeyHex = () => crypto.randomBytes(KEY_LEN).toString('hex');
