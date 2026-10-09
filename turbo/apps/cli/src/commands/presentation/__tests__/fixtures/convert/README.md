# Native export baseline fixtures

These are manual browser/renderer regression inputs, not mocked visual tests.
The command unit tests separately cover permission enforcement, parsing,
byte-preserving artifact transfer, selector waiting, file URLs, and text checks.

## Purpose

Compare the pinned `dom-to-pptx@2.1.2` renderer's original artifact with the
previous CLI wrapper, without silently repairing the comparison inputs or
outputs. This is an experimental baseline, **not a production-ready fidelity
improvement**. Do not treat a successful `--verify` result as visual acceptance.

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

## Executed comparison

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
