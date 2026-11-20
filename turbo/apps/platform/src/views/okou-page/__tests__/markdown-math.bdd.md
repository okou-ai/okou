# Markdown math

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [markdown-math.test.tsx](markdown-math.test.tsx).

## markdown-math-001

Original test `Agent formulas render from explicit delimiters without treating currency as math`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-math.test.tsx#L21).

- **Given** A completed Agent chat message contains explicit inline and display math, invalid and fatal math expressions, ordinary currency and ticker text, and math-like text in inline and fenced code.
- **When** The user opens the chat.
- **Then** Valid formulas render, including the valid error-marker formula; invalid and fatal formulas remain readable and are marked as errors. Currency and ticker text are preserved, and math-like text in code is not treated as math.

## markdown-math-002

Original test `Shared Agent formulas render`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-math.test.tsx#L94).

- **Given** A shared Agent thread contains an assistant message with an explicit inline formula.
- **When** The user opens the shared thread.
- **Then** The formula renders as math.
