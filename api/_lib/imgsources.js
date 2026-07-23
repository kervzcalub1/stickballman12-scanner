// Aggregate of every marketplace/brand image source the Image Finder can pull from.
//
// The endpoints that fetch picked images SERVER-SIDE (images/import, images/cutout,
// images/brand) need one SSRF allowlist covering all sources. Keeping that union here
// — rather than growing it inside kicksdb.js — means adding a brand (adidas, New
// Balance, …) is a one-line change here and nothing else has to move.
import { isAllowedSourceImageUrl as isKicksdbImageUrl, hiResSourceUrl as kicksdbHiRes } from './kicksdb.js';
import { isNikeImageUrl } from './nike.js';
import { isAdidasImageUrl } from './adidas.js';

// SSRF guard for every server-side image fetch: StockX / GOAT (KicksDB), Nike, or the
// Shopify CDN that carries the adidas studio set.
//
// NOTE on cdn.shopify.com: it's a SHARED CDN, so allowing it is broader than the other
// two hosts — it permits fetching any Shopify-hosted asset, not just adidas'. Judged
// acceptable because this path is ph_team-only, images are size-capped and
// content-type-checked before use, and the host serves public static assets with no
// internal network reach. Worth revisiting if the guard is ever reused somewhere less
// constrained.
export const isAllowedSourceImageUrl = (url) =>
  isKicksdbImageUrl(url) || isNikeImageUrl(url) || isAdidasImageUrl(url);

// Upgrade a gallery URL to the rendition we actually want to composite from. For KicksDB
// that's the full-resolution GOAT original. For Nike we use the ORIGINAL white-bg render
// (not the transparent PNG twin): Nike bakes its own soft drop-shadow into the cutout, so
// running the white-bg image through the AI matte strips that shadow and lets Brand & Fill
// apply its own — worth the per-image cutout cost for a consistent look. (Previously the
// pre-cut twin skipped the matte but kept Nike's shadow.)
export const hiResSourceUrl = (url) => (isNikeImageUrl(url) ? url : kicksdbHiRes(url));
