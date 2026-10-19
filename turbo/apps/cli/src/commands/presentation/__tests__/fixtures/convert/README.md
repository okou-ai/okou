# Native export baseline fixtures

These are manual browser/renderer regression inputs, not mocked visual tests.
The command unit tests separately cover permission enforcement, parsing,
artifact transfer, fixed-frame geometry, table metadata, script fonts,
selector waiting, file URLs, and page/occurrence-scoped native-text checks.

## Editable SVG contract

`svg-native.html` covers native inline SVG export and its explicit boundaries:

- S01: rectangles (including rounded corners), circles, ellipses, lines,
  polylines, polygons, relative paths, shorthand cubic/quadratic curves, arcs,
  transforms, solid fills, stroke caps/joins, alpha and simple SVG text.
  Each SVG becomes one native group of paths and text boxes. SVG arcs and
  ellipses use cubic Bezier approximations. Ungroup to edit the components.
- S02: gradients, `use` references and masks retain the **entire original SVG**
  as one vector picture and report `svg-vector-image`. Do not convert only the
  supported children. The renderer may include a PNG compatibility preview
  alongside that SVG; this is not a claim that every viewer renders the SVG.

Native conversion is deliberately bounded. Paint servers, filters, masks,
clipping, composited group opacity, markers, dashes, even-odd fills, nested
viewports, nonuniform stroke transforms and complex text use the same explicit
source-SVG retention path. External SVG `img` assets remain source pictures.
Retained SVGs freeze computed paint and keep internal definition references;
referenced definitions retain their authored paint inheritance. External styles,
resources and fonts are not newly embedded and still need viewer
acceptance. This path preserves vector source, not component editability.
Plain SVG labels participate in the source-text verification denominator, so
labels inside a retained SVG picture cannot pass as editable text. Unpainted
definition text is excluded from that denominator.

With `presentation-convert:write`, run the CLI against this fixture:

```bash
okou presentation convert --input svg-native.html --selector .slide \
  --out svg-native.pptx --verify --json
```

Inspect S01 for native `p:grpSp`/`p:sp`/`a:custGeom` and text, with no SVG
picture objects. Inspect S02 for three complete SVG pictures and three explicit
diagnostics. Compare the HTML and PPTX renders, then upload this PPTX to Okou
and use its **Upload to Google Slides** action. Verify ungrouping, recoloring
and label editing on S01 in Google Slides; compare positions, curves and stroke
widths against the HTML/PPTX. This external import needs separate acceptance:
native DrawingML alone does not prove Google's import behavior. SVG charts
become editable geometry, not data-backed PowerPoint or Google Sheets charts.

The focused command/parser tests do not substitute for this browser/viewer check.

## Purpose

The first commit established a pinned `dom-to-pptx@2.1.2` native baseline;
the following commit adds independently measured geometry contracts. Keep the
previous artifacts as controls, without silently repairing either side. This
is still experimental, **not a production-ready fidelity replacement**.
Do not treat a successful `--verify` result as visual acceptance.

## Browser-measured native adapter

`native-layout-regressions.html` adds six pages covering resolved counters and
markers, accumulated transforms, editable path paint, text paint and source
image tiling, CSS stacking, and ancestor-gradient projection. The adapter reads
the browser's layout and paint order before materializing text. Each emitted
object has a measured source identity; generated content has one owner.

- Shapes retain native paths, independent borders, rounded corners, and linear
  or radial fills. Repeated linear stops preserve hard edges and transparent
  endpoints retain CSS color interpolation. Tables share the fill serializer.
- Image URL backgrounds retain source pixels and use native placement, tiling,
  crop, and supported image effects. HTML/CSS decoration is never rasterized.
- MathML fractions, roots, scripts, and token glyphs become a native group of
  editable text and rules. Browser-resolved math fonts and `math-auto` Latin
  glyphs are retained. This is component editing, **not semantic OfficeMath
  editing**; `math-semantic-editing` reports that boundary.
- Resolved list markers are editable text, including reversed, negative and
  Roman markers. They are static browser-resolved values, not automatically
  renumbering PowerPoint paragraphs.

The JSON result includes page-scoped `unsupported` entries (with feature,
reason and bounds), `layout.pages[].clippedSource`, native object counts in
`structure`, and missing **and unexpected** text in `verify`. Formula groups
are counted separately from ordinary text. Verification preserves word
boundaries and case, rejects duplicate generated text, validates XML throughout
the package, and rejects duplicate object IDs or unresolved shape references
before writing the output. Invalid renderer XML fails before normalization can
silently skip a page.

`shadow-contract.html` adds six pages for layered outer and inset shadows,
transparent backgrounds, positive/negative spread, transformed and clipped
silhouettes, independent corner radii, and collapsed layers. Each CSS shadow
layer has its own editable group, ordered beneath the box or above its fill for
inset shadows. Blurred opaque outer silhouettes retain native DrawingML shadow
effects; other silhouettes use vector contour bands with geometric cutouts.
Bands do not overlap, which avoids repeated low-alpha rounding in viewers.
Contour blur is an approximation to Gaussian coverage, not a pixel-exact browser
blur for every radius and shape. Inspect the corner transitions and very large
blur radii separately. No shadow path captures or embeds a raster image.

Visual acceptance remains necessary. Current boundaries include conic fills,
arbitrary transformed glyph clipping, perspective and skewed text, group
opacity and blending, backdrop blur, and unsupported filters. LibreOffice does
not reliably display native text gradient/outline paint; those XML properties
are not proof of cross-viewer
fidelity. Font metrics and baseline offsets also need viewer-specific review.
Do not solve these boundaries with generated images or claim full fidelity
from a text or structural pass.

Run the focused command tests (without the full local suite):

```bash
pnpm exec vitest run src/commands/presentation/__tests__/convert.test.ts \
  src/commands/presentation/__tests__/screenshot.test.ts
```

## Native export policy

HTML text and CSS shapes/effects must not become generated image replacements.
The CLI no longer captures page regions. The pinned renderer is adapted before
its image jobs run: original `img`, `svg`, `canvas`, and CSS image URL assets are
allowed; generated decoration/icon images are omitted and reported in JSON as
`unsupported`. This is a capability gap, not a visual success. CSS properties
that the renderer silently approximates still need source/PPT screenshot review.

The adapter requires exact pinned-bundle anchors and uses a separate cache key.
Local and remote sessions use the same policy. A changed bundle fails explicitly
instead of restoring image fallback. Keep the original source text denominator
before layout fragmentation, including text that the native exporter misses.

| Input                                     | Cases     | Observation target                                                                                                                                                                     |
| ----------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal-cases.html`                      | N01–N12   | Plain text, natural/hard wrapping, rich runs, inline highlights, nested lists, CJK fallback, whitespace, table heights, ancestor background, complex corners, and regional font stacks |
| `active-deck.html`                        | N13a/N13b | Selected slides include an inactive page; export must not silently assume that every selected slide has been activated                                                                 |
| `custom-selector.html`                    | N14       | An explicit `.audit-page` selector is the input contract                                                                                                                               |
| Byte-identical copy named `path#tag.html` | N15       | A legal local path must be encoded as a file URL                                                                                                                                       |

Keep the HTML's 1600 × 900 viewport and export at 13.333 × 7.5 inches. Use the
same fonts, renderer bundle, and PPT viewer on both sides. The second active-deck
HTML reference is made by toggling only the two `active` classes, not by changing
its content or running that variant through the converter.

## Reproduce one side

Run from `turbo/apps/cli`, with an ordinarily authorized CLI environment:

```bash
pnpm build
node dist/okou.js presentation convert \
  --input src/commands/presentation/__tests__/fixtures/convert/minimal-cases.html \
  --selector .slide --out /tmp/minimal-cases.pptx --verify --json
okou presentation screenshot --input /tmp/minimal-cases.pptx \
  --out /tmp/minimal-ppt-pages --width 1600 --height 900 --json
okou presentation screenshot \
  --input src/commands/presentation/__tests__/fixtures/convert/minimal-cases.html \
  --slides .slide --out /tmp/minimal-html-pages --width 1600 --height 900 --json
```

Keep original artifacts, including a PPTX retained after verification exits 1.
Compare each page manually; pixel deltas are evidence locators, not quality
scores. Never disable the capability guard or substitute credentials to run
these cases.

## Measured geometry follow-up

`geometry-contract-cases.html` adds four independent checks: wrapped inline
origins, nested visibility overrides and a single-character label, identical
Han glyphs with three regional font stacks, and text-bearing fixed paint boxes.
It also includes repeated text and UI outside the selected pages.

The implementation now separates three contracts:

1. Browser preparation activates explicitly selected inactive pages, waits for
   fonts and eager image loading, and retains inherited solid backgrounds.
2. Wrapped or mixed inline text becomes measured, styled native line fragments
   plus independent paint. An owner's background, border or shadow alone must
   not fragment its text. A multi-line inline bounding rectangle is a union,
   not the origin/width of one text frame. Transformed containers are excluded
   from fragmentation and retain the native adapter's affine geometry.
3. PPTX boxes do not autofit. Table row heights and cell fills come from browser
   measurements; replacing a cell fill must preserve nested border paint.
   Per-frame script font slots come from the source stack, not an OS-wide guess.

Text verification is restricted to selected pages and native text. It tracks
repeated occurrences and single-character labels and rejects transparent
native glyph fills. Image fallback text is not native text. The JSON report
explicitly states that no rendered-page comparison was performed by `--verify`.
A source-built CLI retains the normal capability guard and cleans up its DOM
preparation even on failure.

The follow-up executed 27 authorized conversions, yielding 27 original CLI
PPTX files and 97 LibreOffice-rendered pages. This comprises the existing
64-case corpus, four new geometry cases, and 29 supplemental/control pages.
All conversion commands completed and every PPTX XML part parsed. Image
comparisons, not those exit codes, establish each visual repair. The offscreen
lazy-image HTML screenshot also rendered all eight pages using the shared
resource wait. No production merge or deployment was performed.

Known remaining limitations include clipping/ellipsis, several CSS gradients
and filters, generated counters/list markers, group compositing, transformed
geometry, and MathML. Do not restore the old blanket normalization/font policy,
or claim native PowerPoint/Keynote acceptance from LibreOffice results.

## Historical native-baseline comparison

The control was built from `2ef5d4ec8c2aedc9217e669f110f8c68fb9b65f3`.
Both CLI builds reported 9.382.1 and used the same 2.1.2 renderer. Screenshot
capture used CLI 9.382.0. PPT page images were rendered by LibreOffice 24.2.2.2,
not native Microsoft PowerPoint or Apple Keynote.

The complete matrix also reused the unchanged 48-page audit corpus and a lazy
image probe. It ran 34 primary conversions: 30 original PPTX files / 126 PPT
page images, plus 3 single-variable diagnostic conversions / 20 page images.
The diagnostic omitted only the control build's `spAutoFit` to `normAutofit`
replacement; that compiled diagnostic is not repository implementation code.
Input hashes remained unchanged during execution.

### Established limits, not acceptance claims

- N01–N04 show that ordinary text and rich runs without highlight backgrounds
  remain close without the removed policies.
- N05/C06/C46 recover visible font size but retain overlap or gain wrapping.
  The single-variable diagnostic confirms that the autofit substitution
  contributes to the small-font symptom in the LibreOffice viewer; removing it
  alone is not a rich-text layout fix.
- C07's preformatted line spacing improves, but exact long-token line breaks
  remain different.
- N09/C29/C31/C32 lose measured table heights. For N09 the raw renderer writes
  zero row heights; the control writes the measured values.
- N10/C39 lose the ancestor-painted background, despite 100% text coverage.
- N13b becomes blank and fails text coverage at 50%.
- C01 preserves the same rectangle/circle transform coordinates in the raw
  XML, yet the rendered text-bearing shapes shrink with the renderer's original
  autofit/wrapping policy. Do not misclassify this as lost browser measurements.
- N12's raw East Asian font slots still refer to Arial, not each regional
  fallback. Removing the blanket SC rewrite does not solve font resolution.
- N14/N15 convert successfully after the selector/file-URL corrections.
- Both versions still time out on the offscreen lazy-image probe. Existing
  clipping, generated-content, gradient, filter, and text-verifier limitations
  have not been repaired by this simplification.

Follow-up work should establish measured fixed geometry, per-line rich-text
geometry, slide activation/background preparation, and table row geometry at
their owning layer. Add one independently verified contract at a time rather
than restoring the entire policy bundle or weakening verification to look green.

## Native rounded-background and text separation

`rounded-text-contract.html` adds four independent pages for the C28 repair:

- T01: zero, positive and negative rotation, including the original capsule text.
- T02: non-center transform origins, translation and asymmetric CSS padding.
- T03: explicit line breaks and normal multi-line wrapping.
- T04: a uniform border, rich runs, a hyperlink and a zero-padding control.

DrawingML's `roundRect` preset has an inset text rectangle in addition to the
CSS padding represented by `bodyPr`. Export its paint as a native background
and its original editable text as a transparent rectangular shape with the
same transform and text properties. Keep background borders and shape effects
on the background only, retain the original text identity and hyperlinks, and
allocate an unused slide-wide identity for each background. For independent
pure 2D rotations, retain measured local subpixel dimensions rather than the
renderer-rounded dimensions, and disable viewer wrapping only when the browser
measures a single line. Do not globally widen shapes or disable legitimate
multi-line wrapping.

Run the ordinary authorized source-built CLI and compare every page with the
browser reference. The new fixture is not a screenshot-only deck, and its
native text must not be duplicated invisibly to make verification pass.
Native PowerPoint/Keynote remain separate acceptance targets.

## Text container capacity

`text-container-contract.html` adds 40 cases across four pages:

- T01 compares the same 560px text box with no paint, a background, each border
  side, a transparent border, a shadow, rounded corners and a gradient. With
  24px horizontal padding, the background-only case must retain 512px of usable
  text space; the measured glyph width is not the container width.
- T02 checks left, center and right alignment, explicit and natural line breaks,
  mixed styles, a fixed-width inline box, CJK and ellipsis. Materialized lines
  retain available content space while preserving their measured anchor.
- T03 checks inline side borders, neighboring badges, scripts, underline,
  preformatted text, RTL, first-line indentation and empty painted neighbors.
  Each fragment must stay within its own inline box and avoid adjacent content.
- T04 checks word spacing, margins between inline runs, mixed direction,
  logical alignment, scale, rotation, asymmetric padding and `content-box`.
  Text insets include CSS padding and border widths, scaled with the text.

Run the authorized conversion and screenshot commands above with this fixture
and `--selector .slide`. Compare source and exported text frame widths, usable
width after insets, line count, font size, glyph anchors and independent paint.
Rounded backgrounds remain rounded; their editable text frames are rectangular.
The `data-case` and `data-fragmented` attributes identify each browser case and
whether preparation should materialize its text.

Adjacent runs can leave no spare space, and direction changes or split words
with contextual trailing-space advances retain their measured frames. This
does not provide a general viewer-specific font-fitting policy. Browser
geometry checks do not establish PowerPoint or Google Slides acceptance.

## Selected page background boundary

`page-background-contract.html` places six `.stage` pages inside a 900-pixel
scrolling deck. Only the first page is initially in the deck viewport. Export
all six together with `--selector .stage`, without scrolling between exports:

- B01 is the visible blue-page control.
- B02 preserves an offscreen dark background and readable white text.
- B03 preserves an offscreen native gradient.
- B04 preserves the yellow background inherited from a page wrapper.
- B05 keeps descendant overflow clipping at the inner padding edge; neither
  the oversized orange rectangle nor its green shadow may leak outside it.
- B06 retains the selected page's purple fill and yellow border while clipping
  its oversized child inside that border.

The selected page is an independent export surface. Clipping may walk from a
descendant through that page, but must not continue from the page itself into
the enclosing deck viewport. Compare HTML, the previous export and the current
PPTX; all page paint must remain native, with no generated picture objects.

## Native fidelity contract

`fidelity-contract.html` covers six independently inspectable pages:

- F01: normal-flow text above negative-z backgrounds, nested stacking contexts,
  positive siblings and a rounded card's outer shadow.
- F02: horizontal, vertical and nested rotated reflections of source images.
- F03: measured table row heights and single-line numeric cells.
- F04: filled/outlined rounded badges and legitimate multiline table content.
- F05: variable font weights 400/500/600/700, negative character spacing across
  adjacent colored runs, a missing first-choice family, a CSS family alias and
  a regular-only fallback with `font-synthesis-weight: none`.
- F06: a rotated table whose cells retain their own editable text, an ordinary
  control table, and embedded faces declared with `normal`/`bold` weight keywords.

Table grids remain native tables; measured cell text and badge paint are
separate editable objects. Editing a grid cell does not edit those text boxes.
No page, text, badge, border or shadow is replaced with a screenshot.

The adapter decodes used webfonts losslessly, instances variable axes with the
pinned `harfbuzzjs@1.6.1` subset WASM, and preserves glyph metrics and OpenType
positioning/substitution tables. A distinct embedded family identifies each
instance so the viewer cannot substitute a different weight. CSS font subsets
are selected by glyph coverage. System-only fonts remain viewer dependencies;
fonts that forbid embedding produce a diagnostic. The command requires network
access for its pinned renderer and font instancer.

Use an embedded-font-capable PPTX viewer for both baseline and candidate.
LibreOffice 24.2 does not import PPTX embedded fonts; it is not a valid font
fidelity oracle for this contract. Validation used LibreOffice 26.2.6.3 and
Chromium HTML references, not native Microsoft PowerPoint or Apple Keynote.
A successful native-text verification remains separate from visual acceptance.

Font fixture provenance: `fonts/geist-latin-variable.woff2` comes from
`@fontsource-variable/geist@5.3.0/files/geist-latin-wght-normal.woff2` under the
included SIL OFL license. The TTF is its losslessly decoded SFNT counterpart;
`geist-latin-regular.woff2` is a weight-400 static instance of that same font.
The TTF binary regression checks independently validate table preservation,
coverage, names and the SFNT checksum, including malformed directories.

F03 also covers percentage `colgroup` tracks with independently authored cell
widths. F05 includes a CSS-aliased, static CFF Chinese fallback. The small
`noto-cjk-fixture` OTF/WOFF2 pair is subset from Noto Sans CJK SC Regular under
`fonts/Noto-OFL.txt`. Static fonts keep their outline tables intact; only variable
fonts enter the axis instancer, which must retain an outline table.

The same page also covers a TTC webfont. `collection-fixture.ttc` combines the
existing CFF and variable TrueType fixtures under their included licenses.
Extract the default face with absolute collection table offsets before font
coverage/embedding; preserve every shared table and recompute SFNT checksums.
The binary test also checks the second face and invalid collection offsets.
F04 includes an inline-flex badge: materialize it with its owning cell so an
empty inline box cannot move the baseline and enlarge previously correct rows.
Its outlined badge uses only an inset shadow, which must survive even when the
source has no background fill or CSS border.
