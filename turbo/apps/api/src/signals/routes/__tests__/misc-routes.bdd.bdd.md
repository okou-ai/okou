# misc-routes.bdd

## misc-routes.bdd-001

- Vitest: "MISC-02: preferences, push subscription, user export, and empty logs > keeps reporting the retired chat resources preference as false"
- Mode: run
- Given: A signed-in workspace administrator.
- When: The administrator updates `POST /api/user-preferences` with timezone `UTC`, locale `en-US` and theme `dark`, then reads `GET /api/user-preferences`.
- Then: Both the update response and the reread return `chatResourcesEnabledByDefault: false` and theme `dark`.

## misc-routes.bdd-002

- Vitest: "MISC-02: preferences, push subscription, user export, and empty logs > chains visible user-scoped reads and writes without hidden fixtures"
- Mode: run
- Given: A signed-in workspace administrator with no initialized preferences, a user without an organization, and a correctly signed email unsubscribe token for some user; the app URL is `https://app.okou.ai`.
- When: The administrator reads and updates preferences (`GET`/`POST /api/user-preferences`), registers a push subscription (`POST /api/push-subscriptions`), reads `GET /api/user/export`, and lists `GET /api/logs`; the user without an organization calls `POST /api/user/export`; anonymous callers hit `GET` and `POST /api/email/unsubscribe` without a token, with an invalid token, and with the valid token.
- Then: The first preferences read returns HTTP 409 `USER_PREFERENCES_UNINITIALIZED`; the update returns HTTP 200 echoing timezone, locale, send mode `cmd-enter`, cloud browser default false, theme `dark`, color theme `golden-hour` and 3 remaining network-body captures, and the reread matches exactly. Push registration returns HTTP 201 `{ success: true }`, the export status is HTTP 200 with `job: null` and `canExport: true`, and the no-organization export start returns HTTP 401 with an API error. Missing tokens return HTTP 400 `Missing token`, invalid tokens HTTP 400 `Invalid token`, the valid GET redirects (302) to `https://app.okou.ai/email/unsubscribe?token=<token>`, the valid POST returns `{ unsubscribed: true }`, and the logs list is empty.

## misc-routes.bdd-003

- Vitest: "MISC-02: preferences, push subscription, user export, and empty logs > reads and writes every supported locale through the canonical contract"
- Mode: run
- Given: A signed-in workspace administrator with initialized preferences (UTC, `en-US`).
- When: For each supported locale (`en-US`, `pt-BR`, `ja-JP`, `ko-KR`, `id-ID`, `de-DE`, `es-ES`, `it-IT`, `fr-FR`, `hi-IN`, `zh-Hans`, `zh-Hant`) the administrator reads `GET /api/user-preferences` and then sets that locale through `POST /api/user-preferences`.
- Then: Every read lists exactly those twelve supported locales in order, every update returns the chosen locale with the same supported list, and the final read returns locale `zh-Hant`.

## misc-routes.bdd-004

- Vitest: "MISC-03: workflows lifecycle through public API > chains create, list, read, update, delete, and post-delete read"
- Mode: run
- Given: An onboarded administrator and member share a provisioned workspace.
- When: The member creates a workflow via `POST /api/workflows`; the administrator lists `GET /api/workflows`, attempts a create that supplies a reserved `SKILL.md` file, creates a workflow, lists, reads `GET /api/workflows/:workflowId`, updates it with `PATCH`, deletes it with `DELETE`, and reads it again.
- Then: The member's workflow is created (201) as `private`, owned by the member with `canManage: true`, and does not appear in the administrator's list. The reserved-file create returns HTTP 400 with an API error. The administrator's create returns 201 with display name `BDD Workflow` and the given description, appears in the list, reads back the original instruction, updates to the new instruction, deletes with HTTP 204, and the post-delete read returns HTTP 404 with an API error.

## misc-routes.bdd-005

- Vitest: "MISC-04: available run models, personal subscriptions, and logs > lists the fixed Auto model for both administrators and members"
- Mode: run
- Given: A workspace administrator and a member with no personal model subscription connected.
- When: Each lists `GET /api/run-models`.
- Then: Both see exactly one model, `auto`, whose member-effective provider is `built-in` with `org` credential scope and no model provider ID.

## misc-routes.bdd-006

- Vitest: "MISC-04: available run models, personal subscriptions, and logs > chains personal subscription account create, replace, list, and delete through public API"
- Mode: run
- Given: A signed-in workspace administrator with no personal model providers, and an unauthenticated caller.
- When: The unauthenticated caller lists `GET /api/me/model-providers`; the administrator lists, upserts a `claude-code-oauth-token` provider via `POST /api/me/model-providers`, lists run models, upserts a different token of the same type, lists again, deletes with `DELETE /api/me/model-providers/claude-code-oauth-token`, and lists providers and run models again.
- Then: The unauthenticated list returns HTTP 401 with an API error and the initial list is empty. The first upsert returns 201 with `created: true`, an active provider with a model provider ID and no secret, and run models then include `claude-sonnet-5-5` effective via `claude-code-oauth-token` with `member` scope. The replacement returns 201 with the same model provider ID but a new account ID, and the list holds exactly that one active account. Delete returns 204, the provider list is empty, and run models return only `auto`.
