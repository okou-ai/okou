# Email unsubscribe page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [email-unsubscribe-page.test.tsx](email-unsubscribe-page.test.tsx).

## email-unsubscribe-page-001

Original test `An invalid unsubscribe token shows an error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/email-unsubscribe/__tests__/email-unsubscribe-page.test.tsx#L24).

- **Given** The user is signed out and opens the unsubscribe page with an invalid token. The unsubscribe service responds with a 400 error.
- **When** The user selects Unsubscribe.
- **Then** The page shows “Something went wrong.”

## email-unsubscribe-page-002

Original test `A missing unsubscribe token cannot submit an unsubscribe request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/email-unsubscribe/__tests__/email-unsubscribe-page.test.tsx#L47).

- **Given** The user is signed out and opens the unsubscribe page without a token.
- **When** The page loads.
- **Then** An alert says “Something went wrong,” the Okou image is present, and no buttons are available to submit an unsubscribe request.

## email-unsubscribe-page-003

Original test `A user can confirm email unsubscribe`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/email-unsubscribe/__tests__/email-unsubscribe-page.test.tsx#L60).

- **Given** The user is signed out and opens the unsubscribe page with a valid token. The unsubscribe service responds successfully.
- **When** The user selects the enabled Unsubscribe button.
- **Then** The page shows “Unsubscribed” and says, “You will no longer receive system-initiated email notifications from Okou.”
