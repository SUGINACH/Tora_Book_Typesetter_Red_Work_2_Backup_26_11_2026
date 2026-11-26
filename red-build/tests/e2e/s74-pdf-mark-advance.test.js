// tests/e2e/s74-pdf-mark-advance.test.js — **S74: רגרסיית פגם הקרנת ניקוד משולב ב-PDF**
// פרוסה 1, גרסה 3 (26.11) — סביבת השער מתוקנת לפי הכרעת דין-וחשבון 26.11:
// גרסה 2 מדדה בטעות קונפליקט סמכויות-גופן של סביבת הבדיקה (המודל נמדד במימוש-
// טבלה של גוף לא-רשום: 3.48em×14pt=48.72pt בדיוק; ה-PDF צויר ב-FrankReal אמיתי
// מהגופן שהוזרק לייצוא בלבד: 34.66pt) — ולא את הפגם. כעת body-font=FrankReal
// רשום לפני ה-typeset ⇒ המודל מודד בסיסים-בלבד (font-metrics + combined) מול
// ה-PDF שמצייר ב-hmtx גולמי — שחזור נאמן של מחלקת הפגם החי (פורנזי 25.11 §6-§7:
// מדידה≠ציור לאותה מילה מנוקדת). התיקון: הכותב מקרין את החלטת המדידה (/W מאופס
// לניקוד בפרופיל המאוחד; המורשת ב-hmtx מופרד כחוזה הייחוס).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { describe, it, assert, assertClose, report } = require('../harness');

const { typeset } = require('../../src/engine/core/pipeline');
const { getDefaultSettings } = require('../../src/engine/core/settings-registry');
const { exportPdfFromModel } = require('../../src/engine/output/export-api');
const { registerFont, clearRegisteredFonts } = require('../../src/engine/typography/measure-api');

const REPO = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(REPO, 'ui/assets/imud');
const FONT_DIR = path.join(ASSETS, 'fonts');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ASSETS, 'imud-fonts.json'), 'utf8'));

// קבועים מאומתים (פורנזי §2 + Phase-2 probe) — לא נחושים:
const FRANKREAL_UPM = 2048;
const FRANKREAL_HMTX = { 'ש': 1261, 'ׁ': 1247, 'ְ': 147, 'מ': 1042, 'ַ': 399, 'ע': 972 };
const BASE_UNITS = FRANKREAL_HMTX['ש'] + FRANKREAL_HMTX['מ'] + FRANKREAL_HMTX['ע']; // 3275
const MARK_UNITS = FRANKREAL_HMTX['ׁ'] + FRANKREAL_HMTX['ְ'] + FRANKREAL_HMTX['ַ']; // 1793
const WORD = 'שְׁמַע';
const MARKS = ['ׁ', 'ְ', 'ַ'];

function frankRealBytes() {
  const e = CATALOG.find(x => x.family === 'FrankReal');
  assert(e, 'FrankReal בקטלוג');
  return fs.readFileSync(path.join(FONT_DIR, e.file));
}

let _pdftotext = null;
function pdftotextAvailable() {
  if (_pdftotext !== null) return _pdftotext;
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); _pdftotext = true; }
  catch (e) { _pdftotext = false; }
  return _pdftotext;
}

function isSheamWord(t) {
  const s = String(t);
  return s.includes('ש') && s.includes('ע') && s.includes('מ') && MARKS.some(m => s.includes(m));
}

function pdfWordsOnPage(pdfPath, pageNo) {
  const xml = execFileSync('pdftotext', ['-bbox', '-f', String(pageNo), '-l', String(pageNo), pdfPath, '-'], { encoding: 'utf8' });
  return [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
    .map(m => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: m[5] }));
}

function setup() {
  clearRegisteredFonts();
  for (const f of ['Frank Ruhl Libre', 'David Libre', 'Hadassah Friedlaender', 'FrankReal']) {
    const e = CATALOG.find(x => x.family === f);
    if (e) registerFont(f, fs.readFileSync(path.join(FONT_DIR, e.file)));
  }
  // **S74 (גרסה 3 — תיקון סביבת השער):** גוף המסמך ב-FrankReal הרשום. כך
  // המדידה רצה במימוש font-metrics עם combined (ה-pipeline קובע את הדגל על
  // ההגדרות הפנימיות) ⇒ המודל מתכנן את שְׁמַע בבסיסים-בלבד — כמו הדפדפן
  // (GPOS mark-to-base, advance 0). בלי זה נפלה המדידה לטבלה (גוף לא-רשום)
  // והשער מדד קונפליקט גופנים של סביבת הבדיקה — לא את הפגם.
  return { ...getDefaultSettings(), 'body-font': 'FrankReal' };
}

function buildDoc() {
  const para = `${WORD} ישראל אליך בכל אשר תעשה ובכל אשר תבקש והיה ביום ההוא נאם ה׳ אשר אקבץ את שבוייך מכל הארץ אשר הפצתיך שמה והשבתיך אל המקום אשר בחרתי לשכן שמי בו ואתה תדע כי לבבי עמך להציל אותך ולקבצך מכל קצוות הארץ ולהשיבך אל ביתך אשר יצאת משם ואל מקומך אשר נטשת שמה ואת בניך אקבץ מכל הגויים אשר הפצתים שמה ואשיבם אל ארצם אשר נתתי לאבותיהם וירשוה ואני אהיה להם לאלוהים והם יהיו לי לעם ולא ידחו עוד מעל פני האדמה אשר נתתי להם.`;
  return [
    'כותרת 1 - חלק',
    para,
    ...Array.from({ length: 4 }, (_, i) => `פסקת מילוי ${i + 1} עם טקסט ממשי למילוי הטורים בנפח אמיתי ולבדיקת גיאומטריה עקבת של העמוד. ${'מילים למילוי הטור ולבדיקת יציבות הפריסה '.repeat(4)}`)
  ].join('\n');
}

function findSheamInModel(model) {
  let found = null, count = 0;
  model.pages.forEach((mp, i) => {
    for (const ln of mp.lines) {
      for (const w of (ln.words || [])) {
        if (isSheamWord(w.text)) { count++; if (!found) found = { pageIdx: i, word: w, line: ln }; }
      }
    }
  });
  return { found, count };
}

describe('S74 — פגם הקרנת ניקוד משולב ב-PDF (FrankReal שְׁמַע, פורנזי 25.11)', () => {
  it('מקדימון: hmtx הגולמי של ניקודי FrankReal חיובי — תנאי הגילוי', () => {
    assert(MARK_UNITS === 1793, `סכום advances ניקודים גולמי מאומת (קיבלנו ${MARK_UNITS})`);
    assert(BASE_UNITS === 3275, `סכום בסיסים מאומת (קיבלנו ${BASE_UNITS})`);
  });

  it('המודל מציב את שְׁמַע פעם אחת בלבד — עוגן ההשוואה מוגדר', () => {
    const S = setup();
    const r = typeset(buildDoc(), S, {});
    assert(r.pageModel && r.pageModel.pages.length, 'PageModel נוצר');
    const { found, count } = findSheamInModel(r.pageModel);
    assert(count === 1, `המילה נמצאת פעם אחת במודל (נמצאו ${count})`);
    assert(found, 'עוגן המילה קיים');
    assert(found.word && Number.isFinite(found.word.w), 'למילה במודל יש רוחב מתוכנן (w)');
    // **S74 (גרסה 3):** המודל מדד במדדי-אמת של FrankReal הרשום עם combined —
    // בסיסים-בלבד (סביבת השער תקינה; אם זה נכשל, המדידה נפלה לטבלה והשער
    // חוזר למדוד קונפליקט סביבה במקום הפגם).
    const modelWpt = found.word.w * 72 / 96;
    const basesPt = BASE_UNITS / FRANKREAL_UPM * 14 * (96 / 72) * (72 / 96); // גוף 14pt — בסיסים בלבד
    assertClose(modelWpt, basesPt, 0.5,
      `סביבת השער: המודל חייב למדוד בסיסים-בלבד במדדי FrankReal (קיבלנו ${modelWpt.toFixed(3)}pt מול ${basesPt.toFixed(3)}pt) — אחרת המדידה נפלה מ-font-metrics/combined והשער מודד קונפליקט סביבה.`);
    clearRegisteredFonts();
  });

  it('שער הנפל: רוחב שְׁמַע ב-PDF חייב להתאים לרוחב המילה במודל (±0.5pt)', () => {
    if (!pdftotextAvailable()) return it.skip('pdftotext לא מותקן');
    const S = setup();
    const fontBytes = frankRealBytes();
    const r = typeset(buildDoc(), S, {});
    const model = r.pageModel;
    assert(model && model.pages.length, 'PageModel נוצר');
    const { found } = findSheamInModel(model);
    assert(found, 'המילה נמצאת במודל');
    const modelWidthPt = found.word.w * 72 / 96;
    const res = exportPdfFromModel(model, S, fontBytes, 'FrankReal');
    assert(res.ok, 'ייצוא PDF הצליח: ' + (res.error || ''));
    const pdfPath = path.join(__dirname, '..', 'artifacts', 's74-mark-advance.pdf');
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, Buffer.from(res.bytes));
    const words = pdfWordsOnPage(pdfPath, found.pageIdx + 1);
    const cand = words.filter(v => isSheamWord(v.text));
    assert(cand.length >= 1, `המילה נחלצה ב-bbox מעמ' ${found.pageIdx + 1} (${cand.length} מועמדים; ${words.length} מילים בעמוד)`);
    const span = cand[0];
    const pdfWidthPt = span.x1 - span.x0;
    const sizePx = found.word.w / (BASE_UNITS / FRANKREAL_UPM);
    const markAdvancePt = MARK_UNITS * (sizePx * 72 / 96) / FRANKREAL_UPM;
    assertClose(pdfWidthPt, modelWidthPt, 0.5,
      `פגם הקרנת ניקוד משולב ב-PDF (פורנזי §7): רוחב שְׁמַע ב-PDF=${pdfWidthPt.toFixed(3)}pt מול המודל=${modelWidthPt.toFixed(3)}pt — הפרש ${(pdfWidthPt - modelWidthPt).toFixed(3)}pt ≈ advances ניקוד גולמי (${markAdvancePt.toFixed(3)}pt). ה-PDF בונה מילים תו-תו עם hmtx גולמי במקום להקרין את מדידת המודל (combined). תיקון שורש: הכותב מקרין את החלטת המדידה (/W מאופס לניקוד); אין לתקן במרווח/CSS/offset.`);
    clearRegisteredFonts();
  });
});

report('s74-pdf-mark-advance');
