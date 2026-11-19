# Chat continuity clipboard

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-continuity-clipboard.test.tsx](chat-continuity-clipboard.test.tsx).

## chat-continuity-clipboard-001

Original test `Paste copied chat text and attachments safely`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-clipboard.test.tsx#L100).

- **Given** The user has a chat draft reading “Before after,” with the cursor between the words, and a copied message containing two lines and an available attachment.
- **When** They paste that copied message, then paste text with an inaccessible attachment.
- **Then** The first paste appears between “Before” and “after” with both line breaks and an attachment control. The second paste keeps its text, shows that the missing file must be uploaded again, and leaves the available attachment intact.

## chat-continuity-clipboard-002

Original test `Persist pasted text and attachments after the copied file resolves`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-clipboard.test.tsx#L167).

- **Given** The user has an empty chat draft and copies “Copied notes to keep” with an attachment whose availability check is still pending.
- **When** They paste the copied content and the file subsequently becomes available.
- **Then** The text appears while the file is resolving, and a cancel-upload control is shown. After resolution, the saved draft includes both the text and attachment, and sending is enabled.

## chat-continuity-clipboard-003

Original test `Pasted text is saved when attachment restoration returns 404`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-clipboard.test.tsx#L288).

- **Given** The user has an earlier draft, “Keep the earlier draft.”, and pastes “Pasted text survives” with an attachment that returns 404 during restoration.
- **When** They paste the copied content.
- **Then** The saved and visible draft retains both the earlier text and pasted text, while the attachment is omitted and a warning says “unreadable-copy.txt is no longer available. Upload it again to send.”

## chat-continuity-clipboard-004

Original test `Paste plain and multi-line text at the current draft position`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-clipboard.test.tsx#L300).

- **Given** The user has a chat draft reading “Alpha omega,” with the cursor between the words, and another chat available as a reference.
- **When** They paste plain text at the cursor, then paste multi-line text containing a reference to that chat at the end of the draft.
- **Then** The plain text appears between “Alpha” and “omega.” The later paste preserves its order around the chat reference, which is visibly represented as a reference, with the first and last pasted lines on either side.

## chat-continuity-clipboard-005

Original test `Copy a multiline draft without flattening its line breaks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-clipboard.test.tsx#L363).

- **Given** The user has entered a two-line draft: “First draft line” and “Second draft line.”
- **When** They copy the selected draft.
- **Then** The clipboard’s plain text is exactly “First draft line\nSecond draft line,” preserving the line break.
