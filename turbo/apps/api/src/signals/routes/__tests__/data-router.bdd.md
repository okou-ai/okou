# data-router

## data-router-001

- Vitest: "Data Router accounting when a run ends > resolves the service token only at auth and totals reported request credits once"
- Mode: run
- Given: A Pro user has an assigned Run with a personal model subscription. The Data Router endpoint and its service credential are configured, and the provider can report costs of three and four credits for two registered requests.
- When: The Runner reads execution, the network boundary resolves the router credential, and the Run registers both request IDs and completes. The old firewall credential and completion callback are retried after termination.
- Then: Execution exposes the router URL but never its service credential. The authorized boundary returns the service bearer, resolved secret name and expiry. Incompatible personal-model mappings return HTTP 424 with `CONNECTOR_NOT_CONFIGURED`. Settlement uses a JSON-only stateless MCP 2026-07-28 billing_get request with the service credential. Completion debits seven credits once, and subsequent auth is HTTP 403.

## data-router-002

- Vitest: "Data Router accounting when a run ends > dispatches a healthy Run without Data Router configuration and refuses its auth"
- Mode: run
- Given: The Data Router service credential is absent, while a Pro user can start a Run.
- When: The Runner gets execution and requests firewall auth for the Data Router.
- Then: The dispatch omits the router from billable firewalls and auth returns HTTP 424 with `CONNECTOR_NOT_CONFIGURED`. Run readback remains running and completion goes through.

## data-router-003

- Vitest: "Data Router accounting when a run ends > settles captured usage after a completed Run"
- Mode: run
- Given: A Run has a registered Router request and the provider can report four credits. The provider delays its response.
- When: The authenticated sandbox completes the Run, bringing the provider lookup into flight, then the provider releases the usage result.
- Then: Completion returns HTTP 200 and the eventual balance decreases by exactly four credits.

## data-router-004

- Vitest: "Data Router accounting when a run ends > settles reported usage once across cancellation and completion callbacks"
- Mode: run
- Given: A Run has one registered request for which the provider reports three credits.
- When: The owner cancels the Run twice and the sandbox sends its completion callback.
- Then: Cancellation and completion return HTTP 200, and balance falls by three after the first cancellation and stays there after replay and completion.

## data-router-005

- Vitest: "Data Router accounting when a run ends > scopes session and agent request history to the user's organization and rejects another Run token"
- Mode: run
- Given: One user has a Run in each of two organizations, and another member of the first organization has a separate Run. Each assigned sandbox registers its own Router request.
- When: The other member’s sandbox attempts to register a request against the original Run. The owner then reads history using their web session and the original Run’s execution token.
- Then: The cross-Run registration returns HTTP 401. Both history responses return HTTP 200 with only the original user and organization’s request ID.
