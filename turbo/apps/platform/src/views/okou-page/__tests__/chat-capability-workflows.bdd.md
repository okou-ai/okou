# Chat capability workflows

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-workflows.test.tsx](chat-capability-workflows.test.tsx).

## chat-capability-workflows-001

Original test `Edit schedule and Gmail workflow triggers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-workflows.test.tsx#L186).

- **Given** A chat thread has an enabled schedule automation set to run every 5 minutes.
- **When** The user edits the automation and saves a 15-minute interval.
- **Then** The automation summary shows “Every 15 minutes,” and the editor closes.

## chat-capability-workflows-002

Original test `Edit Gmail match workflow trigger filters`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-workflows.test.tsx#L220).

- **Given** A chat thread has a Gmail new-message automation for a specific thread, matching sender alerts@example.com.
- **When** The user edits the filters to match sender billing@example.com and subjects containing either “invoice” or “receipt,” then saves.
- **Then** The summary shows the fixed thread ID, the new sender, and both subject terms. The editor closes, and no “Next run” is shown.

## chat-capability-workflows-003

Original test `Present workflow trigger events as meaningful chat history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-workflows.test.tsx#L313).

- **Given** Chat history contains a completed workflow trigger with both a workflow ID and a prompt, a legacy trigger with only an automation brief, and a pending trigger with an automation brief.
- **When** The user views the chat history and selects the completed trigger’s prompt.
- **Then** The completed trigger links to the workflow’s automations page and displays the prompt, not its different brief; selecting the prompt leaves the chat route unchanged. The legacy trigger displays its brief, and the pending trigger appears as a pending automation event with its brief, not as a queued message.
