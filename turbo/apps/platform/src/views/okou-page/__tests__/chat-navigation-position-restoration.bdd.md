# Chat navigation position restoration

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-navigation-position-restoration.test.tsx](chat-navigation-position-restoration.test.tsx).

## chat-navigation-position-restoration-001

Original test `with a measurable thread viewport > restore the reading position during keyboard thread navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.test.tsx#L485).

- **Given** The user is reading “Current message 2” in the current thread, with that message 64 pixels below the viewport’s top and the view not at the latest activity.
- **When** The user navigates to the previous thread and back using Control+Shift+ArrowUp and Control+Shift+ArrowDown.
- **Then** The current thread returns with “Current message 2” at the same reading position, not at the latest activity. Messages from the two threads do not appear in the wrong thread.

## chat-navigation-position-restoration-002

Original test `Restore the reading position after switching threads from the sidebar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.test.tsx#L573).

- **Given** The user is reading “Research message 2” in the Research notes thread, away from the latest activity.
- **When** The user opens Planning notes from the sidebar, then returns to Research notes from the sidebar.
- **Then** The Research thread returns with “Research message 2” at the same reading position.

## chat-navigation-position-restoration-003

Original test `Return to the latest message in a thread opened from the sidebar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.test.tsx#L648).

- **Given** The user has opened Planning notes from the sidebar, and the Research notes thread contains several messages.
- **When** The user opens Research notes, scrolls away from the latest activity, then selects “Scroll to bottom.”
- **Then** The thread returns to its latest activity, and the “Scroll to bottom” button is no longer shown.

## chat-navigation-position-restoration-004

Original test `Open a conversation at a linked event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.test.tsx#L694).

- **Given** The conversation contains a message whose event ID is linked in the URL fragment using the event form.
- **When** The user opens the conversation at that link.
- **Then** The linked message appears at the top of the viewport, the linked location is marked as landed, and the “Scroll to bottom” button is shown.

## chat-navigation-position-restoration-005

Original test `Open a conversation at a linked run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.test.tsx#L694).

- **Given** The conversation contains a message whose event ID is linked in the URL fragment using the run form.
- **When** The user opens the conversation at that link.
- **Then** The linked message appears at the top of the viewport, the linked location is marked as landed, and the “Scroll to bottom” button is shown.

## chat-navigation-position-restoration-006

Original test `Follow a run link in the current conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.test.tsx#L736).

- **Given** The current conversation contains a link to an earlier run and has loaded earlier messages.
- **When** The user follows the link to the earlier run.
- **Then** The linked message is positioned 28% of the viewport height below the top, providing context above it. The linked location is marked as landed, and the “Scroll to bottom” button is shown.

## chat-navigation-position-restoration-007

Original test `Follow the Resources origin link to its parent run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.test.tsx#L807).

- **Given** The user is viewing a child conversation with a Resources entry linking to a parent conversation and run.
- **When** The user opens the Resources panel and follows the parent conversation link.
- **Then** The parent conversation opens at the linked message, positioned at the top of the viewport, and the “Scroll to bottom” button is shown.

## chat-navigation-position-restoration-008

Original test `Expand folded work when opening a linked message`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.test.tsx#L879).

- **Given** A linked message is inside folded work in a conversation.
- **When** The user opens the conversation using the message’s event link.
- **Then** The linked work detail is visible at the top of the viewport, and the “Scroll to bottom” button is shown.

## chat-navigation-position-restoration-009

Original test `Open a conversation safely when a linked message is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.test.tsx#L913).

- **Given** The requested linked message is unavailable, but the conversation has messages.
- **When** The user opens the conversation using the unavailable message’s event link.
- **Then** The conversation opens at the latest reply. It is within the viewport, and the “Scroll to bottom” button is not shown.

## chat-navigation-position-restoration-010

Original test `Return to the latest message after sending from history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.test.tsx#L946).

- **Given** The user is reading an earlier message in a conversation that has an active run and is not at the latest activity.
- **When** The user sends “Add the latest deployment result.”
- **Then** The sent message appears, the composer clears, and the view returns to the latest activity with no “Scroll to bottom” button.

## chat-navigation-position-restoration-011

Original test `Preserve the reading position while entering and leaving sharing mode`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.test.tsx#L1001).

- **Given** The user is reading “Shareable message 3,” away from the latest activity.
- **When** The user enters sharing mode, the viewport becomes 80 pixels shorter, and then the user cancels sharing mode.
- **Then** The reading position of “Shareable message 3” is preserved both during sharing mode and after cancellation.
