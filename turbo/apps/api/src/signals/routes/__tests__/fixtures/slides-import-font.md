`slides-import-font.ttf` is an original synthetic TrueType fixture, generated
with FontTools FontBuilder. It contains printable ASCII mapped to simple
rectangles, with 1000 units/em. Advances are 700 for `0`, 650 for `5`, 250 for
space, and 600 for the remaining characters. Its family is `Import Test`.

These deliberately simple metrics give independent expected widths: `05` at
192pt requires 259.2pt, and `guardrails` at 49.92pt requires 299.52pt. The API
tests serve these real font bytes at the external Google Fonts boundary; they
do not replace the production parser or text preparation implementation.
