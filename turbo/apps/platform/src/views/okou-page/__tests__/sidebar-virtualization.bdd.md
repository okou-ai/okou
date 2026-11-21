# Sidebar virtualization

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-virtualization.test.tsx](sidebar-virtualization.test.tsx).

## sidebar-virtualization-001

Original test `Keep the chat viewport keyboard-focusable only while a conversation is open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L165).

- **Given** A chat list has 32 conversations and a five-row viewport, with no conversation open.
- **When** The user opens a conversation and then starts a new chat.
- **Then** The viewport is keyboard-focusable while the conversation is open and is no longer keyboard-focusable after starting a new chat.
- **Upstream change** `4e5707de` (#49556) makes `/` the only chat page (`/agents/{id}/chat` redirects there) and replaces the header New chat button with a New chat row linking to `/` at the top of the list; the upstream test is now `Keep the chat viewport keyboard-focusable only while a conversation is open` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L165)). Rebuild this scenario by starting the new chat from the New chat row.

## sidebar-virtualization-002

Original test `Keyboard navigation reveals an adjacent conversation outside the virtual window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L194).

- **Given** A conversation is open in a 32-conversation list with a five-row viewport, and the viewport is keyboard-focused and scrolled to History 17.
- **When** The user presses Ctrl+Shift+ArrowDown to navigate to the adjacent conversation.
- **Then** History 2 becomes current, the viewport scrolls to one row down, and it remains keyboard-focusable.

## sidebar-virtualization-003

Original test `Collapse and expand a Project inside a scrolled virtual window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L227).

- **Given** A virtualized sidebar shows 17 Projects and 32 conversations, with History 1 and History 2 in Project 17.
- **When** The user expands and collapses Project 17 while scrolled to it, then expands it again and opens History 1.
- **Then** Expanding shows History 1 and History 2; collapsing hides them while History 3 remains visible. The user can reopen the Project and navigate to History 1.

## sidebar-virtualization-004

Original test `Project fold shares one CSS reveal length and completion (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L470).

- **Given** On desktop, a collapsed Project contains two conversations in a list with 25 rows of base height.
- **When** The user expands the Project and then collapses it after the reveal finishes.
- **Then** Expansion adds a single two-row reveal height to the list; collapse hides the children and returns the list to 25 rows. History 3 remains usable during collapse and opens its conversation.

## sidebar-virtualization-005

Original test `Project fold shares one CSS reveal length and completion (mobile: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L470).

- **Given** On mobile, a collapsed Project contains two conversations in a list with 25 rows of base height.
- **When** The user expands the Project and then collapses it after the reveal finishes.
- **Then** Expansion adds a single two-row reveal height to the list; collapse hides the children and returns the list to 25 rows. History 3 remains usable during collapse and opens its conversation.

## sidebar-virtualization-006

Original test `A pointer reversal before the fold frame keeps children usable (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L525).

- **Given** On desktop, a collapsed Project contains History 1, and its children are usable.
- **When** The user starts collapsing the Project and immediately reverses by expanding it before the fold frame.
- **Then** The children remain usable and History 1 can be opened as a conversation.

## sidebar-virtualization-007

Original test `A pointer reversal before the fold frame keeps children usable (mobile: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L525).

- **Given** On mobile, a collapsed Project contains History 1, and its children are usable.
- **When** The user starts collapsing the Project and immediately reverses by expanding it before the fold frame.
- **Then** The children remain usable and History 1 can be opened as a conversation.

## sidebar-virtualization-008

Original test `A running fold reverses from its displayed CSS length (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L555).

- **Given** On desktop, a Project with two conversations is in the middle of its collapse animation.
- **When** The user reverses the fold while it is running.
- **Then** The reveal resumes from the displayed child height, keeps History 1 usable, and allows the conversation to be opened after the reveal finishes.

## sidebar-virtualization-009

Original test `A running fold reverses from its displayed CSS length (mobile: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L555).

- **Given** On mobile, a Project with two conversations is in the middle of its collapse animation.
- **When** The user reverses the fold while it is running.
- **Then** The reveal resumes from the displayed child height, keeps History 1 usable, and allows the conversation to be opened after the reveal finishes.

## sidebar-virtualization-010

Original test `List wheel cancels Project motion without undoing the click (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L603).

- **Given** On desktop, a Project with two conversations is beginning to expand.
- **When** The user scrolls the list with the mouse wheel before the reveal frame.
- **Then** The reveal motion ends with the Project still expanded and the list at its full 27-row height; History 1 remains usable and opens its conversation.

## sidebar-virtualization-011

Original test `List touchmove cancels Project motion without undoing the click (mobile: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L603).

- **Given** On mobile, a Project with two conversations is beginning to expand.
- **When** The user moves a touch on the list before the reveal frame.
- **Then** The reveal motion ends with the Project still expanded and the list at its full 27-row height; History 1 remains usable and opens its conversation.

## sidebar-virtualization-012

Original test `List scroll cancels Project motion without undoing the click (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L603).

- **Given** On desktop, a Project with two conversations is beginning to expand.
- **When** The user scrolls the list before the reveal frame.
- **Then** The reveal motion ends with the Project still expanded and the list at its full 27-row height; History 1 remains usable and opens its conversation.

## sidebar-virtualization-013

Original test `List dragstart cancels Project motion without undoing the click (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L603).

- **Given** On desktop, a Project with two conversations is beginning to expand.
- **When** The user starts dragging from the list before the reveal frame.
- **Then** The reveal motion ends with the Project still expanded and the list at its full 27-row height; History 1 remains usable and opens its conversation.

## sidebar-virtualization-014

Original test `Reduced motion folds immediately without retaining hidden children (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L630).

- **Given** On desktop, reduced motion is enabled and a Project contains two conversations.
- **When** The user expands and then collapses the Project.
- **Then** Both changes happen immediately without retaining hidden children; the list changes between 25 and 27 rows, and History 3 remains visible after collapse.

## sidebar-virtualization-015

Original test `Reduced motion folds immediately without retaining hidden children (mobile: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L630).

- **Given** On mobile, reduced motion is enabled and a Project contains two conversations.
- **When** The user expands and then collapses the Project.
- **Then** Both changes happen immediately without retaining hidden children; the list changes between 25 and 27 rows, and History 3 remains visible after collapse.

## sidebar-virtualization-016

Original test `Folding a partially visible Project keeps newly exposed chats reachable (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L650).

- **Given** On desktop, a Project is partially visible in a scrolled virtual list of 17 Projects, and the viewport shows five and a half rows.
- **When** The user expands the Project and then collapses it without changing the scroll position.
- **Then** History 1 and History 3 are reachable during expansion; after collapse, the list height updates to 41 rows and History 7 is reachable and opens its conversation. The rendered conversation rows never exceed 68.

## sidebar-virtualization-017

Original test `Folding a partially visible Project keeps newly exposed chats reachable (mobile: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L650).

- **Given** On mobile, a Project is partially visible in a scrolled virtual list of 17 Projects, and the viewport shows five and a half rows.
- **When** The user expands the Project and then collapses it without changing the scroll position.
- **Then** History 1 and History 3 are reachable during expansion; after collapse, the list height updates to 41 rows and History 7 is reachable and opens its conversation. The rendered conversation rows never exceed 68.

## sidebar-virtualization-018

Original test `A 10,000-chat Project stays bounded while opening and cancelling its reveal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L693).

- **Given** A desktop Project contains 10,000 conversations and is initially collapsed.
- **When** The user opens the Project, cancels the reveal with a wheel event, scrolls to History 10000, returns to the top, and collapses the Project.
- **Then** At most 68 conversation rows are rendered throughout; the expanded list reaches 10,025 rows, and after collapse History 1 is no longer shown.

## sidebar-virtualization-019

Original test `Navigating away from a mobile reveal cancels its viewport lifetime`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L735).

- **Given** On mobile, a collapsed Project is ready to expand.
- **When** The user begins expanding it, opens History 3, waits for the conversation, and returns to the chat list.
- **Then** The conversation viewport is gone while away, and the restored Project remains expanded with no unfinished fold state.

## sidebar-virtualization-020

Original test `A filtered desktop list excludes its external footer from the reveal height`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L756).

- **Given** A desktop archived-chat list has an external “Show all chats” footer and a collapsed Project; the list itself is three rows high.
- **When** The user expands and collapses the Project, cancels the collapse with a wheel event, and chooses “Show all chats.”
- **Then** The footer is excluded from the Project reveal height, which expands the list to five rows. Cancelling collapse returns it to three rows, and choosing “Show all chats” removes the footer.

## sidebar-virtualization-021

Original test `Expanding an already-visible current conversation does not cancel its reveal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L794).

- **Given** On desktop, History 1 is the current conversation inside a collapsed Project.
- **When** The user expands the Project while the current conversation is visible.
- **Then** The current conversation remains selected, the viewport stays at the top, and the reveal completes without losing the selection.

## sidebar-virtualization-022

Original test `The mobile unread footer shares the Project reveal's list height`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L823).

- **Given** On mobile, an unread chat list has a collapsed Project and a “Show all chats” footer within the list; the list is four rows high.
- **When** The user expands the Project, cancels the reveal with a touch movement, collapses it, cancels that motion, and selects “Show all chats.”
- **Then** The expanded list reaches six rows with the footer included in its height; collapse returns it to four rows. Selecting the footer shows History 3 and removes the footer.

## sidebar-virtualization-023

Original test `A bottom-clamping Project collapse commits its smaller list immediately`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L857).

- **Given** A desktop list has 17 Projects and two conversations outside the Projects, and the user has scrolled near the bottom with a Project header visible.
- **When** The user expands that Project, scrolls to the expanded list's bottom, and collapses the Project.
- **Then** The collapse immediately commits a 19-row list; History 1 is no longer visible and History 3 remains visible.

## sidebar-virtualization-024

Original test `Resize and navigate a loaded virtual viewport`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L880).

- **Given** A conversation is open in a virtualized list of 6,406 conversations with a 612-pixel viewport.
- **When** The viewport is resized to 900 pixels and then 360 pixels, and the user opens History 2.
- **Then** The list shows 25 rows initially, 33 after enlarging, and 18 after shrinking; opening History 2 preserves the 18-row rendering and marks that conversation current.

## sidebar-virtualization-025

Original test `Show every unread conversation beyond the current history window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L962).

- **Given** The chat list contains unread conversations outside the currently rendered history window.
- **When** The unread history list is shown.
- **Then** Every unread conversation beyond the current window is visible, while History 1 and History 101 are not shown.

## sidebar-virtualization-026

Original test `Follow full-list wave positions across scrolling and pinning`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L986).

- **Given** A 120-conversation list has a running indicator on History 3, an unread History 2, and a five-row viewport.
- **When** The user scrolls down and back to the top, then pins History 3.
- **Then** Running indicator positions remain tied to full-list indices while scrolling; after pinning, History 3 moves to the first row, its indicator starts at zero, and the next row's indicator is at -11/12.

## sidebar-virtualization-027

Original test `Refresh virtualization after pinning adds a grid row and unpinning removes it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L1088).

- **Given** A virtualized conversation list initially renders 25 rows while four pinned-agent cards are shown.
- **When** The user pins another agent and then unpins it.
- **Then** With five cards, the list refreshes to 18 rows; after returning to four cards, it refreshes to 25 rows.
- **Upstream change** `4e5707de` (#49556) retires pinned agents and the pinned-agent grid and removes this upstream test. Retire this scenario.

## sidebar-virtualization-028

Original test `Measure the mobile chat list only after the main stylesheet bounds it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L1126).

- **Given** The mobile app is loading its main stylesheet, and a 120-conversation list is not yet bounded by the stylesheet.
- **When** The stylesheet finishes loading and bounds the chat-list viewport.
- **Then** No conversation rows render before the stylesheet is ready; afterward, 13 rows render.

## sidebar-virtualization-029

Original test `Show all chats from the tail of a scrolled mobile unread list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L1189).

- **Given** On mobile, the user filters a 40-conversation list to 24 unread conversations and scrolls to the tail of that unread list.
- **When** The user selects “Show all chats” and opens History 1.
- **Then** History 32 and the footer are reachable at the tail; showing all chats restores History 1, which opens its conversation.

## sidebar-virtualization-030

Original test `Restore the mobile chat-list scroll position after returning from a conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L1238).

- **Given** On mobile, a 32-conversation list is scrolled to History 17 at a scroll offset of 16 rows.
- **When** The user opens History 17 and returns to the chat list.
- **Then** The list restores its previous scroll position and shows History 17.

## sidebar-virtualization-031

Original test `Remeasure the mobile chat list when a service notice arrives and is dismissed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-virtualization.test.tsx#L1258).

- **Given** On mobile, a 120-conversation list initially renders 20 rows because no service notice is present.
- **When** A service notice arrives and the user dismisses it.
- **Then** The list remeasures to 13 rows while the notice is present and returns to 20 rows after dismissal.
