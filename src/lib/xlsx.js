// A minimal .xlsx writer — one sheet, a bold frozen header, columns sized to their text.
//
// Why not a CSV: a CSV is plain text and has nowhere to keep a column width, so every
// app that opens one picks its own and the long columns arrive squashed. Why not a
// library: the xlsx packages are 300 KB+ for what is six small XML files in a zip, and
// fflate (the zip) is already here. Runs in the browser AND on the server, so the file
// a person downloads and the one sent on Telegram are byte-for-byte the same builder.
//
// `columns`: [{ label, type: 'text' | 'money' | 'int', maxWidth? }]
// `rows`:    [[value, …], …] in column order. null / '' / NaN → an empty cell.
import { zipSync, strToU8 } from 'fflate';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 forbids most control characters; a stray one makes Excel call the file corrupt.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

// A1-style column letters: 0 → A, 25 → Z, 26 → AA.
const colName = (i) => {
  let n = i + 1; let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

// Style ids in styles.xml below: 0 plain · 1 bold header · 2 money (0.00) · 3 whole number.
const STYLE = { text: 0, money: 2, int: 3 };

const isBlank = (v) => v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v));
const shown = (v, type) => (isBlank(v) ? '' : type === 'money' ? Number(v).toFixed(2) : String(v));

// One sheet's XML, plus the name and filter range the workbook needs for it.
function sheetXml({ sheetName = 'Sheet1', columns, rows }) {
  const cols = columns.map((c) => ({ type: 'text', maxWidth: 60, ...c }));
  // Width in Excel's "characters": the longest thing in the column (header included),
  // plus a little air, never narrower than 6 and capped so one long cell (a VIN list)
  // can't push everything else off screen — that cell still holds all its text.
  const widths = cols.map((c, i) => {
    const longest = Math.max(String(c.label).length, ...rows.map((r) => shown(r[i], c.type).length));
    return Math.min(c.maxWidth, Math.max(6, longest + 2));
  });

  const cell = (ref, v, type, style) => {
    if (isBlank(v)) return style ? `<c r="${ref}" s="${style}"/>` : '';
    if ((type === 'money' || type === 'int') && Number.isFinite(Number(v))) {
      // Rounded to the cent: 75.99 − 87.18 is -11.189999999999998 in floating point, and
      // that is what a cell would show when someone widens it or sums it.
      const n = type === 'money' ? Math.round(Number(v) * 100) / 100 : Number(v);
      return `<c r="${ref}" s="${style}"><v>${n}</v></c>`;
    }
    return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  };

  const head = `<row r="1">${cols.map((c, i) => cell(`${colName(i)}1`, c.label, 'text', 1)).join('')}</row>`;
  const body = rows.map((r, ri) => {
    const n = ri + 2;
    return `<row r="${n}">${cols.map((c, i) => cell(`${colName(i)}${n}`, r[i], c.type, STYLE[c.type])).join('')}</row>`;
  }).join('');
  const last = `${colName(cols.length - 1)}${rows.length + 1}`;

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${head}${body}</sheetData>
<autoFilter ref="A1:${last}"/>
</worksheet>`;
  const name = esc(String(sheetName).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  return { xml, name, filter: `'${name}'!$A$1:$${colName(cols.length - 1)}$${rows.length + 1}` };
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * Several sheets in one workbook (the Lost Package Tracker's Summary + Lost + Delivered + …):
 * `sheets` = [{ sheetName, columns, rows }, …], each laid out exactly as `buildXlsx` lays out
 * its one. Sheet names must differ (Excel refuses a duplicate) — the caller's job.
 */
export function buildXlsxBook(sheets) {
  const built = sheets.map(sheetXml);
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${built.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${built.map((b, i) => `<sheet name="${b.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${built.map((b, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${b.filter}</definedName>`).join('')}</definedNames>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${built.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${built.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
  };
  // Sheets, THEN styles: the zip keeps insertion order, and a one-sheet file must come out
  // byte-for-byte as it did before this function existed (the same file is sent on Telegram).
  built.forEach((b, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(b.xml); });
  files['xl/styles.xml'] = strToU8(STYLES);
  return zipSync(files);
}

export function buildXlsx({ sheetName = 'Sheet1', columns, rows }) {
  return buildXlsxBook([{ sheetName, columns, rows }]);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
