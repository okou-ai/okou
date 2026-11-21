# Sidebar pin order

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-pin-order.test.tsx](sidebar-pin-order.test.tsx).

## sidebar-pin-order-001

Original test `keyboard menu reordering survives the matching persisted event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pin-order.test.tsx#L98).

- **Given** An authenticated user sees three pinned chats in order: “First pin,” “Second pin,” and “Last pin,” followed by “Regular thread.”
- **When** The user opens “Last pin”’s menu with the keyboard and chooses Move up, then the persisted matching reorder event and a later rename event arrive.
- **Then** “Last pin” moves between “First pin” and “Second pin.” After the events arrive, the order remains, with the renamed “Persisted last pin” in that position.

## sidebar-pin-order-002

Original test `moving a pin between equal ranks preserves the requested order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pin-order.test.tsx#L151).

- **Given** “First pin” and “Second pin” have equal pin ranks, followed by “Last pin” and “Regular thread.”
- **When** The user chooses Move up for “Last pin.”
- **Then** The displayed order becomes “First pin,” “Last pin,” “Second pin,” and “Regular thread.”

## sidebar-pin-order-003

Original test `Move up skips a hidden archived pin`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pin-order.test.tsx#L172).

- **Given** “First pin,” an archived hidden pin, and “Last pin” are ordered as pins; only the visible pins and “Regular thread” appear in the sidebar.
- **When** The user chooses Move up for “Last pin.”
- **Then** The visible order becomes “Last pin,” “First pin,” and “Regular thread.”

## sidebar-pin-order-004

Original test `Move down skips a hidden archived pin`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pin-order.test.tsx#L172).

- **Given** “First pin,” an archived hidden pin, and “Last pin” are ordered as pins; only the visible pins and “Regular thread” appear in the sidebar.
- **When** The user chooses Move down for “First pin.”
- **Then** The visible order becomes “Last pin,” “First pin,” and “Regular thread.”

## sidebar-pin-order-005

Original test `an unconfirmed optimistic pin move cannot undo an agent reassignment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pin-order.test.tsx#L215).

- **Given** An authenticated user sees “First pin,” “Second pin,” and “Last pin” pinned in that order, followed by “Regular thread.”
- **When** The user moves “Last pin” up, then a canonical event reassigns it to another agent before the reorder is confirmed.
- **Then** The reassigned chat disappears from this agent’s sidebar; the sidebar shows “First pin,” “Second pin,” and “Regular thread,” rather than restoring “Last pin.”

## sidebar-pin-order-006

Original test `new pins receive a rank ahead of all existing pins`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pin-order.test.tsx#L258).

- **Given** An authenticated user sees pinned chats ranked ahead of “Regular thread.”
- **When** The user pins “Regular thread” while the pin request is still pending.
- **Then** The requested rank for the new pin is earlier than “a0,” and the sidebar optimistically shows “Regular thread” before all existing pins.
