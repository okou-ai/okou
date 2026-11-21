# Sidebar inline rename

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-inline-rename.test.tsx](sidebar-inline-rename.test.tsx).

## sidebar-inline-rename-001

Original test `Double-click a conversation to open it and rename it in place`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-inline-rename.test.tsx#L53).

- **Given** The sidebar lists “Release plan” and “Incident notes,” with “Incident notes” open.
- **When** The user double-clicks “Release plan” and types “Launch plan,” then presses Enter.
- **Then** “Release plan” opens, and its title field is focused with the existing title selected. The conversation is renamed to “Launch plan,” the field closes, and focus returns to the renamed conversation.

## sidebar-inline-rename-002

Original test `Opening another chat from the field still sends its title`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-inline-rename.test.tsx#L73).

- **Given** The sidebar lists “Release plan” and “Incident notes,” with “Incident notes” open.
- **When** The user double-clicks “Incident notes,” types “Postmortem,” then clicks “Release plan” while the rename request is waiting for authentication.
- **Then** “Release plan” opens, and the rename request for “Incident notes” still completes with title “Postmortem.” The sidebar shows “Postmortem,” and the rename field closes.

## sidebar-inline-rename-003

Original test `Scrolling the field's row away saves it instead of reopening it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-inline-rename.test.tsx#L118).

- **Given** The sidebar lists 40 conversations, including “Chat 1” through “Chat 40.”
- **When** The user starts renaming “Chat 1” to “Scrolled away,” then scrolls its row out of view and back.
- **Then** The rename field closes when the row is scrolled away. On returning to the row, the title is “Scrolled away,” and the field remains closed.

## sidebar-inline-rename-004

Original test `Escape or an emptied field keeps the title`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-inline-rename.test.tsx#L152).

- **Given** The sidebar contains “Incident notes.”
- **When** The user starts renaming it, types “Discarded,” and presses Escape; then reopens the field, deletes the entire title, and presses Enter.
- **Then** Both actions close the field and retain the original “Incident notes” title. Focus returns to its conversation link.

## sidebar-inline-rename-005

Original test `Enter and Escape stay with an input method while it composes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-inline-rename.test.tsx#L175).

- **Given** The user is renaming “Incident notes” in a focused title field while an input method is composing text.
- **When** The user presses Enter with key code 229, then presses Escape with composition active.
- **Then** Enter is cancelled and does not submit the rename; Escape does not close the field. The field remains focused.

## sidebar-inline-rename-006

Original test `A modified double-click keeps its browser behavior instead of renaming`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-inline-rename.test.tsx#L191).

- **Given** The sidebar contains “Incident notes.”
- **When** The user double-clicks it with Alt, Control, Meta, or Shift held, then double-clicks it without a modifier.
- **Then** Each modified double-click retains browser link behavior and does not open the rename field. An unmodified double-click opens the field with “Incident notes.”
