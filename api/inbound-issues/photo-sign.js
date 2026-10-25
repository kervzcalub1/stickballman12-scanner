// POST /api/inbound-issues/photo-sign  { contentType, id? } -> { ok, uploadUrl, publicUrl, key }
// A presigned R2 PUT for an inbound-issue photo: the parcel, the label, the inside of the
// box — taken on the receiving Issues step (no batch exists yet, so `id` is absent) or
// added to a case later on the Inbound Issues page. Per-PAIR photos keep their own
// per-VIN path (photos/sign-issue); this one is for the shipment.
import crypto from 'node:crypto';
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { r2Configured, presignPutUrl, publicUrl } from '../_lib/r2.js';
import { VIEW_ROLES, idOf } from './_shared.js';
import { estToday } from '../../src/lib/format.js';

const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, VIEW_ROLES)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'Photo storage is not configured (R2 env vars missing).' });
  const body = await getJsonBody(req);
  const contentType = EXT[body.contentType] ? body.contentType : 'image/jpeg';
  const id = idOf(body.id);
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${EXT[contentType]}`;
  const key = id ? `inbound-issues/case-${id}/${name}` : `inbound-issues/${estToday()}/${name}`;
  try {
    const uploadUrl = presignPutUrl({ key, expiresIn: 300 });
    return send(res, 200, { ok: true, uploadUrl, publicUrl: publicUrl(key), key });
  } catch (e) {
    console.error('[inbound-issues/photo-sign]', e.message);
    return send(res, 500, { ok: false, error: 'Could not prepare the upload.' });
  }
}
