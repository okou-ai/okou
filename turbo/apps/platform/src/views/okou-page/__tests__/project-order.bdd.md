# Project order

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [project-order.test.tsx](project-order.test.tsx).

## project-order-001

Original test `Project menus move optimistically, reconcile remote events and retain group folding above root chats`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-order.test.tsx#L189).

- **Given** The sidebar lists Launch, Research, and Campaign, with Research expanded and root chats below the Projects.
- **When** The user opens Launch’s menu, then Research’s menu and moves Research up; a remote event later moves Research to the end.
- **Then** Launch cannot move up. Research moves optimistically ahead of Launch, remains expanded, and the root chats stay below the Project groups. After the remote update, the order is Launch, Campaign, Research, and Research cannot move down.

## project-order-002

Original test `The focused Project row and menu own reorder keys instead of the current pinned chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-order.test.tsx#L256).

- **Given** The user is viewing a pinned chat, and the sidebar lists Launch, Research, and Campaign.
- **When** The user focuses Research and presses Alt+Shift+ArrowUp, then focuses its menu’s Move down item and presses Alt+Shift+ArrowDown; finally, the user focuses the pinned chat and presses Alt+Shift+ArrowUp.
- **Then** The first shortcut moves Research to the top without changing the pinned-chat order, focus, or current chat. The menu shortcut restores the original Project order and returns focus to Research’s menu trigger. The pinned-chat shortcut reorders the pinned chats and leaves Project order unchanged.

## project-order-003

Original test `Project page reorder preserves composer text and ignores composition, repeats and other modifiers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-order.test.tsx#L283).

- **Given** The user is on the Research Project page with unsent composer text.
- **When** The user presses Alt+Shift+ArrowUp in the composer, also testing the same key with IME composition, a repeated key event, or the Meta modifier; then presses ArrowUp from the open chat-list menu.
- **Then** Composition, repeated key, and Meta-modified events are not prevented. The valid reorder shortcut moves Research ahead of Launch while preserving the composer text, focus, and Project page. ArrowDown in the open menu does not reorder Projects.

## project-order-004

Original test `A failed request retains the optimistic move until a later confirmed move reconciles it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-order.test.tsx#L310).

- **Given** The sidebar lists Launch, Research, and Campaign, and moving Research up receives a conflict response.
- **When** The user moves Research up, then later moves it down after a subsequent accepted move and remote updates arrive.
- **Then** Research stays optimistically ahead of Launch after the failed request, and the failure message is shown. The later accepted move reconciles the failed move and remote ordering; Research ends after Launch and Campaign.

## project-order-005

Original test `A new Project stays at the tail before and after its creation is confirmed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-order.test.tsx#L364).

- **Given** The sidebar lists Launch, Research, and Campaign.
- **When** The user creates a Project named Notes, then the creation is confirmed with a later rename event.
- **Then** Notes appears expanded at the end of the list before confirmation. After confirmation and the rename event, Notes confirmed remains at the end.

## project-order-006

Original test `Filtered lists keep canonical Project order and hide reorder actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-order.test.tsx#L410).

- **Given** The sidebar lists Launch, Research, and Campaign in canonical order.
- **When** The user filters the chat list to Unread, opens Research’s menu, focuses Research, and presses Alt+Shift+ArrowUp; then returns to Inbox.
- **Then** The filtered list shows only Research, whose menu still includes Rename but has no Move up action. The shortcut does not reorder Projects. Returning to Inbox restores Launch, Research, and Campaign in their original order, and Move up advertises the Alt+Shift+ArrowUp shortcut.
