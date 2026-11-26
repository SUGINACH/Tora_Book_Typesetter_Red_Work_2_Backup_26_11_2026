// src/engine/output/pdf-writer.js — Pure-JS PDF 1.4 writer (S12.1-3, REQ-EXP-03)
'use strict';

const { inflateRawPure } = require('../import/zip-reader');

/**
 * כותב PDF מהקרנת הגיאומטריה (geometry-projector — מקור יחיד) + תת־גופן
 * TrueType מוטמע (CIDFontType2 + ToUnicode — טקסט אמיתי נבחר/מופק).
 *
 * יכולות (חוזה S12.1-3):
 *  - MediaBox/TrimBox/BleedBox מרישום גדלי העמוד (מ״מ→pt) + export-bleed-mm;
 *  - סימני חיתוך (pdf-crop-marks) — קווים מחוץ לתבנית החיתוך ב־4 פינות;
 *  - עץ סימניות (Outlines) ממודל הכותרות — H1 רמה 1, H2 רמה 2 תחתיו;
 *  - יעדי קישור לחיצים משורות ה־TOC (Link/GoTo → עמוד הכותרת);
 *  - טקסט אמיתי לכל מילה (BT/Tf/Td/Tj) — RTL מוצב מפורש;
 *  - דטרמיניזם: אין תאריך/מזהים אקראיים; סדר אובייקטים קבוע; ייצוא כפול ⇒ בתים זהים.
 *
 * עצמאי לחלוטין — אפס תלות חיצונית (אותה דוקטרינה כמו zip-writer/xml-lite).
 * מוכן גם לצינור הדפסת Chromium: ה־HTML העצמאי (html-export) כולל את אותם
 * כללי @page; ה־PDF הכתוב כאן הוא המסלול המנועי המלא (סימניות+קישורים).
 */

const PX_TO_PT = 72 / 96;
const MM_TO_PT = 72 / 25.4;

/** כתיבת מסמך PDF — אוסף אובייקטים ומרכיב xref מדויק. */
class PdfBuilder {
  constructor() {
    this.objects = new Map(); // id → Buffer (האובייקט בלבד, בלי "N 0 obj")
    this.nextId = 1;
  }
  reserve() { return this.nextId++; }
  put(id, content) {
    this.objects.set(id, Buffer.isBuffer(content) ? content : Buffer.from(content, 'latin1'));
    return id;
  }
  add(content) { return this.put(this.reserve(), content); }
  build() {
    const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let pos = parts[0].length;
    const offsets = new Map();
    const maxId = Math.max(0, ...this.objects.keys());
    for (let id = 1; id <= maxId; id++) {
      if (!this.objects.has(id)) continue;
      const head = Buffer.from(`${id} 0 obj\n`, 'latin1');
      const body = this.objects.get(id);
      const tail = Buffer.from('\nendobj\n', 'latin1');
      offsets.set(id, pos);
      pos += head.length + body.length + tail.length;
      parts.push(head, body, tail);
    }
    const xrefPos = pos;
    let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= maxId; id++) {
      if (offsets.has(id)) xref += `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`;
      else xref += `0000000000 65535 f \n`;
    }
    parts.push(Buffer.from(xref, 'latin1'));
    parts.push(Buffer.from(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}

function escapePdfText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function round2(v) { return Math.round(v * 100) / 100; }
function pdfPrecise(v) { const n = Math.round(Number(v) * 1e6) / 1e6; return Object.is(n, -0) ? '0' : String(n); }

/** Adler-32 for producing a minimal valid zlib stream without Node zlib. */
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return (((b << 16) | a) >>> 0);
}

/** A deterministic zlib wrapper using uncompressed DEFLATE blocks. */
function zlibStored(bytes) {
  const source = Buffer.from(bytes);
  const parts = [Buffer.from([0x78, 0x01])];
  let offset = 0;
  if (!source.length) {
    parts.push(Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff]));
  }
  while (offset < source.length) {
    const length = Math.min(65535, source.length - offset);
    const final = offset + length >= source.length;
    const nlen = (~length) & 0xffff;
    const header = Buffer.from([
      final ? 0x01 : 0x00,
      length & 0xff, (length >>> 8) & 0xff,
      nlen & 0xff, (nlen >>> 8) & 0xff
    ]);
    parts.push(header, source.subarray(offset, offset + length));
    offset += length;
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(adler32(source), 0);
  parts.push(checksum);
  return Buffer.concat(parts);
}

/** Validate and inflate a PNG zlib payload with the engine's pure DEFLATE reader. */
function inflatePngIdat(bytes, expectedSize) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 64 * 1024 * 1024) {
    throw new Error('png-pixel-data-size-limit');
  }
  if (!bytes || bytes.length < 6 || (bytes[0] & 0x0f) !== 8 ||
      (((bytes[0] << 8) | bytes[1]) % 31) !== 0 || (bytes[1] & 0x20) !== 0) {
    throw new Error('png-zlib-header-invalid');
  }
  const rawDeflate = bytes.subarray(2, bytes.length - 4);
  const inflated = inflateRawPure(rawDeflate, 0, expectedSize);
  if (inflated.length !== expectedSize) throw new Error('png-scanline-size-mismatch');
  const checksum = bytes.readUInt32BE(bytes.length - 4);
  if (adler32(inflated) !== checksum) throw new Error('png-adler32-mismatch');
  return inflated;
}

/** Undo PNG row filters (0..4) into packed, unfiltered pixel rows. */
function unfilterPngRows(filtered, width, height, channels) {
  const rowBytes = width * channels;
  const pixels = new Uint8Array(rowBytes * height);
  let source = 0;
  for (let y = 0; y < height; y++) {
    const filter = filtered[source++];
    const rowStart = y * rowBytes;
    const previousStart = rowStart - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const value = filtered[source++];
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const up = y > 0 ? pixels[previousStart + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[previousStart + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upperLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upperLeft);
        predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upperLeft);
      } else if (filter !== 0) {
        throw new Error('png-filter-unsupported:' + filter);
      }
      pixels[rowStart + x] = (value + predictor) & 0xff;
    }
  }
  return pixels;
}

/**
 * Split 8-bit PNG grayscale-alpha/RGBA pixels into opaque color samples and an
 * alpha plane. The resulting zlib streams use PNG filter 0 and a PDF soft mask.
 */
function splitPngAlpha(filtered, width, height, colorType) {
  const channels = colorType === 6 ? 4 : 2;
  const colorChannels = colorType === 6 ? 3 : 1;
  const pixels = unfilterPngRows(filtered, width, height, channels);
  const colorRows = new Uint8Array(height * (1 + width * colorChannels));
  const alphaRows = new Uint8Array(height * (1 + width));
  for (let y = 0; y < height; y++) {
    const srcRow = y * width * channels;
    const colorRow = y * (1 + width * colorChannels);
    const alphaRow = y * (1 + width);
    colorRows[colorRow] = 0; // PNG filter None
    alphaRows[alphaRow] = 0;
    for (let x = 0; x < width; x++) {
      const src = srcRow + x * channels;
      const color = colorRow + 1 + x * colorChannels;
      for (let c = 0; c < colorChannels; c++) colorRows[color + c] = pixels[src + c];
      alphaRows[alphaRow + 1 + x] = pixels[src + colorChannels];
    }
  }
  return {
    colorBytes: zlibStored(colorRows),
    alphaBytes: zlibStored(alphaRows),
    smask: {
      width, height, colorSpace: '/DeviceGray', bitsPerComponent: 8,
      filter: '/FlateDecode',
      decodeParms: `/DecodeParms << /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns ${width} >>`,
      bytes: zlibStored(alphaRows)
    }
  };
}

/**
 * Parse image bytes for direct PDF XObject embedding. JPEG is copied unchanged
 * under DCTDecode. PNG supports opaque grayscale/RGB directly and 8-bit
 * grayscale-alpha/RGBA through a PDF soft mask; unsupported formats fail loudly.
 */
function parsePdfImageAsset(asset) {
  const source = asset && asset.bytes;
  if (!source || typeof source.length !== 'number' || source.length === 0) {
    return { ok: false, code: 'empty-image-bytes' };
  }
  // Buffer.from(Uint8Array) copies exactly the view, including any byteOffset
  // and byteLength; do not pass its larger backing ArrayBuffer to the Worker shim.
  const bytes = Buffer.from(source);
  const measured = asset.measured || {};
  if (Number(measured.orientation || 1) !== 1) {
    return { ok: false, code: 'jpeg-exif-orientation-unsupported', message: 'תמונות עם EXIF orientation שאינו 1 דורשות נרמול כיוון לפני הטמעה' };
  }

  // JPEG: locate a valid SOF frame header and retain the original DCT stream.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) {
        return { ok: false, code: 'jpeg-invalid-segment' };
      }
      if (sofMarkers.has(marker)) {
        if (segmentLength < 8) return { ok: false, code: 'jpeg-invalid-frame' };
        const bits = bytes[offset + 2];
        const height = bytes.readUInt16BE(offset + 3);
        const width = bytes.readUInt16BE(offset + 5);
        const components = bytes[offset + 7];
        if (bits !== 8 || !width || !height || (components !== 1 && components !== 3)) {
          return { ok: false, code: 'jpeg-color-model-unsupported', message: 'PDF תומך כאן ב-JPEG של 8-bit grayscale או RGB בלבד' };
        }
        return {
          ok: true, format: 'jpeg', width, height,
          colorSpace: components === 1 ? '/DeviceGray' : '/DeviceRGB',
          bitsPerComponent: 8, filter: '/DCTDecode', bytes
        };
      }
      offset += segmentLength;
    }
    return { ok: false, code: 'jpeg-frame-not-found' };
  }

  // PNG: accept grayscale or RGB without alpha/interlacing. The IDAT zlib
  // stream already contains PNG row-filter bytes, consumed by Predictor 15.
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 33 && pngSignature.every((value, index) => bytes[index] === value)) {
    let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = -1;
    const idat = [];
    let sawHeader = false, sawEnd = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) return { ok: false, code: 'png-invalid-chunk-length' };
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      const dataStart = offset + 8, dataEnd = dataStart + length;
      if (type === 'IHDR') {
        if (sawHeader || length !== 13) return { ok: false, code: 'png-invalid-ihdr' };
        width = bytes.readUInt32BE(dataStart);
        height = bytes.readUInt32BE(dataStart + 4);
        bitDepth = bytes[dataStart + 8];
        colorType = bytes[dataStart + 9];
        const compression = bytes[dataStart + 10];
        const filter = bytes[dataStart + 11];
        interlace = bytes[dataStart + 12];
        if (!width || !height || compression !== 0 || filter !== 0) return { ok: false, code: 'png-invalid-header' };
        sawHeader = true;
      } else if (type === 'IDAT') {
        if (!sawHeader || sawEnd) return { ok: false, code: 'png-invalid-idat-order' };
        idat.push(bytes.subarray(dataStart, dataEnd));
      } else if (type === 'IEND') {
        sawEnd = true;
        break;
      }
      offset = dataEnd + 4; // skip CRC
    }
    if (!sawHeader || !sawEnd || !idat.length) return { ok: false, code: 'png-incomplete-stream' };
    if (interlace !== 0 || bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType)) {
      return { ok: false, code: 'png-color-model-unsupported', message: 'PDF תומך ב-PNG לא משולב בעומק 8-bit: grayscale/RGB עם או בלי alpha' };
    }
    const idatBytes = Buffer.concat(idat);
    if (colorType === 4 || colorType === 6) {
      try {
        const channels = colorType === 6 ? 4 : 2;
        const expectedSize = height * (1 + width * channels);
        const filtered = inflatePngIdat(idatBytes, expectedSize);
        const split = splitPngAlpha(filtered, width, height, colorType);
        return {
          ok: true, format: 'png', width, height,
          colorSpace: colorType === 6 ? '/DeviceRGB' : '/DeviceGray',
          bitsPerComponent: 8, filter: '/FlateDecode',
          decodeParms: `/DecodeParms << /Predictor 15 /Colors ${colorType === 6 ? 3 : 1} /BitsPerComponent 8 /Columns ${width} >>`,
          bytes: split.colorBytes,
          smask: split.smask
        };
      } catch (error) {
        return { ok: false, code: 'png-alpha-decode-failed', message: error && error.message ? error.message : String(error) };
      }
    }
    return {
      ok: true, format: 'png', width, height,
      colorSpace: colorType === 0 ? '/DeviceGray' : '/DeviceRGB',
      bitsPerComponent: bitDepth, filter: '/FlateDecode',
      decodeParms: `/DecodeParms << /Predictor 15 /Colors ${colorType === 0 ? 1 : 3} /BitsPerComponent 8 /Columns ${width} >>`,
      bytes: idatBytes
    };
  }
  return { ok: false, code: 'image-format-unsupported', message: 'הטמעת PDF תומכת כרגע ב-JPEG וב-PNG אטום grayscale/RGB בלבד' };
}

/** **כותרת סימנייה עברית:** מחרוזת טקסט PDF לא־לטינית ⇒ UTF-16BE עם BOM
 * כמחרוזת הקסדצימלית (חוזה PDF 1.4 §3.8.4) — קוראים מציגים עברית תקינה. */
function pdfTitleHex(s) {
  let out = 'FEFF';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp > 0xFFFF) {
      const v = cp - 0x10000;
      const hi = 0xD800 + (v >> 10), lo = 0xDC00 + (v & 0x3FF);
      out += hi.toString(16).padStart(4, '0') + lo.toString(16).padStart(4, '0');
    } else {
      out += cp.toString(16).padStart(4, '0');
    }
  }
  return `<${out.toUpperCase()}>`;
}

/** **D-89 (דיווח משתמש: "כיוון הסוגריים בכל המופעים הפוך"):** חיקוי ה-bidi
 * של הדפדפן למילה עברית שמצוירת בסדר ויזואלי:
 *  - אותיות עברית/ניטרליים מהופכים (התו הלוגי הראשון בצד ימין) — כמו קודם;
 *  - ריצות ספרות/לטינית נשארות בסדר לוגי (קריאות שמאל→ימין). בלי זה מספר
 *    הטלפון 052-7666666 הוצג הפוך (6666667-250) — מדגם ה-CUTOVER, עמ' 2.
 *    פיסוק מספרי קצר (.,-+/:;%) בין שתי ריצות LTR נבלע לתוכן (1.5, 052-7666666);
 *    פיסוק עוקב/קודם (סוף משפט) נשאר בהקשר RTL — כמו UAX#9 בדפדפן.
 *  - סוגריים מכוונים בהקשר RTL משוקפים (Bidi Mirrored, UAX#9 §3.1.4):
 *    '(' לוגי מצויר כגליף ')' בקצה ימין של הרץ — "נפתח" כלפי כיוון הקריאה.
 *    סוגריים בתוך ריצת LTR (ספרות) אינם משוקפים.
 * המודול מיוצא לבדיקות (visualOrderRtl) — מקור יחיד לשני הצרכנים העתידיים. */
const LTR_RE = /[0-9A-Za-z]/;
const BRACKET_MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
// פיסוק ביניים (CS/ES — נבלע במספר רק **בין** שתי ריצות LTR: 052-7666666, 1.5)
const NUM_MID_GLUE = '.,-+/:;';
// פיסוק עוקב/קודם מסוג ET (W5 — נדבק למספר גם בקצה: 1.5%, $20)
const NUM_ET_GLUE = '%$#°₪';

function visualOrderRtl(chars) {
  // חלוקה לריצות LTR/שאר
  const runs = [];
  for (const ch of chars) {
    const l = LTR_RE.test(ch);
    if (runs.length && runs[runs.length - 1].ltr === l) runs[runs.length - 1].chars.push(ch);
    else runs.push({ ltr: l, chars: [ch] });
  }
  // בליעת פיסוק בין/בקצה ריצות LTR — חלק מהמספר (052-7666666, 1.5, 1.5%).
  // פיסוק ביניים נבלע רק כשריצת LTR באה אחריו; פיסוק ET נבלע גם בקצה (W5).
  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    const isMid = r.chars.length <= 3 && r.chars.every(c => NUM_MID_GLUE.includes(c));
    const isEt = r.chars.length <= 3 && r.chars.every(c => NUM_ET_GLUE.includes(c));
    if (!r.ltr && prev && prev.ltr && (isMid || isEt)) {
      prev._glue = (prev._glue || []).concat(r.chars); // עדיין לא ידוע אם תבוא LTR אחרי
      continue;
    }
    if (r.ltr && prev && prev._glue) { prev.chars.push(...prev._glue, ...r.chars); prev._glue = null; continue; }
    if (prev && prev._glue) {
      // לא באה LTR אחרי הפיסוק: ET נדבק למספר שלפניו (1.5%); ביניים — הקשר RTL (סוף משפט)
      if (prev._glue.every(c => NUM_ET_GLUE.includes(c))) { prev.chars.push(...prev._glue); }
      else merged.push({ ltr: false, chars: prev._glue });
      prev._glue = null;
    }
    merged.push({ ltr: r.ltr, chars: r.chars.slice() });
  }
  const tail = merged[merged.length - 1];
  if (tail && tail._glue) {
    if (tail._glue.every(c => NUM_ET_GLUE.includes(c))) { tail.chars.push(...tail._glue); }
    else merged.push({ ltr: false, chars: tail._glue }); // פיסוק עוקב בלי LTR אחריו — הקשר RTL
    tail._glue = null;
  }
  // סדר ויזואלי: היפוך סדר הריצות; RTL — היפוך פנימי + שיקוף סוגריים; LTR — כמו שהוא
  const out = [];
  for (let i = merged.length - 1; i >= 0; i--) {
    const r = merged[i];
    if (r.ltr) { out.push(...r.chars); continue; }
    for (let j = r.chars.length - 1; j >= 0; j--) out.push(BRACKET_MIRROR[r.chars[j]] || r.chars[j]);
  }
  return out;
}

/** מחרוזת CID הקסדצימלית לטקסט (Identity-H: 2 בתים לגליף).
 * **RTL:** PDF מתקדם ימינה מ־Td ברוחבים חיוביים; לכן התווים נפלטים בסדר
 * **ויזואלי** (חילוץ לוגי אחרון ראשון = השמאלי ביותר) — דרך visualOrderRtl
 * (D-89: ריצות LTR שלמות + שיקוף סוגריים) — המילה מרונדרת נכון לקורא עברי. */
function cidHex(text, font) {
  const chars = [...String(text)].filter(ch => {
    const cp = ch.codePointAt(0);
    return cp >= 0x20 && cp !== 0x7F;
  });
  let out = '';
  for (const ch of visualOrderRtl(chars)) {
    const g = font.cidOf(ch);
    if (g === 0) continue;
    out += g.toString(16).padStart(4, '0');
  }
  return out;
}

/** ToUnicode CMap — מיפוי gid → Unicode (חילוץ טקסט אמיתי ב־pdftotext). */
function buildToUnicode(font) {
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange'
  ];
  const entries = [];
  for (const [ch, gid] of font.charToGidEntries()) {
    if (gid === 0) continue;
    entries.push(`<${gid.toString(16).padStart(4, '0')}> <${ch.codePointAt(0).toString(16).padStart(4, '0')}>`);
  }
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`, ...chunk, 'endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return lines.join('\n');
}

/**
 * Convert the restricted absolute SVG outline emitted by the canonical
 * HarfBuzz DrawFuncs callbacks into PDF path operators. No font shaping or
 * glyph lookup happens here: these are the exact GID outlines in font units.
 */
function svgOutlineToPdfOps(pathData) {
  if (typeof pathData !== 'string' || pathData.length > 2 * 1024 * 1024) return null;
  if (!pathData.length) return [];
  const ops = [];
  let i = 0;
  let command = null;
  let x = 0, y = 0, sx = 0, sy = 0;
  const isDigit = (ch) => ch >= '0' && ch <= '9';
  const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
  const skipSeparators = () => {
    while (i < pathData.length && (isSpace(pathData[i]) || pathData[i] === ',')) i++;
  };
  const readNumber = () => {
    skipSeparators();
    const start = i;
    if (pathData[i] === '+' || pathData[i] === '-') i++;
    let integerDigits = 0;
    while (i < pathData.length && isDigit(pathData[i])) { integerDigits++; i++; }
    let fractionDigits = 0;
    if (pathData[i] === '.') {
      i++;
      while (i < pathData.length && isDigit(pathData[i])) { fractionDigits++; i++; }
    }
    if (integerDigits + fractionDigits === 0) throw new Error('outline-path-number-expected');
    if (pathData[i] === 'e' || pathData[i] === 'E') {
      i++;
      if (pathData[i] === '+' || pathData[i] === '-') i++;
      let exponentDigits = 0;
      while (i < pathData.length && isDigit(pathData[i])) { exponentDigits++; i++; }
      if (!exponentDigits) throw new Error('outline-path-invalid-exponent');
    }
    const value = Number(pathData.slice(start, i));
    if (!Number.isFinite(value)) throw new Error('outline-path-non-finite-number');
    return value;
  };
  try {
    while (i < pathData.length) {
      skipSeparators();
      if (i >= pathData.length) break;
      const ch = pathData[i];
      if (ch === 'M' || ch === 'L' || ch === 'Q' || ch === 'C' || ch === 'Z') {
        command = ch;
        i++;
      } else if (command == null) {
        return null;
      }
      if (command === 'Z') {
        ops.push('h');
        x = sx;
        y = sy;
        command = null;
        continue;
      }
      if (command === 'M') {
        x = readNumber();
        y = readNumber();
        sx = x;
        sy = y;
        ops.push(`${round2(x)} ${round2(y)} m`);
        command = 'L'; // further coordinate pairs after moveto are lineto
      } else if (command === 'L') {
        x = readNumber();
        y = readNumber();
        ops.push(`${round2(x)} ${round2(y)} l`);
      } else if (command === 'Q') {
        const cx = readNumber(), cy = readNumber();
        const ex = readNumber(), ey = readNumber();
        const c1x = x + (2 / 3) * (cx - x);
        const c1y = y + (2 / 3) * (cy - y);
        const c2x = ex + (2 / 3) * (cx - ex);
        const c2y = ey + (2 / 3) * (cy - ey);
        ops.push(`${round2(c1x)} ${round2(c1y)} ${round2(c2x)} ${round2(c2y)} ${round2(ex)} ${round2(ey)} c`);
        x = ex;
        y = ey;
      } else if (command === 'C') {
        const c1x = readNumber(), c1y = readNumber();
        const c2x = readNumber(), c2y = readNumber();
        const ex = readNumber(), ey = readNumber();
        ops.push(`${round2(c1x)} ${round2(c1y)} ${round2(c2x)} ${round2(c2y)} ${round2(ex)} ${round2(ey)} c`);
        x = ex;
        y = ey;
      } else {
        return null;
      }
    }
  } catch (_) {
    return null;
  }
  return ops.length ? ops : null;
}

function visualShapedRunOrder(entries) {
  const out = entries.slice();
  const levels = out.map(entry => {
    const level = entry.run && entry.run.shaping ? entry.run.shaping.bidiLevel : 0;
    return Number.isSafeInteger(level) ? level : 0;
  });
  const odd = levels.filter(level => level % 2 === 1);
  if (!odd.length) return out;
  const maxLevel = Math.max(...levels);
  const minOdd = Math.min(...odd);
  for (let level = maxLevel; level >= minOdd; level--) {
    let start = 0;
    while (start < out.length) {
      while (start < out.length && levels[start] < level) start++;
      if (start >= out.length) break;
      let end = start + 1;
      while (end < out.length && levels[end] >= level) end++;
      for (let left = start, right = end - 1; left < right; left++, right--) {
        [out[left], out[right]] = [out[right], out[left]];
        [levels[left], levels[right]] = [levels[right], levels[left]];
      }
      start = end;
    }
  }
  return out;
}

/** Vector-only PDF projection for a positioned PageModel word. */
function shapedWordPdfOps(word, xPx, baselinePx, sizePt, pageHeightPt) {
  const typography = word && word.typography;
  if (!typography || typography.contractVersion !== 'page-word-typography-v1' ||
      !Array.isArray(typography.segments) || !typography.segments.length ||
      !Number.isSafeInteger(typography.glyphCount) || typography.glyphCount <= 0 ||
      !Number.isFinite(word.w) || word.w < 0 ||
      !Number.isFinite(sizePt) || sizePt <= 0) {
    return { ok: false, error: 'invalid-page-word-typography' };
  }
  const sizePx = sizePt * (96 / 72);
  const entries = [];
  const naturalBySegment = new Map();
  let totalGlyphs = 0;
  for (const segment of typography.segments) {
    if (!segment || !Number.isFinite(segment.advancePx) || segment.advancePx < 0 ||
        !Array.isArray(segment.shapedRuns) || !segment.shapedRuns.length) {
      return { ok: false, error: 'invalid-page-word-shaping-segment' };
    }
    let naturalAdvancePx = 0;
    for (const run of segment.shapedRuns) {
      if (!run || run.kind !== 'ShapedRun' || run.contractVersion !== 'shaped-run-v1' ||
          !run.font || !Number.isSafeInteger(run.font.unitsPerEm) || run.font.unitsPerEm <= 0 ||
          !Array.isArray(run.glyphs) || !run.glyphs.length ||
          !run.advance || !Number.isFinite(run.advance.x)) {
        return { ok: false, error: 'invalid-page-word-shaped-run' };
      }
      let runAdvance = 0;
      for (const glyph of run.glyphs) {
        if (!glyph || !Number.isSafeInteger(glyph.gid) || glyph.gid <= 0 ||
            typeof glyph.outlinePath !== 'string' || glyph.outlinePath.length > 2 * 1024 * 1024 ||
            !Number.isFinite(glyph.xAdvance) || !Number.isFinite(glyph.yAdvance) ||
            !Number.isFinite(glyph.xOffset) || !Number.isFinite(glyph.yOffset)) {
          return { ok: false, error: 'shaped-glyph-outline-or-position-missing' };
        }
        if (Math.abs(glyph.yAdvance) > 1e-7) {
          return { ok: false, error: 'vertical-glyph-advance-not-supported' };
        }
        runAdvance += glyph.xAdvance;
      }
      if (!Number.isFinite(runAdvance) || runAdvance < 0 ||
          Math.abs(runAdvance - run.advance.x) > 1e-7) {
        return { ok: false, error: 'shaped-glyph-advance-mismatch' };
      }
      naturalAdvancePx += (runAdvance / run.font.unitsPerEm) * sizePx;
      entries.push({ run, segment });
      totalGlyphs += run.glyphs.length;
    }
    naturalBySegment.set(segment, naturalAdvancePx);
  }
  if (totalGlyphs !== typography.glyphCount) return { ok: false, error: 'page-word-glyph-count-mismatch' };
  const segmentScale = new Map();
  for (const segment of typography.segments) {
    const natural = naturalBySegment.get(segment);
    if (natural <= 0) {
      if (segment.advancePx > 0) return { ok: false, error: 'zero-shaped-segment-advance' };
      segmentScale.set(segment, 1);
    } else {
      segmentScale.set(segment, segment.advancePx / natural);
    }
  }
  const visual = visualShapedRunOrder(entries);
  const ops = [`/Span << /ActualText ${pdfTitleHex(word.text)} >> BDC`];
  let penPx = 0;
  let drawnGlyphs = 0;
  for (const entry of visual) {
    const run = entry.run;
    const direction = run.shaping && run.shaping.direction;
    if (direction !== 'rtl' && direction !== 'ltr') {
      return { ok: false, error: 'shaped-run-direction-invalid' };
    }
    const xScalePt = (sizePt / run.font.unitsPerEm) * segmentScale.get(entry.segment);
    const yScalePt = sizePt / run.font.unitsPerEm;
    const runAdvancePx = run.glyphs.reduce((sum, glyph) =>
      sum + glyph.xAdvance * sizePx / run.font.unitsPerEm * segmentScale.get(entry.segment), 0);
    if (!Number.isFinite(runAdvancePx) || runAdvancePx < 0) {
      return { ok: false, error: 'shaped-run-advance-invalid' };
    }
    // HarfBuzz returns visual glyph order within each ScriptRun. LTR runs
    // advance from their left edge; RTL runs begin at their right edge.
    let glyphPenPx = direction === 'rtl' ? penPx + runAdvancePx : penPx;
    for (const glyph of run.glyphs) {
      const glyphAdvancePx = glyph.xAdvance * sizePx / run.font.unitsPerEm * segmentScale.get(entry.segment);
      if (direction === 'rtl') glyphPenPx -= glyphAdvancePx;
      if (glyph.outlinePath.length) {
        const pathOps = svgOutlineToPdfOps(glyph.outlinePath);
        if (!pathOps || !pathOps.length) return { ok: false, error: 'invalid-native-glyph-outline-path' };
        const gxPt = xPx * PX_TO_PT + glyphPenPx * PX_TO_PT + glyph.xOffset * xScalePt;
        const gyPt = pageHeightPt - baselinePx * PX_TO_PT + glyph.yOffset * yScalePt;
        ops.push(`q ${pdfPrecise(xScalePt)} 0 0 ${pdfPrecise(yScalePt)} ${round2(gxPt)} ${round2(gyPt)} cm ${pathOps.join(' ')} f Q`);
        drawnGlyphs++;
      }
      if (direction === 'ltr') glyphPenPx += glyphAdvancePx;
    }
    penPx += runAdvancePx;
  }
  if (!drawnGlyphs) return { ok: false, error: 'page-word-has-no-visible-glyph-outline' };
  if (Math.abs(penPx - word.w) > Math.max(1.25, word.w * 0.015)) {
    return { ok: false, error: 'page-word-shaped-advance-does-not-match-positioned-width' };
  }
  ops.push('EMC');
  return { ok: true, ops, glyphCount: totalGlyphs, drawnGlyphs };
}

/**
 * כתיבת מסמך PDF שלם.
 * @param {object} opts
 * @param {Array} opts.pages — תוצר projectPage() לכל עמוד
 * @param {{w:number,h:number}} opts.pageSizeMm — גודל עמוד במ״מ (מרישום גדלי העמוד)
 * @param {object} opts.font — {subsetBytes, widthsUnits:Map(gid→units), unitsPerEm, cidOf:(ch)=>gid, charToGidEntries:()=>[ch,gid][]}
 * @param {object} [opts.font2] — **S4.15:** גופן משני (FrankReal-Bold — מילות-חלון):
 *   אותה צורה; מילים עם fontKey==='window' נציירות בו (/F2). בלעדיו — הכל ב-/F1.
 * @param {object} [opts.font5] — **S5.1:** גוף ההערה (Frank Ruhl Libre — fontKey
 *   'fnbody'): אותה צורה; /F5. בלעדיו — הערות ב-/F1 (התנהגות קודמת).
 * @param {object} [opts.font6] — **S5.1:** הערות-צד (Hadassah Friedlaender —
 *   fontKey 'margin'): אותה צורה; /F6. בלעדיו — הערות-צד ב-/F1.
 * @param {Array} [opts.extraFonts] — **S73 (תצוגה=ייצוא בגופנים):** גופנים
 *   דינמיים לפי משפחה — [{key, font, ascentEm?, descentEm?}]. מילה שה-fontKey
 *   שלה שווה ל-key מצוירת בגופן זה (/F7, /F8, … לפי הסדר). מיועד למשפחות
 *   הכותרות/השער/הכותרות-העליונות מההגדרות — כמו שה-DOM מציג. משפחה
 *   שלא סופקה כאן נופלת ל-/F1 (גוף הטקסט) — התנהגות קודמת.
 * @param {object} opts.settings — pdf-crop-marks, export-bleed-mm
 * @param {Array} [opts.outline] — [{title, page, level}] — סימניות מכותרות
 * @param {Array} [opts.tocLinks] — [{page, x, y, w, h, targetPage}] — קישורי TOC (px מהמקרן)
 * @returns {Buffer}
 */
function writePdf(opts) {
  const { pages, pageSizeMm, font, font2, font3, font4, font5, font6, settings, outline, tocLinks } = opts;
  const pdf = new PdfBuilder();

  const wPt = pageSizeMm.w * MM_TO_PT;
  const hPt = pageSizeMm.h * MM_TO_PT;
  const bleedPt = (Number(settings['export-bleed-mm']) || 0) * MM_TO_PT;
  const cropMarks = settings['pdf-crop-marks'] === true;
  const pageCount = pages.length;

  // ---- הקצאת מזהים דטרמיניסטית מראש ----
  // מפת מזהים קבוע: 1 קטלוג, 2 דפים, 3 Type0, 4 CIDFont, 5 FontDescriptor,
  // 6 FontFile2 (stream), 7 ToUnicode (stream), 8 Outlines; 9 שמור; 10+ דינמי.
  const ID = {
    catalog: 1, pages: 2, type0: 3, cidFont: 4, fontDescriptor: 5, fontFile: 6, toUnicode: 7, outlines: 8
  };
  pdf.nextId = 10;
  // **S4.15:** מזהי הגופן המשני (קבועים — דטרמיניזם): 9 היה שמור; 4 נוספים דינמיים
  // מיד אחריו, לפני הדפים — סדר קבוע לכל הרצות.
  if (font2) {
    ID.type0b = 9;
    ID.cidFontb = pdf.reserve();
    ID.fontDescriptorb = pdf.reserve();
    ID.fontFileb = pdf.reserve();
    ID.toUnicodeb = pdf.reserve();
  }
  // **S4.26:** מזהי הגופן השלישי (DavidLibre-Bold — כותרות) — אחרי אלו של
  // font2, סדר קבוע לפני הדפים (דטרמיניזם).
  if (font3) {
    ID.type0c = pdf.reserve();
    ID.cidFontc = pdf.reserve();
    ID.fontDescriptorc = pdf.reserve();
    ID.fontFilec = pdf.reserve();
    ID.toUnicodec = pdf.reserve();
  }
  // **S4.26:** מזהי הגופן הרביעי (Frank Ruhl Libre — fallback לפיסוק שחסר
  // בגוף הראשי, כמו מחסנית ה-CSS בדפדפן).
  if (font4) {
    ID.type0d = pdf.reserve();
    ID.cidFontd = pdf.reserve();
    ID.fontDescriptord = pdf.reserve();
    ID.fontFiled = pdf.reserve();
    ID.toUnicoded = pdf.reserve();
  }
  // **S5.1:** מזהי הגופן החמישי (Frank Ruhl Libre — גוף ההערה, /F5) והשישי
  // (Hadassah Friedlaender — הערות-צד, /F6) — אותו סדר קבוע (דטרמיניזם).
  if (font5) {
    ID.type0e = pdf.reserve();
    ID.cidFonte = pdf.reserve();
    ID.fontDescriptore = pdf.reserve();
    ID.fontFilee = pdf.reserve();
    ID.toUnicodee = pdf.reserve();
  }
  if (font6) {
    ID.type0f = pdf.reserve();
    ID.cidFontf = pdf.reserve();
    ID.fontDescriptorf = pdf.reserve();
    ID.fontFilef = pdf.reserve();
    ID.toUnicodef = pdf.reserve();
  }
  // **S73 (גופנים דינמיים — תצוגה=ייצוא):** משפחות נוספות (כותרות/שער/כותרות
  // עליונות מההגדרות). מזהים דטרמיניסטיים — 5 ברצף לכל גופן, בסדר המערך
  // שנקבע מראש ב-export-api (מיון לפי key) — ייצוא כפול ⇒ בתים זהים.
  const extraFonts = [];
  for (const ef of (opts.extraFonts || [])) {
    if (!ef || !ef.font) continue;
    extraFonts.push({
      key: String(ef.key),
      font: ef.font,
      ascentEm: Number.isFinite(ef.ascentEm) ? ef.ascentEm : 0.8,
      descentEm: Number.isFinite(ef.descentEm) ? ef.descentEm : 0.2,
      ids: { type0: pdf.reserve(), cidFont: pdf.reserve(), fontDescriptor: pdf.reserve(), fontFile: pdf.reserve(), toUnicode: pdf.reserve() }
    });
  }
  /** מפת key → {font, name} לציור מיידי ב-emitWord (נתיב יחיד). */
  const extraByKeys = new Map(extraFonts.map((ef, i) => [ef.key, { font: ef.font, name: `F${7 + i}` }]));

  // תמונות הן משאבי PDF נפרדים עם זהות תוכן יציבה. סדר המזהים נקבע לפי
  // assetId, ולא לפי סדר הגעת הבתים, לשמירת דטרמיניזם בייצוא כפול.
  const imageByAssetId = new Map();
  const imageObjects = [];
  const imageAssets = [...(opts.imageAssets || [])]
    .filter(item => item && item.assetId != null)
    .slice()
    .sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)));
  for (const item of imageAssets) {
    const key = String(item.assetId);
    if (imageByAssetId.has(key)) continue;
    const parsed = parsePdfImageAsset(item);
    if (!parsed.ok) {
      throw new Error('pdf-image-unsupported:' + key + ':' + parsed.code +
        (parsed.message ? ':' + parsed.message : ''));
    }
    const record = {
      assetId: key,
      name: `Im${imageObjects.length + 1}`,
      objectId: pdf.reserve(),
      ...(parsed.smask ? { smaskObjectId: pdf.reserve() } : {}),
      ...parsed
    };
    imageByAssetId.set(key, record);
    imageObjects.push(record);
  }

  const pageIds = pages.map(() => pdf.reserve());
  const contentIds = pages.map(() => pdf.reserve());
  const linkIds = new Map(); // pageIndex → [ids]
  for (const link of tocLinks || []) {
    if (!linkIds.has(link.page)) linkIds.set(link.page, []);
    linkIds.get(link.page).push(pdf.reserve());
  }
  const outlineItems = (outline || []).map(o => ({ ...o, id: pdf.reserve() }));

  // ---- עץ הסימניות: היררכיה לפי level ----
  const stack = [];
  const roots = [];
  for (const it of outlineItems) {
    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
    it.parent = stack.length ? stack[stack.length - 1] : null;
    it.children = [];
    if (!it.parent) roots.push(it); else it.parent.children.push(it);
    stack.push(it);
  }
  const flatOrder = [];
  const walk = (list) => { for (const x of list) { flatOrder.push(x); walk(x.children); } };
  walk(roots);
  for (const list of [roots, ...flatOrder.filter(f => f.children.length).map(f => f.children)]) {
    for (let i = 0; i < list.length; i++) { list[i].prev = list[i - 1] || null; list[i].next = list[i + 1] || null; }
  }

  // ---- תוכן לכל עמוד (content streams) ----
  const contents = pages.map((pg) => {
    const ops = [];
    // **S6.0 (R5-M2 — צבע דביק):** מצב מילוי נוכחי לכל אורך מסלול התוכן
    // של העמוד. בעבר 'rg' נפלט רק למילים צבועות ולא אופס לעולם ⇒ מילה
    // צבועה (הערת-שוליים אפורה) צבעה את כל הטקסט שאחריה בעמוד — הערות
    // שוליים, גיליון וכותרות (נמדד: #404040 מדביק עד סוף העמוד).
    let fillState = '0 0 0';
    const emitFill = (color) => {
      if (Array.isArray(color) && color.length === 3) {
        const cs = `${round2(color[0])} ${round2(color[1])} ${round2(color[2])} rg`;
        if (cs !== fillState) { ops.push(cs); fillState = cs; }
      } else if (fillState !== '0 0 0') {
        ops.push('0 0 0 rg'); fillState = '0 0 0';
      }
    };
    // **D-89 (צבע פר-מילה):** rgb 0..1 על המילה (כותרת עליונה בכחול-הייחוס
    // #0F1749, בלוקי השער האחורי) — ברירת מחדל שחור (0 0 0 rg מרומז ב-PDF).
    const emitWord = (text, xPx, yPx, sizePt, fontKey, color, modelWord = null) => {
      // Shaped words are emitted from their exact HarfBuzz GID outlines.
      // ActualText preserves extraction/copy; no second bidi or font shaping.
      if (modelWord && modelWord.typography) {
        const shaped = shapedWordPdfOps(modelWord, xPx, yPx, sizePt, hPt);
        if (!shaped.ok) throw new Error('pdf-glyph-outline:' + shaped.error);
        emitFill(color);
        ops.push(...shaped.ops);
        return;
      }
      // **S4.15:** מילת-חלון בגופן המשני (FrankReal-Bold) — כמו המקור;
      // **S4.26:** כותרות בגופן השלישי (DavidLibre-Bold — כמו הייחוס);
      // **S4.26 (פיצול גליפים):** תווים שחסרים בגוף הראשי (פיסוק בסיסי
      // בגוטמן רש"י: ' . ׳) מצוירים בגופן ה-fallback (/F4) — המשך אותה
      // פעולת טקסט, העט ממשיך מאליו אחרי כל Tj.
      // **S5.1 (תיקון C4 + הרחבת ה-fallback לכל הגופנים):** הרשת כעת
      // פר-תו לכל גופן (F1..F6): תו שחסר בגופן המילה נופל לגוף הטקסט (/F1)
      // ורק אז ל-/F4. בעבר תו חסר ב-/F2 או //F3 הושמט בשקט מה-PDF
      // (הדפדפן הציג אותו — תצוגה ≠ ייצוא). פורמט ה-bytes של המקרים
      // הקיימים נשמר בדיוק (מסלול יחיד = המסלול הפשוט הקודם;
      // מסלול מרובה = פורמט ה-F4 הקודם).
      // **S73 (תצוגה=ייצוא בגופנים):** משפחה דינמית — ה-fontKey של המילה הוא
      // שם המשפחה מההגדרות (למשל 'Lia Sgula' בכותרת השער); היא נמדדת
      // באותו גופן במקרן ומצוירת כאן בתת-הגופן הייעודי (/F7…) — כמו ה-DOM.
      // משפחה שלא סופקה ⇒ המשך לשרשרת הקיימת (window/heading/fnbody/margin/F1).
      const ex = fontKey != null ? extraByKeys.get(fontKey) : null;
      const useF2 = !ex && font2 && fontKey === 'window';
      const useF3 = !ex && font3 && fontKey === 'heading';
      const useF5 = !ex && font5 && fontKey === 'fnbody';
      const useF6 = !ex && font6 && fontKey === 'margin';
      const f = ex ? ex.font : (useF2 ? font2 : (useF3 ? font3 : (useF5 ? font5 : (useF6 ? font6 : font))));
      const fName = ex ? ex.name : (useF2 ? 'F2' : (useF3 ? 'F3' : (useF5 ? 'F5' : (useF6 ? 'F6' : 'F1'))));
      const chars = [...String(text)].filter(ch => {
        const cp = ch.codePointAt(0);
        return cp >= 0x20 && cp !== 0x7F;
      // **S6.0 (R7-M3 — NBSP נעלם ב-PDF):** גופני Frank אינם ממפים U+00A0
      // ⇒ התו הושמט בשקט מהייצוא והמילים הודבקו. כעת NBSP ממופה לרווח
      // רגיל (הדפדפן מציג רווח — עתה גם ה-PDF).
      }).map(ch => (ch === '\u00A0' ? ' ' : ch));
      const visual = visualOrderRtl(chars);
      if (!visual.length) return;
      // ריצות פר-תו: הגופן הראשי של המילה; חסר ⇒ /F1 (גוף); חסר גם שם
      // וקיים ב-/F4 ⇒ /F4. תו שאינו בשום גופן מושמט (כמו קודם — tofu).
      const runs = [];
      for (const ch of visual) {
        let rn = fName, rf = f;
        if (f.cidOf(ch) === 0) {
          if (font.cidOf(ch) !== 0) { rn = 'F1'; rf = font; }
          else if (font4 && font4.cidOf(ch) !== 0) { rn = 'F4'; rf = font4; }
          else continue;
        }
        if (runs.length && runs[runs.length - 1].name === rn) runs[runs.length - 1].chars.push(ch);
        else runs.push({ name: rn, font: rf, chars: [ch] });
      }
      if (!runs.length) return;
      // **S6.0 (R5-M2):** הצבע נפלט פעם אחת לפני המסלולים — עם איפוס
      // מפורש כשהמילה אינה צבועה והקודם היה צבוע (בעבר: הצבע נדבק).
      emitFill(color);
      if (runs.length === 1) {
        // מסלוק יחיד — פורמט ה-bytes של המסלול הפשוט הקודם (ללא שינוי)
        let out = '';
        for (const ch of runs[0].chars) {
          const g = runs[0].font.cidOf(ch);
          if (g) out += g.toString(16).padStart(4, '0');
        }
        if (!out) return;
        ops.push(`BT /${runs[0].name} ${round2(sizePt)} Tf ${round2(xPx * PX_TO_PT)} ${round2(hPt - yPx * PX_TO_PT)} Td <${out}> Tj ET`);
        return;
      }
      // מסלוק מרובה — פורמט ה-F4 הקודם (BT x y Td; פר-ריצה /Fn sz Tf <hex> Tj; ET)
      ops.push(`BT ${round2(xPx * PX_TO_PT)} ${round2(hPt - yPx * PX_TO_PT)} Td`);
      for (const run of runs) {
        let hex = '';
        for (const ch of run.chars) {
          const g = run.font.cidOf(ch);
          if (g) hex += g.toString(16).padStart(4, '0');
        }
        if (hex) ops.push(`/${run.name} ${round2(sizePt)} Tf <${hex}> Tj`);
      }
      ops.push('ET');
    };
    const emitLines = (lines) => {
      for (const ln of lines) {
        // **S12 (parity):** בסיס השורה מהמקרן (מודל תיבת שורה CSS — half-leading+ascent)
        const baselineY = ln.baselineY != null ? ln.baselineY : ln.y + ln.h - ln.sizePt * (96 / 72) * 0.78;
        // **S4.9 (legacy IMUD):** מילים עם גודל/בסיס משלהן (מילת-חלון 1.5×, סמני הערות)
        for (const w of ln.words) emitWord(w.text, w.x, w.baselineY != null ? w.baselineY : baselineY, w.sizePt || ln.sizePt, w.fontKey, w.color, w);
      }
    };
    if (pg.spanning) emitLines(pg.spanning.lines);
    emitLines(pg.lines);
    // תמונות מוצבות רק לפי x/y/w/h הסופיים מה-PageModel. אין מדידה,
    // fit או חישוב מיקום חדש בכותב; אותו XObject יכול לשרת כמה עמודים.
    for (const image of (pg.images || [])) {
      const record = image && imageByAssetId.get(String(image.assetId));
      if (!record) throw new Error('pdf-image-resource-missing:' + (image && image.assetId));
      const values = [image.x, image.y, image.w, image.h].map(Number);
      if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) {
        throw new Error('pdf-image-geometry-invalid:' + record.assetId);
      }
      const x = values[0] * PX_TO_PT;
      const y = hPt - (values[1] + values[3]) * PX_TO_PT;
      const width = values[2] * PX_TO_PT;
      const height = values[3] * PX_TO_PT;
      ops.push(`q ${pdfPrecise(width)} 0 0 ${pdfPrecise(height)} ${pdfPrecise(x)} ${pdfPrecise(y)} cm /${record.name} Do Q`);
    }
    // מרזב הערות — סמן + מילות ההערה (מימין לשמאל); בסיס מהמקרן
    for (const fn of pg.footnotes) {
      if (fn.words && fn.words.length) {
        // **D-89 (דיווח משתמש: "בהערות השוליים יש מילים אחת על השניה"):**
        // בסיס פר-מילה מהמקרן (פר-שורה) — בעבר baselineY אחד לכל ההערה
        // וכל שורות הערה רבת-שורות נערמו זו על זו.
        for (const w of fn.words) emitWord(w.text, w.x, w.baselineY != null ? w.baselineY : fn.baselineY, w.sizePt || 8.5, w.fontKey, w.color, w);
        continue;
      }
      const fs = 11;
      const baseY = fn.baselineY != null ? fn.baselineY : fn.y + 9;
      let x = fn.x + fn.w - 4;
      // **S73:** צבע סמן ההערה — כצבע גוף ההערה מההגדרות (ברירת מחדל שחור)
      if (fn.marker) { emitWord(fn.marker, x - 14, baseY, fs, null, fn.color); x -= 18; }
      let cx = x;
      for (const w of fn.text.split(/\s+/).filter(Boolean)) {
        cx -= 8.2;
        emitWord(w, cx, baseY, fs);
      }
    }
    // גיליון — מקור יחיד (D-81): מיקום/רוחב מהקרן; נפילה לנוסחה הישנה רק אם חסר
    // **S73:** גופן/צבע הגיליון מההגדרות (page-num-font/page-num-color) —
    // כמו ה-DOM; fontKey של משפחה רשומה מצויר בגופן שלה, אחרת גוף הטקסט.
    if (pg.folio && pg.folio.text) {
      const fw = pg.folio.w != null ? pg.folio.w : pg.folio.text.length * 6;
      const fx = pg.folio.x != null ? pg.folio.x : pg.width / 2 - fw / 2;
      const fy = pg.folio.baselineY != null ? pg.folio.baselineY : pg.folio.y + 10;
      emitWord(pg.folio.text, fx, fy, pg.folio.sizePt || 10, pg.folio.fontKey || null, pg.folio.color);
    }
    // כותרת עליונה — סלוטים לפי מיקום פיזי מהקרן (D-81); נפילה מתועדת לנוסחה הישנה
    if (pg.header) {
      for (const s of pg.header.slots) {
        const sw = s.w != null ? s.w : s.text.length * 5.5;
        const x = s.x != null ? s.x : (s.pos === 'right' ? pg.width - 60 - sw : s.pos === 'center' ? (pg.width - sw) / 2 : 60);
        const y = pg.header.baselineY != null ? pg.header.baselineY : pg.header.y + 10;
        // **D-89:** סלוט legacy עם מילים ממוקמות מהמקרן — בסיס/צבע פר-מילה;
        // נפילה לנוסחה הישנה רק כשאין מילים (נתיב DP).
        if (s.words && s.words.length) {
          for (const w of s.words) emitWord(w.text, w.x, w.baselineY != null ? w.baselineY : y, w.sizePt || s.sizePt || 9, w.fontKey, w.color, w);
          continue;
        }
        // **Iteration-003 (תצוגה=ייצוא):** הסלוט המוטבע נושא fontKey (גופן
        // הסלוט מההגדרות — Livorna בייחוס) — עד כאן null קבוע ⇒ /F1 (גוף).
        emitWord(s.text, x, y, s.sizePt || 9, s.fontKey || null, s.color);
      }
    }
    // **EXT-4 (ציור עיטורים):** פעולות הציור מגיעות מוכנות מהפרויקטור
    // (d.pdfOps — פוענחו שם מה-SVG במקור היחיד ornament-ink; הכותב עצמו
    // חף-תלויות ואוסף אובייקטים בלבד). תמונות רסטר אינן מצוירות כאן (מתועד).
    if (pg.decorations && pg.decorations.length) {
      for (const d of pg.decorations) {
        if (Array.isArray(d.pdfOps)) ops.push(...d.pdfOps);
      }
    }
    // סימני חיתוך (**S6.0 R5-M6** — בחוץ ל-TrimBox, כמו המסמך; בעבר צוירו
    // בפנים על העמוד החתוך עצמו): זוג קווים בכל פינה, מוסטים 0.5מ״מ משפת
    // החיתוך, באורך 5מ״מ — בתוך טבעת הבליד/ההרחבה של ה-MediaBox.
    if (cropMarks) {
      const g = 0.5 * MM_TO_PT, L = 5 * MM_TO_PT;
      const xl0 = -(g + L), xl1 = -g, xr0 = wPt + g, xr1 = wPt + g + L;
      const yb0 = -(g + L), yb1 = -g, yt0 = hPt + g, yt1 = hPt + g + L;
      ops.push('0.6 w 0 G');
      ops.push(`${round2(xl0)} 0 m ${round2(xl1)} 0 l S`);
      ops.push(`0 ${round2(yb0)} m 0 ${round2(yb1)} l S`);
      ops.push(`${round2(xr0)} 0 m ${round2(xr1)} 0 l S`);
      ops.push(`${round2(wPt)} ${round2(yb0)} m ${round2(wPt)} ${round2(yb1)} l S`);
      ops.push(`${round2(xl0)} ${round2(hPt)} m ${round2(xl1)} ${round2(hPt)} l S`);
      ops.push(`0 ${round2(yt0)} m 0 ${round2(yt1)} l S`);
      ops.push(`${round2(xr0)} ${round2(hPt)} m ${round2(xr1)} ${round2(hPt)} l S`);
      ops.push(`${round2(wPt)} ${round2(yt0)} m ${round2(wPt)} ${round2(yt1)} l S`);
    }
    return Buffer.from(ops.join('\n'), 'latin1');
  });

  // ---- הרכבה: קטלוג, דפים, גופן ----
  const catalogKids = pageIds.map(id => `${id} 0 R`).join(' ');
  const outlinesRef = (outlineItems.length) ? ` /Outlines ${ID.outlines} 0 R /PageMode /UseOutlines` : '';
  pdf.put(ID.catalog, `<< /Type /Catalog /Pages ${ID.pages} 0 R${outlinesRef} >>`);
  pdf.put(ID.pages, `<< /Type /Pages /Count ${pageCount} /Kids [${catalogKids}] >>`);

  // W: לפי חוזה PDF — צורה 1: `c [w1 w2 … wn]` (רצף רוחבים בסוגריים); יחידות פר 1000
  const wArray = [];
  let run = null;
  let prevGid = -10;
  for (const g of [...font.widthsUnits.keys()].sort((a, b) => a - b)) {
    const wv = Math.round((font.widthsUnits.get(g) / font.unitsPerEm) * 1000);
    if (g === prevGid + 1 && run) run.push(wv);
    else { if (run) wArray.push(run); run = [g, wv]; }
    prevGid = g;
  }
  if (run) wArray.push(run);
  const wStr = wArray.map(r => `${r[0]} [${r.slice(1).join(' ')}]`).join(' ');

  pdf.put(ID.type0, `<< /Type /Font /Subtype /Type0 /BaseFont /ToraBook /Encoding /Identity-H /DescendantFonts [${ID.cidFont} 0 R] /ToUnicode ${ID.toUnicode} 0 R >>`);
  pdf.put(ID.cidFont, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ToraBook /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ID.fontDescriptor} 0 R /DW 1000 /W [${wStr}] >>`);
  pdf.put(ID.fontDescriptor, `<< /Type /FontDescriptor /FontName /ToraBook /Flags 4 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${ID.fontFile} 0 R >>`);
  const ffStream = Buffer.concat([
    Buffer.from(`<< /Length ${font.subsetBytes.length} /Length1 ${font.subsetBytes.length} >>\nstream\n`, 'latin1'),
    font.subsetBytes,
    Buffer.from('\nendstream', 'latin1')
  ]);
  pdf.put(ID.fontFile, ffStream); // 5
  const toUni = buildToUnicode(font);
  pdf.put(ID.toUnicode, `<< /Length ${toUni.length} >>\nstream\n${toUni}\nendstream`); // 6

  // **S4.15:** הגופן המשני (FrankReal-Bold — מילות-חלון) — אותם אובייקטים בשמות שונים
  if (font2) {
    const wArray2 = [];
    let run2 = null;
    let prevGid2 = -10;
    for (const g of [...font2.widthsUnits.keys()].sort((a, b) => a - b)) {
      const wv = Math.round((font2.widthsUnits.get(g) / font2.unitsPerEm) * 1000);
      if (g === prevGid2 + 1 && run2) run2.push(wv);
      else { if (run2) wArray2.push(run2); run2 = [g, wv]; }
      prevGid2 = g;
    }
    if (run2) wArray2.push(run2);
    const wStr2 = wArray2.map(r => `${r[0]} [${r.slice(1).join(' ')}]`).join(' ');
    pdf.put(ID.type0b, `<< /Type /Font /Subtype /Type0 /BaseFont /ToraWin /Encoding /Identity-H /DescendantFonts [${ID.cidFontb} 0 R] /ToUnicode ${ID.toUnicodeb} 0 R >>`);
    pdf.put(ID.cidFontb, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ToraWin /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ID.fontDescriptorb} 0 R /DW 1000 /W [${wStr2}] >>`);
    pdf.put(ID.fontDescriptorb, `<< /Type /FontDescriptor /FontName /ToraWin /Flags 4 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 751 /Descent -135 /CapHeight 700 /StemV 120 /FontFile2 ${ID.fontFileb} 0 R >>`);
    const ff2 = Buffer.concat([
      Buffer.from(`<< /Length ${font2.subsetBytes.length} /Length1 ${font2.subsetBytes.length} >>\nstream\n`, 'latin1'),
      font2.subsetBytes,
      Buffer.from('\nendstream', 'latin1')
    ]);
    pdf.put(ID.fontFileb, ff2);
    const toUni2 = buildToUnicode(font2);
    pdf.put(ID.toUnicodeb, `<< /Length ${toUni2.length} >>\nstream\n${toUni2}\nendstream`);
  }

  // **S4.26:** הגופן הרביעי (Frank Ruhl Libre — fallback לפיסוק) — אותם
  // אובייקטים בשמות שונים (מטריקות: asc 1000/1000, desc −200/1000).
  if (font4) {
    const wArray4 = [];
    let run4 = null;
    let prevGid4 = -10;
    for (const g of [...font4.widthsUnits.keys()].sort((a, b) => a - b)) {
      const wv = Math.round((font4.widthsUnits.get(g) / font4.unitsPerEm) * 1000);
      if (g === prevGid4 + 1 && run4) run4.push(wv);
      else { if (run4) wArray4.push(run4); run4 = [g, wv]; }
      prevGid4 = g;
    }
    if (run4) wArray4.push(run4);
    const wStr4 = wArray4.map(r => `${r[0]} [${r.slice(1).join(' ')}]`).join(' ');
    pdf.put(ID.type0d, `<< /Type /Font /Subtype /Type0 /BaseFont /ToraPunct /Encoding /Identity-H /DescendantFonts [${ID.cidFontd} 0 R] /ToUnicode ${ID.toUnicoded} 0 R >>`);
    pdf.put(ID.cidFontd, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ToraPunct /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ID.fontDescriptord} 0 R /DW 1000 /W [${wStr4}] >>`);
    pdf.put(ID.fontDescriptord, `<< /Type /FontDescriptor /FontName /ToraPunct /Flags 4 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 1000 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${ID.fontFiled} 0 R >>`);
    const ff4 = Buffer.concat([
      Buffer.from(`<< /Length ${font4.subsetBytes.length} /Length1 ${font4.subsetBytes.length} >>\nstream\n`, 'latin1'),
      font4.subsetBytes,
      Buffer.from('\nendstream', 'latin1')
    ]);
    pdf.put(ID.fontFiled, ff4);
    const toUni4 = buildToUnicode(font4);
    pdf.put(ID.toUnicoded, `<< /Length ${toUni4.length} >>\nstream\n${toUni4}\nendstream`);
  }

  // **S4.26:** הגופן השלישי (DavidLibre-Bold — כותרות/TOC) — אותם אובייקטים
  // בשמות שונים (מטריקות אמת: ascender 1599/2048=781, descender −449/2048=−219).
  if (font3) {
    const wArray3 = [];
    let run3 = null;
    let prevGid3 = -10;
    for (const g of [...font3.widthsUnits.keys()].sort((a, b) => a - b)) {
      const wv = Math.round((font3.widthsUnits.get(g) / font3.unitsPerEm) * 1000);
      if (g === prevGid3 + 1 && run3) run3.push(wv);
      else { if (run3) wArray3.push(run3); run3 = [g, wv]; }
      prevGid3 = g;
    }
    if (run3) wArray3.push(run3);
    const wStr3 = wArray3.map(r => `${r[0]} [${r.slice(1).join(' ')}]`).join(' ');
    pdf.put(ID.type0c, `<< /Type /Font /Subtype /Type0 /BaseFont /ToraHead /Encoding /Identity-H /DescendantFonts [${ID.cidFontc} 0 R] /ToUnicode ${ID.toUnicodec} 0 R >>`);
    pdf.put(ID.cidFontc, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ToraHead /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ID.fontDescriptorc} 0 R /DW 1000 /W [${wStr3}] >>`);
    pdf.put(ID.fontDescriptorc, `<< /Type /FontDescriptor /FontName /ToraHead /Flags 4 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 781 /Descent -219 /CapHeight 700 /StemV 120 /FontFile2 ${ID.fontFilec} 0 R >>`);
    const ff3 = Buffer.concat([
      Buffer.from(`<< /Length ${font3.subsetBytes.length} /Length1 ${font3.subsetBytes.length} >>\nstream\n`, 'latin1'),
      font3.subsetBytes,
      Buffer.from('\nendstream', 'latin1')
    ]);
    pdf.put(ID.fontFilec, ff3);
    const toUni3 = buildToUnicode(font3);
    pdf.put(ID.toUnicodec, `<< /Length ${toUni3.length} >>\nstream\n${toUni3}\nendstream`);
  }

  // **S5.1:** הגופן החמישי (Frank Ruhl Libre — גוף ההערה, /F5) — אותם
  // אובייקטים בשמות שונים. מטריקות: asc 1000/1000, desc −200/1000 (כמו /F4,
  // אותו גופן קובץ).
  if (font5) {
    const wArray5 = [];
    let run5 = null;
    let prevGid5 = -10;
    for (const g of [...font5.widthsUnits.keys()].sort((a, b) => a - b)) {
      const wv = Math.round((font5.widthsUnits.get(g) / font5.unitsPerEm) * 1000);
      if (g === prevGid5 + 1 && run5) run5.push(wv);
      else { if (run5) wArray5.push(run5); run5 = [g, wv]; }
      prevGid5 = g;
    }
    if (run5) wArray5.push(run5);
    const wStr5 = wArray5.map(r => `${r[0]} [${r.slice(1).join(' ')}]`).join(' ');
    pdf.put(ID.type0e, `<< /Type /Font /Subtype /Type0 /BaseFont /ToraFn /Encoding /Identity-H /DescendantFonts [${ID.cidFonte} 0 R] /ToUnicode ${ID.toUnicodee} 0 R >>`);
    pdf.put(ID.cidFonte, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ToraFn /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ID.fontDescriptore} 0 R /DW 1000 /W [${wStr5}] >>`);
    pdf.put(ID.fontDescriptore, `<< /Type /FontDescriptor /FontName /ToraFn /Flags 4 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 1000 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${ID.fontFilee} 0 R >>`);
    const ff5 = Buffer.concat([
      Buffer.from(`<< /Length ${font5.subsetBytes.length} /Length1 ${font5.subsetBytes.length} >>\nstream\n`, 'latin1'),
      font5.subsetBytes,
      Buffer.from('\nendstream', 'latin1')
    ]);
    pdf.put(ID.fontFilee, ff5);
    const toUni5 = buildToUnicode(font5);
    pdf.put(ID.toUnicodee, `<< /Length ${toUni5.length} >>\nstream\n${toUni5}\nendstream`);
  }

  // **S5.1:** הגופן השישי (Hadassah Friedlaender — הערות-צד, /F6).
  if (font6) {
    const wArray6 = [];
    let run6 = null;
    let prevGid6 = -10;
    for (const g of [...font6.widthsUnits.keys()].sort((a, b) => a - b)) {
      const wv = Math.round((font6.widthsUnits.get(g) / font6.unitsPerEm) * 1000);
      if (g === prevGid6 + 1 && run6) run6.push(wv);
      else { if (run6) wArray6.push(run6); run6 = [g, wv]; }
      prevGid6 = g;
    }
    if (run6) wArray6.push(run6);
    const wStr6 = wArray6.map(r => `${r[0]} [${r.slice(1).join(' ')}]`).join(' ');
    pdf.put(ID.type0f, `<< /Type /Font /Subtype /Type0 /BaseFont /ToraMargin /Encoding /Identity-H /DescendantFonts [${ID.cidFontf} 0 R] /ToUnicode ${ID.toUnicodef} 0 R >>`);
    pdf.put(ID.cidFontf, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ToraMargin /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ID.fontDescriptorf} 0 R /DW 1000 /W [${wStr6}] >>`);
    pdf.put(ID.fontDescriptorf, `<< /Type /FontDescriptor /FontName /ToraMargin /Flags 4 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${ID.fontFilef} 0 R >>`);
    const ff6 = Buffer.concat([
      Buffer.from(`<< /Length ${font6.subsetBytes.length} /Length1 ${font6.subsetBytes.length} >>\nstream\n`, 'latin1'),
      font6.subsetBytes,
      Buffer.from('\nendstream', 'latin1')
    ]);
    pdf.put(ID.fontFilef, ff6);
    const toUni6 = buildToUnicode(font6);
    pdf.put(ID.toUnicodef, `<< /Length ${toUni6.length} >>\nstream\n${toUni6}\nendstream`);
  }

  // **S73 (גופנים דינמיים):** כתיבת אובייקטי המשפחות הנוספות — אותם חמישה
  // אובייקטים כמו שאר הגופנים (Type0/CIDFontType2/FontDescriptor/FontFile2/
  // ToUnicode). שם ה-BaseFont נגזר מהאינדקס (ToraEx1, ToraEx2, …) — שמות
  // משפחה עלולים להכיל רווחים/תווים בלתי-חוקיים בשם PDF. מטריקות ה-Ascent/
  // Descent מפרופיל הגופן הרשום (נפילה 800/−200 — כמו הגוף).
  extraFonts.forEach((ef, i) => {
    const wArrE = [];
    let runE = null;
    let prevGidE = -10;
    for (const g of [...ef.font.widthsUnits.keys()].sort((a, b) => a - b)) {
      const wv = Math.round((ef.font.widthsUnits.get(g) / ef.font.unitsPerEm) * 1000);
      if (g === prevGidE + 1 && runE) runE.push(wv);
      else { if (runE) wArrE.push(runE); runE = [g, wv]; }
      prevGidE = g;
    }
    if (runE) wArrE.push(runE);
    const wStrE = wArrE.map(r => `${r[0]} [${r.slice(1).join(' ')}]`).join(' ');
    const baseName = `ToraEx${i + 1}`;
    const ascE = Math.round(ef.ascentEm * 1000);
    const descE = -Math.round(Math.abs(ef.descentEm) * 1000);
    pdf.put(ef.ids.type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${baseName} /Encoding /Identity-H /DescendantFonts [${ef.ids.cidFont} 0 R] /ToUnicode ${ef.ids.toUnicode} 0 R >>`);
    pdf.put(ef.ids.cidFont, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ef.ids.fontDescriptor} 0 R /DW 1000 /W [${wStrE}] >>`);
    pdf.put(ef.ids.fontDescriptor, `<< /Type /FontDescriptor /FontName /${baseName} /Flags 4 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent ${ascE} /Descent ${descE} /CapHeight ${Math.round(ef.ascentEm * 700)} /StemV 80 /FontFile2 ${ef.ids.fontFile} 0 R >>`);
    const ffE = Buffer.concat([
      Buffer.from(`<< /Length ${ef.font.subsetBytes.length} /Length1 ${ef.font.subsetBytes.length} >>\nstream\n`, 'latin1'),
      ef.font.subsetBytes,
      Buffer.from('\nendstream', 'latin1')
    ]);
    pdf.put(ef.ids.fontFile, ffE);
    const toUniE = buildToUnicode(ef.font);
    pdf.put(ef.ids.toUnicode, `<< /Length ${toUniE.length} >>\nstream\n${toUniE}\nendstream`);
  });

  // ---- תמונות: Image XObjects + stream bytes ----
  for (const image of imageObjects) {
    const decodeParms = image.decodeParms ? ' ' + image.decodeParms : '';
    const smaskRef = image.smask ? ` /SMask ${image.smaskObjectId} 0 R` : '';
    const dictionary = `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.colorSpace} /BitsPerComponent ${image.bitsPerComponent} /Filter ${image.filter}${decodeParms}${smaskRef} /Length ${image.bytes.length} >>`;
    pdf.put(image.objectId, Buffer.concat([
      Buffer.from(dictionary + '\nstream\n', 'latin1'),
      image.bytes,
      Buffer.from('\nendstream', 'latin1')
    ]));
    if (image.smask) {
      const mask = image.smask;
      const maskParams = mask.decodeParms ? ' ' + mask.decodeParms : '';
      const maskDictionary = `<< /Type /XObject /Subtype /Image /Width ${mask.width} /Height ${mask.height} /ColorSpace ${mask.colorSpace} /BitsPerComponent ${mask.bitsPerComponent} /Filter ${mask.filter}${maskParams} /Length ${mask.bytes.length} >>`;
      pdf.put(image.smaskObjectId, Buffer.concat([
        Buffer.from(maskDictionary + '\nstream\n', 'latin1'),
        mask.bytes,
        Buffer.from('\nendstream', 'latin1')
      ]));
    }
  }

  // ---- עמודים ----
  // **S6.0 (R5-M6 — תיבות עמוד חוקיות):** TrimBox = גודל העמוד; BleedBox
  // בתוך ה-MediaBox (בעבר ה-BleedBox חרג **מחוץ** ל-MediaBox — הפרה של
  // PDF 32000-1 §14.11.2 והבליד לא היה קיים כלל). עם בליד/סימני-חיתוך
  // ה-MediaBox מתרחב סביב ה-Trim; הקואורדינטות של התוכן לא משתנות
  // (הן יחסיות לראשית ה-Trim שנותרת 0,0).
  const markExtPt = cropMarks ? (0.5 + 5) * MM_TO_PT : 0;
  const extPt = Math.max(bleedPt, markExtPt);
  const trimbox = `[0 0 ${round2(wPt)} ${round2(hPt)}]`;
  const mediabox = extPt > 0.01
    ? `[${round2(-extPt)} ${round2(-extPt)} ${round2(wPt + extPt)} ${round2(hPt + extPt)}]`
    : trimbox;
  const bleedbox = bleedPt > 0.01
    ? `[${round2(-bleedPt)} ${round2(-bleedPt)} ${round2(wPt + bleedPt)} ${round2(hPt + bleedPt)}]`
    : trimbox;
  pages.forEach((pg, i) => {
    const annots = linkIds.get(i) || [];
    const annotsStr = annots.length ? ` /Annots [${annots.map(id => `${id} 0 R`).join(' ')}]` : '';
    // **S5.1:** רשימת גופנים דינמית — מחרוזת זהה בדיוק לצירופים הקיימים
    // (סדר F1,F2,F3,F4), ותוספת טבעית ל-/F5 (גוף הערה) ו-/F6 (הערות-צד).
    const fontPairs = [['/F1', ID.type0]];
    if (font2) fontPairs.push(['/F2', ID.type0b]);
    if (font3) fontPairs.push(['/F3', ID.type0c]);
    if (font4) fontPairs.push(['/F4', ID.type0d]);
    if (font5) fontPairs.push(['/F5', ID.type0e]);
    if (font6) fontPairs.push(['/F6', ID.type0f]);
    // **S73:** הגופנים הדינמיים באותם משאבים לכל עמוד — סדר קבוע (דטרמיניזם)
    extraFonts.forEach((ef, i) => fontPairs.push([`/F${7 + i}`, ef.ids.type0]));
    const fontRes = `/Font << ${fontPairs.map(([n, id]) => `${n} ${id} 0 R`).join(' ')} >>`;
    const pageImageRefs = [];
    const seenPageImages = new Set();
    for (const image of (pg.images || [])) {
      const record = image && imageByAssetId.get(String(image.assetId));
      if (!record) throw new Error('pdf-image-resource-missing:' + (image && image.assetId));
      if (seenPageImages.has(record.assetId)) continue;
      seenPageImages.add(record.assetId);
      pageImageRefs.push(`/${record.name} ${record.objectId} 0 R`);
    }
    const xObjectRes = pageImageRefs.length ? ` /XObject << ${pageImageRefs.join(' ')} >>` : '';
    pdf.put(pageIds[i], `<< /Type /Page /Parent ${ID.pages} 0 R /MediaBox ${mediabox} /TrimBox ${trimbox} /BleedBox ${bleedbox} /Resources << ${fontRes}${xObjectRes} >> /Contents ${contentIds[i]} 0 R${annotsStr} >>`);
    pdf.put(contentIds[i], Buffer.concat([
      Buffer.from(`<< /Length ${contents[i].length} >>\nstream\n`, 'latin1'),
      contents[i],
      Buffer.from('\nendstream', 'latin1')
    ]));
  });

  // ---- קישורי TOC ----
  let linkCursor = 0;
  for (const link of tocLinks || []) {
    const id = linkIds.get(link.page)[0] ? null : null;
    void id;
  }
  // סדר הקצאת הקישורים: לפי סדר tocLinks (אותו סדר בשמור המזהים)
  {
    const perPage = new Map();
    for (const link of tocLinks || []) {
      if (!perPage.has(link.page)) perPage.set(link.page, []);
      perPage.get(link.page).push(link);
    }
    for (const [pgIdx, links] of perPage) {
      const ids = linkIds.get(pgIdx);
      links.forEach((link, j) => {
        const x1 = link.x * PX_TO_PT, y1 = hPt - (link.y + link.h) * PX_TO_PT;
        const x2 = (link.x + link.w) * PX_TO_PT, y2 = hPt - link.y * PX_TO_PT;
        pdf.put(ids[j], `<< /Type /Annot /Subtype /Link /Rect [${round2(x1)} ${round2(y1)} ${round2(x2)} ${round2(y2)}] /Border [0 0 0] /Dest [${pageIds[link.targetPage]} 0 R /XYZ null null null] >>`);
      });
    }
    void linkCursor;
  }

  // ---- סימניות ----
  if (outlineItems.length) {
    pdf.put(ID.outlines, `<< /Type /Outlines /First ${roots[0].id} 0 R /Last ${roots[roots.length - 1].id} 0 R /Count ${flatOrder.length} >>`);
    for (const it of flatOrder) {
      const parts = [
        '<< /Title ' + pdfTitleHex(it.title),
        `/Parent ${it.parent ? it.parent.id : ID.outlines} 0 R`,
        `/Dest [${pageIds[it.page]} 0 R /XYZ null null null]`,
        `/Count ${it.children.length}`
      ];
      if (it.prev) parts.push(`/Prev ${it.prev.id} 0 R`);
      if (it.next) parts.push(`/Next ${it.next.id} 0 R`);
      if (it.children.length) parts.push(`/First ${it.children[0].id} 0 R /Last ${it.children[it.children.length - 1].id} 0 R`);
      pdf.put(it.id, parts.join(' ') + ' >>');
    }
  } else {
    pdf.put(ID.outlines, `<< /Type /Outlines /Count 0 >>`);
  }

  return pdf.build();
}

module.exports = { writePdf, PdfBuilder, PX_TO_PT, MM_TO_PT, visualOrderRtl, BRACKET_MIRROR };
