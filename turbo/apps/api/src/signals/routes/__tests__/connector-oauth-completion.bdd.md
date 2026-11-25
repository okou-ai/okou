# connector-oauth-completion

## connector-oauth-completion-001

- Vitest: "exposes a receipt only to its owner and exact current connector target"
- Mode: run
- Given: An authenticated user in an organization has completed a GitHub OAuth add attempt. A valid account and an attempt ID exist.
- When: Callers use GET /api/connector-accounts/oauth-completions/:attemptId as the owner, with a different connector target, different user or organization, a nonexistent attempt and no authentication. The owner retries and then deletes the account and checks the receipt again.
- Then: The exact owner/target returns HTTP 200 with only the connection ID and Cache-Control no-store. Incorrect identities and unknown IDs receive indistinguishable HTTP 404 NOT_FOUND with OAuth completion not found responses with no-store. Anonymous read returns HTTP 401 and deleting the account causes HTTP 404 NOT_FOUND with OAuth completion not found with no-store.

## connector-oauth-completion-002

- Vitest: "does not complete a denied reconnect after rename or default-account changes and allows retry"
- Mode: run
- Given: An authenticated owner has a GitHub account and begins a reconnect that will be denied by the provider.
- When: The owner renames the account and selects it as default before the OAuth callback, checks its receipt before and after provider denial, completes a separate retry, then attempts a successful callback with the old attempt state.
- Then: The denied callback reports error. Its receipt stays HTTP 404 after the account changes, after denial and after the separate success. The successful retry's receipt returns the exact connection ID, and replaying the denied attempt reports error and still yields HTTP 404.

## connector-oauth-completion-003

- Vitest: "retains independent receipts for overlapping GitHub adds that reuse the same account"
- Mode: run
- Given: An authenticated owner already has a GitHub account for the provider identity. They start two overlapping add attempts for that same identity.
- When: The OAuth provider completes the second attempt first, then the first. The owner reads both receipts.
- Then: The first attempt's receipt is HTTP 404 until its callback. The start response IDs differ from the pre-existing account ID. After both callbacks each distinct attempt receipt returns only the existing connection ID.

## connector-oauth-completion-004

- Vitest: "expires completed attempts without expiring their connector account"
- Mode: run
- Given: An authenticated owner has a completed GitHub OAuth attempt tied to a saved account.
- When: After 16 minutes the owner sends GET /api/connector-accounts/oauth-completions/:attemptId for the attempt and reads the exact account separately.
- Then: The receipt returns HTTP 404 while the account detail returns HTTP 200 with the same saved connection ID.

## connector-oauth-completion-005

- Vitest: "tracks successful and cancelled custom http OAuth attempts independently"
- Mode: run
- Given: An authenticated owner creates a custom HTTP OAuth connector requesting read. The provider allows the add attempt and denies a later reconnect after the account is renamed.
- When: The owner sends GET /api/connector-accounts/oauth-completions/:attemptId before and after the add callback, tries wrong built-in and custom targets, completes the denied reconnect, then deletes the account and checks the add receipt again.
- Then: The add receipt is HTTP 404 before callback and HTTP 200 after success, with only the exact ID and no-store. Each wrong target receives HTTP 404 NOT_FOUND with OAuth completion not found and no-store. The denied reconnect has no receipt and does not affect the completed add receipt. After deletion the original receipt returns HTTP 404 NOT_FOUND with OAuth completion not found and no-store.

## connector-oauth-completion-006

- Vitest: "tracks successful and cancelled custom mcp OAuth attempts independently"
- Mode: run
- Given: An authenticated owner creates a custom streamable MCP OAuth connector requesting read. The provider allows the add attempt and denies a later reconnect after the account is renamed.
- When: The owner sends GET /api/connector-accounts/oauth-completions/:attemptId before and after the add callback, tries wrong built-in and custom targets, completes the denied reconnect, then deletes the account and checks the add receipt again.
- Then: The add receipt is HTTP 404 before callback and HTTP 200 after success, with only the exact ID and no-store. Each wrong target receives HTTP 404 NOT_FOUND with OAuth completion not found and no-store. The denied reconnect has no receipt and does not affect the completed add receipt. After deletion the original receipt returns HTTP 404 NOT_FOUND with OAuth completion not found and no-store.
