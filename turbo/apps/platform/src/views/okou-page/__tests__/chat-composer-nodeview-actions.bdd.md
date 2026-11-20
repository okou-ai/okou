# Chat composer nodeview actions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-nodeview-actions.test.tsx](chat-composer-nodeview-actions.test.tsx).

## chat-composer-nodeview-actions-001

Original test `A template attachment keeps clipboard metadata without native hover hints`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-nodeview-actions.test.tsx#L27).

- **Given** The composer contains a legacy template attachment titled “Legacy deck” and the draft text “Keep this draft.”
- **When** The user copies the composer contents, opens the attachment preview, closes it, and removes the attachment.
- **Then** The attachment shows no native hover title, but copied HTML retains the title “Legacy deck.” Its preview opens in a dialog; after removal, the attachment is gone and the draft text remains.
