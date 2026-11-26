# Phase 1 — Runtime truth snapshot
## 26.11.2026

**Repository:** SUGINACH/Tora_Book_Typesetter_Red_Work_2  
**Working branch:** `engine/legacy-parity-preview-20261119`  
**Exact code source tested:** `e1f69a2ad73a1524237ff5a2a341ff9e597a04af`  
**Current `gh-pages` branch head:** `93178e6c6f60d51ad25e30952c200438ce0c5f2b`  
**Public URL:** https://suginach.github.io/Tora_Book_Typesetter_Red_Work_2/

## 1. Deployment identity

The public `build-info.json` at `gh-pages` reports:

- `profile: unified`
- `branch: engine/legacy-parity-preview-20261119`
- `commit: e1f69a2ad73a1524237ff5a2a341ff9e597a04af`
- `builtAt: 2026-11-26T05:33:28Z`
- `mode: direct-gh-pages-deploy-no-main-merge`

The live-audit workflow waited until the public Pages site served the exact expected source SHA. It then built expected browser bundles from that exact source checkout before comparing the live application.

## 2. Completed workflow gates on the exact code SHA

| Gate | Run / Job | Result | Verified detail |
|---|---|---|---|
| CI matrix | `45762332098` | SUCCESS | Node 18, 20, 22; all 108 test files; scan-control 0 violations; Determinism; Cross-check |
| Node 18 | job `139714987490` | SUCCESS | `s3-font-sync 12/12`; `s74-pdf-mark-advance 3/3`; `s10-ui 45/45`; `s72-column-bottoms 15/15`; deterministic hash `89a0eb42c774943b`; Cross-check passed |
| Node 20 | job `139714987452` | SUCCESS | Same full suite and named gates passed |
| Node 22 | job `139714987140` | SUCCESS | Same full suite and named gates passed |
| Layout audit | job `139714987522` | SUCCESS | 849-page virtualized corpus sweep |
| Full Math local | run `45762332021` | SUCCESS | 691 pages, 44,360 lines, 360,356 words, zero problems, deterministic IDENTICAL |
| Corpus invariants | run `45762332159` | SUCCESS | Full corpus invariants passed |
| Bundle rebuild | run `45762332065` | SUCCESS | Rebuilt deterministic browser bundles before test suite |
| Preview / public live | run `45762332053`, job `139715158078` | SUCCESS | Exact Pages SHA, headless browser, HTML/PDF audit and impact signature |
| HarfBuzz POC | run `45762332095`, job `139714986966` | SUCCESS | 16 font instances, 659 glyphs, 80 source/cluster cases; exact FrankReal Node↔Worker proof |

## 3. Public live export audit

Pages served exact source commit `e1f69a2ad73a1524237ff5a2a341ff9e597a04af`. The public app/Worker and expected bundles were compared from the same source checkout. The headless browser Full Math audit returned:

- PageModel pages: 691
- HTML pages: 691
- PDF pages: 691
- Extracted Hebrew characters: 1,507,214
- Lines: 44,360
- Words: 360,356
- Findings/problems: 0
- Determinism: `IDENTICAL`

Impact signature:
- Input: `91fe1a2fd616e1fd`
- Settings: `654391c7c2c61095`
- Geometry: `b11bd54934b55627`
- Content: `e392b5e439f17e89`

Live audit artifact: `15091331105`.

## 4. S74 combined-mark metric gate

The font-registration and combined-mark propagation fixes are verified in the same code baseline. All three Node versions passed:
- `s3-font-sync: 12/12`
- `s74-pdf-mark-advance: 3/3`

The test uses the canonical FontResolver registration path and checks combined vs raw hmtx measurement plus cache isolation. The PDF `/W` policy makes the scoped exported word-width gate pass. It is explicitly **not** a glyph-position/ink-parity proof and is not the final shaping architecture.

## 5. Production truth — what is still not integrated

The production browser Worker loads/validates HarfBuzz + Unicode18 and injects `typographyRuntime` into `typeset()`. In the inspected source path, however:
- `pipeline.js` does not consume `env.typographyRuntime` as a shaper service.
- `line-items.js` performs `splitTextItem` before shaping and before `boxItemFor`/measurement.
- `measureItem` propagates the combined-mark policy but still does not consume `ShapedRun` advances or cluster slices.
- `LineModel`, materialization and `PageModel` do not carry canonical glyph IDs/clusters/offsets as the authoritative text output.
- DOM/HTML can reshape Unicode independently; PDF still maps per-character CIDs and its own widths/positioning.

Therefore HarfBuzz/Unicode18 runtime readiness and isolated parity are verified, but **production shaping integration remains OPEN**.

## 6. Remaining high-priority work

1. Paragraph-level Unicode18 Bidi/Script/EGC itemization before word splitting; preserve logical UTF-16 source coverage, levels and formatting controls.
2. Canonical FontResolver mapping for every EGC/style run; explicit unsupported/missing glyph policy; no silent fallback.
3. Shape full logical runs with HarfBuzz before measurement; legal breakpoints only at cluster-safe boundaries; line-edge BOT/EOT/context reshaping where required.
4. Feed the same shaped advances to line breaking and preserve immutable ShapedRun slices in LineItem/LineModel.
5. Carry glyph IDs, clusters, advances, x/y offsets, source mapping, font identity and validated ink bounds into PageModel.
6. DOM, standalone HTML and PDF must project the same glyph data; PDF subset by actual GIDs and preserve Unicode extraction through ToUnicode/ActualText.
7. Validate Hebrew nikud/taamim, Rashi fonts, mixed RTL/LTR, numbers, brackets, ligatures, fallback, WOFF2/TTC and font variation behavior.
8. Compare glyph ink/position on the same PageModel. A matching width alone is not acceptance.

## 7. Scope controls

No change was made to `main`, the legacy engine, user font files, global defaults or page geometry in this continuation. P6/P7 remain entirely out of scope. Runtime assets remain staged and are not production shaping activation by themselves.

References:
- CI: https://github.com/SUGINACH/Tora_Book_Typesetter_Red_Work_2/actions/runs/45762332098
- Public live audit: https://github.com/SUGINACH/Tora_Book_Typesetter_Red_Work_2/actions/runs/45762332053
- Full Math: https://github.com/SUGINACH/Tora_Book_Typesetter_Red_Work_2/actions/runs/45762332021
- Corpus invariants: https://github.com/SUGINACH/Tora_Book_Typesetter_Red_Work_2/actions/runs/45762332159
- HarfBuzz POC: https://github.com/SUGINACH/Tora_Book_Typesetter_Red_Work_2/actions/runs/45762332095
