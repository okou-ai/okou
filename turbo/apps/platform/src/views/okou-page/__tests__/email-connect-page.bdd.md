# Email connect page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [email-connect-page.test.tsx](email-connect-page.test.tsx).

## email-connect-page-001

Original test `connects in the active workspace without asking a multi-workspace user to choose again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/email-connect-page.test.tsx#L42).

- **Given** A signed email connection link is opened by a user with multiple workspace memberships and an active workspace.
- **When** The connection is completed.
- **Then** The page shows Email connected and a notification naming verified@example.com, returns to /settings/email, submits the link proof, and links Open email to mailto:okou@okou.io without asking the user to choose a workspace.

## email-connect-page-002

Original test `explains an expired connection without asking the user to resend account details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/email-connect-page.test.tsx#L78).

- **Given** A user opens an expired email connection link.
- **When** The connection request is rejected as invalid or expired.
- **Then** The page explains that the link is invalid or expired and says to send a new email to Okou; Email connected is not shown.

## email-connect-page-003

Original test `adds an email from the Works card with a short code and updates the open dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/email-connect-page.test.tsx#L95).

- **Given** A user is on Works with email integration available and opens Email connections.
- **When** They copy the initial short code, generate a new code, and an email address is added.
- **Then** The dialog shows the new code and updates the Open email mailto link to use it; the added address appears without leaving /works. Closing the dialog returns focus to Email options.

## email-connect-page-004

Original test `opens unsigned email settings with the login email connected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/email-connect-page.test.tsx#L155).

- **Given** A signed-in user opens /settings/email and their login email is connected.
- **When** The email settings page loads and the user closes its dialog.
- **Then** The route redirects to /works, the Email connections dialog lists the login email and enables Add email, and closing returns focus to Email options.

## email-connect-page-005

Original test `keeps a failed code request in the dialog and lets the user retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/email-connect-page.test.tsx#L191).

- **Given** A user opens Email connections from Works, and requesting a connection code initially fails.
- **When** They retry by selecting Add email after the request becomes available.
- **Then** The dialog first shows a retryable error without closing, then displays the returned code 12345678 after the retry succeeds.

## email-connect-page-006

Original test `deletes each linked address from Manage and returns focus to Add email`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/email-connect-page.test.tsx#L227).

- **Given** A user manages two linked addresses from the Works email card.
- **When** They delete each address in turn and close the dialog.
- **Then** Each deleted address disappears while the other remains until deleted; closing returns focus to Add email.

## email-connect-page-007

Original test `manages multiple connections and adds another mailbox without leaving Works`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/email-connect-page.test.tsx#L305).

- **Given** A user manages a Gmail address and an Outlook address from Works.
- **When** They add another mailbox and the email-changed event arrives.
- **Then** The dialog identifies the existing addresses' sources as Gmail and Outlook, displays the new address, and remains on /works. Closing returns focus to Email options.

## email-connect-page-008

Original test `deletes the login email while keeping other addresses connected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/email-connect-page.test.tsx#L354).

- **Given** A user's login email and a secondary email are connected and listed in Manage.
- **When** They delete the login email, close Manage, and reopen it.
- **Then** The login email is absent while the secondary address remains connected; the reopened list preserves that state, and closing returns focus to Email options.
