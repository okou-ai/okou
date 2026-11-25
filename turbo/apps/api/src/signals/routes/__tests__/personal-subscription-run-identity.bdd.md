# personal-subscription-run-identity

## personal-subscription-run-identity-001

- Vitest: "personal subscription run identity > executes without proven upstream identity but denies failed-run account management"
- Mode: run
- Given: A Pro member connected a Claude Code subscription whose Anthropic profile returns no account identity, and selected `claude-sonnet-5-5`.
- When: The member sends and launches a chat Run, reads its Runner execution, the Run fails, and the member calls `GET /api/me/model-provider-accounts/:id?runId=<run>` and `POST /api/me/model-provider-accounts/:id/runs/:runId/subscription-reset` for the connected account.
- Then: The execution's subscription credentials are sourced from the connected account and the Run's source account reads `{ status: "unknown" }`. After the failure both the account read and the reset return HTTP 404.

## personal-subscription-run-identity-002

- Vitest: "personal subscription run identity > preserves proven recovery identity for claude-code-oauth-token pending admission"
- Mode: run
- Given: A Pro member has a connected `claude-code-oauth-token` subscription (identity A) and two admitted running chat Runs on it.
- When: The member reads the second Run, connects a different identity B of the same type via `POST /api/me/model-providers`, and reads the Run again.
- Then: Before the reconnect the Run is `running` with source account `{ status: "connected", id: <account A> }`; afterwards its source account reads exactly `{ status: "unavailable" }`.

## personal-subscription-run-identity-003

- Vitest: "personal subscription run identity > preserves proven recovery identity for codex-oauth-token pending admission"
- Mode: run
- Given: A Pro member has a connected `codex-oauth-token` subscription (identity A) and two admitted running chat Runs on it.
- When: The member reads the second Run, connects a different identity B of the same type via `POST /api/me/model-providers`, and reads the Run again.
- Then: Before the reconnect the Run is `running` with source account `{ status: "connected", id: <account A> }`; afterwards its source account reads exactly `{ status: "unavailable" }`.

## personal-subscription-run-identity-004

- Vitest: "personal subscription run identity > runs a free-plan member's claude-code-oauth-token subscription model on its subscription route"
- Mode: run
- Given: A free-plan onboarded member connected a `claude-code-oauth-token` subscription and a Runner is available.
- When: The member sends and launches a chat Run with model `claude-opus-5-5`, and the Runner reads its execution input.
- Then: The Run is `running`, and its execution's subscription credentials come from the member's connected account rather than the built-in route; the Run then fails as expected.

## personal-subscription-run-identity-005

- Vitest: "personal subscription run identity > runs a free-plan member's codex-oauth-token subscription model on its subscription route"
- Mode: run
- Given: A free-plan onboarded member connected a `codex-oauth-token` subscription and a Runner is available.
- When: The member sends and launches a chat Run with model `gpt-6-sol`, and the Runner reads its execution input.
- Then: The Run is `running`, and its execution's subscription credentials come from the member's connected account rather than the built-in route; the Run then fails as expected.

## personal-subscription-run-identity-006

- Vitest: "personal subscription run identity > failed A after active B > recovers the captured account and preserves reset idempotency"
- Mode: run
- Given: A Pro member's chat Run on Codex account A failed; the member then connected account B through Codex device auth and activated it. ChatGPT reports one reset credit, and the consume endpoint first answers `reset` then `already_redeemed`.
- When: The member reads the Run, reads `GET /api/me/model-provider-accounts/<A>?runId=<run>`, and calls `POST /api/me/model-provider-accounts/<A>/runs/<run>/subscription-reset` twice with the same idempotency key.
- Then: The Run source shows provider `codex-oauth-token`, model `gpt-6-astra`, `member` scope and connected account A. The account read shows account A with 1 reset credit. The first reset returns `outcome: "reset"` and the second `outcome: "alreadyRedeemed"`, both consume calls carry the same body, at least one consume happens, and no ChatGPT call uses identity B.

## personal-subscription-run-identity-007

- Vitest: "personal subscription run identity > failed A after active B > denies another member access to the captured account and reset"
- Mode: run
- Given: A Pro member's failed Codex Run captured account A after account B became active, and the member can recover A (read and reset succeed); another member of the same workspace exists.
- When: The other member reads `GET /api/me/model-provider-accounts/<A>?runId=<run>` and calls the failed-run subscription reset for A.
- Then: The owner's recovery shows the connected captured account, 1 reset credit and outcome `reset` without using identity B. Both of the other member's requests return HTTP 404.

## personal-subscription-run-identity-008

- Vitest: "personal subscription run identity > failed A after active B > rechecks a disconnected recovery account after in-flight usage completes"
- Mode: run
- Given: A Pro member's failed Codex Run captured account A after account B became active, and ChatGPT's usage read for A stalls.
- When: The member starts `GET /api/me/model-provider-accounts/<A>?runId=<run>`; while the usage read is in flight the member deletes account A; then the usage read completes and the member lists `GET /api/me/model-providers`.
- Then: The recovery read returns HTTP 404 `{ error: { message: "Resource not found", code: "NOT_FOUND" } }`, and the list holds only account B, active, with 1 reset credit.

## personal-subscription-run-identity-009

- Vitest: "personal subscription run identity > failed A after active B > removes recovery after the captured account is deleted"
- Mode: run
- Given: A Pro member's failed Codex Run captured account A after account B became active, and the member's recovery of A works.
- When: The member deletes account A via `DELETE /api/me/model-provider-accounts/:id`, reads the Run, and retries the account read and failed-run reset for A.
- Then: The Run's source account reads exactly `{ status: "unavailable" }`, both recovery requests return HTTP 404, and no further ChatGPT requests are made.

## personal-subscription-run-identity-010

- Vitest: "personal subscription run identity > admits one canonical run for concurrent idempotent chat sends"
- Mode: run
- Given: A Pro member with a connected Codex subscription has an empty chat thread.
- When: The member sends two concurrent identical `POST /api/chat/events` requests with the same client event ID, then the claimed Run completes.
- Then: Both sends return HTTP 201. Exactly one `input.prompt` for that client event is claimed by a Run, the thread finally has exactly one such prompt bound to that Run, and the Run reads `completed`.

## personal-subscription-run-identity-011

- Vitest: "personal subscription run identity > retains pending bindings when a replacement changes the active identity"
- Mode: run
- Given: A Pro member with Codex account A has a running Run and a pending Run.
- When: The member connects identity B, the running Run's firewall resolves its credentials via `POST /api/webhooks/run/firewall/auth`, the pending Run starts and resolves too, both Runs are cancelled, and the member reconnects identity A.
- Then: Both Runs resolve `ChatGPT-Account-ID: identity-a`, and the pending Run's execution is bound to the originally captured account. Reconnecting identity A after cancellation yields a different account ID than the captured one.

## personal-subscription-run-identity-012

- Vitest: "personal subscription run identity > keeps both admitted identities when reconnect merges a duplicate account"
- Mode: run
- Given: A Pro member's first Run is bound to Codex account A; the member adds account B via device auth, activates it, and starts a second Run on B.
- When: The member re-activates A and reconnects A through device auth in `reconnect` mode, which returns identity B; both Runs resolve credentials via `POST /api/webhooks/run/firewall/auth`; the member lists providers before and after cancelling both Runs.
- Then: The reconnect returns account B's ID. The first Run still resolves `ChatGPT-Account-ID: identity-a` and the second resolves `identity-b`. The provider list contains only account B before and after the cancellations.

## personal-subscription-run-identity-013

- Vitest: "personal subscription run identity > rejects reactivation of a retained disconnected claude-code-oauth-token account"
- Mode: run
- Given: A Pro member's running Run captured `claude-code-oauth-token` account A, and the member then connected identity B as a replacement.
- When: The member tries to activate account A via `POST /api/me/model-provider-accounts/<A>/activate`, lists providers, and the Run's firewall resolves its credentials.
- Then: Activation returns HTTP 404, the list shows the replacement as the only active account, and the Run still resolves `Authorization: Bearer <account A token>`.

## personal-subscription-run-identity-014

- Vitest: "personal subscription run identity > rejects reactivation of a retained disconnected codex-oauth-token account"
- Mode: run
- Given: A Pro member's running Run captured `codex-oauth-token` account A, and the member then connected identity B as a replacement.
- When: The member tries to activate account A via `POST /api/me/model-provider-accounts/<A>/activate`, lists providers, and the Run's firewall resolves its credentials.
- Then: Activation returns HTTP 404, the list shows the replacement as the only active account, and the Run still resolves `Authorization: Bearer <account A token>`.

## personal-subscription-run-identity-015

- Vitest: "personal subscription run identity > reuses the same Claude identity across a reconnect"
- Mode: run
- Given: A Pro member's running Run captured Claude account A.
- When: The member reconnects identity A, deletes the account, reconnects identity A again, the Run resolves its credentials, the Run is cancelled, and the member lists providers.
- Then: Both reconnects return the captured account ID, the Run resolves `Authorization: Bearer <original token>`, and the list contains the captured account.

## personal-subscription-run-identity-016

- Vitest: "personal subscription run identity > user.banned stops the active Run from using a retained subscription"
- Mode: run
- Given: A Pro member's running Run is bound to a Codex account that the member then deleted, so only the Run retains it; Stripe lists no subscriptions.
- When: Clerk delivers a signed `user.banned` webhook for the member to `POST /api/webhooks/clerk`, then the Run's firewall token requests credentials via `POST /api/webhooks/run/firewall/auth`.
- Then: The webhook returns HTTP 200, and the credential request is refused with a non-200 status (400, 401, 403 or 424).

## personal-subscription-run-identity-017

- Vitest: "personal subscription run identity > user.deleted stops the active Run from using a retained subscription"
- Mode: run
- Given: A Pro member's running Run is bound to a Codex account that the member then deleted, so only the Run retains it; Stripe lists no subscriptions.
- When: Clerk delivers a signed `user.deleted` webhook for the member to `POST /api/webhooks/clerk`, then the Run's firewall token requests credentials via `POST /api/webhooks/run/firewall/auth`.
- Then: The webhook returns HTTP 200, and the credential request is refused with a non-200 status (400, 401, 403 or 424).

## personal-subscription-run-identity-018

- Vitest: "personal subscription run identity > organization.deleted stops the active Run from using a retained subscription"
- Mode: run
- Given: A Pro member's running Run is bound to a Codex account that the member then deleted, so only the Run retains it; Stripe lists no subscriptions.
- When: Clerk delivers a signed `organization.deleted` webhook for the member's workspace to `POST /api/webhooks/clerk`, then the Run's firewall token requests credentials via `POST /api/webhooks/run/firewall/auth`.
- Then: The webhook returns HTTP 200, and the credential request is refused with a non-200 status (400, 401, 403 or 424).

## personal-subscription-run-identity-019

- Vitest: "personal subscription run identity > organizationMembership.deleted stops the active Run from using a retained subscription"
- Mode: run
- Given: A Pro member's running Run is bound to a Codex account that the member then deleted, so only the Run retains it; Stripe lists no subscriptions.
- When: Clerk delivers a signed `organizationMembership.deleted` webhook for the member to `POST /api/webhooks/clerk`, then the Run's firewall token requests credentials via `POST /api/webhooks/run/firewall/auth`.
- Then: The webhook returns HTTP 200, and the credential request is refused with a non-200 status (400, 401, 403 or 424).

## personal-subscription-run-identity-020

- Vitest: "personal subscription run identity > claude-code-oauth-token personal provider removal > denies the retained credentials to the replacement sandbox"
- Mode: run
- Given: A Pro member's running Run captured a `claude-code-oauth-token` account; the member removed the provider type via `DELETE /api/me/model-providers/claude-code-oauth-token` (204, list now empty) and the Run still resolves the original token.
- When: The member connects identity B and starts a second Run; each Run resolves its credentials via `POST /api/webhooks/run/firewall/auth`, and the second Run's firewall token asks for the first Run's credential mapping.
- Then: The second Run is bound to a different account and resolves the new token, the first Run still resolves the original token, and the second Run's request for the first Run's credentials returns HTTP 424.

## personal-subscription-run-identity-021

- Vitest: "personal subscription run identity > codex-oauth-token personal provider removal > denies the retained credentials to the replacement sandbox"
- Mode: run
- Given: A Pro member's running Run captured a `codex-oauth-token` account; the member removed the provider type via `DELETE /api/me/model-providers/codex-oauth-token` (204, list now empty) and the Run still resolves the original token.
- When: The member connects identity B and starts a second Run; each Run resolves its credentials via `POST /api/webhooks/run/firewall/auth`, and the second Run's firewall token asks for the first Run's credential mapping.
- Then: The second Run is bound to a different account and resolves the new token, the first Run still resolves the original token, and the second Run's request for the first Run's credentials returns HTTP 424.

## personal-subscription-run-identity-022

- Vitest: "personal subscription run identity > cleans up only after the final completed transition"
- Mode: run
- Given: A Pro member has two running Runs bound to Codex account A, and the member deleted account A.
- When: The first Run reaches `completed`, the second Run resolves credentials, the second Run reaches `completed`, and the member reconnects identity A.
- Then: After the first Run ends the second Run still resolves `ChatGPT-Account-ID: identity-a`; after both end, reconnecting identity A yields a new account ID different from the captured one.

## personal-subscription-run-identity-023

- Vitest: "personal subscription run identity > cleans up only after the final failed transition"
- Mode: run
- Given: A Pro member has two running Runs bound to Codex account A, and the member deleted account A.
- When: The first Run reaches `failed`, the second Run resolves credentials, the second Run reaches `failed`, and the member reconnects identity A.
- Then: After the first Run ends the second Run still resolves `ChatGPT-Account-ID: identity-a`; after both end, reconnecting identity A yields a new account ID different from the captured one.

## personal-subscription-run-identity-024

- Vitest: "personal subscription run identity > cleans up only after the final cancelled transition"
- Mode: run
- Given: A Pro member has two running Runs bound to Codex account A, and the member deleted account A.
- When: The first Run is `cancelled`, the second Run resolves credentials, the second Run is `cancelled`, and the member reconnects identity A.
- Then: After the first Run ends the second Run still resolves `ChatGPT-Account-ID: identity-a`; after both end, reconnecting identity A yields a new account ID different from the captured one.

## personal-subscription-run-identity-025

- Vitest: "personal subscription run identity > does not resurrect a retained credential when final cancellation races refresh"
- Mode: run
- Given: A Pro member's running Run captured Codex account A; the member reconnected an expired token for identity A and deleted the captured account, and the upstream token refresh is held in flight.
- When: The Run's firewall requests credentials (triggering refresh), the member cancels the Run while the refresh is held, then the refresh completes; the firewall requests credentials again and the member reconnects identity A.
- Then: The Run reads `cancelled`, the later credential request is refused with a non-200 status (400, 403 or 424), and reconnecting identity A yields an account ID different from the captured one.

## personal-subscription-run-identity-026

- Vitest: "exact subscription selection > preserves the requested model and lazy exact claude-code-oauth-token authentication"
- Mode: run
- Given: A Pro member connected a `claude-code-oauth-token` subscription and prefers `claude-opus-5-5`.
- When: The member sends and launches a chat Run with model `claude-opus-5-5`, reads `GET /api/logs/:id`, reads the Runner execution, switches the preference back to `claude-sonnet-5-5`, reads the log again, and the Run's firewall resolves its credentials.
- Then: The log shows selected model, runtime provider `claude-code-oauth-token` and runtime model `claude-opus-5-5`. The execution sets `ANTHROPIC_MODEL` to `claude-opus-5-5`, contains no raw token in its environment, and is bound to the connected account. The later log read is unchanged, and the firewall resolves `Authorization: Bearer <connected token>`.

## personal-subscription-run-identity-027

- Vitest: "exact subscription selection > preserves the requested model and lazy exact codex-oauth-token authentication"
- Mode: run
- Given: A Pro member connected a `codex-oauth-token` subscription and prefers `gpt-6-sol`.
- When: The member sends and launches a chat Run with model `gpt-6-sol`, reads `GET /api/logs/:id`, reads the Runner execution, switches the preference back to `gpt-6-astra`, reads the log again, and the Run's firewall resolves its credentials.
- Then: The log shows selected model, runtime provider `codex-oauth-token` and runtime model `gpt-6-sol`. The execution sets `OPENAI_MODEL` to `gpt-6-sol`, contains no raw token in its environment, and is bound to the connected account. The later log read is unchanged, and the firewall resolves `Authorization: Bearer <connected token>` with `ChatGPT-Account-ID: identity-a`.

## personal-subscription-run-identity-028

- Vitest: "keeps a Claude identity shared after a type-wide disconnect and reconnect"
- Mode: run
- Given: A Pro member's running Run captured Claude account A.
- When: The member removes the provider type via `DELETE /api/me/model-providers/claude-code-oauth-token`, reconnects identity A, and the Run resolves its credentials via `POST /api/webhooks/run/firewall/auth`.
- Then: The reconnect returns the captured account ID, and the Run resolves `Authorization: Bearer <reconnected token>`.

## personal-subscription-run-identity-029

- Vitest: "personal priority connection boundaries > lists and runs personal claude-code-oauth-token, then removes it after disconnection"
- Mode: run
- Given: A Pro member connected a `claude-code-oauth-token` subscription and selected `claude-sonnet-5-5`.
- When: The member lists `GET /api/run-models`, runs a chat Run and resolves its credentials, cancels it, removes the provider type, lists run models again, and creates a thread with `claude-sonnet-5-5`.
- Then: The model is listed as member-effective via `claude-code-oauth-token` with `member` scope, and the Run resolves `Authorization: Bearer <connected token>`. After removal the model is no longer listed and the thread creation returns HTTP 400.

## personal-subscription-run-identity-030

- Vitest: "personal priority connection boundaries > lists and runs personal codex-oauth-token, then removes it after disconnection"
- Mode: run
- Given: A Pro member connected a `codex-oauth-token` subscription and selected `gpt-6-astra`.
- When: The member lists `GET /api/run-models`, runs a chat Run and resolves its credentials, cancels it, removes the provider type, lists run models again, and creates a thread with `gpt-6-astra`.
- Then: The model is listed as member-effective via `codex-oauth-token` with `member` scope, and the Run resolves `Authorization: Bearer <connected token>`. After removal the model is no longer listed and the thread creation returns HTTP 400.

## personal-subscription-run-identity-031

- Vitest: "member-effective model contract > keeps fixed Auto common and personal model visibility scoped to the member"
- Mode: run
- Given: A Pro owner connected a Claude subscription (`claude-sonnet-5-5`), and an onboarded member of the same workspace has no subscription.
- When: Both list `GET /api/run-models`; the member connects a Codex subscription and lists again; the owner lists again.
- Then: Both see an identical `auto` entry labelled `Auto`. The owner sees `claude-sonnet-5-5` via `claude-code-oauth-token` with `member` scope and `accountSelection: capture_required`, which the member does not see. After connecting, the member sees `gpt-6-astra` via `codex-oauth-token` with `member` scope but still not the owner's model; the owner does not see `gpt-6-astra` and their Claude entry is unchanged.

## personal-subscription-run-identity-032

- Vitest: "member-effective model contract > requires the configured claude-code-oauth-token subscription"
- Mode: run
- Given: A Pro member who selected `claude-sonnet-5-5` has removed their `claude-code-oauth-token` provider.
- When: The member sends `POST /api/chat/events` with model `claude-sonnet-5-5`, and lists `GET /api/run-models`.
- Then: The send returns HTTP 201 but no Run is created; the thread gets an `input.rejected` event with error `conflict` and an `output.error` mentioning a subscription. The run models list only `auto`.

## personal-subscription-run-identity-033

- Vitest: "member-effective model contract > requires the configured codex-oauth-token subscription"
- Mode: run
- Given: A Pro member who selected `gpt-6-astra` has removed their `codex-oauth-token` provider.
- When: The member sends `POST /api/chat/events` with model `gpt-6-astra`, and lists `GET /api/run-models`.
- Then: The send returns HTTP 201 but no Run is created; the thread gets an `input.rejected` event with error `conflict` and an `output.error` mentioning a subscription. The run models list only `auto`.

## personal-subscription-run-identity-034

- Vitest: "personal effective provider entitlement > rejects a suspended entitlement even with org credits and a supported subscription"
- Mode: run
- Given: A Pro member with a connected Claude subscription has workspace credits from the paid Pro invoice, and a Stripe webhook has since marked the Pro subscription `canceled`.
- When: The member sends `POST /api/chat/events` with model `claude-sonnet-5-5` and lists `GET /api/run-models`.
- Then: No Run is created and an `input.rejected` event is appended. The model's member-effective entry shows `claude-code-oauth-token`, `member` scope and availability `plan_restricted`.

## personal-subscription-run-identity-035

- Vitest: "subscription bundle decryption ownership > preserves exact authority when reconnect commits during delayed bundle decrypts"
- Mode: run
- Given: A Pro member's running Run is bound to Codex account A, and the server's credential bundle decryption is held while the Run's firewall resolves credentials (row `reconnect`).
- When: While `POST /api/webhooks/run/firewall/auth` is held in decryption, the member reconnects identity A via `POST /api/me/model-providers`; then decryption is released and the Run resolves credentials again.
- Then: No decryptions remain in flight. The held request returns HTTP 200 with `ChatGPT-Account-ID: identity-a` and either the original or the reconnected token, and the later request returns HTTP 200 with the reconnected token and `ChatGPT-Account-ID: identity-a`.

## personal-subscription-run-identity-036

- Vitest: "subscription bundle decryption ownership > preserves exact authority when activation commits during delayed bundle decrypts"
- Mode: run
- Given: A Pro member's running Run is bound to Codex account A, the member also added account B through device auth, and credential bundle decryption is held while the Run's firewall resolves credentials (row `activation`).
- When: While `POST /api/webhooks/run/firewall/auth` is held, the member activates account B via `POST /api/me/model-provider-accounts/<B>/activate`; then decryption is released, the Run resolves again, and the member starts a new Run.
- Then: No decryptions remain in flight. Both of the first Run's requests return HTTP 200 with the original token and `ChatGPT-Account-ID: identity-a`. The new Run is bound to account B and resolves `ChatGPT-Account-ID: identity-b`.

## personal-subscription-run-identity-037

- Vitest: "subscription bundle decryption ownership > preserves exact authority when disconnect commits during delayed bundle decrypts"
- Mode: run
- Given: A Pro member's running Run is bound to Codex account A, and credential bundle decryption is held while the Run's firewall resolves credentials (row `disconnect`).
- When: While `POST /api/webhooks/run/firewall/auth` is held, the member deletes account A via `DELETE /api/me/model-provider-accounts/:id`; then decryption is released and the Run resolves again.
- Then: No decryptions remain in flight. Both requests return HTTP 200 with the original token and `ChatGPT-Account-ID: identity-a`.

## personal-subscription-run-identity-038

- Vitest: "subscription bundle decryption ownership > preserves exact authority when membership commits during delayed bundle decrypts"
- Mode: run
- Given: A Pro member's running Run is bound to Codex account A, and credential bundle decryption is held while the Run's firewall resolves credentials (row `membership`).
- When: While `POST /api/webhooks/run/firewall/auth` is held, Clerk delivers a signed `organizationMembership.deleted` webhook for the member; then decryption is released and the Run requests credentials again.
- Then: No decryptions remain in flight. If the held request succeeds it carries the original token with `ChatGPT-Account-ID: identity-a`. The later request is refused with a non-200 status (400, 401, 403 or 424).

## personal-subscription-run-identity-039

- Vitest: "subscription bundle decryption ownership > preserves exact authority when final-cancel commits during delayed bundle decrypts"
- Mode: run
- Given: A Pro member's running Run is bound to Codex account A, the member already deleted account A, and credential bundle decryption is held while the Run's firewall resolves credentials (row `final-cancel`).
- When: While `POST /api/webhooks/run/firewall/auth` is held, the member cancels the Run; then decryption is released, the Run requests credentials again, and the member reconnects identity A.
- Then: No decryptions remain in flight. If the held request succeeds it carries the original token with `ChatGPT-Account-ID: identity-a`. The later request is refused with a non-200 status (400, 401, 403 or 424), and reconnecting identity A yields a new account ID.

## personal-subscription-run-identity-040

- Vitest: "personal priority credential and session boundaries > keeps a selected subscription personal when credential decryption fails"
- Mode: run
- Given: A Pro member's running Run is bound to a connected Codex account, and the key management service fails every credential decryption.
- When: The member lists `GET /api/run-models`; the Run's firewall requests credentials via `POST /api/webhooks/run/firewall/auth`; the member reads the Run and billing status.
- Then: The model is listed as member-effective via `codex-oauth-token` with `member` scope without any decryption. The credential request returns HTTP 502 with code `TOKEN_ACCESS_RESOLUTION_FAILED` and connectors `["codex-oauth-token"]` after attempting decryption. The execution has no billable firewalls, the Run source stays `member` scope on the connected account, and billing credits are unchanged.

## personal-subscription-run-identity-041

- Vitest: "personal priority credential and session boundaries > preserves a Codex session across account changes and resolves uncreated queued messages at promotion"
- Mode: run
- Given: A Pro member's chat Run on Codex account A is running, a follow-up message is queued on the same thread, the member connects identity B as the active account, and the first Run's session history is stored.
- When: The first Run completes, the queued message is promoted to a new Run, and the new Run's firewall resolves its credentials.
- Then: The first execution was bound to account A and the promoted Run's execution to account B, resolving `Authorization: Bearer <B token>`. The promoted execution uses the `codex` agent and continues native session `subscription-<first run ID>`.
