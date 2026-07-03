// Listing-photo helpers shared by the /api/photos/* endpoints.
//
// Two photo SOURCES coexist per SKU/angle:
//   'warehouse' — raw shots taken on intake (warehouse staff).
//   'ph_edited' — edited images uploaded by the PH team on the In-Store Listing /
//                 Edited-Photos page. Display prefers ph_edited (see db.js).
// Role ⇄ source: warehouse manages only 'warehouse'; ph_team only 'ph_edited';
// admin manages either. Returns the resolved source, or null if the role isn't
// allowed to touch the requested set.
export function photoSourceForRole(role, requested) {
  const src = requested === 'ph_edited' ? 'ph_edited' : 'warehouse';
  if (role === 'admin') return src;
  if (role === 'warehouse') return src === 'warehouse' ? 'warehouse' : null;
  if (role === 'ph_team') return src === 'ph_edited' ? 'ph_edited' : null;
  return null;
}

export const PHOTO_ANGLES = ['side', 'diagonal', 'outsole', 'top', 'rear'];
export const PH_EXTRA_ANGLES = ['extra1', 'extra2'];
