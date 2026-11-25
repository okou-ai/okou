# me-model-provider-accounts-activate

## me-model-provider-accounts-activate-001

- Vitest: "POST /api/me/model-provider-accounts/:id/activate > switches codex accounts and preserves the other subscription type"
- Mode: run
- Given: A signed-in member connected two Codex subscription accounts and one Claude account through the device authorization flows; the first Codex account is active and the second is not. The clock is 2026-10-09T14:00Z.
- When: The member calls `POST /api/me/model-provider-accounts/:id/activate` for the second Codex account, lists `GET /api/me/model-providers`, then activates the first Codex account again.
- Then: The activation returns the second account with `isActive` true and `updatedAt` at the clock time. The list shows the first Codex account inactive with the same `updatedAt`, the second active and the Claude account still active. After reactivating the first, the active accounts are the first Codex account and the Claude account.

## me-model-provider-accounts-activate-002

- Vitest: "POST /api/me/model-provider-accounts/:id/activate > switches claude accounts and preserves the other subscription type"
- Mode: run
- Given: A signed-in member connected two Claude subscription accounts and one Codex account through the device authorization flows; the first Claude account is active and the second is not. The clock is 2026-10-09T14:00Z.
- When: The member calls `POST /api/me/model-provider-accounts/:id/activate` for the second Claude account, lists `GET /api/me/model-providers`, then activates the first Claude account again.
- Then: The activation returns the second account with `isActive` true and `updatedAt` at the clock time. The list shows the first Claude account inactive with the same `updatedAt`, the second active and the Codex account still active. After reactivating the first, the active accounts are the first Claude account and the Codex account.

## me-model-provider-accounts-activate-003

- Vitest: "POST /api/me/model-provider-accounts/:id/activate > activates the same sole account repeatedly with nullable metadata"
- Mode: run
- Given: A signed-in member connected a single Claude Code OAuth token while Anthropic's profile endpoint returns HTTP 503, so the account has no profile metadata.
- When: The member calls `POST /api/me/model-provider-accounts/:id/activate` for that account at 14:00 and again at 14:01.
- Then: Each response returns the same account and provider IDs, the original `createdAt`, `updatedAt` at the request time, `isActive` true, and null email, workspace name, plan type, reset period, next reset and refresh error. The member still has exactly one account.

## me-model-provider-accounts-activate-004

- Vitest: "POST /api/me/model-provider-accounts/:id/activate > rejects logical-provider, foreign-user and foreign-org IDs without switching"
- Mode: run
- Given: A signed-in member has two Codex accounts, with the first active. Another user in the same organization and the same user in another organization also exist.
- When: The owner activates using the logical provider ID, the other user activates the owner's second account, and the same user in the other organization activates the second account, each via `POST /api/me/model-provider-accounts/:id/activate`.
- Then: Each request returns HTTP 404 `NOT_FOUND`, and after each the owner's only active account is still the first.

## me-model-provider-accounts-activate-005

- Vitest: "POST /api/me/model-provider-accounts/:id/activate > rejects a disconnected account without changing the active sibling"
- Mode: run
- Given: A signed-in member has two Codex accounts and has disconnected the second.
- When: The member calls `POST /api/me/model-provider-accounts/:id/activate` for the disconnected account.
- Then: The response is HTTP 404, and the account list contains only the first account, still active.

## me-model-provider-accounts-activate-006

- Vitest: "POST /api/me/model-provider-accounts/:id/activate > promotes the oldest connected codex sibling when the active account is disconnected"
- Mode: run
- Given: A signed-in member connected three Codex accounts; the first is active.
- When: The member disconnects the first account, tries to activate it, disconnects the third, disconnects the second, and connects a new Codex account.
- Then: After the first disconnect, the second account is active and the third inactive. Activating the disconnected account returns HTTP 404. After the further disconnects only the second remains active, then the list is empty. The new account is active and has a different provider ID than the first.

## me-model-provider-accounts-activate-007

- Vitest: "POST /api/me/model-provider-accounts/:id/activate > promotes the oldest connected claude sibling when the active account is disconnected"
- Mode: run
- Given: A signed-in member connected three Claude accounts; the first is active.
- When: The member disconnects the first account, tries to activate it, disconnects the third, disconnects the second, and connects a new Claude account.
- Then: After the first disconnect, the second account is active and the third inactive. Activating the disconnected account returns HTTP 404. After the further disconnects only the second remains active, then the list is empty. The new account is active and has a different provider ID than the first.

## me-model-provider-accounts-activate-008

- Vitest: "POST /api/me/model-provider-accounts/:id/activate > keeps one active account after competing switches and permits a subsequent save"
- Mode: run
- Given: A signed-in member connected three Codex accounts.
- When: The member activates the second and third accounts concurrently via `POST /api/me/model-provider-accounts/:id/activate`, then activates the second again.
- Then: The concurrent requests return HTTP 200 or 409, at least one 200. Exactly one account is active, either the second or the third. After the later activation, only the second account is active.

## me-model-provider-accounts-activate-009

- Vitest: "POST /api/me/model-provider-accounts/:id/activate > does not resurrect a disconnected target during a competing switch"
- Mode: run
- Given: A signed-in member connected two Codex accounts; the first is active.
- When: The member activates the second account while concurrently deleting it with `DELETE /api/me/model-provider-accounts/:id`, then tries to activate it again and activates the first.
- Then: The activation returns 200, 404 or 409 and the delete returns HTTP 204. The deleted account is not listed, at most one account is active, the reactivation of the deleted account returns HTTP 404, and activating the first succeeds.

## me-model-provider-accounts-activate-010

- Vitest: "POST /api/me/model-provider-accounts/:id/activate > does not resurrect a disconnected sibling during a competing switch"
- Mode: run
- Given: A signed-in member connected two Codex accounts; the first is active.
- When: The member activates the second account while concurrently deleting the first with `DELETE /api/me/model-provider-accounts/:id`, then tries to activate the first and activates the second.
- Then: The activation returns 200, 404 or 409 and the delete returns HTTP 204. The first account is not listed, at most one account is active, activating the deleted first account returns HTTP 404, and activating the second succeeds.

## me-model-provider-accounts-activate-011

- Vitest: "POST /api/me/model-provider-accounts/:id/activate > preserves a concurrent new connection while switching existing accounts"
- Mode: run
- Given: A signed-in member connected two Codex accounts.
- When: The member activates the second account via `POST /api/me/model-provider-accounts/:id/activate` while concurrently connecting a third Codex account, then activates the second again.
- Then: The member has three accounts with exactly one active, and the final activation succeeds.
