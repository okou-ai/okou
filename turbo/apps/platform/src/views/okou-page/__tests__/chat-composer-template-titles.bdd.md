# Chat composer template titles

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-template-titles.test.tsx](chat-composer-template-titles.test.tsx).

## chat-composer-template-titles-001

Original test `Hovering a built-in caption shows its hint without changing the selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-template-titles.test.tsx#L54).

- **Given** A saved presentation template is selected in the composer and its picker is open.
- **When** The user hovers over a built-in template caption.
- **Then** A title hint appears, the picker stays open, and the existing selected template remains unchanged; the hovered template's slide preview does not appear.

## chat-composer-template-titles-002

Original test `Leaving a built-in caption dismisses its title hint`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-template-titles.test.tsx#L68).

- **Given** A saved presentation template is selected in the composer and a built-in caption's title hint is visible.
- **When** The user moves the pointer away from the caption.
- **Then** The title hint disappears.
