# Composer pasted text

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [composer-pasted-text.test.tsx](composer-pasted-text.test.tsx).

## composer-pasted-text-001

Original test `Insert 10,000 ASCII code units into the existing draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L129).

- **Given** The composer contains the draft “Keep the existing draft.”
- **When** The user pastes 10,000 ASCII characters.
- **Then** The pasted text is appended to the draft without creating an attachment, and Send is enabled.

## composer-pasted-text-002

Original test `Insert 5,000 emoji (10,000 UTF-16 code units) into the existing draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L129).

- **Given** The composer contains the draft “Keep the existing draft.”
- **When** The user pastes 5,000 emoji, totaling 10,000 UTF-16 code units.
- **Then** The pasted text is appended to the draft without creating an attachment, and Send is enabled.

## composer-pasted-text-003

Original test `A size-rejected long paste stays inline and can be sent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L147).

- **Given** The composer contains selected draft text, and the pasted text is 10,001 ASCII characters. The generated text-file attachment exceeds the 5 GB limit.
- **When** The user pastes the text and sends it.
- **Then** The oversize warning appears, no attachment is added, and the text remains inline, replacing the selected draft. Sending submits exactly that text as the message.

## composer-pasted-text-004

Original test `Attach and send 10,001 ASCII code units with exact whit… without replacing selected draft text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L201).

- **Given** The composer contains the draft “Keep the existing draft.” and the entire draft is selected.
- **When** The user pastes 10,001 ASCII characters including the exact leading and trailing whitespace “\n \t” and “ \r\n”, then sends.
- **Then** The original draft remains unchanged and a text-file attachment named Pasted text-1.txt is added with the exact pasted contents. Sending submits both the original draft text and the attachment.

## composer-pasted-text-005

Original test `Attach and send 5,000 emoji plus x (10,001 UTF-16 code … without replacing selected draft text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L201).

- **Given** The composer contains the draft “Keep the existing draft.” and the entire draft is selected.
- **When** The user pastes 5,000 emoji followed by x, totaling 10,001 UTF-16 code units, then sends.
- **Then** The original draft remains unchanged and a text-file attachment named Pasted text-1.txt is added with the exact pasted contents. Sending submits both the original draft text and the attachment.

## composer-pasted-text-006

Original test `Repeated oversized pastes keep distinct filenames and complete contents`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L258).

- **Given** The composer contains the draft “Keep the existing draft.”
- **When** The user pastes two oversized notes, one beginning “First pasted note” and one beginning “Second pasted note.”
- **Then** Both attachments remain distinct, named Pasted text-1.txt and Pasted text-2.txt, and each uploaded file contains its complete corresponding text. The draft remains unchanged.

## composer-pasted-text-007

Original test `Keep mixed oversized text and clipboard-notes.txt as text plus the original file`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L296).

- **Given** The composer contains the draft “Keep the existing draft.” The clipboard contains 10,001 characters of text and the original file clipboard-notes.txt.
- **When** The user pastes the mixed clipboard contents.
- **Then** The text is appended inline to the draft and the original file is attached as clipboard-notes.txt. No generated Pasted text attachment is added.

## composer-pasted-text-008

Original test `Keep mixed oversized text and clipboard-image.png as text plus the original file`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L296).

- **Given** The composer contains the draft “Keep the existing draft.” The clipboard contains 10,001 characters of text and the original file clipboard-image.png.
- **When** The user pastes the mixed clipboard contents.
- **Then** The text is appended inline to the draft and the original file is attached as clipboard-image.png. No generated Pasted text attachment is added.

## composer-pasted-text-009

Original test `Restore a rich Okou copy before converting its oversized plain-text fallback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L322).

- **Given** A user message contains more than 10,000 characters and a text-file attachment; the user copies it using Okou’s rich message copy.
- **When** They paste the copied rich content into a composer containing a draft.
- **Then** The draft remains and the copied message text is appended inline, with its attachment restored under its original filename. No generated Pasted text attachment is added.
