// Inventory CSV export (the daily report download).

export const REPORT_COLS = [
  ['vin', 'VIN'], ['name', 'Name'], ['sku', 'SKU'], ['size', 'Size'],
  ['cost', 'Cost'], ['status', 'Status'], ['supplier_name', 'Supplier'],
  ['batch_code', 'Batch'], ['date_received', 'Received'], ['created_by', 'By'],
];

export function toCSV(rows) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = REPORT_COLS.map(([, label]) => esc(label)).join(',');
  const body = rows.map((r) => REPORT_COLS.map(([k]) => esc(k === 'date_received' ? (r[k] || '').slice(0, 10) : r[k])).join(',')).join('\n');
  return `${head}\n${body}`;
}

export function downloadCSV(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
