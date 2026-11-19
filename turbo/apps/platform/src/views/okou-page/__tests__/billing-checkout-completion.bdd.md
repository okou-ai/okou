# Billing checkout completion

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [billing-checkout-completion.test.tsx](billing-checkout-completion.test.tsx).

## billing-checkout-completion-001

Original test `Returning from concurrency checkout confirms purchased capacity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-checkout-completion.test.tsx#L34).

- **Given** The user returns to the agents page with the concurrency=purchased return parameter.
- **When** The page handles the checkout return.
- **Then** It displays that concurrency was added and new slots will be available after Stripe confirms the subscription, then removes the return parameter from the URL.

## billing-checkout-completion-002

Original test `A pending subscription completes checkout and clears its return parameters after confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-checkout-completion.test.tsx#L53).

- **Given** The user returns to the agents page with a team billing session whose checkout completion is initially pending and later confirmed.
- **When** Checkout completion is checked until it succeeds.
- **Then** The Agents page is shown, and the billing return parameters are cleared from the URL after confirmation.

## billing-checkout-completion-003

Original test `A confirmed usage-pack purchase displays its confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-checkout-completion.test.tsx#L77).

- **Given** The user is on the limited-free-1 tier and a usage-pack checkout can be previewed and completed.
- **When** They choose Pro, proceed through member-package configuration, and confirm the order.
- **Then** The app displays “Subscription change confirmed.”
