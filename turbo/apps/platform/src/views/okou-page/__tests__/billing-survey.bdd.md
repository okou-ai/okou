# Billing survey

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [billing-survey.test.tsx](billing-survey.test.tsx).

## billing-survey-001

Original test `Ask a free workspace admin why they are not upgrading and thank them with credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.test.tsx#L153).

- **Given** A free-workspace admin has run out of credits, and the workspace has not yet answered the exhaustion survey.
- **When** They open the survey, select “Something else,” enter “Waiting for my team budget,” and submit.
- **Then** The survey states that the first eligible answer earns 200 bonus credits valid for 30 days, and Submit starts disabled until an answer is selected. The upgrade action remains directly available, and after submission the member sees that 200 credits were added; the recorded answer is “other” with the entered detail.

## billing-survey-002

Original test `Leave the out-of-credits card unchanged once the member has answered`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.test.tsx#L202).

- **Given** A member has answered the workspace’s credits-exhausted survey and then encounters an out-of-credits error.
- **When** The chat’s out-of-credits card is shown.
- **Then** The “Upgrade to Pro” action remains visible, and no exhaustion survey is shown.

## billing-survey-003

Original test `Ask why a purchase was not completed when Stripe sends the member back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.test.tsx#L221).

- **Given** A member returns to the app with a canceled billing checkout, and the server reports an abandoned plan checkout only for that canceled return.
- **When** They choose “The price was higher than I expected” and submit the checkout survey.
- **Then** The survey is dismissed, the response records the plan checkout and its session, and the billing query parameter is removed from the URL.

## billing-survey-004

Original test `Wait for the restored plans dialog to close before asking about canceled checkout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.test.tsx#L263).

- **Given** A member returns from a canceled plan checkout while the restored “Choose a plan” dialog is open; an exhaustion survey action is also available in the chat.
- **When** They close the plans dialog and submit “The price was higher than I expected” in the checkout survey.
- **Then** The checkout survey does not appear while the plans dialog is open. After the plans dialog closes, the checkout survey appears; submitting it dismisses the survey and records the plan checkout session and answer.

## billing-survey-005

Original test `Ask on a new device using the unpaid Checkout returned by the server`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.test.tsx#L309).

- **Given** On a new device, the server reports an unpaid credits checkout for the member, with no canceled-return query in the URL.
- **When** The member selects “Not now” in the checkout survey.
- **Then** The survey closes without submitting a response.

## billing-survey-006

Original test `Wait while a recent Checkout may still be open in another tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.test.tsx#L331).

- **Given** A free-workspace member has an out-of-credits error, and no abandoned checkout is reported.
- **When** They open the exhaustion survey while a recent checkout could still be open in another tab.
- **Then** The exhaustion survey appears, but no checkout-abandonment dialog appears.

## billing-survey-007

Original test `Keep the Pro upgrade action without an exhaustion survey for a Pro-only model with 0 credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.test.tsx#L350).

- **Given** A member has 0 credits and encounters a Pro-only model error.
- **When** The chat error card is shown.
- **Then** “Upgrade to Pro” remains available, and no credits-exhaustion survey is shown.

## billing-survey-008

Original test `Keep the Pro upgrade action without an exhaustion survey for a Pro-only model with 500 credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.test.tsx#L350).

- **Given** A member has 500 credits and encounters a Pro-only model error.
- **When** The chat error card is shown.
- **Then** “Upgrade to Pro” remains available, and no credits-exhaustion survey is shown.

## billing-survey-009

Original test `Ask another admin for feedback without promising an already claimed organization reward`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.test.tsx#L379).

- **Given** A free-workspace admin opens the exhaustion survey after the workspace reward has already been claimed, as indicated by a reward amount of 0.
- **When** They view the survey’s reward information.
- **Then** The survey does not promise the first eligible answer’s 200 bonus credits valid for 30 days.

## billing-survey-010

Original test `Keep a completed Checkout out of the abandonment survey even without a success redirect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.test.tsx#L402).

- **Given** The server reports no abandoned checkout, even though the member has not returned through a success redirect, and the chat has an out-of-credits error.
- **When** The member opens the exhaustion survey.
- **Then** No checkout-abandonment survey appears.
