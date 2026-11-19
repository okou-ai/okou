# Chat sharing

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-sharing.test.tsx](chat-sharing.test.tsx).

## chat-sharing-001

Original test `The row label toggles a message group once`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L269).

- **Given** A conversation is in message-sharing mode with no groups selected.
- **When** The user toggles a message group using its row label, then toggles it off.
- **Then** The group is selected once and the selected count becomes one; toggling it off clears the selection and disables Share.

## chat-sharing-002

Original test `With Agent name on replies, the selection column toggles a group and marks it as a whole`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L278).

- **Given** A conversation is in message-sharing mode with Agent name on replies enabled.
- **When** The user selects a group from its row label, then clears it with the checkbox.
- **Then** The group is marked selected as a whole and the count is one; clearing it removes the whole-group mark and disables Share.

## chat-sharing-003

Original test `The checkbox toggles a message group once`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L290).

- **Given** A conversation is in message-sharing mode with no groups selected.
- **When** The user clicks a message-group checkbox twice.
- **Then** The first click selects one group and enables Share; the second clears the selection, disables Share, and leaves focus on the checkbox.

## chat-sharing-004

Original test `Keyboard toggling preserves focus and the message group count`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L300).

- **Given** A message-group checkbox has focus and no groups are selected.
- **When** The user presses Space twice.
- **Then** The first press selects one group; the second clears it and disables Share. Focus remains on the checkbox throughout.

## chat-sharing-005

Original test `Message text and code copying remain separate from group selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L313).

- **Given** A conversation is in message-sharing mode and an assistant answer contains a link and a code block.
- **When** The user copies the code, then selects the answer group and clicks the answer text.
- **Then** Copying writes only the code plus a newline to the clipboard and does not select the group. Selecting the group enables Share; clicking the answer text does not clear the selection.

## chat-sharing-006

Original test `A growing selected message group becomes partial and can select its new messages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L352).

- **Given** Only the initial user message is present, and its group has been selected for sharing.
- **When** A second user message is added to the conversation, then the user selects the expanded group.
- **Then** The group becomes partially selected because it now contains a new message. Selecting it marks the whole group; clearing and selecting it again allows sharing both message IDs in their conversation order.

## chat-sharing-007

Original test `Share selected message groups as a public conversation snapshot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L417).

- **Given** A conversation has a user prompt and an assistant answer, and message sharing is open.
- **When** The user selects both groups and shares them.
- **Then** The public snapshot request contains the prompt ID followed by the answer ID, and the resulting share link is copied. The selected answer group cannot be deselected, and passage actions are absent.

## chat-sharing-008

Original test `Hide passage actions throughout sharing and restore them afterward`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L450).

- **Given** Text in an assistant answer is selected, exposing passage actions.
- **When** The user opens message sharing, creates a share, and closes the sharing view.
- **Then** Passage actions stay hidden throughout sharing, including after selecting text again. After closing, selecting the answer text restores the three passage actions.

## chat-sharing-009

Original test `Back-to-back user messages keep their frame apart while sharing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L555). · **intent review**

- **Given** Two user messages appear back-to-back and message sharing is open.
- **When** The user views the messages while sharing.
- **Then** Both messages retain their action-row space, the second remains stacked with the first, and no Copy message button is shown. This test uses layout proxies because the test environment cannot observe actual overlap.

## chat-sharing-010

Original test `With Agent name on replies, back-to-back user messages drop their pull with the copy row while sharing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L566). · **intent review**

- **Given** Two user messages appear back-to-back, Agent name on replies is enabled, and message sharing is open.
- **When** The user views the messages while sharing.
- **Then** Neither message has an action row, the second is not marked as stacked with the first, and no Copy message button is shown. This test uses layout proxies because the test environment cannot observe actual overlap.

## chat-sharing-011

Original test `Replacing a selected live answer clears it before the next answer is shared`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L574).

- **Given** A live answer is selected for sharing while its run is active.
- **When** A revised answer arrives in the same run and the user selects and shares it.
- **Then** The old answer disappears and the new answer starts unselected, with the selected count reset to zero. Sharing sends only the new answer ID.

## chat-sharing-012

Original test `A selected answer remains shareable after later turns move it outside the render window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L653).

- **Given** An answer is selected for sharing in a conversation that can receive later turns.
- **When** Twelve later prompt-and-answer turns arrive, moving the selected answer outside the rendered conversation window, and the user shares.
- **Then** The original answer is no longer visible, but the selected count remains one and sharing sends the original answer ID.

## chat-sharing-013

Original test `Sharing a running answer shows only its latest message and restores the expanded history on close`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L751).

- **Given** A running answer has three messages, its expanded history is open, and its run indicator is visible.
- **When** The user opens message sharing, selects the answer group, shares it, and closes sharing.
- **Then** Sharing displays only the latest answer message and sends only its ID; earlier messages, passage actions, and the run indicator are hidden. Closing restores all three messages, expanded history, passage actions, and the run indicator.

## chat-sharing-014

Original test `Sharing a failed answer shows only its latest message and restores the expanded history on close`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L751).

- **Given** A failed answer has three messages, its expanded history is open, and its failure status is visible.
- **When** The user opens message sharing, selects the answer group, shares it, and closes sharing.
- **Then** Sharing displays only the latest answer message and sends only its ID; earlier messages, passage actions, and failure status are hidden. Closing restores all three messages, expanded history, passage actions, and failure status.

## chat-sharing-015

Original test `Sharing while awaiting the first answer hides the run indicator until cancelled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L870).

- **Given** A conversation has a user prompt and is awaiting its first answer, with a run indicator visible.
- **When** The user opens message sharing and then cancels it.
- **Then** The sharing view offers the prompt group and hides the run indicator; cancelling restores the run indicator.

## chat-sharing-016

Original test `An oversized message group cannot be added to a shared snapshot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L903).

- **Given** A conversation contains a normal prompt and an answer with an oversized message body exceeding 524,288 characters.
- **When** The user tries to select the oversized answer group for sharing.
- **Then** The group remains unselected, a message asks the user to select fewer messages, and the normal prompt remains visible.

## chat-sharing-017

Original test `Select an audience before creating a share and change it after creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L946).

- **Given** Message sharing is open and the initial audience is Organization.
- **When** The user selects Anyone at Default Org, selects an answer group, creates the share, then changes the created share to Anyone with the link.
- **Then** The share is created with the organization audience, shown as Anyone at Acme afterward, and updated to the public audience.

## chat-sharing-018

Original test `Choose Organization and copy a message share without replacing the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1092).

- **Given** A message can be shared with an audience of Organization, and the composer contains its message field.
- **When** The user opens the message-share menu and chooses Organization.
- **Then** The request includes both conversation event IDs and the organization audience. The share link is copied and confirmed before the response; the composer remains and no shared-link textbox replaces it after the response.

## chat-sharing-019

Original test `Choose Everyone and copy a message share without replacing the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1092).

- **Given** A message can be shared with an audience of Everyone, and the composer contains its message field.
- **When** The user opens the message-share menu and chooses Everyone.
- **Then** The request includes both conversation event IDs and the public audience. The share link is copied and confirmed before the response; the composer remains and no shared-link textbox replaces it after the response.

## chat-sharing-020

Original test `Dismiss the audience menu without copying`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1131).

- **Given** The composer is visible and the message-share audience menu is open.
- **When** The user presses Escape.
- **Then** The menu closes, focus returns to Share, the clipboard remains unchanged, and the composer stays visible.

## chat-sharing-021

Original test `Choose a message audience from the keyboard and return focus to Share`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1144).

- **Given** The message Share button is focused and the composer is visible.
- **When** The user opens the menu with Enter and chooses an audience with ArrowDown and Enter.
- **Then** A copy confirmation appears, the request uses the public audience, and focus returns to Share.

## chat-sharing-022

Original test `A failed message share (403) reverts the optimistic copy and keeps the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1163).

- **Given** A message share is being created for Everyone and the composer is visible; the service will fail with status 403.
- **When** The user chooses Everyone and the failed response arrives.
- **Then** The optimistic Copied confirmation is removed, an error says the shared link could not be created, and the share action and composer remain available with no shared-link textbox.

## chat-sharing-023

Original test `A failed message share (404) reverts the optimistic copy and keeps the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1163).

- **Given** A message share is being created for Everyone and the composer is visible; the service will fail with status 404.
- **When** The user chooses Everyone and the failed response arrives.
- **Then** The optimistic Copied confirmation is removed, an error says the shared link could not be created, and the share action and composer remain available with no shared-link textbox.

## chat-sharing-024

Original test `A failed message share (409) reverts the optimistic copy and keeps the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1163).

- **Given** A message share is being created for Everyone and the composer is visible; the service will fail with status 409.
- **When** The user chooses Everyone and the failed response arrives.
- **Then** The optimistic Copied confirmation is removed, an error says the shared link could not be created, and the share action and composer remain available with no shared-link textbox.

## chat-sharing-025

Original test `A failed message share (503) reverts the optimistic copy and keeps the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1163).

- **Given** A message share is being created for Everyone and the composer is visible; the service will fail with status 503.
- **When** The user chooses Everyone and the failed response arrives.
- **Then** The optimistic Copied confirmation is removed, an error says the shared link could not be created, and the share action and composer remain available with no shared-link textbox.

## chat-sharing-026

Original test `A denied clipboard write reverts the optimistic message share confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1186).

- **Given** A message share is being created for Organization, and the browser will deny clipboard writes.
- **When** The user chooses Organization and the share response arrives.
- **Then** The optimistic Copied confirmation is removed, an error says the link could not be copied, and the share action and composer remain available with no shared-link textbox.

## chat-sharing-027

Original test `A previous share failure does not revert a newer copy confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1204).

- **Given** An Organization share is pending and has shown Copied; a newer Everyone share is then started and also shows Copied.
- **When** The older Organization request fails before the newer request succeeds.
- **Then** The older failure displays a share-creation error but does not remove the newer Copied confirmation.

## chat-sharing-028

Original test `A visibility share fails without publishing when its API is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1250).

- **Given** A conversation is in message-sharing mode and the visibility service returns 404 when a selected group is shared.
- **When** The user selects the answer group and attempts to share it.
- **Then** An error says the shared chat could not be created, and no shared-link textbox is shown.
