# User message document

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [user-message-document.test.ts](user-message-document.test.ts).

## user-message-document-001

Original test `Supported generation templates restore for editing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L137).

- **Given** A message contains an illustration template, a workflow template, or a website template.
- **When** The saved message is restored for editing and saved again.
- **Then** Each supported template message is preserved exactly.

## user-message-document-002

Original test `A saved video template draft restores its brief as editable text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L162).

- **Given** A saved video-template message contains launch-brief text followed by an Epic grandeur video template.
- **When** The message is restored for editing and saved again.
- **Then** The editable text is retained, while the video template is absent from the saved message.

## user-message-document-003

Original test `Complex composer content survives saving and restoring`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L180).

- **Given** A message contains two attachments, a presentation template, multiline text, a chat-thread mention, an agent mention, and closing text.
- **When** The message is restored with its attachments, saved, and converted to a prompt.
- **Then** The saved message matches the original, and the prompt retains the meaningful content in order: template, text, thread mention, agent mention, and closing text.

## user-message-document-004

Original test `Email feedback keeps its source status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L248).

- **Given** A feedback message quotes a sent email and includes a rewrite note.
- **When** The message is restored, saved, and converted to a prompt.
- **Then** The sent status, mail ID, and sent ID are preserved, and the prompt identifies the quoted passage as part of a sent email before including the quote and note.

## user-message-document-005

Original test `Forwarded feedback uses the document-level source title`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L274).

- **Given** A feedback quote is followed by source metadata for an agent chat titled “Source launch plan.”
- **When** The document is converted to prompt text and display text.
- **Then** Both outputs identify the forwarded source using the document-level title and include the quote.

## user-message-document-006

Original test `Forwarded mail feedback keeps common source identifiers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L302).

- **Given** Forwarded feedback comes from a chat titled “Source launch plan” and has one of three forms: a draft email with a note, a sent email with a sent ID and no note, or two draft-email quotes where only the second has a note.
- **When** Each document is converted to prompt text and display text.
- **Then** Both outputs preserve the common chat source title and the applicable draft or sent email identifiers. They include the quote or quotes and note, and the two-quote case preserves quote order and reports two forwarded parts.

## user-message-document-007

Original test `A file-only message keeps its attachment without invented text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L406).

- **Given** A message contains only a PDF attachment and no text.
- **When** The message is restored with its attachment, saved, and converted to a prompt.
- **Then** The attachment remains in the saved message and the prompt is empty; no text is invented.

## user-message-document-008

Original test `An annotated attachment keeps its editable marks on the file part`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L431).

- **Given** An image attachment has an editable box annotation with coordinates, color, and note.
- **When** An empty editor document is converted to a message with that attachment.
- **Then** The file part retains the attachment identity and the annotation data.

## user-message-document-009

Original test `An incomplete editor message is rejected safely`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L475).

- **Given** An editor document has a presentation-template attachment paired with an illustration selection, or has no content.
- **When** Either editor document is converted to a message.
- **Then** Both incomplete messages are rejected by returning no saved message.

## user-message-document-010

Original test `Multiple feedback quotes keep their notes and order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L498).

- **Given** A message has context text, two quoted feedback passages with separate notes, and trailing context; the second note includes a chat-thread mention.
- **When** The message is restored, saved, and converted to a prompt.
- **Then** The saved message matches the original, and the prompt preserves the context, quote-and-note order, separator between the quotes, thread mention, and trailing context.

## user-message-document-011

Original test `Multiple inline templates survive feedback editing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L542).

- **Given** A message contains pitch-deck and paper-cut templates in text, followed by feedback quoting a passage with the paper-cut template in its note.
- **When** The message is restored, saved, and converted to a prompt.
- **Then** The saved message matches the original, and the prompt retains both inline templates and the feedback quote and note in order.

## user-message-document-012

Original test `Paragraphs, line breaks, and intentional spaces are preserved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L581).

- **Given** An editor message contains leading spaces, a hard line break with trailing spaces, an empty paragraph, and a final paragraph with trailing spaces.
- **When** The editor content is saved and restored for editing.
- **Then** The saved text preserves the spaces, line break, blank paragraph, and paragraph order exactly, and saving the restored document produces the same message.

## user-message-document-013

Original test `A single quoted passage without a note stays singular`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L614).

- **Given** A message contains one quoted passage with no note.
- **When** The message is converted to a prompt.
- **Then** The prompt describes one quoted passage and includes the quote without implying multiple passages.

## user-message-document-014

Original test `Routing metadata is not shown as user text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L631).

- **Given** A message contains user text plus source, automation, and model-routing metadata.
- **When** The document is validated and converted to display text and prompt text.
- **Then** The metadata remains in the validated document but neither output includes it; both outputs contain only the user text.

## user-message-document-015

Original test `A template-only message remains sendable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L662).

- **Given** A message contains only a pitch-deck presentation template.
- **When** It is restored, saved, and converted to a prompt.
- **Then** The template remains in the saved message, and the prompt says “Select Pitch deck presentation template.”

## user-message-document-016

Original test `Suggestion quote and typed direction round-trip through the saved editor document`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L680).

- **Given** A message contains existing draft text, suggestion context, and feedback with a quoted passage and typed direction.
- **When** The message is restored, saved, and converted to prompt and display text.
- **Then** Suggestion feedback is unchanged across the round trip; prompt text includes the source identifier and typed direction, while display text includes the suggestion title but not the source identifier.

## user-message-document-017

Original test `Project mentions preserve captured identity through drafts, feedback, text and display`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.test.ts#L717).

- **Given** A project mention with a captured project ID and name appears in message text and in a feedback note.
- **When** The draft is restored and saved, then the document is converted to prompt and display text.
- **Then** The saved message preserves the project identity in both locations, prompt text includes its project link, and display text includes its captured name.
