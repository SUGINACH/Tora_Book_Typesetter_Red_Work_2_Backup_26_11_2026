# שלב 8 — מקרינים טהורים, תצוגה וייצוא מתוך PageModel

> מסמך מצב חי — מתעדכן בכל פרוסה. בסיס: main `740721d` (שלב 6 הושלם — PR #30).

## פרוסה 1 (17.11, ענף stage8a/materialization) — הפרדת materialization חד-פעמי (§4.1)

**הפער:** buildPageModel קרא ל-projectDocument מ-output/ — מנגנון שממשיך לקבל החלטות גיאומטריה: מדד מחדש את רוחבי כל מילות הגוף (בגוף הטקסט — כולל כותרות שנמדדו בזמן השבירה בגופן הכותרת ⇒ תצוגה≠ייצוא ברמת המילה), מדד ושבר תוכן מבני (TOC/שערים/סלוטי כותרת/גיליון), וחילק נתיבי מרזב בעצמו.

**הפתרון:**
1. **`layout/structural-stamps.js` (חדש)** — הטבעת גיאומטריית התוכן המבני בזמן התכנון (ה-pipeline קורא לפני בניית המודל, אחרי כל ההחלטות): page.tocLayout (מילים נמדדות), page.shaarLayout (בלוקים+שורות+רוחבים+גופן+צבע+מיקום), page.headerSlotGeo, page.folioGeo, page.footnoteLanes.
2. **`core/materialize.js` (הועבר מ-output/geometry-projector.js)** — המנגנון הפנימי הטהור: רוחבי מילים **מה-LineModel** (measuredAdvance של הפרגמנטים + naturalPx של ה-glue — מדידת השבירה היחידה), תוכן מבני מהחותמות, מיקומים מהתוכנית. **אפס measureTextWidth, אפס נפילות** על תוצר ה-pipeline (מוכח בבדיקה). נפילה לקלט סינתטי ⇒ diagnostic גלוי (materializeFallbacks).
3. **`output/geometry-projector.js` — facade מעבר** לנתיב ה-PDF הוותיק ולבדיקות: מבטיח חותמות (מטביע חד-פעמית לקלט סינתטי, מסומן) ואז מנגנון ה-materialization היחיד — אין מנוע שני. יוסר בשלב 9 לאחר הוכחת parity.
4. **page-model** קורא ל-materializeDocument ישירות; **pipeline** מטביע ומדווח (אירוע structural-stamps).

**ראיות:** s8a-materialization חדשה (6): טוהר (0 מדידות/0 נפילות), חותמות לכל עמוד מבני, שקילות facade (ביט-לביט), רוחבי כותרות מה-LineModel, layoutHash נשמר (f6f32c40 — ההטבעה אינה משנה תכנון), דטרמיניזם הקרנה, נפילה גלויה לקלט סינתטי. cross-check PASS (כל הנעילות); test:determinism OK; 69/70 באצווה + s10-ui ירוקה בנפרד (פלייק ידוע של תחרות פורטים בהרצה טורית — אינו קשור לשינוי; הופיע גם באצוות קודמות).

**שינוי גיאומטרי מתועד:** רוחבי מילות כותרות בהקרנה מתוקנות מגוף-הגוף לגופן הכותרת האמיתי (17 שורות בקנוני; geometryHash המודל משתנה, layoutHash לא). תיקון מחלקת תצוגה≠ייצוא — לא רגרסיה.

**נותר לפרוסאות הבאות:** השלמת שדות PageModel + Worker transport (פרוסה 2); DOM/HTML/PDF מהמודל (פרוסות 3–5); מלאי כפילויות + parity + דוח ביצועים (פרוסה 6).

## פרוסה 1-ביקורת (17.11, ענף stage8b/materialize-boundary) — §3.1–§3.3: גבולות materialization

**הפער שנבדק (הוראת §3):** האם הקוד החדש מושלם רק משום שהבדיקות עברו. נבדקו כל התלויות של core/materialize.js, כל נתיבי ה-fallback, תוצאות PR #30, ודיוק הדיווח על ה-69/70.

**ממצאי הביקורת (לפני התיקון):**
1. **תלות הפוכה core→renderer:** materialize ייבא scrubPUAText מ-output/dom-renderer. הועבר למודול הניטרלי **core/pua-text.js** (קבועי PUA + scrub; dom-renderer צורך ומייצא הלאה — SSOT).
2. **כפילות familyFontKeyOf** — שני עותקים זהים (materialize + structural-stamps). הועבר למקור יחיד **typography/font-keys.js** (עותק שלישי ב-legacy-projector ייסגר בשלב 9).
3. **נקב אמיתי בטוהר הייצור — כותרת עמודי הערות:** projectEndnotePage סינתז את הכותרת בעצמו (fakeLine — מדידה בזמן materialization). במסמכים עם note-placement-mode=endnotes היה מדידה שנייה במסלול הייצור. **תוקן בשורש:** stampEndnoteHeading חדש (structural-stamps) — page.endnoteTitleGeo (מילים+רוחב רווח+גודל+מפתח גופן) נמדד פעם אחת בהטבעה; ההקרנה צורכת. fontKey 'heading' (/F3) נשמר כמו בנתיב הישן.
4. **נפילת-שווא (852 שורות ב-very_long):** שורה חד-מילית אין לה glue ב-LineModel (אין רווחים למלא) — וההקרנה דרשה רוחב רווח בלתי-מותנה ⇒ "נפילת מדידה" כזובה + מדידת רווח. **תוקן בשורש:** רוחב רווח נדרש רק לשורה רב-מילית; חד-מילית ⇒ 0 ללא נפילה.
5. **מצבי הפעלה מתוחמים (§3.1-5):** materializeDocument/projectPage מקבלים {measure, mode}:
   - **'production'** (מ-buildPageModel): אסורה מדידת טקסט. כל חוסר נתון (חותמת TOC/שער/גיליון/כותרת/נתיבים/LineModel/רוחבים) ⇒ diagnostic מזוהה — ולא השחזור ולא מדידה. שורת גוף בלי LineModel: המילים נשמרות (חשבונאות מלאה) ברוחב 0 מסומן + diagnostic. מניעת כפילויית MeasureAPI (היה נבנה פעמיים ב-projectDocument).
   - **'compat'** (ברירת מחדל לקריאה ישירה — בדיקות ותיקות + facade/נתיב PDF ותיק): התנהגות ה-fallback הקודמת, מתועדת ונספרת.
6. **חשבונאות גלויה (§3.1-6):** materializeFallbacks של ה-production נכנסים ל-model.diagnostics, ל-model.meta.materializeFallbacks ול-violations של validatePageModel (code: materialize-fallback) ⇒ כל נפילה בייצור = נראית ב-ledger ובבדיקות קורפוס. ה-diagnostics של הבונה (שהיו נאספים ולא היו נצרכים) נושאים כעת במודל.
7. **תיקון דיוק דיווח — ה-69/70:** נבדק לעומת הריצות האמיתיות: **אין תחרות פורטים** (s10-ui אינה פותחת פורטים כלל; אין listen/createServer באף בדיקת אצווה). ה-CI של ראש ה-PR (#31, 04c4d81f) ירוק בכל שלוש גרסאות Node; הכישלון היחיד ב-CI הוא 'local' = בסיס full-math היסטורי. ה-69/70 היה ארע בהרצת האצווה המקומית בלבד (סביבת sandbox מוגבלת). למרות זאת **יוצבו התפרים הרגישים**: waitFor מותנה-מצב מחליף שינה קבועה בנקודות הא-סינכרון של s10-ui (אותם אסרטים, בלי הנחת זמנים).
8. **היגיינה:** facade מטפל כעת גם ב-shaar-back בלי חותמה וב-endnoteTitleGeo בבדיקת החותמות החסרות.

**ראיות (commit ענף, Node v24.22.3):**
- **s8b-materialize-boundary חדשה (8 בדידות):** probe אטום — patch ל-MeasureAPI.prototype.measureTextWidth שזורק — production materialization + buildPageModel עוברים באפס קריאות (תופס גם מופעים פנימיים); endnotes: כותרת מהחותמה בלי מדידה; very_long 1108 עמודים: 0 נפילות (בעבר 852 שווא); מוצא רוחבי-מילה מה-LineModel לכל שורות הגוף (כולל כותרות בגופן משלהן); הזרקות שליליות (חותמת TOC/LineModel/גיליון חסרים) ⇒ diagnostic+violation, טקסט נשמר, אפס מדידות; compat מתועד; אין תלות core→renderer.
- **אצווה מלאה: 70/70 קבצי סוויטה EXIT=0** (כולל s10-ui 43/43; s8b נוספה לשרשרת).
- test:determinism OK (f6f32c4073c4fd35); cross-check PASSED (קנוני f6f32c40, very_long d2a18112, מורשת legacy-a8bdd — כל הנעילות; באנדלים נבנו מחדש ותואמים).
- layout-audit בדפדפן אמיתי: fixture קטן 10/10 עמודים 0 בעיות; very_long 699/699 עמודים (וירטואליזציה, 43,124 שורות) **0 בעיות** — SIDE_NOTE_OVERLAP עמ' 107 נשאר סגור.
- full-math-audit מקומי: אותו בסיס היסטורי בדיוק (353,687 < 355,967 = 0.98×363,232) — ללא שינוי חתימה; הסף לא שונה.
- נייטרליות גיאומטרית: layoutHash זהים ל-main בכל הקורפוסים (כולל endnotes: 00069e7561722ae3 — ההטבעה החדשה אחרי חישוב finalHash).

**פערים שנצפו ותועדו לפרוסה 2 (לא רגרסיה — קיימים ב-main):** מצב endnotes מפיק 105 הפרות PageModel (planned-line-missing 56 — מיפוי זהות שורות-הערות לפי טקסט נכשל; note-without-id 48 — רשומות buildEndnotePages בלי noteId; line-count-mismatch 1). נסגרים בהשלמת המודל (פרוסה 2), לא במקרינים.

**תוצאות PR #30 שנשמרו (§3.3):** חוזה עיטורים + ornament-ink-missing (נבדק: הדיאגנוסטיקה מגיע כעת גם ל-model.diagnostics); הצמדת הערות לעוגנים (s6c ירוקה 15/15 באצווה); fn-anchor-compromise נשמר (s6b ירוקה 23/23); שימור noteId/anchorId/continuationOf/wordRange — ללא שינוי במסלולים אלה.

## פרוסה 2 (17.11, ענף stage8c/pagemodel-contract) — השלמת PageModel + תמונות + העברת Worker (§4.1–§4.4)

**מה נעשה:**
1. **§4.1 — השלמת החוזה:** ריהוט מלא במודל — סלוטי כותרת עליונה (pos/align/text/x/w/sizePt/fontKey/color מהחותמת; בעבר רק y), גיליון מלא (x/y/w/text/baselineY/fontKey/color/sizePt; בעבר y+text בלבד), פס חוצה-טורים (spanning: x/y/w/h), bookmarks (document.outline — עץ H1/H2 מהטוקנים עם עמוד ראשון), קישורי TOC (document.tocLinks — מלבנים מחותמת tocLayout, לא נוסחה מוקרנת), diagnostics והזמנות נושאים במודל.
2. **S8-END1 נסגר בשורש:** מצב endnotes — 105 הפרות → **0**. שורש א': matchEndnoteLine ניחש זהות לפי טקסט — הוחלף ב-tokenId שההקרנה עצמה נושאת; שורש ב': רשומות הערות ללא noteId קיבלו זהות דטרמיניסטית (en:{tokenId}); שורש ג': ספירת ה-planLines הפסיקה להתייחס לרשומות-ההערות כ"שורות תוכנית".
3. **§4.2 — תמונות פריטים ממדרגה ראשונה:** ההצהרה עולה מהמודל → פריט השורה (line-items: image{assetId מכתובת-תוכן, resourcePath, natural, fit, altText}) → ה-LineModel (assets לכל שורה: inline + block/centered + float עם anchor/side/ממדים) → ה-PageModel (page.images: מיקום סופי מהשורה הממוקמת, הצהרה, resolved). תיקוני שורש בדרך: (א) זהות הנכס הקנונית = contentAssetId של ה-resolver (בעבר הושווה מזהה נתיב מול מזהה תוכן — תמיד שקר); (ב) בדיקת §21-10 הייתה **מתה** (ln.lineModel.assets מעולם לא אויש) — כעת המלאי אמיתי וכל נכס נפתר או מדווח; (ג) רוחב טקסט-המקור של צף מוטבע בתכנון (pipeline-bridge — מדידה אחת) וההקרנה צורכת (בעבר: מדידת נפילה בכל שורות הפריסה של הצף); (ד) שורת תמונת בלוק/ממורכזת — רוחב מהפרגמנט (measuredAdvance) ויישור מרכז מהאילוץ; (ה) resolved ללא resolver = false (בעבר: ברירת-מחדל אמת שקרית).
4. **§4.3 — חוזה העברה:** worker-protocol עוטף את המודל (pagemodel-transport-v1: גרסה + ההאשים מהבונה + אומדן bytes); הצד המקבל (src/ui/page-model-transport.js) מאמת סכמה/גרסה/האשים/עמודים ומקפיא מחדש עמוק (structured clone מפשיר — מתועד). הוכחת שלמות: חישוב מחדש של geometryHash/contentHash על העותק זהה ביט-לביט.
5. **§4.4 — חיבור למסלול הפעיל:** ה-Worker (engine-worker-main) מחזיר את המודל בתוצאת ui-result-v1; app-shell קולט (אימות + הקפאה) וחושף app.pageModel() — ה-UI מקבל את המודל בפועל. כשל העברה ⇒ הודעה מפורשת, לא השתקה.

**ראיות (commit ענף, Node v24.22.3):** s8c-pagemodel-contract חדשה (10): ריהוט מלא; outline/tocLinks מהחותמות; endnotes 0 הפרות + noteId לכל הערה; תמונות inline/block/float (גיאומטריה, הצהרה, resolved, זהות תוכן); העברה (clone אמיתי, האשים, הקפאה מחדש, מעטפות שגויות נדחות); Worker אמיתי מחזיר מודל זהה לבנייה ישירה. s10-ui +1 (44): המודל מגיע לאפליקציה, קפוא, האשים זהים, ריהוט מלא. אצווה מלאה **71/71 EXIT=0**; test:determinism OK; cross-check **PASS — כל הנעילות** (קנוני f6f32c40, very_long d2a18112, מורשת legacy-a8bdd — נייטרליות מלאה); layout-audit בדפדפן: **0 בעיות** (fixture + very_long 699/699).

**שינוי גיאומטרי מתועד (מסמכי תמונות בלבד — לא בקורפוסים הנעולים):** שורת תמונת בלוק/ממורכזת מוקרנת כעת ברוחב התצוגה של התמונה וביישור מרכז (מהאילוץ במודל) במקום רוחב טקסט-התחביר שנמדד מחדש; שורות המשך של צף — רווח 0 בין מילת הזרימה האחרונה לטקסט-הצף (במקום רווח שנמדד). שניהם מקרבים את התצוגה אל אמת המודל; פרוסה 3 תחליף את מילת התחביר בתמונה עצמה.

**נותר:** פרוסה 3 — DOM מה-PageModel בלבד (ה-renderer יצרוך pageModel ולא pages גולמיים; תמונות יצוירו מ-page.images); פרוסות 4–6.

### אימות חי פרוסה 2 (main c222f4d · ?v=2026-11-17-s8c · 17.11)

- **הפריסה נבדקה:** הבאנדלים החיים נושאים את קוד ההעברה (pagemodel-transport-v1 ב-app וב-worker; ?v=s8c נטען). gh-pages-audit: בדיקת sha256/טריות **עברה**; הכשל היחיד — בסיס full-math ההיסטורי (353,687 < 355,967) ללא שינוי חתימה.
- **ממצא מתועד (S8-DL3):** האפליקציה החיה מריצה כברירת מחדל את פרופיל IMUD (loadLegacyDefaults — "התנהגות המקור היא המפרט", החלטת מוצר) ⇒ מנוע המורשת, שקדם ל-PageModel ⇒ app.pageModel() = null במסמכי ברירת-המחדל. **החיווט עצמו הוכח במסלול המאוחד** (s10-ui 44/44: המודל מגיע דרך Worker אמיתי/inline עם האשים זהים וקפוא; s8c: ה-Worker מחזיר מודל זהה לבנייה ישירה). המעבר של ברירת-המחדל למסלול המאוחד שייך לשלב 9 (parity ואז הסרת המורשת) — לא משנים ברירות מחדל בשלב 8.
- PDF מהאתר החי (בדיקה נציגה): 10 עמודים — תואם לבנייה מקומית באותן הגדרות; טקסט חלץ זהה (165=165 מילים; הפרשי bidi-markers של pdftotext בלבד); גופן ראשי מוטמע זהה.

## תיקון H3 — חוזה ה-CSS המקורי בשני המנועים (17.11, ענף fix/h3-css-parity-rebase) — §1.1 בהוראת ההמשך

**מה נעשה:** SSOT חדש `core/h3-contract.js` (line-height 1.22; ריפודים 8/4/4 — ה-CSS המקורי של Orange/Yellow/Green). מורשת: pitch רב-שורתי 21.96 במקום 34; ריפוד עליון פעם אחת; תחתון+שוליים פעם אחת; הפסים נושאים lineHeightPx ל-DOM ול-PDF. **תיקון סף השבירה של PR #32 המקורי:** `max(60, block+22)` במקום `max(60, block)` — סף "בלוק בלבד" החזיר 4 אלמנות כותרת דו-שורתיות (רגרסיה ל-S74 בעיה 6); הסמנטיקה המקורית (בלוק + ~שורת-גוף עוקבת; רצפה 60 = 38+22) נשמרת, והחד-שורתי ביט-מדויק. **הטמעה במסלול המאוחד** (לפני פרוסה 3 — כדי ש-PageModel שייצרן ייבנה על החוזה): מדידת H3 ב-1.22 (baseStyleOf); פס H3 ב-planner עם titleTopPadPx 8 וגובה 8+lines+8 (היה: אפס ריפודים ו-line-height 1.4); materialize ו-DOM מתחילים שורות פס אחרי הריפוד העליון (גם עבור הזמנות עיטור-H2 — מיושב עם ההנחה המתועדת של ornament-plan); סמנטיקת LineModel נגזרת מהגודל בפועל; `.spanning-band{box-sizing:border-box}`.

**ראיות:** npm test מלא **EXIT=0**; test:determinism OK; cross-check **PASS** (קנוני f6f32c40 — ללא שינוי; very_long DP e68e1f0b; מורשת legacy-28f52). השוואות baseline↔תיקון מסווגות במלואן (audits/H3_SPACING_OLD_STYLE_PARITY_2026-11-17.md): אפס שינויי חלוקת שורות בכל הקורפוסים; זרמי מילים שלמים; תוכן הערות קנוני זהה; אלמנות כותרת 6=6; דטרמיניזם OK. חתימת full-math זזה ב-+3 מילים (353,687→353,690) מה-reflow — הפער ההיסטורי הידוע, ללא החמרה; הסף לא שונה.

**נעילות שחודשו עם הצדקה:** s72 (fixed-doc legacy-5f0dc; קורפוס legacy-7db63), s76 (legacy-8b344/legacy-5f0dc), s77 (שתיים), s8b (e68e1f0b), s69 (e68e1f0b), cross-check-locks.json (DP + מורשת). s2-heading3-spacing עודכנה לחוזה ה-CSS (6/6); s4-line-engine ו-s4b — לפי ה-SSOT (26/26, 16/16).

**השפעה על פרוסה 3:** פסי H3 במסלול המאוחד ייבנו מעכשיו עם הריפוד העליון במודל (titleTopPadPx) — ה-PageModel שפרוסה 3 תצרוך כבר נושא את גיאומטריית החוזה המלאה; ה-DOM-renderer מציב את שורות הפס אחרי הריפוד (border-box), ו-materialize משקף זאת בהקרנה.

## §1.2 — סגירת כשל Full-Math ההיסטורי (17.11, ענף fix/fullmath-content-floor)

רצפת הנפח של full-math-audit נסגרה בשורש: הרצפה השוותה מול ה-fixture הגולמי (~2.75% ממנו תחביר סימון שאינו ניתן לרינדור) — כעת מול מילות התוכן מהטוקניזר SSOT + משמר נגד-מעגליות לפי זהויות. בדרך נסגרו: F-BL4 (סמני-הערה שנבלעו בחיתוך המרזב — 2 ב-very_long, 4 במסמך הבדיקה; שוחזרו), גולל הדטרמיניזם של S77, וטביעה דו-צירית של S70. **תוצאה: full-math-audit עובר מלא — 0 בעיות + דטרמיניזם מלא (699/699)** — הכשל "353,687<355,967" שנרשם כבסיס היסטורי בכל שערי הפריסה מאז שלב 1 הוכרע כמדידה שגויה, לא אובדן תוכן. פירוט והוכחות: audits/FULLMATH_FLOOR_ROOT_CLOSURE_2026-11-17.md. נעילות fixed-doc חודשו (legacy-1457d) בשלוש בדיקות עם הצדקה מלאה; הקורפוסים הנעולים לא השתנו.

## פרוסה 3 (17.11, ענף stage8d/pagemodel-dom) — מקרין DOM טהור מה-PageModel (§2)

**מה נעשה:**
1. **מקרין חדש `output/pagemodel-dom-renderer.js`** — `renderModelPage(mp, settings, doc)`: ציור עמוד PageModel בלבד. אפס מדידה (מוכח: patch-שזורק על ה-MeasureAPI + בדיקת תלות סטטית); כל x/y/w/h/baseline/זהות/צבע/גופן מהמודל; מילים ממוקמות-מוחלט ב-x שנקבע בתכנון (הדפדפן אינו מזיז אפילו מילה); תוויות רווח מפורשות בין מילים (ספירת נפח/העתקה/נגישות). מבנה ה-DOM שומר על עוגני האודיט (.page/.column/.line/.footnotes/.fn-rule/.side-note/.orn) — כלי הבדיקה הקיימים עובדים על הפרופיל המאוחד בלי שכפול.
2. **השלמת המודל בסמכויות** (מקרין אינו משלים כלום): תיבת שער (variant+rect) + מחלקות/משקל/ריווח-אותיות של בלוקי השער; כתרי שער כדיו SVG מ-SSOT (shaar-content.crownSvgOf — הוצא מהעתק-innerHTML ברנדרר); עמודים מותאמים (boxes/images מעבר נתונים טהור); שורות margin (הערות-צד/תיבות מידע) עם area=margin; מיקום סופי לתמונות float (צד+טור+שורת עוגן — נקבע בבונה המודל, לא ברנדרר); מטען דיו מלא לעיטורים; עוגני endnote-title/endnote-note; fallback זהות tokenId מההקרנה.
3. **פרופילים מפורשים בתצוגה** (§2.3): `engineProfile` עובר מה-Worker דרך ui-result-v1 (legacyProfile סוף-סוף מסואריאל�; היה אובד וה-UI לא ידע מי רץ); preview-tab מציג legacy=רנדרר ישן / unified=מקרין המודל; **unified חסר-מודל = שגיאה מפורשת וגלויה** (alert בקנבס + הודעת מצב; שום נפילה שקטה); placeholders מ-geometry בווירטואליזציה; דגל ביקורת `?engine=unified` ב-boot (מפורש, בלי שינוי ברירת מחדל — §7 בהוראה).
4. **שורש RLM (באג מדידה היסטורי):** תווי בקרת bidi (U+200E/F, U+200B..D, U+202A..E, U+FEFF) אפסו-רוחב במדידה — היו 6.4px לפי hmtx הגופן בניגוד לכל מנוע תצוגה (INK_NOT_JUSTIFIED ~7px בכל מילה מסומנת; 230 מופעי RLM ב-very_long מתוכן המקור). הוכחת סיווג: זרם מילים זהה ביט-לביט; 49 שורות RLM נחלקו מחדש + המשכי-זרימה; 1110=1110 עמודים; הערות 129=129. נעילות חודשו (s8b/s69/cross-check: e68e1f0b→40d587a0).
5. **שורש סמן-מודבק (באג הקרנה היסטורי):** מילה "מילה+סמן הערה" נמדדה בשני גדלים (גוף + גודל רישום) אך הוקרנה כמילה אחת בגודל השורה ⇒ הסמן גלש מהטור (+6..13px; ברינדור הזרימה הישן נבלע בשבירת-שורה שקטה בתוך תיבת השורה — עיוור לאודיט). ההקרנה מפצלת לפי מבנה הפרגמנטים (lineWidthsFromModel מחזיר wordFrags): חלק הטקסט בגודל השורה, הסמן בגודל הרישום עם mk:true. אינווריאנטים חוזקו: s7 — זרם טקסט (לא ספירת פריטים); s8b — סכום חלקי המודל == measuredAdvance; s68 — נייטרליות פרט לסמנים החוקיים.
6. **בדיקות קבלה `s8d-pagemodel-dom` (19)** — כיסוי מלא (אף שורה לא נעלמת/מוכפלת לפי מזהה); קואורדינטות DOM==מודל בסבילות 0.05px (שורות ומילים); הוכחה שלילית למדידה; דיאגנוסטיקה גלויה לפריט/asset חסר; unified-בלי-מודל=שגיאה; legacy לא נפגע; וירטואליזציה במסמך ארוך (placeholders מ-geometry + קפיצה); זהות גופן/עוגן/סדר קריאה.

**ראיות:** npm test מלא **EXIT=0** (s8d 19/19; s10-ui 44/44 עם באנדלים שנבנו) · test:determinism OK · cross-check **PASS** (40d587a0/legacy-28f52/f6f32c40) · אודיט דפדפן: legacy 10/10+699/699 **0 בעיות**; unified 8/8+919/919 **0 בעיות** (וירטואליזציה) · **full-math-audit PASS מלא: 0 בעיות + דטרמיניזם IDENTICAL** (סגירת F-BL1 בפועל: רצפת נפח על מילות תוכן צפויות + משמר טוקניזר).

**נותר (פרוסה 4):** HTML export מה-PageModel בלבד; פרוסה 5 — PDF; פרוסה 6 — parity ופישוט.

## פרוסה 4 (17.11, ענף stage8e/pagemodel-html) — HTML export מה-PageModel (§3)

**מה נעשה:**
1. **`exportHtmlFromModel(model, settings, doc, meta)`** ב-export-api: הייצוא העצמאי נבנה מה-PageModel בלבד — אותו מקרין (`renderModelPage`) שהתצוגה החיה משתמשת בו בפרופיל המאוחד. אין typeset נוסף, אין Parser/Planner, אין מדידה, אין חלוקת הערות — הקרנה טהורה של מה שכבר נקבע. מודל חסר/שגוי ⇒ throw מפורש (חתימת הפונקציה אינה מקבלת result כלל).
2. **קישורי TOC מהמודל:** מלבני tocLinks מוקרנים כעוגני `<a href="#page-N">` במיקומיהם הסופיים; היעדים הם ה-id של אלמנטי העמוד.
3. **חיבור app-shell:** `exportRequest('html')` בפרופיל המאוחד מצרך את המודל שכבר התקבל (pageModelObj); חסר-מודל ⇒ הודעת כשל מפורשת (אין נפילה לייצוא מתוצאה גולמית). legacy ממשיך בנתיב הקיים עד שלב 9 (תקופת המעבר — כמו בתצוגה).

**ראיות:** s8e חדשה (12): הוכחה שלילית ל-typeset (patch שזורק — 0 קריאות); חתימה ללא result; כשל מפורש על 5 קלטים שגויים; מיקומי שורות לפי data-id; עוגני מילים HTML==מודל (כולל מרזב); זהות DOM↔HTML (אותו מקרין); כיסוי כל סוגי התוכן; קישורי TOC; offline (אפס http); **very_long מלא** (344,476 מילות שורות + מרזב — כולן בקובץ); אינטגרציית createApp (unified+inline-transport) — הייצוא מגיע מהמודל בפועל; נתיב legacy לא נפגע. · npm test מלא **EXIT=0** · determinism OK · cross-check PASS · **אימות דפדפן אמיתי: הקובץ העצמאי נטען (7 עמודים, 39 שורות, 152 מילים; רקע כהה+עמודים לבנים; דיו בפיזור טורים)**.

**נותר (פרוסה 5):** PDF מה-PageModel — הסרת העימוד השני מנתיב ה-PDF.

## פרוסה 5 (17.11, ענף stage8e/pagemodel-html) — PDF export מה-PageModel (§4)

**מה נעשה:**
1. **`exportPdfFromModel(model, settings, fontBytes, fontName)`** ב-export-api: הסרת העימוד השני מנתיב ה-PDF. הכותב צורך את **אותו PageModel** שה-DOM וה-HTML צורכים — אין typeset/Parser/Planner/מדידה/חלוקת הערות/החלטות מיקום. אריזה בלבד: רישום גופן הייצוא, מלאי תווים מהטקסט שמצויר בפועל (מהמודל), תתי-גופנים לפי תפקידים (window/heading/fnbody/margin + משפחות רשומות), כתיבה. עמודי הכותב = התאמה טהורה של עמודי המודל (spanning→pg.spanning; השאר→pg.lines; footnotes/folio/header/decorations כמו שהם). סימניות וקישורים — מ-model.document (נבנו בבונה). מודל חסר ⇒ כשל מפורש (model-required) — אין נתיב עימוד חלופי.
2. **השלמת זהויות במודל (סמכות):** מילות מרזב ההערות נושאות sizePt/fontKey/color מההקרנה (הכותב מצייר בזהותן האמיתית); עיטורים נושאים pdfOps (פעולות הציור שחושבו בהקרנה — svgToPdfOps).
3. **חיבור ה-Worker:** התוצאה הגולמית (עם pageModel) נשמרת בזיכרון ה-Worker; export-pdf בפרופיל המאוחד (לפי האמת של הריצה — result.legacyProfile) צורך את המודל שבזיכרון — **אותו מודל שנשלח ל-UI**; חסר-מודל ⇒ כשל מפורש. legacy ממשיך בנתיב הקיים עד שלב 9.

**ראיות:** s8f חדשה (10): הוכחה שלילית לעימוד שני (patch ל-typeset — 0 קריאות); מודל חסר/שגוי/גופן פסול ⇒ כשלים מפורשים; geometryHash של המודל חוזר ב-info; חלוץ טקסט (כיסוי >90% ממילות המודל); FontFile2+ToUnicode בקובץ; bookmarks+קישורים מהמודל עם יעדים; **גיאומטריה: מיקומי מילים ב-bbox של הפלט תואמים ל-baseline של המודל (RTL-visual כולל)**; זרימת Worker מלאה (inline-transport: typeset→מודל→ייצוא fromPageModel + השוואת hash). · npm test מלא **EXIT=0** · determinism OK · cross-check PASS. · **אימות דפדפן אמיתי + Worker אמיתי: הייצוא מהמודל (fromPageModel=true, 8 עמודים, 61KB) ו-geometryHash של הייצוא == hash המודל שה-DOM מציג (1cba68a695e6)**.

**נותר (פרוסה 6):** מלאי קוד מלא (dom-renderer/geometry-projector/legacy-projector/pdf-writer/export-api), parity DOM/HTML/PDF, ביצועים לפני/אחרי, פישוט.

## פרוסה 6 (17.11) — מלאי, parity ופישוט (§5)

**מה נעשה:** (1) מלאי קוד מלא לכל מודולי היעד — סיוון לכל פונקציה (מדידה/החלטה/materialization/ציור/אריזה/צרכנים) ב-`audits/STAGE8_SLICE6_INVENTORY.md`; (2) בדיקות parity תלת-יעדי s8g (8): אותו מודל ⇒ DOM==HTML==PDF בעמודים/שורות/מילים; דטרמיניזם ייצוא ביט-לביט; חלוץ טקסט PDF מכסה את מילות המודל; מלאי סטטי (אפס מדידה במודולי היעד); הוכחת אין-עימוד-שני ל-HTML+PDF יחד; (3) מדידות לפני/אחרי (`tools/perf-slice6.js` → `audits/perf_slice6/perf-slice6.json`): **PDF מהמודל חוסך 94.9% ב-very_long (43.2s→2.19s)** ללא השמטת תוכן (parity 359,584=359,584 מילים); DOM 481ms ל-1,110 עמודים; מודל 56.5KB/עמוד.

**ראיות:** npm test מלא EXIT=0 (s8g 8/8) · determinism OK · cross-check PASS.

**שלב 8 — מצב שערי הסגירה (§13 בהוראה):**
- [x] PageModel מכיל את כל נתוני היעד (פרוסות 1–3: ריהוט/כתרים/עמודים מותאמים/margin/floats/דיו/endnotes)
- [x] המודל עובר בפועל דרך ה-Worker ל-UI (פרוסה 2; אומת ב-Worker אמיתי)
- [x] DOM/HTML/PDF צורכים PageModel בפרופיל המאוחד (פרוסות 3–5; hash מוכח)
- [x] אין ריפלואו/מדידה/עימוד במקרינים (מוכח שלילית+סטטית)
- [x] אין עימוד שני בייצוא (unified; ה-Worker מפנה אוטומטית)
- [x] אין fallback שקט (unified-בלי-מודל = שגיאה מפורשת בכל היעדים)
- [x] קורפוסים ירוקים (cross-check PASS; full-math PASS + דטרמיניזם)
- [x] Pages מאומת חי (פריסה 3: אתר עובד, gh-pages-audit success)
- [x] מפת תלויות ורישום כפילויות מעודכנים (h3-contract במפה; מלאי פרוסה 6)
- [x] parity תלת-יעדי וביצועים (פרוסה 6)
- [ ] **תלוי שלב 9:** הסרת legacy, shadow comparison מלא, החלפת ברירת מחדל — שלב 8 נסגר בפרופיל המאוחד כשיעד המוגדר; המעבר הסופי (ברירת מחדל + הסרת נתיבים) שייך לשלב 9 כמתוכנן.

## עדכון 26.11.2026 — שילוב טיפוגרפיה מעוצבת בהקרנות DOM/HTML/PDF (מימוש חדש; שערי קבלה ממתינים)

העדכון הזה מתאר קוד שנוסף לאחר סגירת פרוסות 8a–8g ההיסטוריות. אין להעתיק את סטטוסי האימות של 17.11 ליישום החדש.

### נתיב המימוש שהוסף
1. **Shaping לפני פיצול מילים:** `production-paragraph-shaper.js` יוצר את שירות ה־paragraph shaper מתוך runtime מאומת ומדיניות מפורשת במסמך. `pipeline.js` מזרים אותו ל־line-items לפני `splitTextItem`. ללא `_typographyShaping.enabled=true` ההתנהגות הישנה נשמרת; מדיניות חסרה גורמת לשגיאה מפורשת.
2. **מקור מדידה יחיד:** `measureItem` מחשב advance מתוך xAdvance של ShapedRun, ומקבל shaping גם במילים וגם ב־glue שמייצג רווח מקור. מפתח המטמון כולל את נתוני ה־shaping.
3. **עד המיקום הסופי:** ShapedRun slices נשמרים ב־LineModel, מוקרנים למילים הממוקמות ב־materialize, מועתקים ל־PageModel ומוגנים ב־contentHash ובאינווריאנט `page-word-typography-v1`.
4. **קווי מתאר:** HarfBuzz DrawFuncs מפיקים outline לכל GID; המחרוזת הווקטורית מוגבלת בגודל ונשמרת ב־ShapedGlyph. כל shaping production לוכד outlines כברירת מחדל.
5. **DOM/HTML:** `pagemodel-dom-renderer.js` מקרין את ה־outlines כ־SVG paths במיקום המילה הסופי, שומר טקסט נגיש/להעתקה, ומדווח diagnostic מפורש אם outline חסר.
6. **PDF:** `pdf-writer.js` ממיר את אותן פקודות outline ל־PDF vector paths, משתמש ב־Bidi levels של ShapedRuns לסדר ויזואלי, ומצמיד `/ActualText` עם הטקסט הלוגי. `exportPdfFromModel` דוחה מילה מעוצבת שאין לה outline; אין חזרה שקטה לציור טקסט שמבצע shaping אחר.

### בדיקות שנוספו — עדיין אין לסמן כעוברות
- MeasureAPI: advances מעוצבים, בידוד cache ו־negative control לטקסט גלוי שלא עבר shaping.
- Production runtime: typeset עם runtime מקומי וגופן אמיתי; בדיקת הגעת GID/offset/outline ל־PageModel.
- S8D DOM: הקרנת SVG מתוך PageModel מוקפא, שימור Unicode ו־negative control ל־outline חסר.
- S8F PDF: ציור GID כנתיב וקטורי, חילוץ Unicode דרך ActualText, ו־negative control שמסרב לייצא כשחסר outline.

**מצב ראיות בעת העדכון:** הקוד והבדיקות נשמרו בענף; ריצות CI, Full Math, Corpus, shaping-runtime ו־Preview עבור ה־HEAD העדכני היו בתור/בתהליך. אין כאן טענה שהן עברו. יש לסגור את כל השערים על SHA אחד לאחר סיום הריצות, ואז לבצע בדיקת דפדפן/Worker אמיתי על DOM, HTML ו־PDF מאותו PageModel.

**מגבלה מכוונת:** הפעלת shaping נשארת opt-in מפורש. שאלות ברירות המחדל/מדיניות הגופנים/שקילות בין סביבות והכרעת חוזה המודל לא נפתרות באמצעות קוד או דוח זה.
