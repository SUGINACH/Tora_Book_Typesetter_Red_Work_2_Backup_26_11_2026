# Phase 2 — FrankReal exact shaping: Node ↔ Classic Worker
## 26.11.2026

**Repository:** SUGINACH/Tora_Book_Typesetter_Red_Work_2  
**Branch:** `engine/legacy-parity-preview-20261119`  
**Code baseline tested:** `e1f69a2ad73a1524237ff5a2a341ff9e597a04af`  
**Workflow:** shaping-runtime-poc `45762332095` — SUCCESS  
**POC job:** `139714986966`  
**Report artifact:** `15090765335`  
**Runtime assets artifact:** `15089534679`  
**CI:** `45762332098` — SUCCESS on Node 18/20/22

## 1. Runtime and general compatibility

The pinned runtime initialized HarfBuzzJS 1.6.4, HarfBuzz core 15.0.0 and Unicode 18.0.0. Node and a real browser Classic Worker passed exact parity across 16 font instances, 659 glyph records and 80 cluster/source-range compatibility cases. Worker loading, dynamic ESM import and WASM initialization were verified. Four raw WOFF2 fixtures remain outside direct HarfBuzzJS input support and were tested only after deterministic build-time SFNT normalization with external fontTools/Brotli.

## 2. Exact source font and input

- Font: `FrankReal-Bold.ttf` (canonical FontResolver alias `FrankReal`)
- SHA-256: `b90214b570d63f225282c4d3c3a5f023ad0d2d415043ae69926c0cc79ef2237a`
- UPEM: 2048
- Text: `שְׁמַע`
- Direction/Script: RTL / Hebr
- UTF-16 document range: `[500,506)`
- Features: `kern=1, mark=1, mkmk=1, rlig=1`
- EGCs: `שְׁ [500,503)`, `מַ [503,505)`, `ע [505,506)`

The Node production adapter created an immutable `ShapedRun` using FontResolver → TextItemShapingPlan → HarfBuzzShaper. This exact ShapedRun was serialized as a hash-locked Worker reference. The Worker fetched the same TTF using `cache: no-store`, verified SHA-256 with `crypto.subtle.digest`, verified UPEM and independently itemized the exact word through Unicode 18 before shaping.

## 3. Exact glyph parity

Both environments returned six glyphs in visual RTL order. The Worker required exact equality against the Node production ShapedRun for GID, absolute cluster, relative cluster, source range, x/y advance and x/y offset.

| GID | Cluster | Source range | Role | xAdvance | yAdvance | xOffset | yOffset |
|---:|---:|---|---|---:|---:|---:|---:|
| 193 | 505 | [505,506) | Ayin | 972 | 0 | 0 | 0 |
| 163 | 503 | [503,505) | Patah | 0 | 0 | 0 | 0 |
| 189 | 503 | [503,505) | Mem | 1042 | 0 | 0 | 0 |
| 156 | 500 | [500,503) | Sheva | 0 | 0 | 0 | 0 |
| 172 | 500 | [500,503) | Shin dot | 0 | 0 | 0 | 0 |
| 200 | 500 | [500,503) | Shin | 1261 | 0 | 0 | 0 |

The three combining mark glyph IDs are `163, 156, 172`; all have xAdvance zero and their combined xAdvance is zero. The base-letter xAdvance sum is `972 + 1042 + 1261 = 3275` font units, equal to the canonical FrankReal measurement basis.

## 4. What this proves — and what it does not

**Proved:** exact, source-hash-locked output parity for this exact six-glyph FrankReal word between the Node production adapter's immutable ShapedRun and the Classic Worker HarfBuzz output; same Unicode 18 EGC/source mapping; same GIDs and positioning metrics; exact general multi-font Node/Worker parity.

**Not proved:** production use of the shaping result in RED's line layout, visual ink parity in browser/HTML/PDF, support for raw WOFF2, fallback coverage across every font/EGC, or BOT/EOT/line-edge reshaping. FrankReal itself contains no GPOS/GSUB, and all offsets in this sample are zero. Thus this is a determinism/metric parity probe, not a general mark-positioning proof.

## 5. Production integration status at the tested baseline

The real Worker loads and verifies the pinned runtime, then passes `typographyRuntime` to `typeset()`. However:
1. `pipeline.js` does not consume `env.typographyRuntime` to create a shaping service or pass it to `buildLineSequences`.
2. `line-items.js` still calls `splitTextItem` before `boxItemFor` and `measureItem`.
3. `measureItem` still measures text/font metrics; it does not consume shaped cluster slices.
4. `LineModel`/materialization/`PageModel` do not retain a canonical GID/cluster/advance/offset sequence.
5. DOM/HTML still provide Unicode text for browser shaping; PDF still uses a character-to-CID projection rather than the same canonical shaped glyph array.

The next production work must connect paragraph Bidi/Script/EGC itemization and font resolution before word splitting, shape complete logical text runs, split only at legal cluster boundaries, measure from those exact glyph advances, carry immutable shaped slices through LineModel/PageModel, and make every output projection consume the same glyph data. No CSS offsets, PDF-only widths, font substitutions or post-layout geometry corrections constitute acceptance.

## 6. WOFF2 limitation

Four raw fixtures are still not accepted directly by HarfBuzzJS:
- `Ambivalenti-Regular.woff2`
- `FrankBasic-1-regular.woff2`
- `Mixtape-Bold.woff2`
- `Mixtape-Regular.woff2`

The POC used build-time external normalization for testing only. Production must prove deterministic normalization preserving source identity, GID order, outlines, UPEM, face index and variations, or reject unsupported input explicitly. Do not mass-convert or overwrite user font files.

## References

- POC run: https://github.com/SUGINACH/Tora_Book_Typesetter_Red_Work_2/actions/runs/45762332095
- Full CI run: https://github.com/SUGINACH/Tora_Book_Typesetter_Red_Work_2/actions/runs/45762332098
- Live public Pages audit: https://github.com/SUGINACH/Tora_Book_Typesetter_Red_Work_2/actions/runs/45762332053
