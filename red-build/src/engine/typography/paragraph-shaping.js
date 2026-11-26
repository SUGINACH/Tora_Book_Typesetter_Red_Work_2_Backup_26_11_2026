'use strict';

const { createTextItemShapingPlan } = require('./text-item-shaping-plan');
const { sliceShapedRun, isShapedRun } = require('./shaped-run');

function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail('invalid-paragraph-shaping-config', label + ' must be a plain object');
  return value;
}

/**
 * Create an explicit, opt-in paragraph shaping service.
 * Runtime and font policy are fixed at construction; direction is supplied per item.
 * This service does not activate itself and never changes measurement.
 */
function createParagraphShaper(options = {}) {
  requireRecord(options, 'options');
  const runtime = options.runtime;
  const fontResolver = options.fontResolver;
  if (!runtime || !runtime.unicode ||
      typeof runtime.unicode.resolve !== 'function' ||
      typeof runtime.unicode.itemizeScripts !== 'function' ||
      typeof runtime.createShaper !== 'function') {
    fail('paragraph-shaping-runtime-unavailable', 'A verified Unicode/HarfBuzz runtime is required');
  }
  if (!fontResolver || typeof fontResolver.resolveFontForGrapheme !== 'function' ||
      typeof fontResolver.resolveFontById !== 'function') {
    fail('paragraph-shaping-font-resolver-unavailable', 'The canonical FontResolver is required');
  }

  const languageByScript = requireRecord(options.languageByScript, 'languageByScript');
  const featuresByScript = requireRecord(options.featuresByScript, 'featuresByScript');
  const variationAxesByFontId = requireRecord(options.variationAxesByFontId, 'variationAxesByFontId');
  const faceIndexByFontId = options.faceIndexByFontId == null
    ? Object.create(null)
    : requireRecord(options.faceIndexByFontId, 'faceIndexByFontId');
  const fallbacksByFamily = options.fallbacksByFamily == null
    ? Object.create(null)
    : requireRecord(options.fallbacksByFamily, 'fallbacksByFamily');
  const defaultFamily = options.defaultFamily == null ? null : String(options.defaultFamily);
  if (defaultFamily != null && !defaultFamily.trim()) {
    fail('invalid-paragraph-shaping-config', 'defaultFamily must be non-empty when supplied');
  }

  const shaper = runtime.createShaper(fontResolver, options.shaperOptions || {});
  if (!shaper || typeof shaper.shapeTextItemPlan !== 'function') {
    fail('paragraph-shaping-adapter-unavailable', 'Runtime did not create a valid HarfBuzz shaper');
  }

  return Object.freeze({
    shapeTextItem(item, request = {}) {
      if (!isRecord(request) || (request.direction !== 'ltr' && request.direction !== 'rtl')) {
        fail('paragraph-shaping-direction-required', 'Each TextItem requires an explicit paragraph direction');
      }
      const plan = createTextItemShapingPlan(item, {
        bidiRuntime: runtime.unicode,
        fontResolver,
        direction: request.direction,
        defaultFamily,
        languageByScript,
        featuresByScript,
        variationAxesByFontId,
        faceIndexByFontId,
        fallbacksByFamily
      });
      const shaped = shaper.shapeTextItemPlan(plan);
      if (!shaped || shaped.kind !== 'ShapedTextItem' ||
          shaped.itemId !== item.id || shaped.text !== plan.text ||
          !Array.isArray(shaped.shapedRuns) || !Array.isArray(shaped.nonShapingRuns)) {
        fail('invalid-shaped-text-item', 'HarfBuzz adapter returned an incomplete ShapedTextItem');
      }
      return shaped;
    }
  });
}

function projectShapedTextItemRange(shapedTextItem, range) {
  if (!isRecord(shapedTextItem) || shapedTextItem.kind !== 'ShapedTextItem' ||
      typeof shapedTextItem.text !== 'string' || !isRecord(shapedTextItem.sourceRange) ||
      !Array.isArray(shapedTextItem.shapedRuns) || !Array.isArray(shapedTextItem.nonShapingRuns)) {
    fail('invalid-shaped-text-item', 'Range projection requires a canonical ShapedTextItem');
  }
  if (!isRecord(range) || !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) || range.end <= range.start) {
    fail('invalid-shaped-source-range', 'Requested source range must be a non-empty UTF-16 interval');
  }
  const itemStart = shapedTextItem.sourceRange.start;
  const itemEnd = shapedTextItem.sourceRange.end;
  if (!Number.isSafeInteger(itemStart) || !Number.isSafeInteger(itemEnd) ||
      itemEnd - itemStart !== shapedTextItem.text.length ||
      range.start < itemStart || range.end > itemEnd) {
    fail('shaped-source-range-outside-item', 'Requested source range falls outside the ShapedTextItem envelope');
  }

  const pieces = [];
  for (const run of shapedTextItem.shapedRuns) {
    if (!isShapedRun(run)) fail('invalid-shaped-run', 'ShapedTextItem contains a non-canonical ShapedRun');
    const start = Math.max(range.start, run.sourceRange.start);
    const end = Math.min(range.end, run.sourceRange.end);
    if (end <= start) continue;
    const slice = start === run.sourceRange.start && end === run.sourceRange.end
      ? run
      : sliceShapedRun(run, start, end);
    pieces.push({
      kind: 'shape',
      sourceRange: { start, end },
      shapedRun: slice
    });
  }

  for (const run of shapedTextItem.nonShapingRuns) {
    if (!isRecord(run) || !Array.isArray(run.sourceRanges) || typeof run.text !== 'string' ||
        !Number.isSafeInteger(run.start) || !Number.isSafeInteger(run.end) ||
        run.end <= run.start || run.end - run.start !== run.text.length) {
      fail('invalid-non-shaping-run', 'Non-shaping source runs must retain exact UTF-16 coordinates and text');
    }
    for (const segment of run.sourceRanges) {
      if (!isRecord(segment) || !isRecord(segment.localRange) || !isRecord(segment.sourceRange)) {
        fail('invalid-non-shaping-source-map', 'Non-shaping source segment has an invalid range map');
      }
      const localStart = segment.localRange.start;
      const localEnd = segment.localRange.end;
      const sourceStart = segment.sourceRange.start;
      const sourceEnd = segment.sourceRange.end;
      if (![localStart, localEnd, sourceStart, sourceEnd].every(Number.isSafeInteger) ||
          localStart < run.start || localEnd > run.end || localEnd <= localStart ||
          sourceEnd <= sourceStart || localEnd - localStart !== sourceEnd - sourceStart) {
        fail('invalid-non-shaping-source-map', 'Non-shaping source segment is not a length-preserving UTF-16 map');
      }
      const start = Math.max(range.start, sourceStart);
      const end = Math.min(range.end, sourceEnd);
      if (end <= start) continue;
      const localSliceStart = localStart + (start - sourceStart);
      const localSliceEnd = localSliceStart + (end - start);
      pieces.push({
        kind: run.kind,
        text: run.text.slice(localSliceStart - run.start, localSliceEnd - run.start),
        sourceRange: { start, end },
        localRange: { start: localSliceStart, end: localSliceEnd }
      });
    }
  }

  pieces.sort((a, b) => a.sourceRange.start - b.sourceRange.start || a.sourceRange.end - b.sourceRange.end);
  let cursor = range.start;
  for (const piece of pieces) {
    if (piece.sourceRange.start !== cursor || piece.sourceRange.end <= cursor) {
      fail('shaped-slice-source-coverage', 'Shaped slices contain a source gap or overlap at UTF-16 offset ' + cursor);
    }
    cursor = piece.sourceRange.end;
  }
  if (cursor !== range.end) {
    fail('shaped-slice-source-coverage', 'Shaped slices do not cover requested source end ' + range.end);
  }

  const shapedRuns = pieces.filter(piece => piece.kind === 'shape').map(piece => piece.shapedRun);
  const nonShapingRuns = pieces.filter(piece => piece.kind !== 'shape');
  const glyphCount = shapedRuns.reduce((sum, run) => sum + run.glyphs.length, 0);
  return Object.freeze({
    contractVersion: 'paragraph-shaped-slices-v1',
    sourceRange: Object.freeze({ start: range.start, end: range.end }),
    pieces: Object.freeze(pieces.map(piece => Object.freeze(piece))),
    shapedRuns: Object.freeze(shapedRuns),
    nonShapingRuns: Object.freeze(nonShapingRuns),
    glyphCount
  });
}

function projectShapedTextItemRanges(shapedTextItem, ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    fail('invalid-shaped-range-list', 'At least one source range must be supplied');
  }
  return Object.freeze(ranges.map(range => projectShapedTextItemRange(shapedTextItem, range)));
}

module.exports = {
  createParagraphShaper,
  projectShapedTextItemRange,
  projectShapedTextItemRanges
};
