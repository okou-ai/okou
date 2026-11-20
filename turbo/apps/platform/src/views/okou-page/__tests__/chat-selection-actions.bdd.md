# Chat selection actions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-selection-actions.test.tsx](chat-selection-actions.test.tsx).

## chat-selection-actions-001

Original test `Keep the draft and passage actions available after renaming the conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx#L57).

- **Given** A conversation is open with a completed assistant response containing “The launch plan has three careful stages.”
- **When** The user enters an unfinished draft, renames the conversation, selects that passage, and chooses Quote.
- **Then** The renamed title is shown, the unfinished draft remains in the message composer, and a quote note is added containing the selected passage.

## chat-selection-actions-002

Original test `Copy the captured passage when pointerup clears its native selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx#L91).

- **Given** A conversation is open with the passage “The launch plan has three careful stages.” selected and passage actions visible.
- **When** The user presses the Copy action, the native selection clears on pointer release, and the user clicks Copy.
- **Then** The passage is copied to the clipboard, a “Copied” confirmation appears, and the passage actions are dismissed.

## chat-selection-actions-003

Original test `Quote the captured passage after a touch selection collapses`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx#L104).

- **Given** A conversation is open with the passage “The launch plan has three careful stages.” selected and passage actions visible on a coarse-pointer device.
- **When** The user presses Quote, the native selection collapses on touch release, and the user clicks Quote.
- **Then** A quote note containing the selected passage is added, and the passage actions are dismissed.

## chat-selection-actions-004

Original test `Forward the captured passage after the native selection collapses`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx#L121).

- **Given** A conversation is open with the passage “The launch plan has three careful stages.” selected and passage actions visible.
- **When** The user presses Forward, the native selection collapses on pointer release, and the user clicks Forward.
- **Then** A dialog displays the captured passage, and the passage actions are dismissed.
- **Upstream change** `4e5707de` (#49556) retires the Forward target picker and removes this upstream test: the passage toolbar's third action is now always `Fork`, which opens the `Okou` Fork composer with the captured passage. Only the Forward picker is retired; rebuild this scenario by pressing `Fork` while the native selection collapses on pointer release, expecting the `Okou` dialog to show the captured passage and the passage actions to be dismissed.

## chat-selection-actions-005

Original test `Preserve the native rich selection until the copy event closes its toolbar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx#L133).

- **Given** A conversation displays the passage “The launch plan has three careful stages.” in bold, and the passage is selected with its passage toolbar open.
- **When** The user presses Ctrl+C and then triggers the browser copy event.
- **Then** Ctrl+C alone leaves the toolbar visible. The copy event dismisses the toolbar while preserving the exact native selection and its range, and focus remains on the same element.

## chat-selection-actions-006

Original test `Dismiss the passage actions when a press lands outside them`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx#L168).

- **Given** A conversation is open with “The launch plan has three careful stages.” selected and passage actions visible.
- **When** The user presses outside the passage actions on a different passage.
- **Then** The passage actions are dismissed.
