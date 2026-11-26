// src/engine/core/page-model-hashes.js — canonical PageModel hash contract (engine + UI receiver)
'use strict';

const { sha256Hex } = require('../assets/hash256');

/** geometryHash — deterministic fingerprint of final geometry only (no text). */
function geometryHashOf(model) {
  const canon = model.pages.map(p => ({
    i: p.index, t: p.type,
    l: p.lines.map(l => l.projected === false ? '∅' : `${l.id}:${l.x},${l.y},${l.w},${l.h},${l.baselineY}:${(l.words || []).map(w => `${Math.round(w.x * 10) / 10}+${Math.round(w.w * 10) / 10}`).join(',')}`),
    fn: p.footnotes.map(n => `${n.noteId}:${n.x},${n.y},${n.w},${n.h}`),
    sn: p.sideNotes.map(s => `${s.noteId}:${s.x},${s.yTop},${s.heightPx}`),
    d: (p.decorations || []).map(d => `${d.kind}:${d.x},${d.y},${d.w},${d.h}`)
  }));
  return sha256Hex(JSON.stringify(canon));
}

/** contentHash — final model text in reading order plus glyph-level typography data. */
function contentHashOf(model) {
  const canon = model.pages.map(p => ({
    i: p.index,
    l: p.lines.map(l => {
      const text = (l.words || []).map(w => w.text).join('\u00A7');
      // Keep the legacy canonical value exactly when neither line nor word
      // glyph sidecars are present; shaped word placement is integrity-protected.
      const wordTypography = (l.words || [])
        .filter(word => word && word.typography)
        .map(word => ({ text: word.text, typography: word.typography }));
      if (!l.typography && !wordTypography.length) return text;
      return {
        text,
        ...(l.typography ? { typography: l.typography } : {}),
        ...(wordTypography.length ? { wordTypography } : {})
      };
    }),
    fn: p.footnotes.map(n => `${n.marker || ''}§${n.text}`),
    sn: p.sideNotes.map(s => s.text)
  }));
  return sha256Hex(JSON.stringify(canon));
}

module.exports = { geometryHashOf, contentHashOf };
