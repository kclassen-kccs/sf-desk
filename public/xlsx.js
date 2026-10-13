// Minimal Excel (.xlsx) writer for SF Desk's "Export to Excel" buttons. Runs in the browser, no
// libraries: builds the workbook XML for one sheet and zips it (deflate where the browser has
// CompressionStream, else stored). Numbers, money, percentages and dates are written as typed
// cells so they sort and sum in Excel.
//
// downloadXlsx('file.xlsx', 'Sheet', columns, rows, { totals: true })
//   columns: [{ header, type: 'string' | 'number' | 'money' | 'percent' | 'date', width?, sum? }]
//   rows:    arrays of values in column order ('YYYY-MM-DD' strings for dates, percent as 0–100)
//   totals:  add a bold Total row with SUM formulas under columns marked sum: true
(function () {
  // Styles (cellXfs index): 0 default, 1 header, 2 date, 3 money, 4 percent, 5 number,
  // 6 total label, 7 total money, 8 total number.
  const STYLE = { string: 0, date: 2, money: 3, percent: 4, number: 5 };
  const TOTAL = { money: 7, number: 8, percent: 8 };

  const esc = (s) => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colName = (i) => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
  // Excel's day number for a 'YYYY-MM-DD' date.
  const serial = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
    return m ? (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000 : null;
  };

  function cell(ref, col, v) {
    if (v == null || v === '') return '';
    const t = col.type || 'string';
    if (t !== 'string') {
      const n = t === 'date' ? serial(v) : t === 'percent' ? Number(v) / 100 : Number(v);
      if (n != null && Number.isFinite(n)) return `<c r="${ref}" s="${STYLE[t]}"><v>${n}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }

  function sheetXml(columns, rows, totals) {
    const last = colName(columns.length - 1), n = rows.length;
    const out = [`<row r="1">${columns.map((c, i) =>
      `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t>${esc(c.header)}</t></is></c>`).join('')}</row>`];
    rows.forEach((r, j) => out.push(`<row r="${j + 2}">${columns.map((c, i) => cell(colName(i) + (j + 2), c, r[i])).join('')}</row>`));
    if (totals && n) {
      const rr = n + 2;
      out.push(`<row r="${rr}">${columns.map((c, i) => {
        const ref = colName(i) + rr;
        if (i === 0) return `<c r="${ref}" s="6" t="inlineStr"><is><t>Total</t></is></c>`;
        if (!c.sum) return '';
        return `<c r="${ref}" s="${TOTAL[c.type] ?? 8}"><f>SUM(${colName(i)}2:${colName(i)}${n + 1})</f></c>`;
      }).join('')}</row>`);
    }
    const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      `<cols>${cols}</cols><sheetData>${out.join('')}</sheetData>` +
      (n ? `<autoFilter ref="A1:${last}${n + 1}"/>` : '') + '</worksheet>';
  }

  const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="9">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  function parts(sheetName, sheet) {
    const name = esc(String(sheetName).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
    return [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>'],
      ['xl/styles.xml', STYLES],
      ['xl/worksheets/sheet1.xml', sheet],
    ];
  }

  // ---------- zip ----------
  const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };

  async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(s).arrayBuffer());
    } catch { return null; }
  }

  async function zip(files) {
    const enc = new TextEncoder(), chunks = [], central = [];
    let offset = 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const [name, text] of files) {
      const nameB = enc.encode(name), raw = enc.encode(text), packed = await deflate(raw);
      const data = packed || raw, method = packed ? 8 : 0, crc = crc32(raw);
      const head = (sig, extra) => {
        const h = new DataView(new ArrayBuffer(extra ? 46 : 30));
        let p = 0;
        const u32 = (v) => { h.setUint32(p, v, true); p += 4; }, u16 = (v) => { h.setUint16(p, v, true); p += 2; };
        u32(sig);
        if (extra) u16(20);
        u16(20); u16(0x0800); u16(method); u16(time); u16(date);
        u32(crc); u32(data.length); u32(raw.length); u16(nameB.length); u16(0);
        if (extra) { u16(0); u16(0); u16(0); u32(0); u32(offset); }
        return new Uint8Array(h.buffer);
      };
      const local = head(0x04034b50, false);
      chunks.push(local, nameB, data);
      central.push(head(0x02014b50, true), nameB);
      offset += local.length + nameB.length + data.length;
    }
    const cdSize = central.reduce((s, b) => s + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  async function buildXlsx(sheetName, columns, rows, { totals = false } = {}) {
    return zip(parts(sheetName, sheetXml(columns, rows, totals)));
  }

  async function downloadXlsx(filename, sheetName, columns, rows, opts) {
    const blob = await buildXlsx(sheetName, columns, rows, opts);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename.replace(/[\\/:*?"<>|]+/g, ' ').trim();
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  window.buildXlsx = buildXlsx;
  window.downloadXlsx = downloadXlsx;
})();
