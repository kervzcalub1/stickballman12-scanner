// Seed the ~253 Manheim shelf locations from the Inventory Location Structure.
// Idempotent: re-running skips codes that already exist (ON CONFLICT DO NOTHING).
// Usage: npm run db:seed-manheim   (run db:setup first so the table exists).
import fs from 'fs';
import path from 'path';

// Load .env into process.env if DATABASE_URL isn't already present (mirrors db-setup).
if (!process.env.DATABASE_URL) {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not configured.'); process.exit(1); }

const { buildLocationCode, pad2, SITE_PREFIXES } = await import('../api/_lib/locations.js');
const { bulkCreateLocations } = await import('../api/_lib/db.js');

const WAREHOUSE = 'Manheim Main Shed';
const SITE = SITE_PREFIXES[WAREHOUSE]; // MNH

// bay -> number of shelves (bottom→up). Insertion order = physical/print order.
const STRUCTURE = [
  { area: 'Warehouse Rows', prefix: 'WH', bays: {
    A1: 3, A2: 5, A3: 5, A4: 5, A5: 3,
    B1: 4, B2: 4, B3: 4, B4: 3,
    C1: 4, C2: 4, C3: 4,
    D1: 4, D2: 4, D3: 4,
    E1: 4, E2: 4, E3: 4,
    F1: 5, F2: 5, F3: 5,
    G1: 5, G2: 5, G3: 5, G4: 3,
    H1: 5, H2: 5, H3: 5, H4: 3,
    J1: 5, J2: 5, J3: 5, J4: 5,
    K1: 3, K2: 1, K3: 4, K4: 5, K5: 5, K6: 5, K7: 5, K8: 5, K9: 5, K10: 4, K11: 4,
  } },
  { area: 'Pods', prefix: 'PD', pods: [1, 2, 3, 4] }, // whole-bay, no shelves
  { area: 'Office Space', prefix: 'OF', bays: { A1: 3, A2: 3, A3: 2 } },
  { area: 'Basement Space', prefix: 'BS', bays: {
    A1: 2, A2: 2, A3: 3, A4: 3, A5: 3, A6: 3, A7: 3, A8: 3, A9: 3, A10: 3, A11: 3, A12: 3,
    B1: 3, B2: 3, B3: 3, B4: 3, B5: 3, B6: 3,
  } },
];

const locations = [];
let sort = 0;
for (const grp of STRUCTURE) {
  if (grp.pods) {
    for (const n of grp.pods) {
      locations.push({
        code: buildLocationCode({ sitePrefix: SITE, areaPrefix: grp.prefix, bayCode: String(n), shelf: null }),
        warehouse: WAREHOUSE, area: grp.area, bay: `Pod ${n}`, shelf: null, label: `Pod ${n}`, sort_order: sort++,
      });
    }
    continue;
  }
  for (const [bay, shelves] of Object.entries(grp.bays)) {
    for (let s = 1; s <= shelves; s++) {
      locations.push({
        code: buildLocationCode({ sitePrefix: SITE, areaPrefix: grp.prefix, bayCode: bay, shelf: s }),
        warehouse: WAREHOUSE, area: grp.area, bay, shelf: s, label: `${bay}-${pad2(s)}`, sort_order: sort++,
      });
    }
  }
}

const { inserted, total } = await bulkCreateLocations(locations, 'system (seed)');
console.log(`Manheim locations: generated ${total}, inserted ${inserted} (skipped ${total - inserted} already present).`);
process.exit(0);
