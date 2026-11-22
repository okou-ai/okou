# Chat conversation locator

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-conversation-locator.test.tsx](chat-conversation-locator.test.tsx).

## chat-conversation-locator-001

Original test `sampled markers show the first-turn timestamp across the whole conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.test.tsx#L65).

- **Given** A conversation has 25 turns, but its first question is not rendered in the current viewport; the locator displays 24 sampled markers.
- **When** The user hovers the first marker.
- **Then** The timestamp preview shows the first turn's time, Aug 1, 10:00 AM, with datetime 2026-08-01T10:00:00.000Z.

## chat-conversation-locator-002

Original test `first-turn navigation reaches beyond the rendered conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.test.tsx#L90).

- **Given** An eight-turn conversation has its first question outside the rendered viewport.
- **When** The user selects the first conversation marker.
- **Then** The first question is brought into the viewport at its top edge, and its message receives landing feedback.
- **Upstream change** Use a 30-turn conversation. After selecting the first marker, answers 24 and 30 are outside the mounted transcript. [#49882](https://github.com/okou-ai/okou/pull/49882).

## chat-conversation-locator-003

Original test `repeat marker selection keeps the landing feedback visible`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.test.tsx#L117).

- **Given** The user has selected the first marker in an eight-turn conversation, and the first question displays landing feedback.
- **When** The user selects the same marker again.
- **Then** The first question continues to display landing feedback.

## chat-conversation-locator-004

Original test `selecting another marker moves the landing feedback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.test.tsx#L148).

- **Given** The first question in an eight-turn conversation is showing landing feedback after its marker was selected.
- **When** The user previews and selects the last marker.
- **Then** The preview shows Aug 1, 10:07 AM, with datetime 2026-08-01T10:07:00.000Z. The eighth question receives landing feedback, the first question loses it, and the eighth question is positioned about 168 pixels below the viewport top.

## chat-conversation-locator-005

Original test `leaving the locator hides its timestamp preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.test.tsx#L197).

- **Given** The user is hovering the first marker in an eight-turn conversation and sees the Aug 1, 10:00 AM timestamp preview.
- **When** The user moves the pointer away from the conversation locator.
- **Then** The timestamp preview disappears.
