# Chat capability message actions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-message-actions.test.tsx](chat-capability-message-actions.test.tsx).

## chat-capability-message-actions-001

Original test `Hide the activity-log action outside debug mode`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-message-actions.test.tsx#L77).

- **Given** A completed assistant response is displayed outside debug mode.
- **When** The user views the response.
- **Then** No “View run logs” action is shown for the response or elsewhere on the page.

## chat-capability-message-actions-002

Original test `Keep Copy to the right of an active run's logs before any assistant output`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-message-actions.test.tsx#L97).

- **Given** A run is active, has a user prompt, and has produced no assistant output. Debug mode is enabled, and its run details are available.
- **When** The user views the prompt’s actions and opens its run logs.
- **Then** “View run logs” appears to the left of “Copy message” and links to that run’s activity page, which shows the run inspection heading.

## chat-capability-message-actions-003

Original test `Do not show user run logs before a run ID is assigned`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-message-actions.test.tsx#L163).

- **Given** A user prompt is displayed in debug mode but has no assigned run ID.
- **When** The user views the prompt’s actions.
- **Then** “Copy message” is available, but “View run logs” is not shown.

## chat-capability-message-actions-004

Original test `Copy workflow trigger bubbles and inspect their associated runs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-message-actions.test.tsx#L192).

- **Given** The chat contains a workflow trigger with visible text and a legacy workflow trigger with an automation brief; each is associated with a different run. Debug mode is enabled.
- **When** The user copies each trigger and opens the first trigger’s run logs.
- **Then** The first trigger copies its visible text, the legacy trigger copies its brief, and their run-log links point to their respective runs. Opening the first link shows the workflow run inspection heading and that run’s activity page.

## chat-capability-message-actions-005

Original test `Keep run logs under the user message when a run fails without output`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-message-actions.test.tsx#L301).

- **Given** A user prompt is associated with a run that fails before producing assistant output. Debug mode is enabled.
- **When** The user views the prompt and its run status.
- **Then** The prompt’s actions include a run-log link for its run, and the chat shows “This run couldn't finish.”

## chat-capability-message-actions-006

Original test `Inspect a response from its prompt or copy it from history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-message-actions.test.tsx#L344).

- **Given** A completed response appears in a conversation with debug mode enabled and run details available.
- **When** The user opens run logs from the response’s prompt, returns to the conversation, and copies the response from history.
- **Then** The response itself has no run-log link; the prompt’s link opens the associated run inspection page, and the historical response is copied to the clipboard.

## chat-capability-message-actions-007

Original test `Copy and paste a structured chat message from the keyboard without flattening it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-message-actions.test.tsx#L422).

- **Given** A structured user message contains text, a PDF attachment, and other structured parts, alongside legacy flattened content. The chat composer is available.
- **When** The user focuses the message’s Copy message action, activates it with Enter, then pastes the copied rich content into the composer.
- **Then** The copied plain text and structured payload retain the message text and one attachment with its file ID, filename, and private file URL; legacy flattened content is excluded. Pasting restores the feedback note and makes the template preview available.
