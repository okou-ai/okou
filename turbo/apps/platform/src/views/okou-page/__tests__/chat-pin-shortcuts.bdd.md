# Chat pin shortcuts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-pin-shortcuts.test.tsx](chat-pin-shortcuts.test.tsx).

## chat-pin-shortcuts-001

Original test `Reorder immediately after selecting a chat with draft ""`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L117).

- **Given** The user is on the new-chat page with three pinned chats and the empty message composer focused.
- **When** They select Middle pin, then press Alt+Shift+Up and Alt+Shift+Down.
- **Then** The pin order moves Middle pin up one position and then returns to its original order. The page remains on the selected chat, and its empty composer stays focused.

## chat-pin-shortcuts-002

Original test `Reorder immediately after selecting a chat with draft "Unsent draft"`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L117).

- **Given** The user is on the new-chat page with three pinned chats and has entered “Unsent draft” in Middle pin’s composer.
- **When** They select Middle pin, then press Alt+Shift+Up and Alt+Shift+Down.
- **Then** The pin order moves Middle pin up one position and then returns to its original order. The page remains on the selected chat, and the draft remains intact with the composer focused.

## chat-pin-shortcuts-003

Original test `Move the current pin one position in either direction without navigating`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L151).

- **Given** The user is viewing a chat with three pinned chats and has focused the chat-list menu control.
- **When** They press Alt+Shift+Up and then Alt+Shift+Down.
- **Then** The current pin moves up one position and then returns to its original position. The selected chat and page location do not change, and focus stays on the chat-list menu control.

## chat-pin-shortcuts-004

Original test `Stop at the first and last pinned positions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L167).

- **Given** The sidebar has three pinned chats, with First pin first and Last pin last.
- **When** The user presses Alt+Shift+Up while First pin is focused, then Alt+Shift+Down while Last pin is focused.
- **Then** First pin cannot move above the first position, and Last pin cannot move below the last position. Focus remains on each chat; moving Middle pin up one position between those checks changes the order as expected.

## chat-pin-shortcuts-005

Original test `Reorder the focused sidebar row on the new-chat page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L183).

- **Given** The user is on the new-chat page with Middle pin’s sidebar chat link focused.
- **When** They press Alt+Shift+Up.
- **Then** Middle pin moves up one position without leaving the new-chat page, and its link remains focused.

## chat-pin-shortcuts-006

Original test `Reorder the focused sidebar menu trigger on the new-chat page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L183).

- **Given** The user is on the new-chat page with Middle pin’s menu trigger focused.
- **When** They press Alt+Shift+Up.
- **Then** Middle pin moves up one position without leaving the new-chat page, and its menu trigger remains focused.

## chat-pin-shortcuts-007

Original test `Reorder the focused sidebar menu item on the new-chat page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L183).

- **Given** The user is on the new-chat page with Middle pin’s “Move up” menu item focused.
- **When** They press Alt+Shift+Up.
- **Then** Middle pin moves up one position without leaving the new-chat page, and the menu item remains focused.

## chat-pin-shortcuts-008

Original test `Reorder from the side composer while keeping its draft and main chat selected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L206).

- **Given** The user has a main chat selected and has entered “Side pane draft” in another pinned chat’s side composer.
- **When** They press Alt+Shift+Up from the side composer.
- **Then** The side chat moves up one position. The main chat remains selected, and the side draft remains intact with the composer focused.

## chat-pin-shortcuts-009

Original test `Reorder from inline rename while keeping its edit and focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L221).

- **Given** The user is editing Middle pin’s title inline and has entered the uncommitted title “Uncommitted title.”
- **When** They press Alt+Shift+Up, then Escape.
- **Then** Middle pin moves up one position while the uncommitted title and edit focus remain intact. Escape exits editing and returns focus to the chat, without changing the reordered pin order.

## chat-pin-shortcuts-010

Original test `Leave composition, held keys, and different modifiers to the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L237).

- **Given** The user has entered “Keep this draft” in a focused message composer while the sidebar has three pinned chats.
- **When** They press Alt+Shift+Up with composition active, a composition key code, a repeated key event, Alt missing, Shift missing, Ctrl held, or Meta held; then they press the shortcut with Alt and Shift.
- **Then** Each ineligible key event leaves the pin order unchanged and is not prevented. The valid shortcut moves Middle pin up one position while preserving the draft and composer focus.

## chat-pin-shortcuts-011

Original test `Do not reorder an unpinned chat or the main chat from another menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L260).

- **Given** The sidebar contains an unpinned regular chat and the chat-list menu includes Inbox.
- **When** The user presses Alt+Shift+Up while the regular chat is focused, then opens the chat-list menu, focuses Inbox, and presses the shortcut.
- **Then** Neither action changes the pinned order.

## chat-pin-shortcuts-012

Original test `Keep the Unread filter from reordering hidden pins`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L278).

- **Given** The user opens the Unread filter when there are no unread chats, so the pinned chats are hidden.
- **When** They press Alt+Shift+Up while the filter is active, then return to Inbox.
- **Then** The shortcut does not reorder hidden pins, and Inbox shows the original pin order.

## chat-pin-shortcuts-013

Original test `Keep the Archived filter from reordering hidden pins`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L278).

- **Given** The user opens the Archived filter when there are no archived chats, so the pinned chats are hidden.
- **When** They press Alt+Shift+Up while the filter is active, then return to Inbox.
- **Then** The shortcut does not reorder hidden pins, and Inbox shows the original pin order.

## chat-pin-shortcuts-014

Original test `Keep the Muted filter from reordering hidden pins`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L278).

- **Given** The user opens the Muted filter when there are no muted chats, so the pinned chats are hidden.
- **When** They press Alt+Shift+Up while the filter is active, then return to Inbox.
- **Then** The shortcut does not reorder hidden pins, and Inbox shows the original pin order.

## chat-pin-shortcuts-015

Original test `Show Windows menu hints and pinned shortcut help`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L302).

- **Given** The user is on Windows with a sidebar containing pinned chats.
- **When** They open a pinned chat’s menu and then open Keyboard Shortcuts help.
- **Then** The menu shows “Shift+Alt+↑” and “Shift+Alt+↓” hints, and the shortcut help lists Pinned, Move up, and Move down. A shortcut sent from outside the chat does not change the pin order.

## chat-pin-shortcuts-016

Original test `Show Mac menu hints and pinned shortcut help`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.test.tsx#L302).

- **Given** The user is on Mac with a sidebar containing pinned chats.
- **When** They open a pinned chat’s menu and then open Keyboard Shortcuts help.
- **Then** The menu shows “⇧⌥↑” and “⇧⌥↓” hints, and the shortcut help lists Pinned, Move up, and Move down. A shortcut sent from outside the chat does not change the pin order.
