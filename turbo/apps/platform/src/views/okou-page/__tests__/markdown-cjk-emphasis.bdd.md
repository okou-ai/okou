# Markdown cjk emphasis

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [markdown-cjk-emphasis.test.tsx](markdown-cjk-emphasis.test.tsx).

## markdown-cjk-emphasis-001

Original test `Complete CJK emphasis pairs render semantic bold, italic, and nested emphasis by default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-cjk-emphasis.test.tsx#L38).

- **Given** A completed assistant message contains complete CJK bold, italic, bold-italic, and nested emphasis pairs.
- **When** The message is displayed using the default settings.
- **Then** The emphasis renders semantically as strong and emphasis elements, including nested emphasis; surrounding paragraph text remains intact.

## markdown-cjk-emphasis-002

Original test `Opening and closing punctuation boundaries work independently next to CJK text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-cjk-emphasis.test.tsx#L78).

- **Given** A completed assistant message has CJK emphasis markers adjacent to opening punctuation, closing punctuation, and ASCII parentheses.
- **When** The message is displayed.
- **Then** The opening- and closing-punctuation CJK spans render as bold, and the ASCII-parenthesized span renders as italic, with surrounding text preserved.

## markdown-cjk-emphasis-003

Original test `CJK boundary repair preserves code, escapes, link destinations, math source, and literal asterisks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-cjk-emphasis.test.tsx#L109).

- **Given** A completed assistant message mixes repairable CJK emphasis with inline and fenced code, escaped markers, links, math, raw HTML, and literal asterisks.
- **When** The message is displayed.
- **Then** Valid CJK emphasis is repaired, while code, escaped markers, link destinations, math source, and literal asterisks remain intact. Math source stays in math annotations, and the intended link destination is preserved.

## markdown-cjk-emphasis-004

Original test `Closed emphasis does not use formula, code, or bare-link asterisks as its closer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-cjk-emphasis.test.tsx#L205).

- **Given** A completed assistant message contains emphasis around math, bare-link, and inline-code content that includes asterisks.
- **When** The message is displayed.
- **Then** Each outer emphasis pair closes at its intended trailing marker; asterisks inside math, the link, or code do not close it.

## markdown-cjk-emphasis-005

Original test `Quoted angle brackets do not expose raw code asterisks as emphasis closers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-cjk-emphasis.test.tsx#L247).

- **Given** A completed assistant message contains an unclosed code element with quoted angle brackets and raw asterisks, plus a separate closed code element with raw asterisks and an emphasis closer after it.
- **When** The message is displayed.
- **Then** The unclosed code text is not wrapped in emphasis; the closed code text is included in the intended outer bold span, and the CJK emphasis is repaired.

## markdown-cjk-emphasis-006

Original test `Quoted angle brackets do not expose raw kbd asterisks as emphasis closers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-cjk-emphasis.test.tsx#L247).

- **Given** A completed assistant message contains an unclosed kbd element with quoted angle brackets and raw asterisks, plus a separate closed kbd element with raw asterisks and an emphasis closer after it.
- **When** The message is displayed.
- **Then** The unclosed kbd text is not wrapped in emphasis; the closed kbd text is included in the intended outer bold span, and the CJK emphasis is repaired.

## markdown-cjk-emphasis-007

Original test `Long literal-star paragraphs preserve text alongside repairable CJK emphasis`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-cjk-emphasis.test.tsx#L285).

- **Given** A completed assistant message contains a paragraph with 4,000 repetitions of “file*.txt ” followed by Chinese text, alongside repairable CJK emphasis and tilde-delimited emphasis.
- **When** The message is displayed.
- **Then** The long literal-star paragraph is preserved without emphasis markup; the CJK bold and tilde-delimited emphasis render correctly.

## markdown-cjk-emphasis-008

Original test `Rendered text preserves authored zero-width spaces and Copy message keeps the exact raw source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-cjk-emphasis.test.tsx#L313).

- **Given** An assistant message contains CJK emphasis and authored zero-width spaces in ordinary text and within the emphasized text.
- **When** The user selects Copy message.
- **Then** Rendered text preserves the authored zero-width spaces, and the clipboard receives the exact original Markdown source.

## markdown-cjk-emphasis-009

Original test `Streaming leaves unclosed runs literal and repairs only a pair completed by appended text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-cjk-emphasis.test.tsx#L357).

- **Given** A streaming assistant message ends with incomplete CJK emphasis markers, and earlier paragraphs have unclosed single- and triple-star runs.
- **When** The stream first appends “）*” and then appends “）**后文” and completes the run.
- **Then** The unclosed runs remain literal throughout; the incomplete closing marker does not create emphasis, but the completed pair renders as bold with surrounding text preserved.
