# Onboarding pasted text

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-pasted-text.test.tsx](onboarding-pasted-text.test.tsx).

## onboarding-pasted-text-001

Original test `A paste at the UTF-16 threshold stays editable text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L138).

- **Given** The onboarding prompt contains “Keep this draft. ”.
- **When** The user pastes 10,000 ASCII characters.
- **Then** The pasted content remains editable in the prompt, Next stays enabled, and no attachment is created.

## onboarding-pasted-text-002

Original test `A paste at the UTF-16 threshold stays editable text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L138).

- **Given** The onboarding prompt contains “Keep this draft. ”.
- **When** The user pastes 5,000 emoji, which total 10,000 UTF-16 code units.
- **Then** The pasted content remains editable in the prompt, Next stays enabled, and no attachment is created.

## onboarding-pasted-text-003

Original test `Oversized Unicode pastes keep the selected draft and save only current attachments (legacy: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L156).

- **Given** A handoff prompt is selected with an existing attachment, which the user removes.
- **When** The user pastes oversized Unicode text.
- **Then** The prompt remains unchanged, the exact pasted text is uploaded as a plain-text attachment, and saving the handoff includes only the new attachment. The handoff link replaces the old one and the legacy prompt query is absent.

## onboarding-pasted-text-004

Original test `Oversized Unicode pastes keep the selected draft and save only current attachments (legacy: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L156).

- **Given** A legacy prompt-query onboarding link is selected with no existing attachments.
- **When** The user pastes oversized Unicode text.
- **Then** The prompt remains unchanged, the exact pasted text is uploaded as a plain-text attachment, and saving creates a handoff containing only that attachment. The handoff link is added and the legacy prompt query is absent.

## onboarding-pasted-text-005

Original test `A 25,000-character paste reaches the first task as a private attachment after onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L207).

- **Given** The user is onboarding with a task prompt and no attachments.
- **When** The user pastes 25,000 characters and completes onboarding.
- **Then** The text is uploaded as a plain-text attachment and saved in the handoff. The first task opens with the original prompt and imported attachment, and the sent message includes the prompt and that file; the handoff query is cleared.

## onboarding-pasted-text-006

Original test `Finishing a later paste does not enable Run while an earlier upload is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L361).

- **Given** The user has started an attachment upload and then pastes a second oversized text while the first upload remains pending.
- **When** The second upload finishes before the first.
- **Then** Next remains disabled until the first upload also finishes. Saving includes the second attachment before the first, matching their displayed order.

## onboarding-pasted-text-007

Original test `A failed pasted attachment retains its contents for retry or explicit removal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L425).

- **Given** The user pastes oversized text and its attachment upload fails with a service-unavailable response.
- **When** The user retries successfully, removes the attachment, then pastes the text again and removes the second failed attachment.
- **Then** The exact text is retained for retry; Next remains disabled after the first failure and becomes enabled after retry. Explicit removal clears the attachment while preserving the prompt and enables Next; after the second failure, removal likewise clears the attachment and enables Next.

## onboarding-pasted-text-008

Original test `Clipboard file items keep their oversized plain-text fallback in the prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L486).

- **Given** The prompt contains “Keep this draft. ”.
- **When** The user pastes 10,001 characters alongside a clipboard image file.
- **Then** The oversized plain-text fallback is added to the prompt, Next stays enabled, and no pasted-text attachment is created.

## onboarding-pasted-text-009

Original test `The attachment cap includes uploads still in progress and preserves a rejected paste as text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L504).

- **Given** The user has one fewer than the maximum number of attachments and starts an upload of oversized pasted text.
- **When** The user pastes another oversized text while the first upload is still pending.
- **Then** The attachment-cap message says the rejected text remains in the prompt; that text is appended to the prompt and Next remains disabled while the first upload is pending. Removing the pending attachment enables Next, and no second attachment is created.

## onboarding-pasted-text-010

Original test `A paste at the 10 MB upload limit preserves every UTF-8 byte`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L541).

- **Given** The user is onboarding with a task prompt and no attachments.
- **When** The user pastes text whose UTF-8 size is exactly 10 MB, including multibyte characters and a newline.
- **Then** The exact text is uploaded as plain text with a measured size of 10 MB, the prompt remains unchanged, and Next becomes enabled.

## onboarding-pasted-text-011

Original test `A paste above 10 MB remains text rather than disappearing into a rejected upload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L570).

- **Given** The user is onboarding with a task prompt and no attachments, and has selected the prompt text.
- **When** The user pastes text one byte above the 10 MB upload limit.
- **Then** The size-limit message says the pasted text remains in the prompt; the full text replaces the prompt, Next is disabled, and no attachment is created.

## onboarding-pasted-text-012

Original test `The final prompt limit includes output instructions and can be corrected without losing text (mobile: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L591).

- **Given** On desktop, the prompt is exactly at the character limit before output instructions are selected.
- **When** The user selects Document, clears that selection, edits the prompt one character over the limit, restores it to the limit, and submits.
- **Then** The displayed count includes the two-character separator and output instructions. Selecting Document disables Next and marks the prompt invalid without saving; clearing the selection enables Next. One character over the limit remains visible and disables Next, while restoring the limit enables submission and saves the original prompt.

## onboarding-pasted-text-013

Original test `The final prompt limit includes output instructions and can be corrected without losing text (mobile: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L591).

- **Given** On mobile, the prompt is exactly at the character limit before output instructions are selected.
- **When** The user selects Document, clears that selection, edits the prompt one character over the limit, restores it to the limit, and submits.
- **Then** The displayed count includes the two-character separator and output instructions. Selecting Document disables Start task and marks the prompt invalid without saving; clearing the selection enables Start task. One character over the limit remains visible and disables it, while restoring the limit enables submission and saves the original prompt.

## onboarding-pasted-text-014

Original test `Changing language refreshes the selected suffix and its exact submission count`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L635).

- **Given** The prompt and selected Document instruction together are exactly at the character limit.
- **When** The user changes the app language to German, edits the prompt to fit the German instruction exactly within the limit, and submits.
- **Then** The selected instruction updates to the German text while the prompt remains unchanged, and the displayed count reflects the new instruction. Submission saves the edited prompt followed by the German instruction and separator, with total length exactly at the limit.

## onboarding-pasted-text-015

Original test `Leaving the owning onboarding page aborts an in-flight paste upload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-pasted-text.test.tsx#L710).

- **Given** The user is onboarding on a preview host and a pasted-text attachment upload is in progress.
- **When** The user chooses Skip to leave onboarding.
- **Then** The app opens the chat composer and aborts the in-flight upload; the onboarding prompt is no longer present.
