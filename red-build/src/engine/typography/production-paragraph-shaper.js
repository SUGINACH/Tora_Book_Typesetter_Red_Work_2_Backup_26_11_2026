// src/engine/typography/production-paragraph-shaper.js
'use strict';

const { createParagraphShaper } = require('./paragraph-shaping');
const fontResolver = require('./font-resolver');

function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function copyConfigValue(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid-typography-shaping-config', path + ' must contain only finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => copyConfigValue(entry, path + '[' + index + ']'));
  if (!isRecord(value)) {
    fail('invalid-typography-shaping-config', path + ' must contain JSON-compatible data only');
  }
  const copy = Object.create(null);
  for (const key of Object.keys(value)) copy[key] = copyConfigValue(value[key], path + '.' + key);
  return copy;
}

/**
 * Resolve only an explicit document-level opt-in into the canonical shaper.
 * No product defaults or fallback chains are inferred: all font, script,
 * direction, variation and fallback policy must be supplied by the document.
 *
 * settings._typographyShaping:
 * {
 *   enabled: true,
 *   baseDirection: "rtl" | "ltr",
 *   defaultFamily: "exact registered FontResolver alias",
 *   languageByScript: { Hebr: "he", Latn: "en", ... },
 *   featuresByScript: { Hebr: [{tag:"kern",value:1}, ...], ... },
 *   variationAxesByFontId: { "fnt-...": [] | [{tag:"wght",value:...}], ... },
 *   faceIndexByFontId?: { "fnt-...": 0, ... },
 *   fallbacksByFamily?: { "Family": ["Fallback A", ...] }
 * }
 */
function createProductionParagraphShaper(settings, env = {}) {
  const explicitConfig = settings && settings._typographyShaping;
  if (explicitConfig != null && !isRecord(explicitConfig)) {
    fail('invalid-typography-shaping-config', 'settings._typographyShaping must be a plain object');
  }
  // Runtime availability alone never enables shaping. It is staged separately
  // from production font normalization and line-edge BOT/EOT integration.
  if (explicitConfig == null || explicitConfig.enabled !== true) return null;
  const config = explicitConfig;
  const runtime = env.typographyRuntime;

  if (!runtime || !runtime.unicode || !runtime.harfbuzz ||
      typeof runtime.createShaper !== 'function') {
    fail('typography-runtime-required', 'Production paragraph shaping requires the verified Worker Unicode/HarfBuzz runtime');
  }
  if (runtime.unicode.unicodeVersion !== '18.0.0' ||
      typeof runtime.harfbuzz.shape !== 'function') {
    fail('typography-runtime-version-mismatch', 'Paragraph shaping requires the pinned Unicode 18 / HarfBuzz runtime');
  }
  if (config.baseDirection !== 'rtl' && config.baseDirection !== 'ltr') {
    fail('invalid-typography-shaping-direction', 'baseDirection must be explicitly rtl or ltr');
  }
  if (typeof config.defaultFamily !== 'string' || !config.defaultFamily.trim()) {
    fail('invalid-typography-shaping-default-font', 'defaultFamily must be an exact, non-empty registered FontResolver alias');
  }
  for (const key of ['languageByScript', 'featuresByScript', 'variationAxesByFontId']) {
    if (!isRecord(config[key])) {
      fail('invalid-typography-shaping-config', key + ' must be an explicit object');
    }
  }

  const shaperOptions = config.shaperOptions == null
    ? Object.create(null)
    : copyConfigValue(config.shaperOptions, 'shaperOptions');
  // A production-shaped word must never be rendered by a second browser/PDF shaper.
  shaperOptions.includeGlyphOutlines = true;
  if (config.maxOutlineCacheEntries != null) {
    if (!Number.isSafeInteger(config.maxOutlineCacheEntries) || config.maxOutlineCacheEntries < 1) {
      fail('invalid-typography-shaping-config', 'maxOutlineCacheEntries must be a positive safe integer');
    }
    shaperOptions.maxOutlineCacheEntries = config.maxOutlineCacheEntries;
  }

  const shaper = createParagraphShaper({
    runtime,
    fontResolver,
    defaultFamily: config.defaultFamily,
    languageByScript: copyConfigValue(config.languageByScript, 'languageByScript'),
    featuresByScript: copyConfigValue(config.featuresByScript, 'featuresByScript'),
    variationAxesByFontId: copyConfigValue(config.variationAxesByFontId, 'variationAxesByFontId'),
    ...(config.faceIndexByFontId != null
      ? { faceIndexByFontId: copyConfigValue(config.faceIndexByFontId, 'faceIndexByFontId') }
      : {}),
    ...(config.fallbacksByFamily != null
      ? { fallbacksByFamily: copyConfigValue(config.fallbacksByFamily, 'fallbacksByFamily') }
      : {}),
    useNativeDefaults: config.useNativeDefaults === true,
    useItemFontRole: config.useItemFontRole === true,
    shaperOptions
  });

  return Object.freeze({
    shaper,
    direction: config.baseDirection,
    defaultFamily: config.defaultFamily,
    unicodeVersion: runtime.unicode.unicodeVersion,
    harfbuzzVersion: typeof runtime.harfbuzz.versionString === 'function'
      ? runtime.harfbuzz.versionString() : null,
    policySource: 'explicit-settings'
  });
}
module.exports = { createProductionParagraphShaper };
