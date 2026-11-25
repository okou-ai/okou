# webhooks-stripe-worker

## webhooks-stripe-worker-001

- Vitest: "authenticates signed billing webhooks with the Worker's Web Crypto provider"
- Mode: run
- Given: Row `billing`. The billing and automation Stripe webhook secrets are configured, and signatures are verified with Stripe's asynchronous Web Crypto provider as in the Worker runtime.
- When: Stripe posts a `customer.created` event with a valid `stripe-signature` header to `POST /api/webhooks/stripe`, then posts the same signature with the body changed to `customer.deleted`.
- Then: The signed event returns HTTP 200 with body `OK`. The tampered event returns HTTP 401 with error "Invalid webhook signature".

## webhooks-stripe-worker-002

- Vitest: "authenticates signed connect webhooks with the Worker's Web Crypto provider"
- Mode: run
- Given: Row `connect`. The billing and automation Stripe webhook secrets are configured, and signatures are verified with Stripe's asynchronous Web Crypto provider as in the Worker runtime.
- When: Stripe posts a `customer.created` event with a valid `stripe-signature` header to `POST /api/webhooks/stripe-automation-events`, then posts the same signature with the body changed to `customer.deleted`.
- Then: The signed event returns HTTP 200 with body `OK`. The tampered event returns HTTP 401 with error "Invalid webhook signature".
