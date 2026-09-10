/**
 * DM Hour — XLSX reader/writer, no dependencies.
 *
 * A JavaScript port of `backend/dmhour/xlsx.py`, kept dependency-free and
 * cross-realm (popup + Node test sandbox) by avoiding DOMParser: the OOXML
 * parts are parsed with tolerant regexes over the same structures the Python
 * version walks with ElementTree. The ZIP container is read through local file
 * headers and inflated with `DecompressionStream("deflate-raw")` (the same
 * primitive `igcapture.js` already uses); writing prefers deflate via
 * `CompressionStream` and falls back to STORE when the realm has none, so a
 * round-trip always works even in a bare test VM.
 *
 * Exposed as `DMHXlsx` (mirrors the `DMHCore` convention) with three entry
 * points the popup consumes: `readXlsxDicts`, `writeXlsxBlob`, `recordsToRows`.
 */
(() => {
  "use strict";

  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const NS_PKG_R = "http://schemas.openxmlformats.org/package/2006/relationships";
  const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
  const COL_RE = /^([A-Z]+)([0-9]+)$/;

  const hasDecompressionStream = typeof globalThis.DecompressionStream === "function";
  const hasCompressionStream = typeof globalThis.CompressionStream === "function";

  function colIndex(letters) {
    let value = 0;
    for (const char of letters) value = value * 26 + (char.charCodeAt(0) - 64);
    return value - 1;
  }

  function colLetters(index) {
    index += 1;
    const letters = [];
    while (index) {
      const remainder = (index - 1) % 26;
      letters.push(String.fromCharCode(65 + remainder));
      index = Math.floor((index - 1) / 26);
    }
    return letters.reverse().join("");
  }

  function decodeXmlEntities(text) {
    return String(text)
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  function escapeXml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** Pull every `<si>…</si>` block and concatenate its `<t>` leaves. */
  function parseSharedStrings(xml) {
    const strings = [];
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let si;
    while ((si = siRe.exec(xml)) !== null) {
      let text = "";
      tRe.lastIndex = 0;
      let t;
      while ((t = tRe.exec(si[1])) !== null) text += decodeXmlEntities(t[1]);
      strings.push(text);
    }
    return strings;
  }

  /**
   * Read a single cell's text. Mirrors `xlsx._cell_text`: shared strings,
   * inline strings, and raw values are the only forms the writer and Excel use
   * for text contacts.
   */
  function cellText(attrs, inner, strings) {
    const type = getAttr(attrs, "t");
    const v = matchInner(inner, "v");
    if (type === "s") return v ? strings[Number(v)] || "" : "";
    if (type === "inlineStr") {
      let text = "";
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let t;
      while ((t = tRe.exec(inner)) !== null) text += decodeXmlEntities(t[1]);
      return text;
    }
    return v || "";
  }

  function getAttr(attrs, name) {
    const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
    return match ? match[1] : null;
  }

  function matchInner(inner, tag) {
    const match = inner.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return match ? decodeXmlEntities(match[1]) : "";
  }

  function parseSheet(xml, strings) {
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) !== null) {
      const cells = {};
      let maxIndex = -1;
      // A cell is either `<c …>…</c>` or self-closing `<c …/>`.
      const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
      let cm;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const attrs = cm[1] ?? cm[3] ?? "";
        const inner = cm[2] ?? "";
        const ref = getAttr(attrs, "r") || "";
        const colMatch = ref.match(COL_RE);
        const index = colMatch ? colIndex(colMatch[1]) : maxIndex + 1;
        cells[index] = cellText(attrs, inner, strings);
        if (index > maxIndex) maxIndex = index;
      }
      if (maxIndex < 0) rows.push([]);
      else rows.push(Array.from({ length: maxIndex + 1 }, (_, i) => cells[i] || ""));
    }
    return rows;
  }

  async function inflate(data) {
    if (!hasDecompressionStream) throw new Error("DecompressionStream unavailable");
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function deflate(data) {
    if (!hasCompressionStream) return null;
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Minimal local-header ZIP reader: enough for any OOXML package. */
  async function unzip(buffer) {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const entries = {};
    let offset = 0;
    while (offset + 30 <= buffer.byteLength) {
      if (view.getUint32(offset, true) !== 0x04034b50) break;
      const method = view.getUint16(offset + 8, true);
      const compSize = view.getUint32(offset + 18, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const nameStart = offset + 30;
      const name = new TextDecoder().decode(u8.slice(nameStart, nameStart + nameLen));
      const dataStart = nameStart + nameLen + extraLen;
      const compData = u8.slice(dataStart, dataStart + compSize);
      if (method === 0) entries[name] = compData;
      else if (method === 8) entries[name] = await inflate(compData);
      else throw new Error(`Unsupported zip compression method: ${method}`);
      offset = dataStart + compSize;
    }
    return entries;
  }

  async function readXlsxRows(buffer) {
    const entries = await unzip(buffer);
    const strings = [];
    if (entries["xl/sharedStrings.xml"]) {
      for (const text of parseSharedStrings(new TextDecoder().decode(entries["xl/sharedStrings.xml"]))) {
        strings.push(text);
      }
    }
    let sheetPath = "xl/worksheets/sheet1.xml";
    if (entries["xl/workbook.xml"] && entries["xl/_rels/workbook.xml.rels"]) {
      const relsXml = new TextDecoder().decode(entries["xl/_rels/workbook.xml.rels"]);
      const relRe = /<Relationship\b[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g;
      const rels = {};
      let rel;
      while ((rel = relRe.exec(relsXml)) !== null) rels[rel[1]] = rel[2];
      const workbookXml = new TextDecoder().decode(entries["xl/workbook.xml"]);
      const sheetRe = /<sheet\b[^>]*\/>/g;
      const sheetMatch = sheetRe.exec(workbookXml);
      if (sheetMatch) {
        const idMatch = sheetMatch[0].match(/\br:id\s*=\s*"([^"]*)"/) || sheetMatch[0].match(/\bid\s*=\s*"([^"]*)"/);
        const rid = idMatch ? idMatch[1] : null;
        const target = rid ? rels[rid] : null;
        if (target) sheetPath = target.startsWith("xl/") ? target : `xl/${String(target).replace(/^\//, "")}`;
      }
    }
    if (!entries[sheetPath]) throw new Error("XLSX workbook has no worksheet");
    return parseSheet(new TextDecoder().decode(entries[sheetPath]), strings);
  }

  function readXlsxDicts(buffer) {
    return readXlsxRows(buffer).then((rows) => {
      if (!rows.length) throw new Error("XLSX sheet is empty");
      const headers = rows[0].map((value, index) => String(value).trim() || `column_${index}`);
      const records = [];
      for (const row of rows.slice(1)) {
        if (!row.some((value) => String(value).trim())) continue;
        const record = {};
        headers.forEach((header, index) => { record[header] = row[index] || ""; });
        records.push(record);
      }
      return records;
    });
  }

  /** Convert an array of records into header + value rows for the writer. */
  function recordsToRows(records) {
    if (!records?.length) return [[]];
    const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
    const rows = [headers];
    for (const record of records) rows.push(headers.map((key) => record[key] == null ? "" : String(record[key])));
    return rows;
  }

  // --- CRC32 + ZIP writer -------------------------------------------------

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u16(view, offset, value) { view.setUint16(offset, value, true); }
  function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  function makeEntry(name, data, method) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const view = new DataView(local.buffer);
    u32(view, 0, 0x04034b50);
    u16(view, 4, 20);      // version needed
    u16(view, 6, 0);       // flags
    u16(view, 8, method);
    u16(view, 10, 0); u16(view, 12, 0); // mod time/date
    u32(view, 14, crc);
    u32(view, 18, data.length);
    u32(view, 22, data.length);
    u16(view, 26, nameBytes.length);
    u16(view, 28, 0);      // extra
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    return { name, nameBytes, crc, method, data, local, localHeaderOffset: 0 };
  }

  async function zip(entries) {
    let offset = 0;
    const parts = [];
    const central = [];
    for (const entry of entries) {
      entry.localHeaderOffset = offset;
      let payload = entry.data;
      let method = 0; // STORE
      const deflated = entry.data.length > 0 ? await deflate(entry.data) : null;
      if (deflated && deflated.length < entry.data.length) {
        payload = deflated;
        method = 8; // deflate
      }
      const built = makeEntry(entry.name, payload, method);
      built.crc = entry.data.length ? crc32(entry.data) : 0; // crc of uncompressed
      const crcView = new DataView(built.local.buffer);
      u32(crcView, 14, built.crc);
      u32(crcView, 18, payload.length);   // compressed size
      u32(crcView, 22, entry.data.length); // uncompressed size
      u16(crcView, 8, method);
      parts.push(built.local);
      const cd = new Uint8Array(46 + built.nameBytes.length);
      const cdView = new DataView(cd.buffer);
      u32(cdView, 0, 0x02014b50);
      u16(cdView, 4, 20);
      u16(cdView, 6, 20);
      u16(cdView, 8, 0);
      u16(cdView, 10, method);
      u16(cdView, 12, 0); u16(cdView, 14, 0);
      u32(cdView, 16, built.crc);
      u32(cdView, 20, payload.length);
      u32(cdView, 24, entry.data.length);
      u16(cdView, 28, built.nameBytes.length);
      u16(cdView, 30, 0); u16(cdView, 32, 0);
      u16(cdView, 34, 0); u16(cdView, 36, 0);
      u32(cdView, 38, 0);
      u32(cdView, 42, offset);
      cd.set(built.nameBytes, 46);
      central.push(cd);
      offset += built.local.length;
    }
    let cdSize = 0;
    for (const cd of central) cdSize += cd.length;
    const cdOffset = offset;
    const all = [...parts, ...central];
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    u32(endView, 0, 0x06054b50);
    u16(endView, 4, 0); u16(endView, 6, 0);
    u16(endView, 8, entries.length); u16(endView, 10, entries.length);
    u32(endView, 12, cdSize);
    u32(endView, 16, cdOffset);
    u16(endView, 20, 0);
    all.push(end);
    const total = all.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of all) { out.set(part, pos); pos += part.length; }
    return out;
  }

  async function writeXlsxBlob(rows) {
    const strings = [];
    const indexByValue = new Map();
    const intern = (value) => {
      if (!indexByValue.has(value)) { indexByValue.set(value, strings.length); strings.push(value); }
      return indexByValue.get(value);
    };
    const sheetRows = [];
    rows.forEach((row, rowNumber) => {
      const cells = [];
      row.forEach((raw, column) => {
        const value = raw == null ? "" : String(raw);
        cells.push(`<c r="${colLetters(column)}${rowNumber + 1}" t="s"><v>${intern(value)}</v></c>`);
      });
      sheetRows.push(`<row r="${rowNumber + 1}">${cells.join("")}</row>`);
    });
    const shared = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<sst xmlns="${NS}" count="${strings.length}" uniqueCount="${strings.length}">`,
      ...strings.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`),
      "</sst>"
    ].join("\n");
    const workbook = `<?xml version="1.0" encoding="UTF-8"?>\n<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets><sheet name="History" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const rels = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="${NS_PKG_R}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="${NS_PKG_R}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="${NS_CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
    const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}"><sheetData>${sheetRows.join("")}</sheetData></worksheet>`;
    const entries = [
      { name: "[Content_Types].xml", data: new TextEncoder().encode(contentTypes) },
      { name: "_rels/.rels", data: new TextEncoder().encode(rootRels) },
      { name: "xl/workbook.xml", data: new TextEncoder().encode(workbook) },
      { name: "xl/_rels/workbook.xml.rels", data: new TextEncoder().encode(rels) },
      { name: "xl/sharedStrings.xml", data: new TextEncoder().encode(shared) },
      { name: "xl/worksheets/sheet1.xml", data: new TextEncoder().encode(sheet) }
    ];
    const bytes = await zip(entries);
    return new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  globalThis.DMHXlsx = Object.freeze({ readXlsxDicts, readXlsxRows, writeXlsxBlob, recordsToRows, colIndex, colLetters, crc32 });
})();
