# Email subscription settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [email-subscription-settings.test.tsx](email-subscription-settings.test.tsx).

## email-subscription-settings-001

Original test `email subscription settings > lets a user restore email without changing brief generation, then pause the brief independently`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/email-subscription-settings.test.tsx#L35).

- **Given** Email updates are off, the morning brief is on, and an email delivery address is available.
- **When** The user enables email updates, pauses the morning brief, disables email updates, and re-enables the brief.
- **Then** Each preference changes independently: email updates can be restored without altering brief generation, and the brief can be paused independently. The final state has email updates off and the brief on.

## email-subscription-settings-002

Original test `email subscription settings > keeps the previous email setting after a failed save so the user can toggle again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/email-subscription-settings.test.tsx#L103).

- **Given** Email updates are off and the first preference save is delayed and then fails.
- **When** The user turns email updates on, waits for the failure, then toggles again.
- **Then** The control is temporarily disabled during the request, returns to off after failure, and accepts the next toggle successfully, leaving email updates on.

## email-subscription-settings-003

Original test `email subscription settings > explains missing email delivery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/email-subscription-settings.test.tsx#L159).

- **Given** The user's email subscription is enabled, but delivery status is no-email and no address is available.
- **When** The user opens email subscription settings.
- **Then** The page explains Email unavailable while the Email updates switch remains checked.
