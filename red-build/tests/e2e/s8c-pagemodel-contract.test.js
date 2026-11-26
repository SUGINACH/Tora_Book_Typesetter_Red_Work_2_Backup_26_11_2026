// tests/e2e/s8c-pagemodel-contract.test.js — שלב 8 פרוסה 2 (§4.1–§4.4): חוזה PageModel מלא + תמונות + העברת Worker
//
// מוכיח:
//  1. §4.1 — השדות שכל יעד פלט צריך: ריהוט מלא (סלוטי כותרת עליונה עם x/w/גופן;
//     גיליון מלא), פס חוצה-טורים, bookmarks (outline) וקישורי TOC עם מלבנים
//     מהחותמות, הזמנות, diagnostics, האשים — בקורפוס קנוני ובמצב endnotes.
//  2. S8-END1 נסגר — מצב endnotes: אפס הפרות (בעבר 105); noteId לכל הערה.
//  3. §4.2 — תמונות פריטים ממדרגה ראשונה: inline עם מיקום סופי, float עם הצהרה,
//     block ממורכז; זהות נכס מכתובת-תוכן; resolved לפי ה-resolver; נכס חסר
//     ⇒ resolved:false + diagnostic; טוהר הייצור גם עם תמונות (probe).
//  4. §4.3 — חוזה ההעברה: עטיפה + האשים; structured clone אמיתי; קבלה ⇒
//     אימות + הקפאה מחדש; ההאשים שהגיעו זהים למקור; חישוב מחדש של
//     geometryHash על העותק זהה ביט-לביט (הוכחת העברה שלמה); מעטפת שגויה נדחית.
//  5. §4.4 — ה-Worker האמיתי (engine-worker-main) מחזיר את המודל בתוצאה;
//     הצרכן מקבל מודל תקין עם האשים זהים לבנייה ישירה.
'use strict';

const { describe, it, assert, assertEq, report } = require('../harness');
const fs = require('fs');
const path = require('path');
const { typeset } = require('../../src/engine/core/pipeline');
const { getDefaultSettings } = require('../../src/engine/core/settings-registry');
const { buildPageModel, geometryHashOf, contentHashOf } = require('../../src/engine/core/page-model');
const { MeasureAPI } = require('../../src/engine/typography/measure-api');
const { AssetResolver } = require('../../src/engine/assets/asset-resolver');
const { tinyPngFor } = require('../helpers/tiny-png');
const { serializeTypesetResult, serializePageModelTransport } = require('../../src/ui/worker-protocol');
const { receivePageModel } = require('../../src/ui/page-model-transport');
const { createEngineWorkerMain } = require('../../src/ui/engine-worker-main');
const { createShapedRun } = require('../../src/engine/typography/shaped-run');
const { projectShapedTextItemRanges } = require('../../src/engine/typography/paragraph-shaping');

const S = () => getDefaultSettings();
const CORPUS = fs.readFileSync(path.join(__dirname, '../fixtures/canonical_corpus.txt'), 'utf8');

/** probe אטום: כל קריאת measureTextWidth זורקת בזמן fn. */
function withMeasurementForbidden(fn) {
  const proto = MeasureAPI.prototype;
  const orig = proto.measureTextWidth;
  let violations = 0;
  proto.measureTextWidth = function () { violations++; throw new Error('production measured!'); };
  try { const out = fn(); return { out, violations }; } finally { proto.measureTextWidth = orig; }
}

describe('שלב 8 פרוסה 2 (§4.1) — חוזה PageModel מלא', () => {
  it('ריהוט מלא: סלוטי כותרת עליונה (x/w/גודל/גופן/צבע) וגיליון מלא (x/w/טקסט/גופן)', () => {
    const r = typeset(CORPUS, S());
    const pm = r.pageModel;
    let headers = 0, folios = 0;
    for (const p of pm.pages) {
      if (p.header) {
        headers++;
        assert(p.header.slots && p.header.slots.length >= 1, 'סלוט אחד לפחות');
        for (const s of p.header.slots) {
          assert(Number.isFinite(s.x) && Number.isFinite(s.w), 'מיקום/רוחב סלוט סופיים');
          assert(s.text, 'טקסט סלוט');
          assert(s.sizePt != null, 'גודל סלוט');
        }
      }
      if (p.folio) {
        folios++;
        assert(Number.isFinite(p.folio.x) && Number.isFinite(p.folio.w), 'מיקום/רוחב גיליון סופיים');
        assert(p.folio.text, 'טקסט גיליון');
        assert(p.folio.baselineY != null, 'בסיס גיליון');
      }
    }
    assert(headers >= 1 && folios >= 1, `ריהוט במודל (כותרות ${headers}, גיליונות ${folios})`);
  });

  it('bookmarks וקישורי TOC: outline מהטוקנים; מלבני קישור מחותמת ה-TOC (לא נוסחה מוקרנת)', () => {
    const r = typeset(CORPUS, S());
    const pm = r.pageModel;
    assert(pm.document.outline.length >= 3, `outline (${pm.document.outline.length})`);
    assert(pm.document.outline.every(o => o.title && Number.isInteger(o.page) && (o.level === 1 || o.level === 2)), 'פריטי outline שלמים');
    assert(pm.document.tocLinks.length >= 3, `tocLinks (${pm.document.tocLinks.length})`);
    assert(pm.document.tocLinks.every(l => Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.w) && Number.isFinite(l.h) && Number.isInteger(l.targetPage)), 'מלבני קישור גאומטריים מהחותמת');
    // המלבנים זהים לחותמת (לא נגזרו מחדש)
    const tp = r.pages.find(p => p.tocLayout && p.tocLayout.rows.length);
    const firstRow = tp.tocLayout.rows.find(row => row.kind !== 'group');
    const link = pm.document.tocLinks.find(l => l.page === tp.index);
    assert(Math.abs(link.x - firstRow.x) < 1e-9 && Math.abs(link.y - firstRow.y) < 1e-9, 'מלבן הקישור מהחותמת במדויק');
  });

  it('diagnostics והזמנות נושאים במודל; הסכמה וההאשים קיימים', () => {
    const r = typeset(CORPUS, S());
    const pm = r.pageModel;
    assertEq(pm.schema, 'pagemodel-v1');
    assert(Array.isArray(pm.diagnostics), 'מערך diagnostics על המודל');
    assert(pm.pages.every(p => Array.isArray(p.reservations)), 'הזמנות לכל עמוד');
    assert(typeof pm.geometryHash === 'string' && pm.geometryHash.length >= 16, 'geometryHash');
    assert(typeof pm.contentHash === 'string' && pm.contentHash.length >= 16, 'contentHash');
    assert(pm.pages.every(p => p.images && Array.isArray(p.images)), 'מערך תמונות לכל עמוד (ריק כשאין)');
  });

  it('S8-END1 נסגר: מצב endnotes — אפס הפרות (בעבר 105) + noteId לכל הערה', () => {
    const settings = S();
    settings['note-placement-mode'] = 'endnotes';
    const r = typeset(CORPUS, settings);
    assertEq(r.pageModelValidation.violations.length, 0, 'אפס הפרות במצב endnotes');
    const enNotes = r.pageModel.pages.flatMap(p => p.footnotes);
    assert(enNotes.length >= 40, `הערות סיום במודל (${enNotes.length})`);
    assert(enNotes.every(n => n.noteId), 'noteId לכל הערה');
    assert(enNotes.every(n => n.stampValid === true), 'חותמות תקפות');
    assert(enNotes.every(n => n.x != null && n.y != null), 'מיקום סופי לכל הערה');
  });
});

describe('שלב 8 פרוסה 2 (§4.2) — תמונות פריטים ממדרגה ראשונה', () => {
  const DOC_IMAGES = [
    'כותרת 1 - חלק',
    'פסקה עם תמונת inline #img/inline.png# בתוך הטקסט ועוד מילים אחריה לזרימה של השורה הראשונה.',
    'פסקה עם תמונת בלוק #img/block.png.c40# ממורכזת ועוד טקסט סביבה לזרימה של ההמשך.',
    'פסקה עם צף משמאל #img/left.png.l30# וטקסט שעוטף אותו מספיק ארוך כדי לרדת שורות אחדות לצד התמונה הצפה הזאת.',
    'פסקת סיום אמיתית.'
  ].join('\n');

  function resolver() {
    const ar = new AssetResolver();
    ar.addBytes('img/inline.png', tinyPngFor(8, 12));
    ar.addBytes('img/block.png', tinyPngFor(20, 30));
    ar.addBytes('img/left.png', tinyPngFor(10, 10));
    return ar;
  }

  it('inline + block + float במודל: גיאומטריה סופית, הצהרה, זהות נכס, resolved', () => {
    const r = typeset(DOC_IMAGES, S(), { assets: resolver() });
    const imgs = r.pageModel.pages.flatMap(p => p.images);
    const inline = imgs.find(i => i.placement === 'inline');
    const centered = imgs.find(i => i.placement === 'centered');
    const float = imgs.find(i => i.placement === 'float');
    assert(inline, 'תמונת inline במודל');
    assert(Number.isFinite(inline.x) && Number.isFinite(inline.y) && inline.w > 0, 'מיקום/רוחב סופיים ל-inline');
    assertEq(inline.natural.w, 8); assertEq(inline.natural.h, 12, 'מידות טבעיות מה-resolver');
    assert(inline.resolved === true, 'inline resolved');
    assert(centered && centered.w > 0, 'תמונת בלוק ממורכזת במודל');
    assert(float && float.side, 'צף עם צד');
    assert(float.resolved === true, 'float resolved');
    assert(float.w > 0 && float.h > 0, 'ממדי צף');
    assertEq(r.pageModel.meta.resources.referenced, imgs.filter(i => i.assetId).length, 'מלאי הנכסים תואם להפניות');
    assertEq(r.pageModel.meta.resources.unresolved, 0, 'אפס נכסים לא פתורים');
    assertEq(r.pageModelValidation.violations.length, 0, 'אפס הפרות עם תמונות');
    assert(r.contentPreserved, 'תוכן נשמר (תחביר התמונות בחשבונאות)');
  });

  it('נכס חסר ⇒ resolved:false + diagnostic — לא השתקה; טוהר הייצור נשמר גם עם תמונות', () => {
    const r = typeset(DOC_IMAGES, S()); // בלי resolver
    const imgs = r.pageModel.pages.flatMap(p => p.images);
    assert(imgs.length >= 3, `תמונות במודל גם בלי נכסים (${imgs.length})`);
    assert(imgs.every(i => i.resolved === false || i.assetId == null), 'לא פתור ללא resolver');
    const probe = withMeasurementForbidden(() => buildPageModel(r, {}));
    assertEq(probe.violations, 0, 'אפס מדידות ב-production גם עם תמונות (רוחב טקסט-המקור מוטבע בתכנון)');
    assertEq(probe.out.model.meta.materializeFallbacks, 0, 'אפס נפילות');
  });

  it('זהות הנכס מכתובת-התוכן (contentAssetId) — מה ש-resolvedAssetIds מחזיר', () => {
    const ar = resolver();
    const r = typeset(DOC_IMAGES, S(), { assets: ar });
    const resolved = new Set(ar.resolvedAssetIds());
    const imgs = r.pageModel.pages.flatMap(p => p.images).filter(i => i.assetId);
    assert(imgs.length >= 2, `תמונות עם assetId (${imgs.length})`);
    assert(imgs.every(i => resolved.has(i.assetId)), 'כל assetId במודל נפתר ב-resolver (אותה זהות קנונית)');
  });
});

describe('שלב 8 פרוסה 2 (§4.3) — חוזה העברת Worker', () => {
  it('עטיפה + structured clone אמיתי + קבלה: הקפאה מחד�, האשים זהים, העברה שלמה ביט-לביט', () => {
    const r = typeset(CORPUS, S());
    const envelope = serializePageModelTransport(r.pageModel);
    assertEq(envelope.transport, 'pagemodel-transport-v1');
    assert(envelope.bytesEstimate > 10000, `אומדן גודל ההעברה (${envelope.bytesEstimate} bytes)`);
    const cloned = structuredClone(envelope); // ההעברה האמיתית של גבול ה-Worker
    assert(!Object.isFrozen(cloned.model.pages), 'structured clone מפשיר הקפאות — כמתועד');
    const received = receivePageModel(cloned);
    assert(received.ok, 'קבלה תקינה: ' + JSON.stringify(received.error || ''));
    assertEq(received.model.geometryHash, r.pageModel.geometryHash, 'geometryHash עבר זהה');
    assertEq(received.model.contentHash, r.pageModel.contentHash, 'contentHash עבר זהה');
    // הוכחת שלמות תוכן: חישוב מחדש על העותק זהה ביט-לביט למקור
    assertEq(geometryHashOf(received.model), r.pageModel.geometryHash, 'גיאומטריה לא השתנתה בהעברה');
    assertEq(contentHashOf(received.model), r.pageModel.contentHash, 'תוכן לא השתנה בהעברה');
    // הקפאה מחדש — מוטציה נזרקת
    let threw = false;
    try { received.model.pages[0].index = 999; } catch (e) { threw = true; }
    assert(threw, 'המודל המתקבל קפוא (מוטציה ⇒ TypeError)');
    assert(received.metrics.pages === r.pageModel.pages.length, 'מדדי העברה: עמודים');
  });

  it('מעטפות שגויות נדחות מפורשות (גרסה/סכמה/האשים/עמודים)', () => {
    const r = typeset(CORPUS, S());
    const env = serializePageModelTransport(r.pageModel);
    assertEq(receivePageModel(null).ok, false, 'מעטפת ריקה');
    assertEq(receivePageModel({ ...env, transport: 'v0' }).ok, false, 'גרסת transport שגויה');
    assertEq(receivePageModel({ ...env, model: { ...env.model, schema: 'pagemodel-v0' } }).ok, false, 'סכמה שגויה');
    assertEq(receivePageModel({ ...env, geometryHash: 'deadbeefdeadbeefdeadbeefdeadbeef' }).ok, false, 'האש לא תואם');
    assertEq(receivePageModel({ ...env, model: { ...env.model, pages: [] } }).ok, false, 'אין עמודים');
  });

  it('§4.4 — ה-Worker האמיתי מחזיר את המודל בתוצאה; הצרכן מקבל מודל תקין (אין מסלול גולמי חלופי)', () => {
    const SMALL = ['כותרת 1 - חלק', 'פסקה ראשונה עם הערה [הערת שוליים אחת] ועוד כמה מילים לזרימה.', 'פסקה שנייה שסוגרת את המסמך הקטן בשלום.'].join('\n');
    let receivedMsg = null;
    const main = createEngineWorkerMain((m) => { receivedMsg = m; });
    main({ type: 'typeset-request', jobId: 'job-s8c', text: SMALL, settings: S() });
    assert(receivedMsg && receivedMsg.type === 'typeset-result', 'תוצאה הגיעה מה-Worker');
    const ser = receivedMsg.result;
    assertEq(ser.schema, 'ui-result-v1');
    assert(ser.pageModel && ser.pageModel.transport === 'pagemodel-transport-v1', 'המודל בתוצאה העוברת');
    const direct = typeset(SMALL, S());
    assertEq(ser.pageModel.geometryHash, direct.pageModel.geometryHash, 'האש גיאומטריה זהה לבנייה ישירה');
    const received = receivePageModel(structuredClone(ser.pageModel));
    assert(received.ok, 'קליטה בצד ה-UI');
    assertEq(received.model.geometryHash, direct.pageModel.geometryHash, 'המודל שנתקבל זהה');
    assertEq(received.metrics.pages, direct.pages.length, 'אותו מספר עמודים');
    assert(received.metrics.bytesEstimate > 5000, `גודל העברה (${received.metrics.bytesEstimate})`);
  });

  it('PageModel preserves glyph sidecars through Worker transport, hashes them, and leaves geometry unchanged', () => {
    const fixtureText = ['כותרת 1 - חלק', 'שלום עולם, זהו מסמך קצר לצורך בדיקת שימור נתוני גליפים ב-PageModel.', 'פסקת סיום אמיתית.'].join('\n');
    const r = typeset(fixtureText, S());
    const baselineModel = r.pageModel;
    let injected = false;
    const shapedPages = r.pages.map(page => ({
      ...page,
      columns: (page.columns || []).map(column => column.map(line => {
        if (injected || !line.lineModel || !Array.isArray(line.lineModel.fragments)) return line;
        let targetText = null;
        const target = line.lineModel.fragments.find(fragment => {
          if (fragment.kind !== 'text' || !Array.isArray(fragment.fragments) ||
              fragment.fragments.length !== 1 || !fragment.sourceRange ||
              !Number.isSafeInteger(fragment.sourceRange.start)) return false;
          const candidate = String(fragment.fragments[0].text || '');
          if (candidate.length !== 4 || !/^\p{Script=Hebrew}{4}$/u.test(candidate) ||
              /\p{M}/u.test(candidate) ||
              fragment.sourceRange.end - fragment.sourceRange.start !== candidate.length) return false;
          targetText = candidate;
          return true;
        });
        if (!target) return line;
        const text = targetText;
        const start = target.sourceRange.start;
        const end = target.sourceRange.end;
        let sourceCursor = start;
        const graphemes = Array.from(text, character => {
          const grapheme = { start: sourceCursor, end: sourceCursor + character.length, text: character };
          sourceCursor += character.length;
          return grapheme;
        });
        const glyphs = graphemes.map((grapheme, index) => ({
          gid: index + 1,
          cluster: grapheme.start,
          xAdvance: 600,
          yAdvance: 0,
          xOffset: index === 1 ? 12 : 0,
          yOffset: index === 1 ? -24 : 0,
          flags: 0,
          controlBounds: null,
          inkBounds: null
        })).reverse();
        const shapedRun = createShapedRun({
          id: 'pagemodel-sidecar#hebrew-word',
          text,
          sourceRange: {
            start, end,
            blockId: target.sourceRange.blockId || 's8c-sidecar',
            itemId: target.sourceRange.itemId || target.itemId
          },
          font: {
            fontId: 'fnt-page-model-sidecar',
            faceIndex: 0,
            unitsPerEm: 2048,
            sourceHash: 'a'.repeat(64)
          },
          shaping: {
            engine: 'harfbuzz',
            engineVersion: '15.0.0',
            unicodeVersion: '18.0.0',
            script: 'Hebr',
            language: 'he',
            direction: 'rtl',
            bidiLevel: 1,
            bot: true,
            eot: true,
            clusterLevel: 'monotone-characters',
            variationAxes: [],
            features: [{ tag: 'kern', value: 1 }]
          },
          graphemes,
          glyphs
        });
        const shapedTextItem = {
          kind: 'ShapedTextItem',
          itemId: target.sourceItemId || target.itemId,
          text,
          sourceRange: { start, end },
          shapedRuns: [shapedRun],
          nonShapingRuns: []
        };
        const shapingSlices = projectShapedTextItemRanges(shapedTextItem, [{ start, end }]);
        const lineModel = {
          ...line.lineModel,
          fragments: line.lineModel.fragments.map(fragment =>
            fragment.itemId === target.itemId ? { ...fragment, shapingSlices } : fragment
          ),
          flow: line.lineModel.flow.map(step =>
            step.type === 'box' && step.itemId === target.itemId
              ? { ...step, shapingSlices } : step
          )
        };
        injected = true;
        return { ...line, lineModel };
      }))
    }));
    assert(injected, 'a plain Hebrew word with a source range was found and shaped');

    const built = buildPageModel({ ...r, pages: shapedPages }, {});
    assertEq(built.validation.violations.length, 0,
      'glyph sidecar remains valid in PageModel: ' + JSON.stringify(built.validation.violations.slice(0, 2)));
    const line = built.model.pages.flatMap(page => page.lines).find(item => item.typography);
    assert(line, 'PageModel retains a line-level typography sidecar');
    assertEq(line.typography.contractVersion, 'page-line-typography-v1');
    assertEq(line.typography.fragments.length, 1, 'one shaped word fragment retained');
    assertEq(line.typography.flow.length, 1, 'the corresponding visual-flow box retained');
    assertEq(line.typography.fragments[0].shapingSlices.glyphCount, 4, 'all four glyphs retained');
    const offsetGlyph = line.typography.fragments[0].shapingSlices.shapedRuns[0].glyphs.find(glyph => glyph.xOffset === 12);
    assert(offsetGlyph, 'non-zero horizontal glyph offset survives PageModel materialization');
    assertEq(offsetGlyph.yOffset, -24, 'vertical mark offset survives PageModel materialization');
    assertEq(built.model.geometryHash, baselineModel.geometryHash,
      'glyph sidecar does not alter page geometry or word positions');
    assert(built.model.contentHash !== baselineModel.contentHash,
      'content hash covers glyph IDs/clusters/advances/offsets');

    const envelope = serializePageModelTransport(built.model);
    const received = receivePageModel(structuredClone(envelope));
    assert(received.ok, 'PageModel with glyph sidecar passes the real transport receiver');
    const receivedLine = received.model.pages.flatMap(page => page.lines).find(item => item.typography);
    assert(receivedLine, 'glyph sidecar survives structured clone');
    const receivedOffsetGlyph = receivedLine.typography.fragments[0].shapingSlices.shapedRuns[0].glyphs.find(glyph => glyph.xOffset === 12);
    assertEq(receivedOffsetGlyph.yOffset, -24, 'glyph positioning survives Worker transport');
    assert(Object.isFrozen(receivedOffsetGlyph), 'received glyph record is immutable');
    const tampered = structuredClone(envelope);
    tampered.model.pages.flatMap(page => page.lines)
      .find(item => item.typography)
      .typography.fragments[0].shapingSlices.shapedRuns[0].glyphs[0].gid += 1;
    assertEq(receivePageModel(tampered).ok, false,
      'glyph-level tampering is rejected by the PageModel content hash');
  });

});

report('s8c-pagemodel-contract');
