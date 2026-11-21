# Chat attachment annotation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-attachment-annotation.test.tsx](chat-attachment-annotation.test.tsx).

## chat-attachment-annotation-001

Original test `Pressing outside the editor keeps the session and every mark drawn in it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L70).

- **Given** A user has drawn a mark in an image annotation editor.
- **When** They press outside the editor.
- **Then** The editor remains visible and the drawn mark is still visible.

## chat-attachment-annotation-002

Original test `A user can click an annotation note, edit it, and close only the note`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L98).

- **Given** An image has an annotation note reading “Move the total higher.”
- **When** The user opens the note, changes it to “Align the total with the heading,” and presses Escape.
- **Then** The note editor closes, the annotation editor stays open, and the updated note is shown.

## chat-attachment-annotation-003

Original test `A tool shortcut works on open and text is typed onto the image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L147).

- **Given** The image annotation editor is open.
- **When** The user presses the text-tool shortcut, places a text mark, types “Raise this,” and presses Enter.
- **Then** The text is entered directly on the image, the text editor closes, and the mark displays “Raise this.”

## chat-attachment-annotation-004

Original test `IME Enter (composing) keeps the text mark open until ordinary Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L186).

- **Given** A text mark is being edited and contains the composed text “标注.”
- **When** The user presses Enter while composition is active, then enters a newline and “Second line” with Shift+Enter, and presses ordinary Enter.
- **Then** The composing Enter leaves the editor open with “标注”; ordinary Enter confirms the note as “标注 Second line” and returns focus to the annotation panel.

## chat-attachment-annotation-005

Original test `IME Enter (Safari final key) keeps the text mark open until ordinary Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L186).

- **Given** A text mark is being edited and contains the composed text “标注.”
- **When** The user presses Enter with Safari’s final-key indicator (key code 229), then enters a newline and “Second line” with Shift+Enter, and presses ordinary Enter.
- **Then** The Safari final-key Enter leaves the editor open with “标注”; ordinary Enter confirms the note as “标注 Second line” and returns focus to the annotation panel.

## chat-attachment-annotation-006

Original test `IME Backspace (composing) preserves an empty note; ordinary Backspace deletes its mark`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L239).

- **Given** An existing annotation note is empty and open for editing.
- **When** The user presses Backspace while composition is active, then presses ordinary Backspace.
- **Then** Composing Backspace preserves the empty note and keeps it open; ordinary Backspace deletes its mark and leaves zero marks.

## chat-attachment-annotation-007

Original test `IME Delete (composing) preserves an empty note; ordinary Delete deletes its mark`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L239).

- **Given** An existing annotation note is empty and open for editing.
- **When** The user presses Delete while composition is active, then presses ordinary Delete.
- **Then** Composing Delete preserves the empty note and keeps it open; ordinary Delete deletes its mark and leaves zero marks.

## chat-attachment-annotation-008

Original test `IME Backspace (Safari final key) preserves an empty note; ordinary Backspace deletes its mark`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L239).

- **Given** An existing annotation note is empty and open for editing.
- **When** The user presses Backspace with Safari’s final-key indicator (key code 229), then presses ordinary Backspace.
- **Then** The Safari final-key Backspace preserves the empty note and keeps it open; ordinary Backspace deletes its mark and leaves zero marks.

## chat-attachment-annotation-009

Original test `IME Delete (Safari final key) preserves an empty note; ordinary Delete deletes its mark`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L239).

- **Given** An existing annotation note is empty and open for editing.
- **When** The user presses Delete with Safari’s final-key indicator (key code 229), then presses ordinary Delete.
- **Then** The Safari final-key Delete preserves the empty note and keeps it open; ordinary Delete deletes its mark and leaves zero marks.

## chat-attachment-annotation-010

Original test `The pill deletes the open mark and is dead until one is`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L282).

- **Given** The annotation editor contains an existing mark, but no mark is selected.
- **When** The user tries the Remove mark control, selects the mark, and uses the control.
- **Then** Remove mark is disabled before selection; after use, the selected mark is deleted and the count is zero.

## chat-attachment-annotation-011

Original test `The editor takes over from the preview without a frame between them`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L311).

- **Given** A user is viewing an image preview.
- **When** They choose Annotate.
- **Then** The annotation editor appears immediately, the preview closes, and the annotation surface subsequently loads.

## chat-attachment-annotation-012

Original test `Attaching marks closes the editor at once and blocks sending until the copy uploads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L330).

- **Given** A user has entered a message and drawn one mark on an attached image; sending is initially available.
- **When** They choose Attach marks while the marked-up copy upload is pending.
- **Then** The editor closes, the composer shows one attached mark, the copy is shown as preparing, and sending is disabled until upload completes.

## chat-attachment-annotation-013

Original test `Attached marks are saved while their copy is still uploading`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L373).

- **Given** An image attachment has a draft message and no annotated copy yet.
- **When** The user draws one mark and chooses Attach marks while the copy is still uploading.
- **Then** The saved draft contains the annotation mark, while the annotated copy ID is not yet present.

## chat-attachment-annotation-014

Original test `A copy that fails to upload can be retried from its chip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L414).

- **Given** A marked-up copy upload fails once, then succeeds on a later read.
- **When** The user retries the copy from its retry control.
- **Then** The retry control disappears and sending becomes enabled after the successful upload.

## chat-attachment-annotation-015

Original test `A user can attach marks to a private image through its public URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L451).

- **Given** An image is available through a private file URL, whose first download URL fails, while its public URL can be read.
- **When** The user draws one mark and chooses Attach marks.
- **Then** The editor closes, the composer shows one attached mark, and sending becomes enabled using the available public image URL.

## chat-attachment-annotation-016

Original test `Confirmed marks persist with their completed annotated file`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L501).

- **Given** An image has no annotated copy yet, and upload of a marked-up copy succeeds.
- **When** The user draws one mark and chooses Attach marks.
- **Then** The saved attachment contains the completed annotated file ID and one annotation mark; the composer shows one mark and sending is enabled.

## chat-attachment-annotation-017

Original test `A user can attach marks after previewing a public image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L544).

- **Given** A public image has been previewed, potentially placing an opaque response in the browser cache.
- **When** The user annotates the image and chooses Attach marks.
- **Then** The editor closes, the composer shows one attached mark, and sending becomes enabled.

## chat-attachment-annotation-018

Original test `A draft with marks but no annotated copy rebuilds it and can send`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L599).

- **Given** A restored draft contains one annotation mark but no annotated copy.
- **When** The chat loads and rebuilds the marked-up copy from the original image.
- **Then** The composer shows one mark and sending becomes enabled; the original image is read once.

## chat-attachment-annotation-019

Original test `An arrow can be selected and re-aimed by dragging its tip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L636).

- **Given** An image contains an existing arrow annotation.
- **When** The user selects the arrow and drags its tip to 25% from the left and 90% from the top.
- **Then** Both arrow handles are visible during selection, and the tip ends at the specified position.

## chat-attachment-annotation-020

Original test `A freehand stroke can be selected and moved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L680).

- **Given** An image contains a freehand stroke whose first point is at 20% from the left and 25% from the top.
- **When** The user selects the stroke and drags it 10 percentage points right and down.
- **Then** The note editor opens on selection, and the stroke’s first point moves to approximately 30% from the left and 35% from the top.

## chat-attachment-annotation-021

Original test `Enter confirms a note and one drag is a single undo step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx#L720).

- **Given** An image contains an annotation with no note.
- **When** The user edits it to “Raise this panel,” presses Enter, then drags the mark and presses Ctrl+Z once.
- **Then** Enter confirms the note and closes its editor; one undo restores the mark’s original left position of 8% after the drag.

### Batch 42 disposition

- `chat-attachment-annotation-018` remains unaccepted. A restored one-mark draft without a copy rebuilds and enables Send. The separate requirement for exactly one original-image read cannot be established through the permitted page evidence.
