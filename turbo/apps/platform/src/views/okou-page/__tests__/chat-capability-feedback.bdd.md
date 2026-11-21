# Chat capability feedback

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-feedback.test.tsx](chat-capability-feedback.test.tsx).

## chat-capability-feedback-001

Original test `Offer passage actions only for a valid assistant selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-feedback.test.tsx#L54).

- **Given** A completed conversation contains two assistant responses.
- **When** The user selects text within one assistant response, then selects text spanning passages from both responses, then selects text within the first response again and presses Q.
- **Then** Copy, Quote, and Forward actions appear for the valid single-response selection but not the cross-response selection. Pressing Q opens feedback for the selected passage, focuses the message composer, and shows the quoted text.

## chat-capability-feedback-002

Original test `Combine inline feedback with the rest of a message draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-feedback.test.tsx#L90).

- **Given** A user has typed ordinary draft text and attached a file, then added a comment on a quoted assistant passage.
- **When** They send the message.
- **Then** The submitted message contains the ordinary text, the passage quote with its comment, and the attached review-notes.txt file.

## chat-capability-feedback-003

Original test `Edit or remove a quoted feedback item`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-feedback.test.tsx#L157).

- **Given** A user has ordinary draft text and a quoted assistant passage with a feedback comment.
- **When** They erase the comment, enter a replacement, and remove the feedback item.
- **Then** The quoted passage remains while the comment can be edited; after removal, the feedback item is gone and the ordinary draft text remains.

## chat-capability-feedback-004

Original test `Edit and send independent notes on multiple quoted passages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-feedback.test.tsx#L209).

- **Given** A user has added feedback to one assistant passage and added a second quoted passage.
- **When** They revise the second passage's note and send both notes.
- **Then** The submitted feedback contains the first passage with its original note followed by the second passage with its replacement note. The feedback items disappear and the Stop control is visible.
