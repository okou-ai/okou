# Chat continuity draft recovery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-continuity-draft-recovery.test.tsx](chat-continuity-draft-recovery.test.tsx).

## chat-continuity-draft-recovery-001

Original test `Recover saved draft attachments safely`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-draft-recovery.test.tsx#L20).

- **Given** A chat has a saved draft containing “Review the available brief” and an attachment that is available.
- **When** The user opens that chat.
- **Then** The text and attachment are restored, and no warning says the file is unavailable.

## chat-continuity-draft-recovery-002

Original test `Remove an unavailable saved draft attachment without losing text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-draft-recovery.test.tsx#L50).

- **Given** A chat has a saved draft containing “Keep this draft text” and an attachment that is unavailable.
- **When** The user opens that chat and attachment restoration fails.
- **Then** The text remains in the composer, a warning says “missing-brief.txt is no longer available. Upload it again to send,” and no remove-attachment control is shown. The saved draft is updated to retain the text with no attachments.
