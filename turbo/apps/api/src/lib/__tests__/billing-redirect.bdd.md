# billing-redirect

## billing-redirect-001

- Vitest: "billingRedirectAllowed > accepts the configured app origin"
- Mode: run
- Intent: review
- Given: In preview, the destination is the configured app origin `https://app.vm7.ai:8443`.
- When: The billing redirect validator evaluates the URL for `/onboarding?billing=success`.
- Then: The validator reports the destination as allowed.

## billing-redirect-002

- Vitest: "billingRedirectAllowed > rejects a non-App origin"
- Mode: run
- Intent: review
- Given: In preview, the configured app origin is `https://app.vm7.ai:8443` and the destination is `https://example.com`.
- When: The billing redirect validator evaluates the URL for `/onboarding?billing=success`.
- Then: The validator reports the destination as disallowed.

## billing-redirect-003

- Vitest: "billingRedirectAllowed > accepts a standalone okou app Worker preview"
- Mode: run
- Intent: review
- Given: In preview, the destination is the standalone Okou app Worker preview on the `vm0.workers.dev` account domain.
- When: The billing redirect validator evaluates the URL for `/onboarding?billing=success`.
- Then: The validator reports the destination as allowed.

## billing-redirect-004

- Vitest: "billingRedirectAllowed > rejects a same-named app Worker preview from another account"
- Mode: run
- Intent: review
- Given: In preview, the destination has the expected PR app Worker name on a different Workers account domain.
- When: The billing redirect validator evaluates the URL for `/onboarding?billing=success`.
- Then: The validator reports the destination as disallowed.

## billing-redirect-005

- Vitest: "billingRedirectAllowed > rejects a standalone okou app Worker preview in production"
- Mode: run
- Intent: review
- Given: In production, the destination is the standalone Okou app Worker preview on the `vm0.workers.dev` account domain.
- When: The billing redirect validator evaluates the URL for `/onboarding?billing=success`.
- Then: The validator reports the destination as disallowed.
