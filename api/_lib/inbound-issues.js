// Inbound issues — server glue (docs/context/inbound-issues.md). The rules live in
// src/lib/inboundIssues.js (shared with the page); the SQL in db.js.
import { openInboundIssues } from './db.js';
import { alertInboundIssuesReported } from './alerts.js';
import { opensCase } from '../../src/lib/inboundIssues.js';

/**
 * After a receiving submit: open a case for every recorded problem and tell the PH team.
 *   recorded:   shipment_issues rows just written (insertIssues' return)
 *   unitIssues: the per-pair defects as sent ({ vin, type, note, photos })
 *   created:    the pairs just inserted ({ id, vin }) — to map a VIN to its row
 * Never throws: the shipment is already saved, and a failure here must not turn that into
 * an error on the floor. It is logged loudly instead.
 */
export async function openCasesForIntake({ batchId, boxId = null, recorded = [], unitIssues = [], created = [], user }) {
  try {
    const idByVin = new Map(created.map((r) => [r.vin, r.id]));
    const shipment = recorded.filter((r) => opensCase(r.type)).map((r) => ({
      shipmentIssueId: r.id, type: r.type, description: r.description,
      expectedCount: r.expected_count, receivedCount: r.received_count, photos: r.photos,
    }));
    const pairs = unitIssues.filter((u) => opensCase(u.type) && idByVin.has(u.vin))
      .map((u) => ({ itemId: idByVin.get(u.vin), type: u.type, note: u.note, photos: u.photos }));
    const by = { id: Number(user?.uid) || null, name: user?.name || user?.username || null };
    const rows = await openInboundIssues({ batchId, boxId, shipment, pairs, by: by.name, byUid: by.id, source: 'receiving' });
    alertInboundIssuesReported(rows, by);
    return rows;
  } catch (e) {
    console.error('[inbound-issues] could not open cases for batch', batchId, e.message);
    return [];
  }
}
