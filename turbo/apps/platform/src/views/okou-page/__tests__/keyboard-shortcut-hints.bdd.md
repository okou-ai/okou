# Keyboard shortcut hints

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [keyboard-shortcut-hints.test.tsx](keyboard-shortcut-hints.test.tsx).

## keyboard-shortcut-hints-001

Original test `Keep the new chat shortcut usable in a Mac browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/keyboard-shortcut-hints.test.tsx#L58).

- **Given** A user is on a chat page in a Mac browser, with the message composer focused.
- **When** The user presses Command+Shift+O.
- **Then** The browser navigates to the new chat for the chat-list agent.
- **Upstream change** `4e5707de` (#49556) makes My Okou permanent, so the new chat shortcut opens the My Okou new chat at `/` instead of the chat-list agent's `/agents/<id>/chat`; the upstream row is `Keep the new chat shortcut usable in a Mac browser` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/keyboard-shortcut-hints.test.tsx#L55)). Rebuild this scenario expecting the browser to land on `/`.

## keyboard-shortcut-hints-002

Original test `Keep the new chat shortcut usable in a Windows browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/keyboard-shortcut-hints.test.tsx#L58).

- **Given** A user is on a chat page in a Windows browser, with the message composer focused.
- **When** The user presses Control+Shift+O.
- **Then** The browser navigates to the new chat for the chat-list agent.

## keyboard-shortcut-hints-003

Original test `Keep the chat list shortcut usable in a Mac browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/keyboard-shortcut-hints.test.tsx#L69).

- **Given** A user is on a chat page in a Mac browser, with the message composer focused and the chat list closed.
- **When** The user presses Command+B, hovers over the Show chat list control, then presses Command+B again.
- **Then** The chat list opens and closes. Its tooltip shows the Mac shortcut ⌘B.

## keyboard-shortcut-hints-004

Original test `Keep the chat list shortcut usable in a Windows browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/keyboard-shortcut-hints.test.tsx#L69).

- **Given** A user is on a chat page in a Windows browser, with the message composer focused and the chat list closed.
- **When** The user presses Control+B, hovers over the Show chat list control, then presses Control+B again.
- **Then** The chat list opens and closes. Its tooltip shows the Windows shortcut Ctrl+B.

## keyboard-shortcut-hints-005

Original test `Keep the search shortcut usable in a Mac browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/keyboard-shortcut-hints.test.tsx#L85).

- **Given** A user is on a chat page in a Mac browser, with the message composer focused.
- **When** The user presses Command+Shift+F.
- **Then** The workspace search dialog opens and focus moves to its search field.

## keyboard-shortcut-hints-006

Original test `Keep the search shortcut usable in a Windows browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/keyboard-shortcut-hints.test.tsx#L85).

- **Given** A user is on a chat page in a Windows browser, with the message composer focused.
- **When** The user presses Control+Shift+F.
- **Then** The workspace search dialog opens and focus moves to its search field.
