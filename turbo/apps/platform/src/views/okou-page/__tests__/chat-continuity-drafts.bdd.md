# Chat continuity drafts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-continuity-drafts.test.tsx](chat-continuity-drafts.test.tsx).

## chat-continuity-drafts-001

Original test `Restore the first edited draft without leaking the other conversation's draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx#L119).

- **Given** Two conversations have separate drafts: one has a saved feedback draft with a quoted requirement, and the other is edited locally.
- **When** The user switches to the saved-draft conversation, adds a separate note, and returns to the first conversation.
- **Then** The first conversation restores its own follow-up text and does not show the separate note from the other conversation.

## chat-continuity-drafts-002

Original test `Protect local edits while a saved draft is loading`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx#L129).

- **Given** A saved server draft contains “Older server draft” and an attachment named “older-notes.txt,” but its response is delayed.
- **When** The user types “Fresh work typed locally” before the saved draft finishes loading.
- **Then** The local text remains in the composer; the older saved text and attachment are not shown.

## chat-continuity-drafts-003

Original test `Restore a rich saved draft when a chat opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx#L172).

- **Given** A chat has a saved draft containing an opening paragraph, a reference to another chat, a presentation template, feedback with a quote and note, and an attachment named “launch-research.txt.”
- **When** The user opens the chat and removes the attachment.
- **Then** The restored draft shows the remaining content in its original order, and the attachment disappears. The saved update retains the opening paragraph and does not remove the referenced chat or feedback content.

## chat-continuity-drafts-004

Original test `Save a typed draft and restore it after navigating away`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx#L285).

- **Given** A chat has no saved draft, and the user types “Unsent launch checklist.”
- **When** The user navigates to a neighboring conversation and then returns.
- **Then** The composer restores “Unsent launch checklist.”

## chat-continuity-drafts-005

Original test `Refresh the sidebar drafts only when a save adds or removes a draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx#L296).

- **Given** A chat has no draft, and its saved-draft listing has been fetched.
- **When** The user saves “Listing draft,” edits it to add “v2,” then clears the composer.
- **Then** The listing is fetched once when the draft is added, is not refetched for the edit, and is fetched once more when the draft is removed; clearing saves an empty user message.

## chat-continuity-drafts-006

Original test `Clear a saved typed draft without restoring it on the next visit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx#L338).

- **Given** A chat has the saved typed draft “Unsent launch checklist.”
- **When** The user clears the draft, navigates to a neighboring conversation, and returns.
- **Then** The saved user message and attachments are cleared, and the chat composer remains empty on return.

## chat-continuity-drafts-007

Original test `Send the current version of a restored draft and clear it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx#L367).

- **Given** A chat has a restored draft with “Original release brief” and an attachment named “outdated-brief.txt.”
- **When** The user removes that attachment, replaces the text with “Revised release brief,” attaches “latest-brief.txt,” and sends the message.
- **Then** The sent prompt is “Revised release brief” and the sent attachment is only “latest-brief.txt.” The conversation shows the revised text and new attachment, not the outdated attachment, and the composer and saved draft are cleared.
