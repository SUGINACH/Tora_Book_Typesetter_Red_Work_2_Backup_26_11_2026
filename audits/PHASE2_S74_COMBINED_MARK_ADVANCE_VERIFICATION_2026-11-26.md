# S74 — Combined mark advance and PDF projection verification
## 26.11.2026

**Code source:** `e1f69a2ad73a1524237ff5a2a341ff9e597a04af`  
**CI:** `45762332098` — SUCCESS on Node 18/20/22  
**Test:** `red-build/tests/e2e/s74-pdf-mark-advance.test.js`  
**Unit test:** `red-build/tests/unit/s3-font-sync.test.js`

## Root correction

The earlier S74 v3 environment used a font-registration path that did not guarantee the canonical `FontResolver` identity used by the production word measurement path. In addition, `measureItem` selected `MeasureAPI.forFontId` with settings that omitted the unified `_marks-advance=combined` policy. The correction:
1. Registers S74 fonts with canonical `FontResolver`.
2. Passes the combined-mark policy from `measureItem` into font-ID-bound measurement APIs.
3. Separates font-ID API cache identity by font size and mark mode.
4. Separates measured-item cache identity by mark mode.
5. Adds a FrankReal unit regression comparing combined and raw hmtx metrics and proving cache isolation.

Code fix commit: `364185f59972059d7f27f59ae580d612ce153504`.

## Verified tests

On source `e1f69a2ad73a1524237ff5a2a341ff9e597a04af`:
- Node 18: `s3-font-sync 12/12`; `s74-pdf-mark-advance 3/3`.
- Node 20: `s3-font-sync 12/12`; `s74-pdf-mark-advance 3/3`.
- Node 22: `s3-font-sync 12/12`; `s74-pdf-mark-advance 3/3`.

Full 108-file suite, D-65 bundle checks, deterministic layout and cross-check all passed in the same CI matrix.

## Limitation — width is not glyph positioning

`pdf-mark-policy.js` changes the PDF subset `/W` widths for mapped combining marks under the unified profile. The S74 assertion verifies the scoped PDF word-width metric. It does not provide HarfBuzz glyph IDs, cluster mapping or x/y offsets to the PDF writer, and it does not prove that PDF ink/mark placement matches DOM or standalone HTML. It is an interim width projection only and **not** acceptance of OUT-03 or production shaping parity.

The exact FrankReal Worker probe also reports zero offsets for this font/sample; FrankReal itself has no GPOS/GSUB. A general ink/positioning solution must therefore be validated with additional fonts and real glyph outlines/extents, not inferred from this width test.

Required final fix remains a single authoritative ShapedRun flowing from paragraph itemization through measurement, legal line breaks, LineModel, PageModel and all three projections. Do not replace this with CSS offsets, post-layout width changes or PDF-only metric correction.

Reference: https://github.com/SUGINACH/Tora_Book_Typesetter_Red_Work_2/actions/runs/45762332098
