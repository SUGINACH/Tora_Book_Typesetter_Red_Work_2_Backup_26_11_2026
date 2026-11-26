// src/engine/assets/asset-resolver.js — Asset Resolver יחיד (שלב 3, §3.1-1/2/11)
'use strict';

/**
 * **חוזה:** spec/00_CURRENT_ENGINE_COMPLETION_PLAN.md §3.1 — "להגדיר Asset Resolver
 * יחיד לנכסי מסמך: קובץ מקומי, ZIP, תיקייה, מזהה פנימי או data source נתמך.
 * פתרון שם/נתיב חייב להיות דטרמיניסטי ובטוח."
 *
 * **עקרונות:**
 * - **זהות content-addressed:** assetId = `ast-<kind>-<sha256(bytes)[:14]>` — אותם
 *   בתים ⇒ אותו מזהה, בכל סביבה ובכל ריצה (זהות בין ריצות מוכחת בבדיקות).
 * - **פתרון נתיב בטוח:** נורמליזציה אחידה, מניעת `..`/absolute/חוץ-שורש, הרשמת
 *   סיומות נתמכות בלבד. דחייה = אבחון מפורש {code, message, ref} — לא נעלם.
 * - **סביבת-אגנוסטיות:** אין fs/DOM כאן. מקורות חיצוניים (תיקייה/קובץ מקומי)
 *   מסופקים כ-provider — פונקציה שמחזירה בתים לפי נתיב מנורמל; ב-Node זו fs,
 *   בדפדפן File API — האחריות על הסביבה בקצה, ה-resolver טהור.
 * - **ZIP:** דרך zip-reader הקיים (אותו מנגנון כמו חבילת הפרויקט).
 * - **Worker transport:** סריאליזציה מפורשת לבתים + מזהים — אין העברת נתיב
 *   מקומי ואין גישה סמויה של ה-Worker למערכת הקבצים (§3.1-2).
 *
 * **מדידה:** measureImageMeta הקנוני (bytes אמיתיים — PNG/JPEG/GIF/BMP/WebP/SVG)
 * ממלא naturalWidth/Height/aspectRatio/orientation; fit/scale נפתרים מהאילוצים
 * של הפריט (widthPct/align) ב-measureItem של MeasureAPI.
 */

const { sha256Hex } = require('./hash256');
const { measureImageMeta } = require('./image-meta');

/** סיות נתמכות — הרשימה שהמוצר תומך בה בפועל (inline-content + מרשם העיטורים). */
const SUPPORTED_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg']);

/** נורמליזציית נתיב: מאחדת / ו-\, מפרקת .. ו-., דוחה absolute וריק. מחזירה חלקים. */
function normalizeRefPath(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return { ok: false, code: 'empty-ref', message: 'הפניית נכס ריקה' };
  const raw = ref.trim().replace(/\\/g, '/');
  if (raw.startsWith('/')) return { ok: false, code: 'absolute-path', message: `נתיב אבסולוטי אסור: ${ref}` };
  if (/^[a-zA-Z]:/.test(raw)) return { ok: false, code: 'absolute-path', message: `כונן אבסולוטי אסור: ${ref}` };
  if (raw.includes('\0')) return { ok: false, code: 'nul-in-path', message: 'תו NUL בנתיב' };
  const parts = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return { ok: false, code: 'path-traversal', message: `נתיב חורג כלפי מעלה (path traversal): ${ref}` };
    parts.push(seg);
  }
  if (!parts.length) return { ok: false, code: 'empty-ref', message: `הפניית נכס ריקה: ${ref}` };
  const last = parts[parts.length - 1];
  const dot = last.lastIndexOf('.');
  const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : null;
  return { ok: true, parts, normalized: parts.join('/'), ext };
}

function kindOfExt(ext) {
  if (ext === 'svg') return 'svg';
  return 'image';
}

class AssetResolver {
  constructor(opts = {}) {
    this._byId = new Map();       // assetId → asset record
    this._byRef = new Map();      // ref (מנורמל) → assetId
    this._providers = [];         // ספקי סביבה: (normalizedPath) → bytes|null
    this.diagnostics = [];        // כל דחייה/שגיאה — מתועדת, לא שקטה
    this._strict = opts.strict === true; // strict: דחייה ראשונה זורקת (בדיקות)
  }

  _diag(code, message, ref) {
    const d = { code, message, ref: ref != null ? String(ref) : null };
    this.diagnostics.push(d);
    if (this._strict) { const e = new Error(`asset-resolver: ${code}: ${message}`); e.code = code; throw e; }
    return { ok: false, ...d };
  }

  /** רישום בתים ישירות (מזהה פנימי / data source נתמך). מקור הסמכות לזהות. */
  addBytes(ref, bytes, meta = {}) {
    const norm = normalizeRefPath(ref);
    if (!norm.ok) return this._diag(norm.code, norm.message, ref);
    if (!bytes || !bytes.length) return this._diag('empty-bytes', 'נכס ללא בתים', ref);
    if (norm.ext && !SUPPORTED_EXTENSIONS.includes(norm.ext)) {
      return this._diag('unsupported-extension', `סיומת .${norm.ext} אינה נתמכת (נתמכות: ${SUPPORTED_EXTENSIONS.join('/')})`, ref);
    }
    const kind = kindOfExt(norm.ext || meta.format || 'image');
    const assetId = `ast-${kind}-${sha256Hex(bytes).slice(0, 14)}`;
    // רישום כפול של אותו תוכן תחת אותו ref — idempotent; תוכן שונה תחת אותו ref — דחייה מפורשת
    const existingRef = this._byRef.get(norm.normalized);
    if (existingRef != null) {
      const existing = this._byId.get(existingRef);
      if (existing && existing.assetId === assetId) return { ok: true, assetId, asset: existing, duplicate: true };
      return this._diag('ref-conflict', `הפניה '${norm.normalized}' כבר ממופה לנכס אחר (${existingRef})`, ref);
    }
    let record = this._byId.get(assetId);
    if (!record) {
      const measured = kind === 'image' || kind === 'svg' ? measureImageMeta(bytes) : null;
      if (measured && !measured.ok) {
        this.diagnostics.push({ code: measured.code, message: measured.message, ref: norm.normalized, assetId });
        // הנכס נרשם בכל זאת (לחשבונאות) עם מדידה שנכשלה — המדידה הכושלת היא האבחון; הפריט לא נעלם.
        record = { assetId, kind, refs: [], bytes, meta: { ...meta }, measured: { ok: false, code: measured.code, message: measured.message } };
      } else {
        record = { assetId, kind, refs: [], bytes, meta: { ...meta }, measured: measured || null };
      }
      this._byId.set(assetId, record);
    }
    record.refs.push(norm.normalized);
    this._byRef.set(norm.normalized, assetId);
    return { ok: true, assetId, asset: record, duplicate: false };
  }

  /** מקור ZIP: כל הרשומות עם סיומת נתמכת נרשמות (שמות מנורמלים+מאובטחים). */
  addZip(bytes) {
    const { readZip } = require('../import/zip-reader');
    const z = readZip(bytes);
    if (!z.ok) return this._diag('zip-error', `קריאת ZIP נכשלה: ${z.error}`, null);
    const results = { ok: true, registered: 0, rejected: [] };
    for (const e of z.entries) {
      const norm = normalizeRefPath(e.name);
      if (!norm.ok) { results.rejected.push({ ref: e.name, code: norm.code }); this.diagnostics.push({ code: norm.code, message: norm.message, ref: e.name }); continue; }
      const r = this.addBytes(norm.normalized, e.data, { source: 'zip' });
      if (r.ok) results.registered++;
      else results.rejected.push({ ref: e.name, code: r.code });
    }
    results.ok = results.rejected.length === 0;
    return results;
  }

  /** מקור תיקייה/מערכת קבצים: ספק סביבתי מחזיר בתים לפי נתיב מנורמל. */
  addProvider(fn) {
    if (typeof fn !== 'function') return this._diag('bad-provider', 'ספק חייב להיות פונקציה', null);
    this._providers.push(fn);
    return { ok: true, providers: this._providers.length };
  }

  /** רישום מראש של רשימת נתיבים דרך הספקים (folder scan בצד הסביבה). */
  addRefList(refs) {
    if (!Array.isArray(refs)) return this._diag('bad-ref-list', 'רשימת הפניות אינה מערך', null);
    const results = { ok: true, registered: 0, rejected: [] };
    for (const ref of refs) {
      const r = this.resolve(ref);
      if (r.ok) results.registered++;
      else results.rejected.push({ ref, code: r.code });
    }
    results.ok = results.rejected.length === 0;
    return results;
  }

  /** פתרון הפנייה → נכס (רשום או דרך ספק). דטרמיניסטי: אותה הפנייה ⇒ אותו נכס. */
  resolve(ref) {
    const norm = normalizeRefPath(ref);
    if (!norm.ok) return this._diag(norm.code, norm.message, ref);
    const hit = this._byRef.get(norm.normalized);
    if (hit != null) {
      const asset = this._byId.get(hit);
      return { ok: true, assetId: hit, asset, source: 'registered' };
    }
    // ספקים — לפי סדר רישום; הראשון שמחזיר בתים קובע (דטרמיניסטי)
    for (const p of this._providers) {
      let bytes = null;
      try { bytes = p(norm.normalized); } catch (e) {
        this.diagnostics.push({ code: 'provider-error', message: e && e.message, ref: norm.normalized });
        continue;
      }
      if (bytes && bytes.length) {
        const r = this.addBytes(norm.normalized, bytes, { source: 'provider' });
        if (r.ok) return { ok: true, assetId: r.assetId, asset: r.asset, source: 'provider' };
        return r;
      }
    }
    return this._diag('not-found', `נכס לא נמצא: ${norm.normalized}`, ref);
  }

  /** לפי מזהה פנימי (הזהות הקנונית שנשמרת במודל). */
  resolveById(assetId) {
    const a = this._byId.get(String(assetId));
    if (!a) return this._diag('unknown-asset-id', `מזהה נכס לא רשום: ${assetId}`, assetId);
    return { ok: true, assetId: String(assetId), asset: a, source: 'id' };
  }

  /** מדידת נכס — החוזה של §3.1-3 (מחזיר את מה שנמדד, כולל כישלון מתועד). */
  measure(assetIdOrRef) {
    const r = String(assetIdOrRef).startsWith('ast-') ? this.resolveById(assetIdOrRef) : this.resolve(assetIdOrRef);
    if (!r.ok) return r;
    const a = r.asset;
    if (!a.measured) return this._diag('not-measurable', `נכס מסוג ${a.kind} אינו תמונה למדידה`, assetIdOrRef);
    return { ok: a.measured.ok, assetId: r.assetId, ...a.measured };
  }

  /** משלוח ל-Worker: בתים + מזהים בלבד — אין נתיבים מקומיים (§3.1-2). */
  serializeForTransport(maxBytes = 64 * 1024 * 1024) {
    const assets = [];
    let total = 0;
    // **שלב 4 מקטע ב׳ (הוראה §6 — אותן זהויות בשני הצדדים):**
    // השיוול כולל גם את שמות הניווט היחסיים של המסמך (resourcePath כגון
    // img/x.png) — אלו מזהי מסמך, לא נתיבי מערכת; בלי המפה הזו המודל בצד העובד לא יכל לפתור את התמונות לפי מקום המועד.
    const refsOf = new Map();
    for (const [ref, assetId] of this._byRef) {
      if (String(ref).startsWith('transport/')) continue; // שמות פנימיים של ההעברה חוזרות — לא משודרים
      if (!refsOf.has(assetId)) refsOf.set(assetId, []);
      refsOf.get(assetId).push(ref);
    }
    for (const [assetId, a] of this._byId) {
      total += a.bytes.length;
      if (total > maxBytes) return this._diag('transport-limit', `חריגת תקרת העברה (${maxBytes} בתים)`, assetId);
      const refs = refsOf.get(assetId);
      assets.push({ assetId, kind: a.kind, bytes: a.bytes.slice(), ...(refs && refs.length ? { refs } : {}) });
    }
    return { ok: true, schema: 'asset-transport-v1', assets };
  }

  /** שחזור בצד ה-Worker — אותם מזיחים (content-addressed) ואותן מדיות.
   * **תיקון ביקורת PR #22 (אימות שלמות transport):** המזהה המוצהר
   * חייב להתאים לזהות המחושבת מחדש מהבתים (`ast-<kind>-<sha256[:14]>`).
   * אין קבלת assetId מוצהר שאינו תואם לתוכן ואין התעלמות שקטה מהפער: כל דחייה
   * נרשמת בדיאגנוסטיקה ובדו"ח transportReport; השאר הנכסים נרשמים כרגיל
   * (הפריטים שנדחו יקבלו דחיית מדידה מפורשת במורדה—לא נעלמים).
   * @param {object} msg — פלט serializeForTransport
   * @param {{maxBytes?:number, strict?:boolean}} opts — תקרת העברה כוללת (ברירת מחדל 64MB, כמו בשילוח) */
  static fromTransport(msg, opts = {}) {
    const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 64 * 1024 * 1024;
    const r = new AssetResolver(opts);
    if (!msg || msg.schema !== 'asset-transport-v1' || !Array.isArray(msg.assets)) {
      r._diag('bad-transport', 'הודעת העברה שגויה (schema לא asset-transport-v1)', null);
      r.transportReport = Object.freeze({ ok: false, registered: 0, rejected: Object.freeze([{ code: 'bad-transport' }]) });
      return r;
    }
    let registered = 0;
    let total = 0;
    const rejected = [];
    const seen = new Map(); // assetId → אורך בתים (לכידת כפילויות לאחר אימות)
    for (const a of msg.assets) {
      if (!a || typeof a.assetId !== 'string' || !a.assetId.startsWith('ast-')) {
        rejected.push({ assetId: a && a.assetId, code: 'bad-asset-id' });
        r.diagnostics.push({ code: 'bad-asset-id', message: 'מזהה נכס שגוי בהעברה', ref: a && a.assetId });
        continue;
      }
      let bytes = a.bytes;
      if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes); // ArrayBuffer גולמי → תצוגה
      // תצוגות (Uint8Array/Buffer) נשמרות כמו שהן — האימות להלן קורא רק אורך ותוכן
      if (!bytes || !bytes.length) {
        rejected.push({ assetId: a.assetId, code: 'empty-bytes' });
        r.diagnostics.push({ code: 'empty-bytes', message: `נכס ללא בתים בהעברה: ${a.assetId}`, ref: a.assetId });
        continue;
      }
      // אימות שלמות: המזהה המוצהר מול הזהות המחושבת מהבתים
      const m = /^ast-(image|svg)-([0-9a-f]{14})$/.exec(a.assetId);
      const computed = m ? `ast-${m[1]}-${sha256Hex(bytes).slice(0, 14)}` : null;
      if (!computed || computed !== a.assetId) {
        rejected.push({ assetId: a.assetId, code: 'asset-id-mismatch', computed: computed || 'unparseable' });
        r.diagnostics.push({ code: 'asset-id-mismatch', message: `מזהה מוצהר ${a.assetId} אינו תואם לתוכן (חושב ${computed})`, ref: a.assetId });
        continue;
      }
      // כפילות: אותו מזהה שעבר אימות ואותו אורך בתים — idempotent; כפילות סותרת נמצאה ברומה על ידי אימות התוכן
      const prevLen = seen.get(a.assetId);
      if (prevLen != null) {
        if (prevLen === bytes.length) { registered++; continue; }
        rejected.push({ assetId: a.assetId, code: 'duplicate-id' });
        r.diagnostics.push({ code: 'duplicate-id', message: `מזהה נכס כפול בהעברה: ${a.assetId}`, ref: a.assetId });
        continue;
      }
      total += bytes.length;
      if (total > maxBytes) {
        rejected.push({ assetId: a.assetId, code: 'transport-limit', totalBytes: total, maxBytes });
        r.diagnostics.push({ code: 'transport-limit', message: `חריעת תקרת העברה (${maxBytes} בתים) בנכס ${a.assetId}`, ref: a.assetId });
        continue;
      }
      seen.set(a.assetId, bytes.length);
      // format מהמזהה עצמו (מושגג כבר באימות) — הסוג שומר על זהות הנכס משני הצדדים.
      // **מקטע ב׳:** רישום מחדש גם תחת שמות הנייוט המקוריים של המסמך
      // (refs מהשיוול) — צד העובד מודד את התמונות לפי אותן נקודות עיגון בדיוק
      // (אותו מדדר זיהות: מזהה-תוכן מהביתים).
      const regRefs = (Array.isArray(a.refs) ? a.refs : []).filter(x => typeof x === 'string' && x && !String(x).startsWith('transport/'));
      const addFirst = regRefs.length
        ? r.addBytes(regRefs[0], bytes, { source: 'worker-transport', format: m[1] })
        : r.addBytes(`transport/${a.assetId}`, bytes, { source: 'worker-transport', format: m[1] });
      if (addFirst.ok) {
        registered++;
        for (const extra of regRefs.slice(1)) {
          const alias = r.addBytes(extra, bytes, { source: 'worker-transport', format: m[1] });
          if (!alias.ok) rejected.push({ assetId: a.assetId, ref: extra, code: alias.code });
        }
      } else {
        rejected.push({ assetId: a.assetId, code: addFirst.code });
      }
    }
    r.transportReport = Object.freeze({ ok: rejected.length === 0, registered, rejected: Object.freeze(rejected) });
    return r;
  }

  /** איפוס אוסף נכסי המסמך כאשר פותחים/מנקים מסמך חדש. */
  clear() {
    this._byId.clear();
    this._byRef.clear();
    this._providers.length = 0;
    this.diagnostics.length = 0;
    this.transportReport = null;
    return this;
  }

  /** סטטיסטיקה + אבחונים (לדוחות). */
  stats() {
    return { assets: this._byId.size, refs: this._byRef.size, providers: this._providers.length, diagnostics: this.diagnostics.length };
  }

  /** **שלב 7 (§21-10 — אינטגריטי נכסים):** מזהי הנכסים שנפתרו בפועל — קריאה
   * בלבד, ממויגת (דטרמיניזם); ה-PageModel מאמת מולה שכל הפניה ב-LineModel נפתרה. */
  resolvedAssetIds() {
    return [...this._byId.keys()].sort();
  }
}

module.exports = { AssetResolver, normalizeRefPath, SUPPORTED_EXTENSIONS };
