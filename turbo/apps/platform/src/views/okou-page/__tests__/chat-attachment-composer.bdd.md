# Chat attachment composer

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-attachment-composer.test.tsx](chat-attachment-composer.test.tsx).

## chat-attachment-composer-001

Original test `A user can paste or drop private attachments`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-composer.test.tsx#L41).

- **Given** A user is composing a chat message and has a private text file and a PDF.
- **When** They paste text and the text file into the message editor, then drag and drop the PDF into the composer.
- **Then** The pasted text appears in the editor, and both files appear as attachments with controls to remove them.

## chat-attachment-composer-002

Original test `A deliberate backdrop click closes an image preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-composer.test.tsx#L110).

- **Given** A chat draft contains the image photo.png.
- **When** The user opens its image preview and deliberately clicks the preview backdrop.
- **Then** The photo.png preview dialog closes.

## chat-attachment-composer-003

Original test `A confirmed image annotation reaches the agent as structured data`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-composer.test.tsx#L136).

- **Given** A chat draft contains billing-page.png with one saved box annotation whose note is “Tighten this spacing.”
- **When** The user enters “Fix the billing page” and sends the message to the agent.
- **Then** The agent receives that prompt and a file part identifying billing-page.png with its image MIME type, annotated file ID, and structured annotation data.

## chat-attachment-composer-004

Original test `Composer attachments show a clear upload lifecycle`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-composer.test.tsx#L190).

- **Given** A user is composing a chat message and selects proposal.docx while its upload is pending.
- **When** The upload is pending, then succeeds; the user also selects dashboard.png, waits for its thumbnail to load, and removes it.
- **Then** While proposal.docx is uploading, it appears with a cancel-upload control. After dashboard.png uploads, it appears with a remove control and a loading thumbnail that clears when the image loads; removing it removes the attachment.

## chat-attachment-composer-005

Original test `A restored image draft uses its MIME type for a binary storage thumbnail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-composer.test.tsx#L248).

- **Given** A restored chat draft contains an image named “image” with MIME type image/jpeg and a private binary-storage URL.
- **When** The user opens its preview.
- **Then** The thumbnail uses the image service URL derived from the private URL, and the opened lightbox displays the original private URL.

## chat-attachment-composer-006

Original test `Saved image annotations return with the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-composer.test.tsx#L276).

- **Given** A restored chat draft contains saved-layout.png with one saved annotation mark.
- **When** The user opens the image preview.
- **Then** The composer shows one mark, and the preview displays the annotation layer with mark number 1.
