# Subscription reset card

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [subscription-reset-card.test.tsx](subscription-reset-card.test.tsx).

## subscription-reset-card-001

Original test `a reset link displays exact-account usage and never resets before a click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L109).

- **Given** A chat message contains a reset link for the authenticated account, whose Codex usage is 0% remaining for five hours and 60% remaining for the week, with three reset credits.
- **When** The user opens the link card and then clicks “3 resets.”
- **Then** The card shows the account email, both usage values, and three remaining resets without submitting before the click. After the click, it reports a successful reset, disables the reset action, and remains in the same card frame.

## subscription-reset-card-002

Original test `repeated cards submit the same idempotency key and share refreshed remaining credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L147).

- **Given** A chat message contains two cards for the same reset URL, and the account has three reset credits.
- **When** The user clicks both cards before either request completes, then both requests finish.
- **Then** Both requests use the same idempotency key. Each card reports success, and both show the shared refreshed balance of two remaining resets.

## subscription-reset-card-003

Original test `the direct URL opens an authenticated reset page and still requires a click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L187).

- **Given** The user is authenticated and opens a direct reset URL for an account with three credits.
- **When** The reset page loads, then the user clicks “3 resets.”
- **Then** Loading the page alone does not submit a reset. The page describes that a reset uses one credit; after the click, it reports that the request was already redeemed.

## subscription-reset-card-004

Original test `the standalone Claude Code page exposes natural recovery without manual-credit confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L215).

- **Given** The user opens the standalone reset page for a Claude Code account that does not support manual resets.
- **When** The page loads and the user opens the five-hour usage details.
- **Then** The page says usage recovers naturally and offers no reset-credit action or remaining-credit count. The details show 0% left and the same recovery notice, without advertising click-to-submit confirmation.

## subscription-reset-card-005

Original test `the Claude Code state cannot submit a reset`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L278).

- **Given** A Claude Code account does not support manual resets and has three credits in its account data.
- **When** The user views its reset card in chat.
- **Then** The card says manual reset is unsupported and usage recovers naturally; no reset button is offered.

## subscription-reset-card-006

Original test `the no credit state cannot submit a reset`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L278).

- **Given** An account has zero reset credits.
- **When** The user views its reset card in chat.
- **Then** The card says no reset credits are available and its reset action is disabled.

## subscription-reset-card-007

Original test `the reconnect state cannot submit a reset`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L278).

- **Given** An account needs to be reconnected and has three reset credits.
- **When** The user views its reset card in chat.
- **Then** The card directs the user to reconnect in Settings > Models, and its reset action is disabled.

## subscription-reset-card-008

Original test `Claude Code recovery details never advertise manual reset credits or confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L295).

- **Given** A Claude Code account does not support manual resets and has three credits in its account data.
- **When** The user opens the five-hour usage details from its chat card.
- **Then** The details show the natural-recovery notice and do not show remaining reset credits or click-to-submit confirmation.

## subscription-reset-card-009

Original test `an unavailable subscription has no reset action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L315).

- **Given** A reset link in a chat message refers to a subscription that is unavailable in the current workspace because the account lookup returns not found.
- **When** The user views the message.
- **Then** The message says the subscription is unavailable in the current workspace and offers no reset action.

## subscription-reset-card-010

Original test `usage rings open accessible recovery and expiry details outside the fixed frame`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L330).

- **Given** An account has usage information and three reset credits, with credits next expiring on October 12, 2030.
- **When** The user opens the five-hour usage ring’s details.
- **Then** The accessible details show 0% left, the credit-expiry information, and a notice that only clicking Reset submits the request. The details appear outside the fixed card frame, which remains in place.

## subscription-reset-card-011

Original test `unknown usage still exposes credit details without inventing zero quota`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L351).

- **Given** An account has three reset credits but no usage information.
- **When** The user views the card and opens the five-hour usage details.
- **Then** Usage rings do not report a numeric quota value; the details show “--” and still display the three remaining resets.

## subscription-reset-card-012

Original test `nothing to reset is a terminal outcome without spending a credit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L365).

- **Given** An account has three reset credits and its reset request succeeds with a “nothing to reset” outcome.
- **When** The user clicks the reset action.
- **Then** The card says there is no exhausted usage window to reset and disables the reset action.

## subscription-reset-card-013

Original test `0 resets is the only reset action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L385).

- **Given** An account has zero reset credits.
- **When** The user views its reset card.
- **Then** The only reset action is “0 resets,” and it is disabled.

## subscription-reset-card-014

Original test `1 reset is the only reset action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L385).

- **Given** An account has one reset credit.
- **When** The user views its reset card.
- **Then** The only reset action is “1 reset,” and it is enabled.

## subscription-reset-card-015

Original test `2 resets is the only reset action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L385).

- **Given** An account has two reset credits.
- **When** The user views its reset card.
- **Then** The only reset action is “2 resets,” and it is enabled.

## subscription-reset-card-016

Original test `— resets is the only reset action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L385).

- **Given** The account’s reset-credit count is unknown.
- **When** The user views its reset card.
- **Then** The only reset action is “— resets,” and it is disabled.

## subscription-reset-card-017

Original test `untrusted reset URLs and code examples stay ordinary message content`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-reset-card.test.tsx#L406).

- **Given** A chat message contains the reset URL as inline code and also contains a reset-looking URL on an untrusted external domain.
- **When** The user views the message.
- **Then** Neither URL produces a reset card.
