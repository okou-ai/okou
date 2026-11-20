# Markdown parser isolation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [markdown-parser-isolation.test.tsx](markdown-parser-isolation.test.tsx).

## markdown-parser-isolation-001

Original test `Opening Instructions preserves literal plus signs in a new streamed reply`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.test.tsx#L99).

- **Given** The user opens an agent's Instructions tab, then its chat, where a plain reply contains literal `++` signs.
- **When** A new streamed reply arrives containing bold Markdown and `++Reply`.
- **Then** The bold label renders as bold, `++Reply` remains literal text, and no underline is created.

## markdown-parser-isolation-002

Original test `Opening Instructions preserves literal plus signs as an unfinished reply grows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.test.tsx#L118).

- **Given** The user opens an agent's Instructions tab, then its chat, where an unfinished streamed reply contains bold Markdown and `++Reply`.
- **When** The reply grows to `++Reply+`.
- **Then** The growing text remains literal, the label remains bold, and no underline is created.

## markdown-parser-isolation-003

Original test `Opening Instructions preserves rich Markdown when a streamed reply completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.test.tsx#L142).

- **Given** The user opens an agent's Instructions tab, then its chat, where a streamed reply contains bold Markdown and `++Reply+`.
- **When** The reply completes with literal plus signs, inline code, a URL containing `++`, a numbered list starting at 3, and a checked task.
- **Then** Rich Markdown renders while literal plus signs remain literal; the code is preserved, the Reference link points to `https://example.com/a++b`, the list starts at 3, the task is checked, and no underline is created.

## markdown-parser-isolation-004

Original test `Opening Instructions keeps rich Activity logs readable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.test.tsx#L198).

- **Given** The user opens an agent's Instructions tab, then its chat, which has a completed run with activity logs containing bold Markdown, literal plus signs, and underlined HTML.
- **When** The user opens the run logs.
- **Then** The Activity label renders bold, the literal plus signs remain visible, the HTML underline renders, and the user is taken to that run's activity page.
