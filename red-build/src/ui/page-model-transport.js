// src/ui/page-model-transport.js — קבלת PageModel מעבר לגבול ה-Worker (שלב 8 פרוסה 2, §4.3)
'use strict';

const { geometryHashOf, contentHashOf } = require('../engine/core/page-model-hashes');

/**
 * **חוזה ההעברה (pagemodel-transport-v1):** ה-Worker בונה את המודל וסריאליזציית
 * הפרוטוקול (ui-result-v1) עוטפת אותו עם גרסת transport + ההאשים שחושבו
 * בצד הבונה. structured clone מפשיר הקפאות — לכן הצד המקבל:
 *   1. מאמת סכמה, גרסאות ומבנה בסיסי.
 *   2. מאמת שההאשים שבמעטפת תואמים לאלה שעל המודל.
 *   3. מחשב מחדש geometryHash ו-contentHash מהתוכן שהתקבל, כדי לזהות שינוי
 *      בשדות הגאומטריים ובתוכן/נתוני הגליפים לאחר יצירת המודל.
 *   4. מקפיא מחדש עמוק ומדווח מדדי העברה.
 *
 * האימות מחשב fingerprints בלבד: הוא אינו מפעיל עימוד, מדידה, shaping או
 * החלטת layout שנייה. שני הצדדים צורכים את אותו חוזה hashes משותף.
 */

const TRANSPORT_VERSION = 'pagemodel-transport-v1';
const MODEL_SCHEMA = 'pagemodel-v1';

/** הקפאה עמוקה — ראי ההתנהגות של deepFreeze בבונה (core/page-model.js). */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * קבלת המודל מההודעה העוברת את גבול ה-Worker.
 * @param {object} envelope — {transport, schema, model, geometryHash, contentHash, bytesEstimate}
 * @returns {{ok:boolean, error?:string, model?:object, metrics?:object}}
 */
function receivePageModel(envelope) {
  if (envelope == null) return { ok: false, error: 'empty-envelope' };
  if (envelope.transport !== TRANSPORT_VERSION) {
    return { ok: false, error: `transport-version-mismatch:${envelope.transport}` };
  }
  if (envelope.schema !== MODEL_SCHEMA) {
    return { ok: false, error: `envelope-schema-mismatch:${envelope.schema}` };
  }
  const model = envelope.model;
  if (!model || typeof model !== 'object') return { ok: false, error: 'no-model' };
  if (model.schema !== MODEL_SCHEMA) {
    return { ok: false, error: `schema-mismatch:${model.schema}` };
  }
  if (!Array.isArray(model.pages) || !model.pages.length) {
    return { ok: false, error: 'no-pages' };
  }
  if (typeof model.geometryHash !== 'string' || model.geometryHash.length !== 64 ||
      typeof model.contentHash !== 'string' || model.contentHash.length !== 64) {
    return { ok: false, error: 'missing-or-invalid-hashes' };
  }
  // First compare the envelope claims with the hashes carried by the model.
  if (envelope.geometryHash !== model.geometryHash || envelope.contentHash !== model.contentHash) {
    return { ok: false, error: 'envelope-hash-mismatch' };
  }
  // Then recompute both canonical fingerprints over the received payload.
  let actualGeometryHash;
  let actualContentHash;
  try {
    actualGeometryHash = geometryHashOf(model);
    actualContentHash = contentHashOf(model);
  } catch (error) {
    return {
      ok: false,
      error: 'hash-verification-failed:' + (error && error.message ? error.message : String(error))
    };
  }
  if (actualGeometryHash !== model.geometryHash || actualContentHash !== model.contentHash) {
    return { ok: false, error: 'model-hash-mismatch' };
  }
  // structured clone מפשיר; המודל שוב immutable בצד הצרכן.
  deepFreeze(model);
  const lines = model.pages.reduce((a, p) => a + (p.lines ? p.lines.length : 0), 0);
  return {
    ok: true,
    model,
    metrics: {
      pages: model.pages.length,
      lines,
      bytesEstimate: envelope.bytesEstimate != null ? envelope.bytesEstimate : null,
      transport: TRANSPORT_VERSION
    }
  };
}

module.exports = { TRANSPORT_VERSION, receivePageModel, deepFreeze };
