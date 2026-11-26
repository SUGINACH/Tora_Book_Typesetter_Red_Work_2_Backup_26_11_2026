'use strict';

importScripts('/shape-core.js', '/bidi-api.js');

let harfBuzzPromise;

function loadHarfBuzz(moduleUrl) {
  if (!harfBuzzPromise) {
    harfBuzzPromise = import(moduleUrl).catch((error) => {
      harfBuzzPromise = null;
      throw error;
    });
  }
  return harfBuzzPromise;
}

async function shapeFrankRealMarkProbe(hb, bidiRuntime, reference, fontUrl) {
  if (!reference || reference.fontName !== 'FrankReal-Bold.ttf' ||
      typeof reference.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(reference.sourceHash) ||
      typeof reference.text !== 'string' || !Number.isSafeInteger(reference.sourceStart) ||
      !Number.isSafeInteger(reference.sourceEnd) || !Array.isArray(reference.glyphs) ||
      !Array.isArray(reference.graphemes) || !Array.isArray(reference.markGlyphIds)) {
    throw new Error('FrankReal Worker probe reference is incomplete or malformed');
  }
  if (!self.crypto || !self.crypto.subtle) {
    throw new Error('Worker secure-context SHA-256 is unavailable; refusing an unverified FrankReal font');
  }
  const response = await fetch(fontUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error('FrankReal Worker font fetch failed: HTTP ' + response.status);
  const bytes = await response.arrayBuffer();
  const digest = await self.crypto.subtle.digest('SHA-256', bytes);
  const sourceHash = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0')).join('');
  if (sourceHash !== reference.sourceHash) {
    throw new Error('FrankReal Worker source hash mismatch: ' + sourceHash + ' != ' + reference.sourceHash);
  }

  const face = new hb.Face(new hb.Blob(bytes), 0);
  const unitsPerEm = Number(face.upem);
  if (unitsPerEm !== reference.unitsPerEm || unitsPerEm !== 2048) {
    throw new Error('FrankReal Worker UPEM mismatch: ' + unitsPerEm + ' != ' + reference.unitsPerEm);
  }
  const font = new hb.Font(face);
  font.setScale(unitsPerEm, unitsPerEm);

  const text = reference.text;
  const itemization = bidiRuntime.itemizeScripts(text, bidiRuntime.resolve(text, 'rtl'));
  if (itemization.scriptRuns.length !== 1 ||
      itemization.scriptRuns[0].text !== text ||
      itemization.scriptRuns[0].script !== 'Hebr' ||
      itemization.scriptRuns[0].direction !== 'rtl' ||
      itemization.scriptRuns[0].bidiLevel !== reference.bidiLevel ||
      itemization.sourceRuns.some((run) => run.kind !== 'shape')) {
    throw new Error('FrankReal Worker Unicode 18 itemization mismatch: ' + JSON.stringify({
      scriptRuns: itemization.scriptRuns,
      sourceRuns: itemization.sourceRuns
    }));
  }
  const scriptRun = itemization.scriptRuns[0];
  const actualGraphemes = itemization.graphemes
    .slice(scriptRun.graphemeStart, scriptRun.graphemeEnd)
    .map((grapheme) => ({
      text: grapheme.text,
      start: grapheme.start + reference.sourceStart,
      end: grapheme.end + reference.sourceStart
    }));
  if (JSON.stringify(actualGraphemes) !== JSON.stringify(reference.graphemes)) {
    throw new Error('FrankReal Worker EGC/source range mismatch: ' + JSON.stringify({
      expected: reference.graphemes, actual: actualGraphemes
    }));
  }

  const featureTags = reference.features.map((feature) => feature.tag);
  const shaped = self.HarfBuzzRuntimePoc.shapeWithItemizedRuns(
    hb, font, text, itemization,
    {
      languageByScript: { Hebr: 'he' },
      featureTagsByScript: { Hebr: featureTags }
    }
  );
  if (shaped.status !== 'passed' || shaped.shapedRuns.length !== 1 ||
      shaped.shapedRuns[0].glyphs.length !== reference.glyphs.length) {
    throw new Error('FrankReal Worker HarfBuzz shaping returned an unexpected run/glyph count');
  }
  const actualGlyphs = shaped.shapedRuns[0].glyphs.map((glyph) => ({
    gid: glyph.gid,
    cluster: glyph.cluster + reference.sourceStart,
    relativeCluster: glyph.cluster,
    sourceRange: {
      start: glyph.sourceRange.start + reference.sourceStart,
      end: glyph.sourceRange.end + reference.sourceStart
    },
    xAdvance: glyph.xAdvance,
    yAdvance: glyph.yAdvance,
    xOffset: glyph.xOffset,
    yOffset: glyph.yOffset
  }));
  const signature = (glyphs) => glyphs.map((glyph) => [
    glyph.gid, glyph.cluster, glyph.relativeCluster,
    glyph.sourceRange.start, glyph.sourceRange.end,
    glyph.xAdvance, glyph.yAdvance, glyph.xOffset, glyph.yOffset
  ]);
  const exactNodeProductionParity =
    JSON.stringify(signature(actualGlyphs)) === JSON.stringify(signature(reference.glyphs));
  if (!exactNodeProductionParity) {
    throw new Error('FrankReal Worker glyph output differs from Node production ShapedRun: ' +
      JSON.stringify({ expected: reference.glyphs, actual: actualGlyphs }));
  }
  const markIds = new Set(reference.markGlyphIds);
  const markGlyphs = actualGlyphs.filter((glyph) => markIds.has(glyph.gid));
  const combiningMarkAdvanceSum = markGlyphs.reduce((sum, glyph) => sum + glyph.xAdvance, 0);
  if (markGlyphs.length !== reference.markGlyphIds.length || combiningMarkAdvanceSum !== 0) {
    throw new Error('FrankReal Worker combining-mark advances are not zero: ' +
      JSON.stringify({ expectedMarkGlyphIds: reference.markGlyphIds, markGlyphs, combiningMarkAdvanceSum }));
  }
  return {
    status: 'passed',
    fontName: reference.fontName,
    sourceHash,
    sourceHashVerified: true,
    unitsPerEm,
    unicodeVersion: bidiRuntime.unicodeVersion,
    text,
    bidiLevel: scriptRun.bidiLevel,
    sourceRange: [reference.sourceStart, reference.sourceEnd],
    graphemes: actualGraphemes,
    glyphCount: actualGlyphs.length,
    glyphs: actualGlyphs,
    markGlyphIds: reference.markGlyphIds,
    combiningMarkGlyphCount: markGlyphs.length,
    combiningMarkAdvanceSum,
    exactNodeProductionParity,
    shapingMethod: 'HarfBuzz classic Worker direct shaping compared against the Node production ShapedRun adapter'
  };
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type !== 'shape') return;
  try {
    const hb = await loadHarfBuzz(message.moduleUrl);
    const bidiResponse = await fetch(message.bidiWasmUrl, { cache: 'no-store' });
    if (!bidiResponse.ok) throw new Error('Bidi WASM fetch failed: HTTP ' + bidiResponse.status);
    const bidiRuntime = await self.RedBidiRuntime.instantiate(await bidiResponse.arrayBuffer());
    if (bidiRuntime.unicodeVersion !== '18.0.0') throw new Error('Unexpected Worker itemizer version ' + bidiRuntime.unicodeVersion);
    const config = message.sharedItemization;
    if (!config || typeof config.sourceText !== 'string' || !config.languageByScript || !config.featureTagsByScript) {
      throw new Error('Worker message is missing shared itemization configuration');
    }
    const itemization = bidiRuntime.itemizeScripts(config.sourceText, bidiRuntime.resolve(config.sourceText, config.baseDirection));
    const sharedItemization = {
      sourceText: config.sourceText, itemization,
      languageByScript: config.languageByScript,
      featureTagsByScript: config.featureTagsByScript
    };
    const results = [];
    for (const fixture of message.fonts || []) {
      const response = await fetch(fixture.url, { cache: 'no-store' });
      if (!response.ok) throw new Error('font fetch failed for ' + fixture.name + ': HTTP ' + response.status);
      const fontBytes = await response.arrayBuffer();
      results.push(self.HarfBuzzRuntimePoc.shapeWithHarfBuzz(hb, fontBytes, Object.assign({}, fixture, { sharedItemization })));
    }
    const frankRealMarkProbe = await shapeFrankRealMarkProbe(
      hb, bidiRuntime, message.frankRealMarkReference, message.frankRealMarkFontUrl
    );
    self.postMessage({
      type: 'shape-result',
      ok: true,
      frankRealMarkProbe,
      runtime: {
        classicWorker: typeof importScripts === 'function',
        dynamicImport: true,
        wasmLoaded: true,
        bidiWasmLoaded: true,
        bidiUnicodeVersion: bidiRuntime.unicodeVersion,
        sharedItemizationProbeFontCount: results.filter((x) => x.sharedItemizationProbe && x.sharedItemizationProbe.status === 'passed').length,
        sharedItemizationProbePassed: results.every((x) => x.coverageStatus !== 'complete' || (x.sharedItemizationProbe && x.sharedItemizationProbe.status === 'passed'))
      },
      results
    });
  } catch (error) {
    self.postMessage({
      type: 'shape-result',
      ok: false,
      error: String(error && error.stack || error)
    });
  }
};
