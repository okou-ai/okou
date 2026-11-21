# Chat composer slash hint

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-slash-hint.test.tsx](chat-composer-slash-hint.test.tsx).

## chat-composer-slash-hint-001

Original test `Show the hint after a bare slash and dismiss it with the menu at /agents/e0000000-0000-4000-a000-000000000010/chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L72).

- **Given** The user is composing in an agent chat with workflow suggestions available.
- **When** They enter a bare slash, type a workflow query, accept the workflow, then enter a bare slash again and dismiss the menu.
- **Then** A hint appears after the bare slash without changing the draft. Typing opens the workflow menu and removes the hint; accepting the workflow inserts its name. Dismissing the reopened menu removes the hint while preserving the draft and editor focus.

## chat-composer-slash-hint-002

Original test `Show the hint after a bare slash and dismiss it with the menu at /chats/b1000000-0000-4000-a000-000000000101`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L72).

- **Given** The user is composing in an existing chat thread with workflow suggestions available.
- **When** They enter a bare slash, type a workflow query, accept the workflow, then enter a bare slash again and dismiss the menu.
- **Then** A hint appears after the bare slash without changing the draft. Typing opens the workflow menu and removes the hint; accepting the workflow inserts its name. Dismissing the reopened menu removes the hint while preserving the draft and editor focus.

## chat-composer-slash-hint-003

Original test `Show the hint immediately after a slash before ' 131' at /agents/e0000000-0000-4000-a000-0000000…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L112).

- **Given** The user is composing in an agent chat with the draft “ 131” and the caret at its start.
- **When** They type a slash, then type a workflow query and accept it.
- **Then** The hint appears immediately after the slash, before “ 131,” without changing the draft. Typing the query keeps the suffix after it, and accepting the workflow leaves the suffix trimmed at its start.

## chat-composer-slash-hint-004

Original test `Show the hint immediately after a slash before ' 131' at /chats/b1000000-0000-4000-a000-00000000…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L112).

- **Given** The user is composing in an existing chat thread with the draft “ 131” and the caret at its start.
- **When** They type a slash, then type a workflow query and accept it.
- **Then** The hint appears immediately after the slash, before “ 131,” without changing the draft. Typing the query keeps the suffix after it, and accepting the workflow leaves the suffix trimmed at its start.

## chat-composer-slash-hint-005

Original test `Show the hint immediately after a slash before '1231' at /agents/e0000000-0000-4000-a000-0000000…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L112).

- **Given** The user is composing in an agent chat with the draft “1231” and the caret at its start.
- **When** They type a slash, then type a workflow query and accept it.
- **Then** The hint appears immediately after the slash, before “1231,” without changing the draft. Typing the query keeps the suffix after it, and accepting the workflow leaves “1231” after the inserted workflow name.

## chat-composer-slash-hint-006

Original test `Show the hint immediately after a slash before '1231' at /chats/b1000000-0000-4000-a000-00000000…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L112).

- **Given** The user is composing in an existing chat thread with the draft “1231” and the caret at its start.
- **When** They type a slash, then type a workflow query and accept it.
- **Then** The hint appears immediately after the slash, before “1231,” without changing the draft. Typing the query keeps the suffix after it, and accepting the workflow leaves “1231” after the inserted workflow name.

## chat-composer-slash-hint-007

Original test `Keep the hint out of copied and sent Draft / and hide it for a selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L141).

- **Given** The user is composing “Draft /” in an agent chat with the caret after the slash.
- **When** They select the whole draft, copy it, restore the caret after the slash, and send it.
- **Then** The hint is hidden while text is selected and does not appear in copied plain or HTML text. The sent prompt is exactly “Draft /”.

## chat-composer-slash-hint-008

Original test `Keep the hint out of copied and sent / 131 and hide it for a selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L141).

- **Given** The user is composing “/ 131” in an agent chat with the caret after the slash.
- **When** They select the whole draft, copy it, restore the caret after the slash, and send it.
- **Then** The hint is hidden while text is selected and does not appear in copied plain or HTML text. The sent prompt is exactly “/ 131”.

## chat-composer-slash-hint-009

Original test `Keep the hint out of copied and sent /1231 and hide it for a selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L141).

- **Given** The user is composing “/1231” in an agent chat with the caret after the slash.
- **When** They select the whole draft, copy it, restore the caret after the slash, and send it.
- **Then** The hint is hidden while text is selected and does not appear in copied plain or HTML text. The sent prompt is exactly “/1231”.

## chat-composer-slash-hint-010

Original test `Preserve IME confirmation while the slash hint is present in Draft /`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L176).

- **Given** The user is composing “Draft /” in an agent chat with the caret after the slash and the hint visible.
- **When** An IME composition starts, Enter is pressed while composition is active, composition ends, and the user types “周报”.
- **Then** The hint hides during composition and returns after composition ends. Enter does not send the draft or remove editor focus; the workflow menu remains open. Typing inserts “周报” at the caret and hides the hint.

## chat-composer-slash-hint-011

Original test `Preserve IME confirmation while the slash hint is present in / 131`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L176).

- **Given** The user is composing “/ 131” in an agent chat with the caret after the slash and the hint visible.
- **When** An IME composition starts, Enter is pressed while composition is active, composition ends, and the user types “周报”.
- **Then** The hint hides during composition and returns after composition ends. Enter does not send the draft or remove editor focus; the workflow menu remains open. Typing inserts “周报” after the slash and before “ 131,” and hides the hint.

## chat-composer-slash-hint-012

Original test `Preserve IME confirmation while the slash hint is present in /1231`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L176).

- **Given** The user is composing “/1231” in an agent chat with the caret after the slash and the hint visible.
- **When** An IME composition starts, Enter is pressed while composition is active, composition ends, and the user types “周报”.
- **Then** The hint hides during composition and returns after composition ends. Enter does not send the draft or remove editor focus; the workflow menu remains open. Typing inserts “周报” after the slash and before “1231,” and hides the hint.

## chat-composer-slash-hint-013

Original test `Follow a slash on a new line without treating a URL or a partial query as an empty query`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L210).

- **Given** The user is composing in an agent chat with workflow suggestions available.
- **When** They enter a URL ending in a slash, enter a partial workflow query and place the caret within it, then start a new line and type a slash before deleting it.
- **Then** A slash at the end of the URL does not show the hint. A slash followed by “weekly” opens the workflow menu without showing the hint. On a new line, a bare slash shows the hint, and deleting the slash hides it.
