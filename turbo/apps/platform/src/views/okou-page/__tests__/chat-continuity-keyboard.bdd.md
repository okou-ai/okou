# Chat continuity keyboard

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-continuity-keyboard.test.tsx](chat-continuity-keyboard.test.tsx).

## chat-continuity-keyboard-001

Original test `with neighboring chat panes > move to a newer chat from the main pane without changing the side pane`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-keyboard.test.tsx#L127).

- **Given** The current chat is open in the main pane, with a neighboring chat in the side pane.
- **When** The user focuses the main composer and presses Control+Shift+ArrowUp to move to a newer chat.
- **Then** The newest neighboring chat becomes the current main chat, while the side pane continues to show the side chat.

## chat-continuity-keyboard-002

Original test `Add or remove the focused chat icon with shortcuts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-keyboard.test.tsx#L143).

- **Given** The focused main chat is titled “Project plan” and the side chat is titled “❓”.
- **When** The user presses Control+Shift+1, then Control+Shift+0 in the main chat composer.
- **Then** The main chat is renamed to “✅ Project plan” and then back to “Project plan”. No emoji search appears.

## chat-continuity-keyboard-003

Original test `Show keyboard help without stealing composer input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-keyboard.test.tsx#L186).

- **Given** The user has typed “?!” in the chat composer.
- **When** The user focuses the chat pane and invokes the keyboard-help shortcut with Shift+?.
- **Then** A Keyboard Shortcuts dialog appears and lists shortcuts for previous thread, next thread, renaming a chat, and changing its icon. The composer still contains “?!”.

## chat-continuity-keyboard-004

Original test `Pin and unpin the focused chat optimistically on Mac`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-keyboard.test.tsx#L230).

- **Given** On a Mac, the main and side chats are open, and the side composer contains “Keep this draft”.
- **When** The user invokes the pin shortcut while focused in the side composer, invokes it again to unpin, then focuses the main pane and invokes it once more.
- **Then** The first shortcut is handled and pins the side chat immediately, without pinning the main chat or removing focus or draft text from the side composer. The second shortcut unpins the side chat while preserving its draft; the third pins the main chat and leaves the side chat unpinned.
