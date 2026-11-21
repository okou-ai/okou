# Chat capability voice forwarding

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-voice-forwarding.test.tsx](chat-capability-voice-forwarding.test.tsx).

## chat-capability-voice-forwarding-001

Original test `Fork opens a quoted personal chat composer and preserves the source draft on dismissal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-forwarding.test.tsx#L48).

- **Given** A user has selected a passage in an assistant response, and the original chat composer contains existing notes.
- **When** The user opens the passage’s personal-chat fork, enters follow-up text, and dismisses the dialog.
- **Then** The dialog shows the quoted passage and its own composer with the new text. The original composer’s existing notes remain unchanged both while the dialog is open and after dismissal.

## chat-capability-voice-forwarding-002

Original test `Keep forwarding suggestions isolated during preview navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-forwarding.test.tsx#L158).

- **Given** A user is forwarding a selected passage and has typed “Forward draft /” in the dialog composer; the slash suggestions menu is open.
- **When** The user navigates the menu with Arrow Up and previews the Document template by hovering it.
- **Then** The Document template is marked pressed while the dialog and draft remain unchanged. Focus stays in the forwarding composer, and the original composer retains its existing notes.

Batch 35 disposition. The frozen registration uses Forward and selects a named destination. #49556 removed the target picker and its switch. In the current Router, selecting the passage offered Fork and opened the personal Okou composer directly. Arrow Up and Document hover preserved the personal draft, its focus and the source notes. The selected-destination prerequisite remains unverified under this ID.

## chat-capability-voice-forwarding-003

Original test `Keep forwarding suggestions isolated during IME composition`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-forwarding.test.tsx#L183).

- **Given** A user is forwarding a selected passage with “Forward draft /” typed and the slash suggestions menu open.
- **When** The user begins an IME composition and presses Enter while composing, then ends composition.
- **Then** The suggestions menu remains open during composition, and the forwarding dialog and draft remain intact afterward. Focus stays in the forwarding composer, and the original composer retains its existing notes.

Batch 35 disposition. The frozen registration uses Forward and selects a named destination. #49556 removed the target picker and its switch. In the current Router, selecting the passage offered Fork and opened the personal Okou composer directly. Composing Enter retained suggestions and the personal draft, focus and source notes. The selected-destination prerequisite remains unverified under this ID.

## chat-capability-voice-forwarding-004

Original test `Keep forwarding suggestions isolated during dismissal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-forwarding.test.tsx#L201).

- **Given** A user is forwarding a selected passage with “Forward draft /” typed and the slash suggestions menu open.
- **When** The user presses Escape.
- **Then** The suggestions menu closes without closing the dialog or changing the forwarding draft. Focus stays in the forwarding composer, and the original composer retains its existing notes.

Batch 35 disposition. The frozen registration uses Forward and selects a named destination. #49556 removed the target picker and its switch. In the current Router, selecting the passage offered Fork and opened the personal Okou composer directly. Escape closed suggestions and preserved the personal draft, its focus and source notes. The selected-destination prerequisite remains unverified under this ID.

## chat-capability-voice-forwarding-005

Original test `reuse an unfinished agent recording in the forward dialog without replacing it > uses the saved recording in the forward dialog without changing the original composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-forwarding.test.tsx#L288).

- **Given** An unfinished voice recording with 4,096 samples has been saved from a new-chat composer, and the original composer has existing notes.
- **When** The user opens a forwarding dialog in a restored chat and chooses to use the saved recording.
- **Then** The dialog’s message composer shows “Original recording.”, while the original composer’s existing notes remain unchanged. The audio is uploaded only once.
