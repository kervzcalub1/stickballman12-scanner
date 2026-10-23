// The text layer of a PDF, line by line — a receipt emailed as a PDF, read in the browser
// (no AI needed: the text is already there). Shared by the buying request's receipt
// (BuyCartReceipt) and a store order's receipts (StoreAuditPanel). `file` is a File or a
// Blob — anything with arrayBuffer().
import { lazyImport } from './chunkLoad.js';

export async function textFromPdf(file) {
  const pdfjs = await lazyImport(() => import('pdfjs-dist'));
  const workerUrl = (await lazyImport(() => import('pdfjs-dist/build/pdf.worker.min.mjs?url'))).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    // Rebuild lines by y-position: a receipt's columns arrive as separate text items,
    // and joining them with spaces in reading order is what makes "2 @ 84.99" one line
    // the parser can see rather than three unrelated fragments.
    const rows = new Map();
    for (const it of content.items) {
      const y = Math.round(it.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      out.push(rows.get(y).sort((a, b) => a.x - b.x).map((r) => r.s).join(' ').replace(/\s{2,}/g, '  ').trim());
    }
  }
  return out.join('\n');
}
