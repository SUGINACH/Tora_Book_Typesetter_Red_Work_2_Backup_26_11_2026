// src/engine/layout/notes-model.js — שלב 6 פרוסה 2: מודל הערות מאוחד (חוזה מקור/עוגן + מדידה קנונית)
'use strict';

/**
 * **חוזה ההערות האחיד (הוראת שלב 6 §§7-10):** כל סוגי ההערות — שוליים (מרזב),
 * צד (שוליים חיצוניים), סיום (עמודי הערות), המשכים מפיצול והערות מועברות — חולקים
 * אותו מודל מקור/עוגן ואותה חותמת מדידה. העיקרון:
 *
 *   מקור תוכן אחד → עוגן אחד → מדידה אחת (לפי הקשר יעד) → תקציב/הצבה/הקרנה
 *   מאותה חותמת → PagePlan → מקרינים טהורים.
 *
 * **זהות ושרשור (§7):** לכל הערה יש `noteId` יציב (kind|sourceId|noteIndex),
 * `sourceId` (הטוקן שבבעלותו טקסט ההערה), `anchorId` (עוגן הגוף), ומדיניות
 * מספור/פיצול/המשך. המשך מפיצול הוא רשומה משלו עם `continuationOf` = noteId
 * המקור ו-`wordRange` — טווח המילים המדויק שלו במקור: מילה לא נעלמת, לא מוכפלת
 * ולא נסדרת מחדש.
 *
 * **מדידה קנונית (§§9-10):** החותמת (`noteRows/noteWords/markerW/markerGlyphW/
 * contMarkW/spaceW/lineH/heightPx/linesCount/stampCtx`) נוצרת פעם אחת לכל
 * (הערה, הקשר יעד) — ההקשר קובא את הרוחב, הגודל, הפיץ' והפקטור. מרגע ההטבעה
 * התקציב, ההצבה ושני המקרינים קוראים את החותמת ואינם מודדים שוב. המקרינים
 * שאוחזים הערה בלי חותמת מפיקים diagnostic מפורש — ולא מדידה חלופית שקטה.
 *
 * דטרמיניזם: פונקציות טהורות של (טקסט, הגדרות, מדידה); אין תאריך/אקראיות.
 */

/**
 * **פרופילי רוחב הגופן (SSOT של מודל ההערות):** עד כאן הועתקה הטבלה בשלושה
 * אתרים (footnote-budget, endnote-pages, side-notes). כעת היא חיה כאן —
 * והמודולים ההם מייצאים אותה הלאה לצרכנים הקיימים (בלי שבירת חוזה).
 * הפקטור מתקן את טבלת impl A בלבד; ב-impl B (font-metrics — ייצוא PDF)
 * המטריקות מדויקות והכפלה מנפחת (S70/R7-M4) — measureContextFor מכבה אותו שם.
 */
const { SZ_CORE } = require('../core/imud-geometry');
const { projectShapedTextItemRanges } = require('../typography/paragraph-shaping');
const NOTE_FONT_FACTORS = { 'David HB': 1.06, 'David': 1.04, 'Narkisim': 1.10, 'Nachlieli': 0.96, 'Alef': 1.02, 'Rubin': 1.05 };
const SIDE_NOTE_FONT_FACTORS = { 'David HB': 1.06, 'David': 1.04, 'Narkisim': 1.10, 'Nachlieli': 0.96, 'Alef': 1.02, 'Rubin': 1.05 };

/** סוגי ההערות במודל המאוחד. */
const NOTE_KINDS = Object.freeze({
  FOOTNOTE: 'footnote',   // מרזב תחתון (עמוד)
  SIDE_NOTE: 'side-note', // שוליים חיצוניים, עוגן פסקה מארחת
  ENDNOTE: 'endnote',     // עמודי הערות-סיום
  INFO_BOX: 'info-box'    // פריט עוגן מורחב (תיבת מידע) — שלב 6 פרוסה 2, דרך registry
});

/** סימון ההמשך של פיצול — טקסט קבוע (מקור יחיד למחרוזת). */
const CONTINUATION_MARK = '(המשך)';

/** ניקוי תווי ה-PUA הפנימיים מטקסט הערה — **אותו טקסט שהמקרינים מציירים**
 * (E000 רווח אטומי ⇒ רווח אמת; E101/E102 ⇒ מוסרים). החותמת מודדת את מה
 * שמצויר — אחרת תקציב≠הקרנה (§9). */
function scrubNoteText(s) {
  return String(s == null ? '' : s)
    .replace(/\uE000/g, ' ')
    .replace(/[\uE101\uE102]/g, '');
}

// ─── הקשרי מדידה — מקור יחיד לגודל/פיץ'/רוחב/פקטור לכל סוג הערה (§10) ───

/**
 * הקשר המדידה של סוג הערה: { sizePt, lineH, widthPx, fontName, factor }.
 * @param {string} kind — אחד מ-NOTE_KINDS
 * @param {object} settings
 * @param {object} [opts] — { widthPx } (עקיפת רוחב לפריט עוגן מורחב), { sizePt }
 * @param {Function} [measure] — פונקציית המדידה (לזיהוי impl לצורך הפקטור)
 */
function measureContextFor(kind, settings, opts = {}, measure = null) {
  const bodyPt = Number(settings['body-font-size-pt']) || 14;
  const implB = measure && measure.impl === 'font-metrics';
  if (kind === NOTE_KINDS.FOOTNOTE) {
    // היסטורי (noteMetrics, שלב 5): 0.8× הגוף, פיץ' 1.25 — כמו המרזב בשני הרנדרים.
    const sizePt = bodyPt * 0.8;
    return {
      kind, sizePt,
      lineH: Math.round(sizePt * (96 / 72) * 1.25),
      widthPx: settings._fnColWidthPx || 200,
      fontName: settings['f-note-body-font'],
      factor: implB ? 1 : (NOTE_FONT_FACTORS[settings['f-note-body-font']] || 1)
    };
  }
  if (kind === NOTE_KINDS.SIDE_NOTE || kind === NOTE_KINDS.INFO_BOX) {
    // היסטורי (estimateSideNoteHeight): 0.75× הגוף, פיץ' 1.15 — כמו .side-note.
    // **Iteration-003 (legacy parity):** בפרופיל IMUD הערת-הצד ב-6pt המכויל
    // (SZ_CORE.marginNote — נמדד בייחוס: ToraMargin 6pt; s-note-body=9 של
    // המקור אינו נצרך שם, כמו f-gtoc).
    const imudProf = !!(settings && (settings['_layout-profile'] === 'imud' || settings._imudRaw));
    const sizePt = Number(opts.sizePt) > 0 ? Number(opts.sizePt)
      : (imudProf ? (Number(SZ_CORE.marginNote) || 6) : bodyPt * 0.75);
    const fontName = opts.fontName || settings['s-note-body-font'];
    const fallbackW = Math.max(60, Math.round(settings._outerMarginPx || 120) - 12);
    // **G4/RC-4c (i004):** בפרופיל IMUD הפיץ' המכויל — GEO.MN_PITCH (9.6px =
    // 6pt×1.2×4/3, כמו המקור; נמדד בייחוס). היה Math.round(6×1.333×1.15)=9 —
    // 0.6px צפוף מדי לכל שורת הערה.
    const imudLineH = imudProf ? sizePt * (96 / 72) * 1.2 : Math.round(sizePt * (96 / 72) * 1.15); // **RC-4c:** 9.6 מדויק — עיגול היה הופך ל-10
    return {
      kind, sizePt,
      lineH: imudLineH,
      widthPx: Number(opts.widthPx) > 0 ? Math.round(Number(opts.widthPx)) : (settings._sideNoteColWidthPx || fallbackW),
      fontName,
      factor: implB ? 1 : (SIDE_NOTE_FONT_FACTORS[fontName] || (fontName && fontName !== settings['body-font'] ? 1.08 : 1))
    };
  }
  if (kind === NOTE_KINDS.ENDNOTE) {
    // היסטורי (endnote-pages/estimateNoteHeight): 0.8× הגוף, פיץ' לפי body-line-height
    // (בדיוק api.lineHeightPx) — ללא עיגול, כמו שהיה בתקציב עמודי ההערות.
    const sizePt = bodyPt * 0.8;
    return {
      kind, sizePt,
      lineH: sizePt * (96 / 72) * (Number(settings['body-line-height']) || 1.4),
      widthPx: Number(opts.widthPx) > 0 ? Math.round(Number(opts.widthPx)) : (settings._endnoteColWidthPx || 300),
      fontName: settings['f-note-body-font'],
      factor: implB ? 1 : (NOTE_FONT_FACTORS[settings['f-note-body-font']] || 1)
    };
  }
  throw new TypeError('notes-model: unknown note kind: ' + kind);
}

// ─── ליבת השבירה — מימוש אחד לכל ההקשרים (§9: אין wrap עצמאי במקרינים) ───

/**
 * עטיפה חמדנית של מילי הערה ברוחב ההקשר, עם קידומת (סמן +/(המשך)) בשורה
 * הראשונה — **אותה אריתמטיקה שקבעה את תקציב המרזב מאז שלב 5** (R3-C3):
 * row0 נפתח ברוחב הקידומת; כל מילה מוסיפה רווח+רוחב; מעבר לרוחב ⇒ שורה.
 * @param {string[]} words — המילים (לאחר ניקוי PUA)
 * @param {object} ctx — הקשר ({ sizePt, widthPx, factor } מ-measureContextFor)
 * @param {Function} measure — פונקציית מדידה (טקסט, גודל) ⇒ רוחב
 * @param {number} prefixW — רוחב הקידומות של שורה 0 (סמן/המשך, כולל רווח)
 * @param {number} spaceW — רוחב הרווח בהקשר (כבר מחושב — מודדים פעם אחת)
 * @returns {{rows:Array}} שורות {wFrom,wTo,widthPx,wordW[]}
 */
function wrapNoteWords(words, ctx, measure, prefixW, spaceW, wordWidths = null) {
  const r3 = (v) => Math.round(v * 1000) / 1000;
  if (wordWidths != null && (!Array.isArray(wordWidths) || wordWidths.length !== words.length ||
      wordWidths.some(width => !Number.isFinite(width) || width < 0))) {
    throw new TypeError('notes-model: wordWidths must contain one finite non-negative advance per note word');
  }
  const rows = [];
  let rowW = Math.min(prefixW, ctx.widthPx); // קידומת בפינת השורה הראשונה
  let wFrom = 0;
  let rowWordW = [];
  for (let i = 0; i < words.length; i++) {
    const ww = wordWidths ? wordWidths[i] : measure(words[i], ctx.sizePt) * ctx.factor;
    const addW = (rowW > 0 ? spaceW : 0) + ww;
    if (rowW + addW > ctx.widthPx && rowW > 0) {
      rows.push({ wFrom, wTo: i, widthPx: r3(rowW), wordW: rowWordW });
      wFrom = i; rowW = ww; rowWordW = [r3(ww)];
    } else {
      rowW += addW;
      rowWordW.push(r3(ww));
    }
  }
  rows.push({ wFrom, wTo: words.length, widthPx: r3(rowW), wordW: rowWordW });
  return { rows };
}

// ─── Glyph shaping להערות: אותה חותמת ושבירת שורות, ללא מקרין/מודד שני ───
function shapeNoteText(text, note, ctx, measure, role) {
  const service = measure && measure.paragraphShaper;
  if (!service || typeof service.shapeTextItem !== 'function' || !text) return null;
  const value = String(text);
  const itemId = 'note-' + String(note.noteId || note.tokenId || 'anonymous')
    .replace(/[^A-Za-z0-9._:-]/g, '_') + '-' + role;
  const item = {
    id: itemId,
    kind: 'text',
    sourceRange: { start: 0, end: value.length },
    payload: {
      runs: [{
        text: value,
        sourceStart: 0,
        sourceEnd: value.length,
        ...(service.useItemFontRole === true && ctx.fontName ? { fontFamily: ctx.fontName } : {})
      }]
    }
  };
  const request = { direction: measure.paragraphDirection || 'rtl', language: 'he' };
  if (service.useItemFontRole === true && ctx.fontName) request.defaultFamily = ctx.fontName;
  return service.shapeTextItem(item, request);
}

function typographyForShapedRuns(runs, sizePt) {
  if (!Array.isArray(runs) || !runs.length) return { advancePx: 0, typography: null, glyphCount: 0 };
  const sizePx = Number(sizePt) * (96 / 72);
  let advancePx = 0;
  let glyphCount = 0;
  const segments = [];
  for (const run of runs) {
    if (!run || !run.font || !Number.isSafeInteger(run.font.unitsPerEm) ||
        run.font.unitsPerEm <= 0 || !Array.isArray(run.glyphs) || !run.glyphs.length) {
      throw new TypeError('notes-model: a shaped note run is missing valid font units or glyphs');
    }
    let runAdvance = 0;
    for (const glyph of run.glyphs) {
      if (!glyph || !Number.isFinite(glyph.xAdvance)) {
        throw new TypeError('notes-model: a shaped note glyph has no finite xAdvance');
      }
      runAdvance += glyph.xAdvance;
    }
    if (!Number.isFinite(runAdvance) || runAdvance < 0) {
      throw new TypeError('notes-model: a shaped note run has an invalid advance');
    }
    const runAdvancePx = runAdvance / run.font.unitsPerEm * sizePx;
    advancePx += runAdvancePx;
    glyphCount += run.glyphs.length;
    segments.push({
      itemId: run.itemId || null,
      sourceRange: run.sourceRange ? { ...run.sourceRange } : null,
      advancePx: runAdvancePx,
      shapedRuns: [run],
      glyphCount: run.glyphs.length
    });
  }
  if (!glyphCount) return { advancePx, typography: null, glyphCount: 0 };
  return {
    advancePx,
    glyphCount,
    typography: { contractVersion: 'page-word-typography-v1', glyphCount, segments }
  };
}

function shapedNoteWords(text, note, ctx, measure) {
  const shaped = shapeNoteText(text, note, ctx, measure, 'body');
  if (!shaped) return null;
  const matches = Array.from(text.matchAll(/\S+/gu), match => ({
    text: match[0], start: match.index, end: match.index + match[0].length
  }));
  const ranges = matches.map(match => ({ start: match.start, end: match.end }));
  const projected = ranges.length
    ? projectShapedTextItemRanges(shaped, ranges).slices
    : [];
  const widths = [];
  const typographies = [];
  for (const slice of projected) {
    const measured = typographyForShapedRuns(slice.shapedRuns, ctx.sizePt);
    if (!measured.glyphCount && slice.nonShapingRuns.some(run =>
      String(run.text || '').replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim())) {
      throw new Error('notes-model: visible note word has no HarfBuzz glyph coverage');
    }
    widths.push(measured.advancePx);
    typographies.push(measured.typography);
  }
  const spaceRun = shapeNoteText(' ', note, ctx, measure, 'space');
  const spaceMeasured = spaceRun ? typographyForShapedRuns(spaceRun.shapedRuns, ctx.sizePt) : null;
  if (spaceRun && !spaceMeasured.glyphCount) {
    throw new Error('notes-model: note-space did not receive a HarfBuzz glyph');
  }
  return { matches, widths, typographies, spaceW: spaceMeasured ? spaceMeasured.advancePx : 0 };
}

function shapedPrefix(note, value, ctx, measure, role) {
  if (!value) return { advancePx: 0, typography: null };
  const shaped = shapeNoteText(value, note, ctx, measure, role);
  if (!shaped) return null;
  const result = typographyForShapedRuns(shaped.shapedRuns, ctx.sizePt);
  if (!result.glyphCount && String(value).trim()) {
    throw new Error('notes-model: visible note prefix has no HarfBuzz glyph coverage (' + role + ')');
  }
  return { advancePx: result.advancePx, typography: result.typography };
}

// ─── חשבונאות מדידה (דפוס api.cacheStats / _rowsStats): הוכחת "פעם אחת" ───
const _stampStats = { calls: [] };
function __resetStampStats() { _stampStats.calls.length = 0; }
function __stampStats() {
  const perKey = Object.create(null);
  for (const k of _stampStats.calls) perKey[k] = (perKey[k] || 0) + 1;
  return { total: _stampStats.calls.length, keys: _stampStats.calls.slice(), perKey };
}

/**
 * **הטבעת חותמת המדידה (§§9-10):** המדידה הראשונה והאחרונה של ההערה בהקשר
 * היעד שלה. מוטציה באתר על אובייקט ההערה (המקור בידי ה-pipeline/המתכנן).
 * הערה שכבר חתומה **באותו הקשר** אינה נמדדת שוב (מחזיר כפי שהיא).
 * @param {object} note — { text, marker?, isContinuation?/mode?, counterMark? }
 * @param {object} settings
 * @param {Function} measure
 * @param {string} kind — NOTE_KINDS.*
 * @param {object} [opts] — עקיפות הקשר ({ widthPx, sizePt, fontName }) לפריטים מורחבים
 * @returns {object} ה-note עצמו (שרשרת)
 */
function stampNote(note, settings, measure, kind, opts = {}) {
  const ctx = measureContextFor(kind, settings, opts, measure);
  const paragraphShaper = measure && measure.paragraphShaper;
  const shapingActive = !!(paragraphShaper && typeof paragraphShaper.shapeTextItem === 'function');
  if (note.stampCtx && note.stampCtx.kind === ctx.kind
    && note.stampCtx.widthPx === ctx.widthPx && note.stampCtx.sizePt === ctx.sizePt
    && note.stampCtx.fontName === (ctx.fontName || null)
    && note.stampCtx.shaping === shapingActive) {
    return note; // כבר נמדדה בדיוק בהקשר הזה — לא מודדים שוב
  }
  _stampStats.calls.push(`${ctx.kind}:${note.noteId || note.tokenId || ''}#${note.noteIndex != null ? note.noteIndex : ''}`);
  const text = scrubNoteText(note.text);
  const words = text.split(/\s+/).filter(Boolean);
  delete note.noteWordTypography;
  delete note.markerTypography;
  delete note.contMarkTypography;
  delete note.counterMarkTypography;
  const shapedBody = shapingActive ? shapedNoteWords(text, note, ctx, measure) : null;
  const wordWidths = shapedBody ? shapedBody.widths : null;
  if (shapedBody && shapedBody.matches.length !== words.length) {
    throw new Error('notes-model: shaped note word ranges differ from the canonical note word list');
  }
  if (shapedBody) note.noteWordTypography = shapedBody.typographies;
  const spaceW = shapedBody ? shapedBody.spaceW : measure(' ', ctx.sizePt) * ctx.factor;
  const mkTxt = note.marker != null && String(note.marker) !== '' ? String(note.marker) : '';
  const shapedMarker = shapingActive && mkTxt ? shapedPrefix(note, mkTxt, ctx, measure, 'marker') : null;
  const mkGlyphW = shapedMarker ? shapedMarker.advancePx : (mkTxt ? measure(mkTxt, ctx.sizePt) * ctx.factor : 0);
  if (shapedMarker && shapedMarker.typography) note.markerTypography = shapedMarker.typography;
  const markerW = mkTxt ? mkGlyphW + spaceW : 0;
  const isCont = note.isContinuation === true || note.mode === 'split-rest';
  const shapedContMark = shapingActive && isCont ? shapedPrefix(note, CONTINUATION_MARK, ctx, measure, 'continuation') : null;
  const contMarkW = isCont ? (shapedContMark ? shapedContMark.advancePx : measure(CONTINUATION_MARK, ctx.sizePt) * ctx.factor) + spaceW : 0;
  if (shapedContMark && shapedContMark.typography) note.contMarkTypography = shapedContMark.typography;
  // **תיקון פרוסה 2 (§9):** הקידומות של שורה 0 — הסמן **וגם סימון ההמשך** —
  // נכנסות לתקציב השורה. בעבר ההמשכים נמדדו בלי '(המשך)' בזמן ששני הרנדרים
  // ציירו אותו ⇒ השורה הראשונה של כל המשך הייתה צרה בכ~30px מהמצויר.
  // הערות-צד עם counterMark — אותו תיקון (הסמן מוצג ולא תוקצב).
  const cmTxt = (!isCont && note.counterMark != null && String(note.counterMark) !== '') ? String(note.counterMark) : '';
  const shapedCounterMark = shapingActive && cmTxt ? shapedPrefix(note, cmTxt, ctx, measure, 'counter') : null;
  const cmGlyphW = shapedCounterMark ? shapedCounterMark.advancePx : (cmTxt ? measure(cmTxt, ctx.sizePt) * ctx.factor : 0);
  if (shapedCounterMark && shapedCounterMark.typography) note.counterMarkTypography = shapedCounterMark.typography;
  const counterMarkW = cmTxt ? cmGlyphW + spaceW : 0;
  const prefixW = contMarkW + markerW + counterMarkW;
  const { rows } = wrapNoteWords(words, ctx, measure, prefixW, spaceW, wordWidths);
  note.noteRows = rows;
  note.noteWords = words;
  note.heightPx = Math.round(rows.length * ctx.lineH * 1000) / 1000;
  note.linesCount = rows.length;
  note.lineH = ctx.lineH;
  note.markerW = markerW ? Math.round(markerW * 1000) / 1000 : 0;
  note.markerGlyphW = mkGlyphW ? Math.round(mkGlyphW * 1000) / 1000 : 0;
  note.contMarkW = contMarkW ? Math.round(contMarkW * 1000) / 1000 : 0;
  note.counterMarkW = counterMarkW ? Math.round(counterMarkW * 1000) / 1000 : 0;
  note.spaceW = Math.round(spaceW * 1000) / 1000;
  note.stampCtx = {
    kind: ctx.kind, sizePt: ctx.sizePt, widthPx: ctx.widthPx, lineH: ctx.lineH,
    factor: shapingActive ? 1 : ctx.factor,
    fontName: ctx.fontName || null,
    shaping: shapingActive
  };
  return note;
}

/** בדיקת תקינות חותמת (למקרינים ולאימות): שורות+מילים+פיץ' עקביים. */
function stampIsValid(note) {
  if (!note || !Array.isArray(note.noteRows) || note.noteRows.length === 0) return false;
  if (!Array.isArray(note.noteWords)) return false;
  if (!(Number(note.lineH) > 0) || !(Number(note.heightPx) > 0)) return false;
  if (note.noteRows.length !== Number(note.linesCount)) return false;
  for (const row of note.noteRows) {
    if (!(row.wTo >= row.wFrom) || !Array.isArray(row.wordW)) return false;
    if (row.wordW.length !== row.wTo - row.wFrom) return false;
  }
  if (note.stampCtx && note.stampCtx.shaping === true) {
    if (!Array.isArray(note.noteWordTypography) ||
        note.noteWordTypography.length !== note.noteWords.length ||
        note.noteWordTypography.some((item, index) => String(note.noteWords[index] || '').trim() && !item)) return false;
  }
  return true;
}

// ─── חוזה הרשומה: זהות, עוגן, מדיניות (§7) ───

/**
 * יצירת רשומת הערה מנורמלת — זהות אחת לכל סוגי ההערות. לא מודדת (המדידה
 * ב-stampNote, פעם אחת בהקשר היעד).
 * @param {object} raw — { text, marker?, tokenId, noteIndex?, part? }
 * @param {object} ctxArgs — { kind, sourceId?, anchorId?, numberingScope?, splitPolicy?,
 *   continuationPolicy?, continuationOf?, wordRange? }
 */
function makeNoteRecord(raw, ctxArgs) {
  const kind = ctxArgs.kind;
  if (!Object.values(NOTE_KINDS).includes(kind)) {
    throw new TypeError('notes-model: makeNoteRecord kind must be one of ' + Object.values(NOTE_KINDS).join('|'));
  }
  const sourceId = raw.tokenId != null ? String(raw.tokenId) : (ctxArgs.sourceId != null ? String(ctxArgs.sourceId) : '');
  const noteIndex = raw.noteIndex != null ? raw.noteIndex : 0;
  const rec = {
    ...raw,
    kind,
    noteId: `${kind}|${sourceId}|${noteIndex}${ctxArgs.fragmentIndex != null ? '|f' + ctxArgs.fragmentIndex : ''}`,
    sourceId,
    anchorId: ctxArgs.anchorId != null ? String(ctxArgs.anchorId) : sourceId,
    numberingScope: ctxArgs.numberingScope || null,
    splitPolicy: ctxArgs.splitPolicy || null,
    continuationPolicy: ctxArgs.continuationPolicy || null,
    ...(ctxArgs.continuationOf != null ? { continuationOf: ctxArgs.continuationOf } : {}),
    ...(ctxArgs.wordRange ? { wordRange: { from: ctxArgs.wordRange.from, to: ctxArgs.wordRange.to } } : {})
  };
  return rec;
}

/** אימות חוזה רשומת הערה (צרכן: page-items + בדיקות). מחזיר רשימת הפרות. */
function validateNoteRecord(rec) {
  const errs = [];
  if (!rec || typeof rec !== 'object') return [{ code: 'note-not-object' }];
  if (!rec.noteId || typeof rec.noteId !== 'string') errs.push({ code: 'note-id-missing' });
  if (!rec.kind || !Object.values(NOTE_KINDS).includes(rec.kind)) errs.push({ code: 'note-kind-invalid', kind: rec.kind });
  if (rec.sourceId == null || rec.sourceId === '') errs.push({ code: 'note-source-missing' });
  if (rec.anchorId == null || rec.anchorId === '') errs.push({ code: 'note-anchor-missing' });
  if (rec.text == null || String(rec.text).trim() === '') errs.push({ code: 'note-text-empty' });
  // **§7:** כל המשך — פיצול או העברה — חייב קישור למקור וטווח מילים מדויק:
  // מילה לא נעלמת, לא מוכפלת ולא נסדרת מחדש.
  const isCont = rec.isContinuation === true || rec.mode === 'split-rest' || rec.continuationOf != null;
  if (isCont) {
    if (rec.continuationOf == null) errs.push({ code: 'note-continuation-without-source' });
    if (rec.wordRange == null) errs.push({ code: 'note-continuation-without-range' });
  }
  if (rec.wordRange != null) {
    const wr = rec.wordRange;
    if (!(wr.from >= 0) || !(wr.to >= wr.from)) errs.push({ code: 'note-word-range-invalid' });
  }
  return errs;
}

/** קישור עוגן-להערה: מפה anchorId ⇒ רשימת noteId (לאימות שאין עוגן יתום). */
function anchorLinksOf(records) {
  const byAnchor = new Map();
  for (const r of records || []) {
    if (!r || !r.noteId) continue;
    if (!byAnchor.has(r.anchorId)) byAnchor.set(r.anchorId, []);
    byAnchor.get(r.anchorId).push(r.noteId);
  }
  return byAnchor;
}

module.exports = {
  NOTE_KINDS,
  CONTINUATION_MARK,
  NOTE_FONT_FACTORS,
  SIDE_NOTE_FONT_FACTORS,
  scrubNoteText,
  measureContextFor,
  wrapNoteWords,
  stampNote,
  stampIsValid,
  makeNoteRecord,
  validateNoteRecord,
  anchorLinksOf,
  __resetStampStats,
  __stampStats
};
