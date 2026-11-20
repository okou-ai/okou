# Markdown interactions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [markdown-interactions.test.tsx](markdown-interactions.test.tsx).

## markdown-interactions-001

Original test `Copying one of several code blocks confirms only that block`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-interactions.test.tsx#L113).

- **Given** A chat message contains two TypeScript code blocks, `const first = "alpha";` and `const second = "beta";`, each with a copy button.
- **When** The user copies the second block.
- **Then** Only the second button is labeled “Copied”; the first remains “Copy to clipboard.” The clipboard contains `const second = "beta";\n`.

## markdown-interactions-002

Original test `External links open safely in a new context`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-interactions.test.tsx#L123).

- **Given** A chat message contains a link labeled “Example website” to https://example.com.
- **When** The user clicks the link.
- **Then** The link points to https://example.com/, opens in a new context, and has both `noopener` and `noreferrer` in its `rel` value.

## markdown-interactions-003

Original test `Repeated rendering keeps rich message content stable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-interactions.test.tsx#L153).

- **Given** A chat message contains a heading, bold and emphasized text, a TypeScript code block, a table, a quotation, a list, math source, a reference link, an image, and literal raw HTML.
- **When** The chat receives a run-completed event and renders the message again.
- **Then** The message retains one heading, one bold element, one code block, one table, one quotation, and one list. The math source, reference link, and literal raw HTML remain present, and exactly one image with alt text “Stable image” remains.

## markdown-interactions-004

Original test `A user can copy a code block`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-interactions.test.tsx#L248).

- **Given** A chat message contains the TypeScript code `const greeting: string = "hello";` in a code block with a copy button.
- **When** The user copies the code block.
- **Then** The button is labeled “Copied,” and the clipboard contains `const greeting: string = "hello";\n`.
