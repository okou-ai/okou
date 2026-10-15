# Google Slides no-wrap import regression

`nowrap.pptx` is a synthetic, editable four-page presentation, with no customer
content. Its text boxes use browser-measured Arial and Geist line widths and
explicit DrawingML `wrap="none"`. The file itself renders without the extra
line breaks in an Office renderer.

1. A tight Arial heading: Google imports `Same Team` as two lines.
2. A tightly bounded Arial number: Google imports `05` as two lines.
3. Geist headings: Google splits `Set` and the final `s` of `guardrails`, along
   with some body text. Geist is available in Google Slides; no embedded-font
   support is required for this case.
4. Controls: left, center and right alignment with and without rotation, a
   normally wrapping paragraph, a painted text box, and explicit line breaks.

To reproduce, upload the unchanged file to Drive with target MIME type
`application/vnd.google-apps.presentation`, then inspect the native deck or
export its PDF. The original upload and Google conversion are distinct outputs.

The route tests upload this same file through both current and legacy public
API entry points. They inspect the bytes sent to Drive and assert text/style
preservation, stable text anchors, unchanged painted/wrapping controls, and
byte-identical original uploads. A real Google import remains the visual
acceptance boundary; mocked HTTP tests cannot establish Google's line layout.

The 2026-10-15 live comparison restored all three cases with a font-relative
width allowance. Changing only `noAutofit`/`normAutofit`/`spAutoFit` did not repair
the import, and a fixed one-point allowance still split large headings. The
control page was pixel-identical before and after at 1600 × 900 when rendering
Google's exported PDF. Google-generated PNG thumbnails showed separate
Geist regular-weight rendering differences from that PDF; they are not evidence
that every font renderer matches. A signed-in editor walkthrough was not run.
