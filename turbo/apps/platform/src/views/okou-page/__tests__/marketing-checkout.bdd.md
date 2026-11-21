# Marketing checkout

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [marketing-checkout.test.tsx](marketing-checkout.test.tsx).

## marketing-checkout-001

Original test `A checkout action sends a Marketing event without waiting for it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-checkout.test.tsx#L102).

- **Given** A user sees an insufficient-credits message and chooses to upgrade by opening checkout in a new tab. The Marketing endpoint accepts the event but delays its response.
- **When** The user activates the upgrade action with Ctrl-click.
- **Then** A checkout-start Marketing event is sent with a UUID event ID, included credentials, a bearer authorization header, and JSON content type. The Stripe URL is opened in a new tab without waiting for the Marketing response, and the request is not aborted while that response is pending.

## marketing-checkout-002

Original test `A Marketing failure does not prevent the Stripe redirect or start retries`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-checkout.test.tsx#L133).

- **Given** A user sees an insufficient-credits message and chooses to upgrade. The Marketing endpoint fails with a network error.
- **When** The user activates the upgrade action, then browser online and focus events occur.
- **Then** The browser navigates to the Stripe checkout URL despite the Marketing failure. The Marketing request is made only once; online and focus events do not trigger retries.

## marketing-checkout-003

Original test `An expired plan preview keeps the quoted amount visible with the confirmation error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/marketing-checkout.test.tsx#L153).

- **Given** A user starts an upgrade to Pro, receives a $20.00 plan preview, and the preview expires before confirmation.
- **When** The user confirms the subscription change and the server responds that the preview has expired.
- **Then** The confirmation error says the subscription change could not be prepared. Both quoted $20.00 amounts remain visible, and the confirmation button remains enabled.
