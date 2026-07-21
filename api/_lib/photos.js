// Listing-photo helpers shared by the /api/photos/* endpoints.
//
import { isPrivileged } from './util.js';
//
// Two photo SOURCES coexist per SKU/angle:
//   'warehouse' — raw shots taken on intake (warehouse staff).
//   'ph_edited' — edited images uploaded by the PH team on the In-Store Listing /
//                 Edited-Photos page. Display prefers ph_edited (see db.js).
// Role ⇄ source: warehouse manages only 'warehouse'; ph_team only 'ph_edited';
// admin/superadmin manage either. Returns the resolved source, or null if the role
// isn't allowed to touch the requested set.
export function photoSourceForRole(role, requested) {
  const src = requested === 'ph_edited' ? 'ph_edited' : 'warehouse';
  if (isPrivileged(role)) return src;
  if (role === 'warehouse') return src === 'warehouse' ? 'warehouse' : null;
  if (role === 'ph_team') return src === 'ph_edited' ? 'ph_edited' : null;
  return null;
}

export const PHOTO_ANGLES = ['side', 'diagonal', 'outsole', 'top', 'rear'];
export const PH_EXTRA_ANGLES = ['extra1', 'extra2'];

// Listing photos are named `<sku>-<position>-<angle>.jpg` — e.g. FD8311-401-4-outsole.jpg.
// The POSITION is the marketplace upload order (what the stores show first), and the
// ANGLE word makes the file self-describing for whoever is doing the uploading. The
// internal slot keys don't read well on a filename, so two are renamed for humans:
// `side` → lateral and `rear` → heel.
export const ANGLE_POSITION = { side: 1, diagonal: 2, top: 3, outsole: 4, rear: 5, extra1: 6, extra2: 7 };
export const ANGLE_FILE_LABEL = {
  side: 'lateral', diagonal: 'diagonal', top: 'top', outsole: 'outsole', rear: 'heel',
  extra1: 'spec', extra2: 'welcome',
};

// `<sku>-<position>-<angle>` with no extension (callers append their own). Falls back to
// the raw slot name for anything not in the map, so an unknown angle still yields a
// usable, unique-ish name instead of "undefined".
export function listingPhotoBaseName(sku, angle) {
  const pos = ANGLE_POSITION[angle];
  const label = ANGLE_FILE_LABEL[angle] || String(angle || 'photo');
  const clean = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-');
  return pos ? `${clean(sku)}-${pos}-${clean(label)}` : `${clean(sku)}-${clean(label)}`;
}
