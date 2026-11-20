# Chat composer document templates

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-document-templates.test.tsx](chat-composer-document-templates.test.tsx).

## chat-composer-document-templates-001

Original test `Document category and scroll survive preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-document-templates.test.tsx#L62).

- **Given** The user has drafted “Prepare the invoice for my client.” and is viewing the template picker’s Document category, filtered to Invoice.
- **When** The user previews Simple invoice and closes its preview with Escape.
- **Then** The Document category remains selected, the Invoice filter and its seven results remain, and the grid scroll position is restored to 120. Focus returns to the Simple invoice preview control, the draft remains unchanged, and no message has been sent.

## chat-composer-document-templates-002

Original test `Using a document template preserves the draft until the user sends it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-document-templates.test.tsx#L109).

- **Given** The user has drafted “Explain this proposal to my client.”
- **When** The user selects the Sidebar report document template, then sends the draft.
- **Then** Selecting the template closes the picker, keeps the draft, and attaches an inline Sidebar report without sending. Sending produces one message containing the document template selection for Sidebar report.

## chat-composer-document-templates-003

Original test `Meeting notes can be previewed and attached without sending the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-document-templates.test.tsx#L143).

- **Given** The user has drafted “Summarize these meeting notes.” and opens the Meeting notes preview in the Business records filter.
- **When** The user previews the first page and attaches the template.
- **Then** The preview shows the meeting-notes page image and an Open larger preview link to that image, with no next-page control. Attaching closes the picker and adds Meeting notes inline while preserving the draft and sending nothing; sending afterward produces one message containing the Meeting notes document template selection.

## chat-composer-document-templates-004

Original test `The Document tray opens its picker with the keyboard`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-document-templates.test.tsx#L182).

- **Given** The user has drafted “Keep this draft” and opened the Document template tray.
- **When** The user activates View all with the keyboard and closes the picker with Escape.
- **Then** The picker opens with Document selected. The draft remains, a Remove Document control is present, and no message has been sent.

## chat-composer-document-templates-005

Original test `A Document tray cover attaches its template and keeps the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-document-templates.test.tsx#L202).

- **Given** The user has drafted “Keep this draft” and opened the Document template tray.
- **When** The user uses the Itemized invoice cover template.
- **Then** The template attaches inline, the draft remains unchanged, the picker stays closed, a Remove Document control is present, and no message is sent.

## chat-composer-document-templates-006

Original test `Document sends its creation intent and keeps its task chip in the new thread`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-document-templates.test.tsx#L217).

- **Given** The user has opened the Document template tray and has not yet entered a draft.
- **When** The user drafts “Prepare a project brief.” and sends it.
- **Then** One message is sent with that prompt and the additional instruction “Create a document.” The new thread retains a Remove Document control.

## chat-composer-document-templates-007

Original test `Document preview pages display unavailable images`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-document-templates.test.tsx#L237).

- **Given** The user is previewing the Simple invoice document template.
- **When** The preview page image fails to load.
- **Then** The preview displays “Preview unavailable.”

## chat-composer-document-templates-008

Original test `Document preview pages navigate, reset on reopen, and can be selected from details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-document-templates.test.tsx#L246).

- **Given** The user opens the Mutual NDA preview, which has two sample pages.
- **When** The user navigates forward and back, reopens Mutual NDA, then opens Simple invoice and selects it.
- **Then** Mutual NDA starts on page 1 with Previous disabled; page 2 has a different image URL, Next is disabled, and the larger-preview link follows the current page. Returning to page 1 restores its URL; reopening Mutual NDA resets to page 1. Simple invoice has no page-navigation controls, and selecting it attaches the template inline without sending a message.
