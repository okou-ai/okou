# run-models

## run-models-001

- Vitest: "available run models > offers canonical Auto to a member without subscriptions"
- Mode: run
- Given: A signed-in workspace member with no personal model subscriptions.
- When: The member requests `GET /api/run-models`.
- Then: The response lists exactly one model: `auto` labelled `Auto`, effective through the `openrouter-codex` runtime with organization credential scope and no model provider ID.

## run-models-002

- Vitest: "available run models > offers a connected personal Claude subscription only to its owner"
- Mode: run
- Given: A signed-in member has connected a personal Claude Code OAuth subscription via `POST /api/me/model-providers`; another member of the same organization exists.
- When: The owner and then the other member request `GET /api/run-models`.
- Then: The owner's list includes a model effective through `claude-code-oauth-token` with member credential scope and subscription effort options. The other member's list is exactly `auto`.

## run-models-003

- Vitest: "available run models > requires authentication"
- Mode: run
- Given: An unauthenticated caller.
- When: The caller requests `GET /api/run-models`.
- Then: The request returns HTTP 401 with code `UNAUTHORIZED`.

## run-models-004

- Vitest: "available run models > returns the selected subscription model to Auto after account disconnection"
- Mode: run
- Given: A signed-in member has connected a personal Claude Code OAuth subscription (HTTP 201) and selected its model in the user model preference.
- When: The member deletes the subscription account with `DELETE /api/me/model-provider-accounts/:id`, then lists `GET /api/run-models` and reads the model preference.
- Then: The preference update returns the subscription model. The deletion returns HTTP 204, the model list becomes exactly `auto`, and the preference reads `selectedModel: auto` with a null service tier.

## run-models-005

- Vitest: "available run models > returns the selected subscription model to Auto after provider disconnection"
- Mode: run
- Given: A signed-in member has connected a personal Claude Code OAuth subscription (HTTP 201) and selected its model in the user model preference.
- When: The member removes the provider with `DELETE /api/me/model-providers/claude-code-oauth-token`, then lists `GET /api/run-models` and reads the model preference.
- Then: The preference update returns the subscription model. The deletion returns HTTP 204, the model list becomes exactly `auto`, and the preference reads `selectedModel: auto` with a null service tier.
