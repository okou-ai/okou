# runtime-credit-balance

## runtime-credit-balance-001

- Vitest: "current credit balance during an active free Run > rejects further billable requests with 0 credits remaining"
- Mode: run
- Given: An active free Run has been authorized at a funded balance and later settles down to 0 credits.
- When: The assigned Run requests billable firewall credentials and image generation, then requests nonbillable firewall auth.
- Then: The initial funded lease expires 25 to 35 seconds after the sampled time. After settlement both billable requests return HTTP 402 with `INSUFFICIENT_CREDITS`, while nonbillable authorization returns HTTP 200.

## runtime-credit-balance-002

- Vitest: "current credit balance during an active free Run > rejects further billable requests with -1 credits remaining"
- Mode: run
- Given: An active free Run has been authorized at a funded balance and later settles down to -1 credits.
- When: The assigned Run requests billable firewall credentials and image generation, then requests nonbillable firewall auth.
- Then: The initial funded lease expires 25 to 35 seconds after the sampled time. After settlement both billable requests return HTTP 402 with `INSUFFICIENT_CREDITS`, while nonbillable authorization returns HTTP 200.

## runtime-credit-balance-003

- Vitest: "current credit balance during an active free Run > shortens renewed billable authorization when a free Run has low credits"
- Mode: run
- Given: An active free Run has 500 credits remaining.
- When: The assigned Run renews authorization for a billable request.
- Then: The API returns HTTP 200 with an expiry at least five seconds and less than ten seconds after the sampled time.
