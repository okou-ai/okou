`slides-import-font.ttf` is an original synthetic TrueType fixture, generated
with FontTools FontBuilder. It contains printable ASCII mapped to simple
rectangles, with 1000 units/em. Advances are 700 for `0`, 650 for `5`, 250 for
space, and 600 for the remaining characters. Its family is `Import Test`.
Its OpenType `kern` feature adjusts the `0`/`5` pair by -20 units and the
`0`/`6` pair by +30 units.

These deliberately simple metrics give independent expected widths: `05` at
192pt requires 259.2pt, and `guardrails` at 49.92pt requires 299.52pt. The API
tests serve these real font bytes at the external Google Fonts boundary; they
do not replace the production parser or text preparation implementation.

`06` at 192pt requires 255.36pt after kerning, exceeding its unkerned 249.6pt
advance. The tests also split this pair across differently colored runs. The
negative adjustment for `05` must not reduce its unkerned frame reservation.
