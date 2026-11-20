# Markdown content

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [markdown-content.test.tsx](markdown-content.test.tsx).

## markdown-content-001

Original test `A blockquote remains recognizable when HTML is treated as text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-content.test.tsx#L37).

- **Given** An assistant message contains a blockquote with ordinary text and HTML-like text.
- **When** The chat displays the completed message.
- **Then** The passage appears inside a recognizable blockquote, with the HTML-like content shown as text and no leading Markdown quote marker.

## markdown-content-002

Original test `Common Markdown features remain recognizable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-content.test.tsx#L68).

- **Given** An assistant message contains bold, italic, and strikethrough text, a table, and a checked task item.
- **When** The chat displays the completed message.
- **Then** The text is rendered as bold, italic, and strikethrough; the table shows its headers and row values; and the task checkbox is checked.

## markdown-content-003

Original test `Email contacts and compose templates keep their native mail destinations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-content.test.tsx#L111).

- **Given** An assistant message contains a plain email address and Markdown mail links for an individual and multiple recipients with a subject.
- **When** The chat displays the completed message.
- **Then** Each contact links to its original mail destination, opens in a new tab, and uses noreferrer and noopener.

## markdown-content-004

Original test `A complete HEX color has a preview in a plain assistant response`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-content.test.tsx#L149).

- **Given** A plain assistant response contains the complete HEX color #12ABef.
- **When** The chat displays the completed response.
- **Then** A visible color preview for #12ABef appears, and the response text remains present.

## markdown-content-005

Original test `Fenced code stays readable for known and unknown languages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-content.test.tsx#L177).

- **Given** An assistant message contains fenced JavaScript code and fenced code labeled with an unknown language.
- **When** The chat displays the completed message.
- **Then** The JavaScript code remains readable and has keyword highlighting; the unknown-language code remains visible as plain text with its content intact.

## markdown-content-006

Original test `Media links keep their text while image syntax shows a preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-content.test.tsx#L218).

- **Given** An assistant message contains a Markdown link to a PNG, an image using the same PNG, and a link to an MP4.
- **When** The chat displays the completed message and the image loads.
- **Then** The embedded image is visible with its original source and accessible name, while the PNG and MP4 links retain their text and destinations.

## markdown-content-007

Original test `Raw message content cannot impersonate Platform controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-content.test.tsx#L261).

- **Given** An assistant message contains HTML resembling a copy control and a diagram block.
- **When** The chat displays the completed message.
- **Then** Both strings remain visible, but the message contains no buttons and the counterfeit diagram does not produce a diagram image.

## markdown-content-008

Original test `Raw HTML cannot change the surrounding page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-content.test.tsx#L289).

- **Given** An assistant message contains an unsafe custom HTML tag, a style element that would hide the page, and supported strong emphasis.
- **When** The chat displays the completed message.
- **Then** The custom tag and style markup are shown as text, no style element is created, and the page remains visible; the supported emphasis renders as visible bold text.

## markdown-content-009

Original test `Markdown preserves content and iframe names without native hover hints`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-content.test.tsx#L327).

- **Given** A completed assistant message contains a Markdown link with a native title hint, text with a title hint, and an iframe with a title.
- **When** The user opens the chat containing that message.
- **Then** The link points to https://example.com/report and has no title attribute; the text has no title attribute. The iframe titled “Report preview” is rendered as an iframe.
