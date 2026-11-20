# Chat rename focus

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-rename-focus.test.tsx](chat-rename-focus.test.tsx).

## chat-rename-focus-001

Original test `Do not focus the emoji button after Rename closes with Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx#L66).

- **Given** The user opens Rename from the side chat pane with F2.
- **When** They rename the chat and close the dialog with Enter.
- **Then** The dialog closes and focus remains on the document body. Pressing Enter does not open emoji search.

## chat-rename-focus-002

Original test `Do not focus the emoji button after Rename closes with Escape`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx#L66).

- **Given** The user opens Rename from the side chat pane with F2.
- **When** They close the dialog with Escape.
- **Then** The dialog closes and focus remains on the document body. Pressing Enter does not open emoji search.

## chat-rename-focus-003

Original test `Do not focus the emoji button after Rename closes with Cancel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx#L66).

- **Given** The user opens Rename from the side chat pane with F2.
- **When** They close the dialog with Cancel.
- **Then** The dialog closes and focus remains on the document body. Pressing Enter does not open emoji search.

## chat-rename-focus-004

Original test `Do not focus the emoji button after Rename closes with Close`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx#L66).

- **Given** The user opens Rename from the side chat pane with F2.
- **When** They close the dialog with Close.
- **Then** The dialog closes and focus remains on the document body. Pressing Enter does not open emoji search.

## chat-rename-focus-005

Original test `Leave focus unforced after Rename opens from the main composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx#L106).

- **Given** The user focuses the main chat composer.
- **When** They open Rename with F2 and close it with Escape.
- **Then** The dialog closes and focus remains on the document body.

## chat-rename-focus-006

Original test `Leave focus unforced after Rename opens from the side composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx#L106).

- **Given** The user focuses the side chat composer.
- **When** They open Rename with F2 and close it with Escape.
- **Then** The dialog closes and focus remains on the document body.

## chat-rename-focus-007

Original test `Do not focus the emoji button after title double-click Rename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx#L126).

- **Given** The user is viewing the main chat.
- **When** They double-click the chat title to open Rename and close it with Escape.
- **Then** The dialog closes and focus remains on the document body.
