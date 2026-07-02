// Cloudflare R2 (S3-compatible) helper — dependency-free SigV4 presigning so the
// warehouse phone uploads listing photos straight to R2 (the Node server never
// handles the image bytes). Config via env (server-side only):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//   R2_ENDPOINT          (optional override of <account>.r2.cloudflarestorage.com)
//   R2_PUBLIC_BASE_URL   (public bucket / custom domain used to READ the images)
// SigV4 validated against the AWS aws-sig-v4-test-suite get-vanilla canonical
// request hash (byte-exact). When unconfigured, r2Configured() is false and the
// photo features degrade gracefully (UI hidden, endpoints return a clear error).
import crypto from 'node:crypto';

const REGION = 'auto';      // R2 ignores region; 'auto' is the convention.
const SERVICE = 's3';

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();

export function r2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID
    && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET,
  );
}

function endpointHost() {
  const ep = process.env.R2_ENDPOINT;
  if (ep) return ep.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

// Percent-encode a path, keeping the slashes between segments.
const encodeKey = (key) => String(key).split('/').map((s) => encodeURIComponent(s)).join('/');
// Strict RFC-3986 encoding for query keys/values (encodeURIComponent leaves !*'()).
const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Presigned URL the client can PUT the raw image bytes to (no auth header
// needed; the signature is in the query string). Only `host` is signed, so the
// client may send any Content-Type. Default 5-minute expiry.
export function presignPutUrl({ key, expiresIn = 300 }) {
  const host = endpointHost();
  const bucket = process.env.R2_BUCKET;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const canonicalUri = `/${bucket}/${encodeKey(key)}`;
  const signedHeaders = 'host';

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(params).sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`).join('&');

  const canonicalRequest = [
    'PUT', canonicalUri, canonicalQuery,
    `host:${host}\n`, signedHeaders, 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), REGION), SERVICE), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// Public, readable URL for an object key. Prefers R2_PUBLIC_BASE_URL (an R2.dev
// or custom domain bound to the bucket); falls back to the endpoint path-style
// URL (only resolves if the bucket is otherwise public).
export function publicUrl(key) {
  const base = process.env.R2_PUBLIC_BASE_URL;
  if (base) return `${base.replace(/\/+$/, '')}/${encodeKey(key)}`;
  return `https://${endpointHost()}/${process.env.R2_BUCKET}/${encodeKey(key)}`;
}

// SSRF guard: listing photos are uploaded to R2 and read back only from
// R2_PUBLIC_BASE_URL. The server must NEVER fetch (or store) an arbitrary
// client-supplied URL — that's a server-side request forgery primitive. Only
// https URLs on the exact R2 public host are allowed.
export function isAllowedPhotoUrl(url) {
  try {
    const base = process.env.R2_PUBLIC_BASE_URL;
    if (!base) return false;
    const u = new URL(String(url));
    if (u.protocol !== 'https:') return false;
    const b = new URL(base.includes('://') ? base : `https://${base}`);
    return u.hostname.toLowerCase() === b.hostname.toLowerCase();
  } catch { return false; }
}
