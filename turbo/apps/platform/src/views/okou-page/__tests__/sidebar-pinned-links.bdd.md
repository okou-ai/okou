# Sidebar pinned links

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-pinned-links.test.tsx](sidebar-pinned-links.test.tsx).

## sidebar-pinned-links-001

Original test `Pinned links preserve the current agent and unread filter for Alt activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pinned-links.test.tsx#L72).

- **Given** The sidebar is open on Nova’s chat, with read and unread conversations and the Research Agent pinned.
- **When** The user activates Nova and then Research Agent while holding Alt.
- **Then** The current URL and selected agent remain Nova’s chat. The unread conversation stays visible and the read conversation stays hidden.

## sidebar-pinned-links-002

Original test `Pinned links preserve the current agent and unread filter for Control activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pinned-links.test.tsx#L72).

- **Given** The sidebar is open on Nova’s chat, with read and unread conversations and the Research Agent pinned.
- **When** The user activates Nova and then Research Agent while holding Control.
- **Then** The current URL and selected agent remain Nova’s chat. The unread conversation stays visible and the read conversation stays hidden.

## sidebar-pinned-links-003

Original test `Pinned links preserve the current agent and unread filter for Meta activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pinned-links.test.tsx#L72).

- **Given** The sidebar is open on Nova’s chat, with read and unread conversations and the Research Agent pinned.
- **When** The user activates Nova and then Research Agent while holding Meta.
- **Then** The current URL and selected agent remain Nova’s chat. The unread conversation stays visible and the read conversation stays hidden.

## sidebar-pinned-links-004

Original test `Pinned links preserve the current agent and unread filter for Shift activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pinned-links.test.tsx#L72).

- **Given** The sidebar is open on Nova’s chat, with read and unread conversations and the Research Agent pinned.
- **When** The user activates Nova and then Research Agent while holding Shift.
- **Then** The current URL and selected agent remain Nova’s chat. The unread conversation stays visible and the read conversation stays hidden.

## sidebar-pinned-links-005

Original test `Pinned links preserve the current agent and unread filter for [MouseMiddle] activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pinned-links.test.tsx#L89).

- **Given** The sidebar is open on Nova’s chat, with read and unread conversations and the Research Agent pinned.
- **When** The user activates Research Agent with the middle mouse button.
- **Then** The current URL remains Nova’s chat, and the read conversation stays hidden.

## sidebar-pinned-links-006

Original test `Pinned links preserve the current agent and unread filter for [MouseRight] activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pinned-links.test.tsx#L89).

- **Given** The sidebar is open on Nova’s chat, with read and unread conversations and the Research Agent pinned.
- **When** The user activates Research Agent with the right mouse button.
- **Then** The current URL remains Nova’s chat, and the read conversation stays hidden.

## sidebar-pinned-links-007

Original test `Reveal a pinned agent title from the whole tile`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pinned-links.test.tsx#L104). · **intent review**

- **Given** The pinned Research Agent tile has a title wider than its visible area.
- **When** The user hovers anywhere over the tile.
- **Then** The title reveal starts with a 925 ms duration and stops when the pointer leaves. This assertion checks the control’s DOM-to-CSS handoff rather than rendered visual behavior.

## sidebar-pinned-links-008

Original test `Pinned links preserve the current agent and unread filter for keyboard activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pinned-links.test.tsx#L130).

- **Given** The sidebar is open on Nova’s chat, with Nova and Research Agent pinned.
- **When** The user presses Enter on Nova, then focuses Research Agent and presses Enter.
- **Then** Nova’s chat remains selected after activating Nova, and the URL changes to Research Agent’s chat after activating Research Agent.

## sidebar-pinned-links-009

Original test `Pinned links label an available unnamed agent with its ID`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pinned-links.test.tsx#L143).

- **Given** Research Agent is available and pinned, but has no display name.
- **When** The pinned link is displayed.
- **Then** The link is identified by the agent ID and points to that agent’s chat URL.

## sidebar-pinned-links-010

Original test `Alt-click still opens a thread in the sidebar pane`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-pinned-links.test.tsx#L164).

- **Given** The current chat is open with a separate conversation available in the sidebar.
- **When** The user Alt-clicks the separate conversation.
- **Then** The current chat URL remains unchanged, the separate conversation appears in the sidebar pane, and its ID is present in the sidebar query parameter.
