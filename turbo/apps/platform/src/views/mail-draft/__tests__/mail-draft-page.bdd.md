# Mail draft page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [mail-draft-page.test.tsx](mail-draft-page.test.tsx).

## mail-draft-page-001

Original test `An external mail link requires sign-in and preserves its destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/mail-draft/__tests__/mail-draft-page.test.tsx#L97).

- **Given** A signed-out user opens a standalone email link.
- **When** The user opens the link.
- **Then** The app shows sign-in with the exact email URL preserved as the redirect destination; the email subject is not shown.

## mail-draft-page-002

Original test `An external mail link opens the complete email and its attachments without a chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/mail-draft/__tests__/mail-draft-page.test.tsx#L115).

- **Given** A user opens a standalone email containing sender, recipients, HTML content, and a text attachment.
- **When** The user opens the email and previews the attachment.
- **Then** The complete email details and attachment preview are shown without opening a chat. Closing the preview returns to the same email URL.

## mail-draft-page-003

Original test `Sending from the standalone page shows the sent email on the same URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/mail-draft/__tests__/mail-draft-page.test.tsx#L179).

- **Given** A user opens a standalone draft email.
- **When** The user sends it successfully.
- **Then** The page shows the email as sent at the same URL, removes its buttons, and links to the sent Gmail thread.

## mail-draft-page-004

Original test `Deleting from the standalone page removes the email without opening a chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/mail-draft/__tests__/mail-draft-page.test.tsx#L210).

- **Given** A user opens a standalone draft email.
- **When** The user deletes it successfully.
- **Then** The page reports that the email is no longer available, hides its subject, and remains at the same URL without opening a chat.

## mail-draft-page-005

Original test `An accepted Outlook send appears as sent immediately on the standalone page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/mail-draft/__tests__/mail-draft-page.test.tsx#L229).

- **Given** A user opens an Outlook draft on the standalone page.
- **When** The user sends it and Outlook accepts the request.
- **Then** Send is disabled while the request is pending; afterward the email immediately appears sent, links to Outlook, and remains at the same URL.

## mail-draft-page-006

Original test `An uncertain Outlook send offers a status check without resending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/mail-draft/__tests__/mail-draft-page.test.tsx#L260).

- **Given** A user opens an Outlook draft on the standalone page.
- **When** Sending returns an uncertain `sending` status, then the user checks status after Outlook marks it sent.
- **Then** The page offers a status check and warns against trying again before confirmation; checking status shows Sent without resending.

## mail-draft-page-007

Original test `An inaccessible mail link cannot expose email actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/mail-draft/__tests__/mail-draft-page.test.tsx#L288).

- **Given** A user opens a standalone mail link that is inaccessible because the draft lookup returns 404.
- **When** The email page loads.
- **Then** The page reports that the email is no longer available and exposes no buttons.

## mail-draft-page-008

Original test `A deleted draft is identified without exposing Send or Delete`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/mail-draft/__tests__/mail-draft-page.test.tsx#L305).

- **Given** A user opens a standalone draft whose status is deleted.
- **When** The email page loads.
- **Then** The page identifies the deleted draft and exposes neither Send nor Delete.

## mail-draft-page-009

Original test `A draft whose Gmail access expired reopens once Gmail is reconnected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/mail-draft/__tests__/mail-draft-page.test.tsx#L318).

- **Given** A user opens a draft whose Gmail access has expired.
- **When** Gmail is reconnected and the app receives the Gmail connection-change event.
- **Then** The page initially asks the user to reconnect and hides the email; afterward it shows the email and removes the reconnect message.

## mail-draft-page-010

Original test `Email content retains links and image descriptions without native hover hints`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/mail-draft/__tests__/mail-draft-page.test.tsx#L364).

- **Given** A user opens email content containing a link and an image with descriptions and native title hints.
- **When** The email content is displayed.
- **Then** The link and image description remain, while title hints are absent from the link, image, and paragraph.
