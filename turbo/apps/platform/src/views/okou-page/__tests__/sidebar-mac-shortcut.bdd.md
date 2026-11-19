# Sidebar mac shortcut

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-mac-shortcut.test.tsx](sidebar-mac-shortcut.test.tsx).

## sidebar-mac-shortcut-001

Original test `The Mac shortcut toggles the chat list while composing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-mac-shortcut.test.tsx#L104).

- **Given** On a Mac browser, a chat is open, the chat list is visible, and the message composer is focused.
- **When** The user presses Command-B in the composer.
- **Then** The chat list is hidden, and the navigation rail offers a “Show chat list” control.

## sidebar-mac-shortcut-002

Original test `The standalone Mac app copies the current URL with Command-L`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-mac-shortcut.test.tsx#L138).

- **Given** The standalone Mac app has a chat open and the message composer focused.
- **When** The user presses Command-L.
- **Then** The keyboard event is prevented, and the app copies the current page URL to the clipboard.
