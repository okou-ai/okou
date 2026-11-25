# integrations-slack-status

## integrations-slack-status-001

- Vitest: "GET /api/integrations/slack > returns 401 when the authenticated session has no organization"
- Mode: run
- Given: A signed-in session has no active organization.
- When: The caller requests `GET /api/integrations/slack`.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## integrations-slack-status-002

- Vitest: "GET /api/integrations/slack > keeps successive status requests scoped to their user and organization"
- Mode: run
- Given: An organization admin installed Slack workspace `T_<id>` ("Workspace T_<id>") through OAuth and is connected; a regular member of the same organization is not connected; the admin also belongs to another organization without Slack.
- When: The admin, the member, the admin in the other organization, and the admin back in the original organization request `GET /api/integrations/slack` in turn (via two different API hosts); the member follows the returned connect URL to `GET /api/slack/oauth/connect`.
- Then: The admin's status is exactly `isConnected: true`, `isInstalled: true`, `isAdmin: true`, the workspace name, `scopeMismatch: false` and `reinstallUrl: null`. The member's status is exactly not connected, installed, not admin, `installUrl: null` and a `connectUrl` at `https://api.okou.ai/api/slack/oauth/connect`, which redirects (HTTP 307) to Slack authorization with a `user_scope` including `users:read`. In the other organization the admin sees not connected, not installed, admin, with an `installUrl` at `https://api.okou.ai/api/slack/oauth/install` and a connect URL. The final read equals the first admin status.

## integrations-slack-status-003

- Vitest: "GET /api/integrations/slack > returns null OAuth URLs when OAuth is disabled after installation"
- Mode: run
- Given: An organization has Slack installed with only the `chat:write` bot scope, and the Slack OAuth client ID is then removed from configuration. The caller is an admin who has not connected Slack.
- When: The admin requests `GET /api/integrations/slack` in the installed organization and again in another organization without Slack.
- Then: The installed status is exactly not connected, installed, admin, `installUrl: null`, `connectUrl: null`, `scopeMismatch: true` and `reinstallUrl: null`. The uninstalled status is exactly not connected, not installed, admin, `installUrl: null` and `connectUrl: null`.

## integrations-slack-status-004

- Vitest: "GET /api/integrations/slack > returns isConnected=false when user has no connection"
- Mode: run
- Given: An organization has Slack installed, and the signed-in user has no Slack connection.
- When: The user requests `GET /api/integrations/slack` and follows the returned connect URL to `GET /api/slack/oauth/connect`.
- Then: The status reports `isConnected` false with a connect URL at `https://api.okou.ai/api/slack/oauth/connect`. The connect route redirects (HTTP 307) to `https://slack.com/oauth/v2/authorize` with a `user_scope` that includes `users:read`.

## integrations-slack-status-005

- Vitest: "GET /api/integrations/slack > returns Okou install URLs on the API origin when Slack is not installed"
- Mode: run
- Given: A signed-in organization admin's organization has no Slack installation.
- When: The admin requests `GET /api/integrations/slack` and follows the returned install URL to `GET /api/slack/oauth/install`.
- Then: The install URL is at `https://api.okou.ai/api/slack/oauth/install`. The install route redirects (HTTP 307) to `https://slack.com/oauth/v2/authorize` with both `scope` and `user_scope` parameters.

## integrations-slack-status-006

- Vitest: "GET /api/integrations/slack > returns Okou install URLs on the Okou API origin"
- Mode: run
- Given: A signed-in organization admin's organization has no Slack installation, and the request is served on the `https://api.okou.ai` origin.
- When: The admin requests `GET /api/integrations/slack`.
- Then: The install URL is at `https://api.okou.ai/api/slack/oauth/install`.

## integrations-slack-status-007

- Vitest: "GET /api/integrations/slack > returns Okou connect URLs on the Okou API origin"
- Mode: run
- Given: An organization has Slack installed through OAuth by another user; the signed-in user is not connected, and the request is served on the `https://api.okou.ai` origin.
- When: The user requests `GET /api/integrations/slack`.
- Then: The connect URL is at `https://api.okou.ai/api/slack/oauth/connect`.

## integrations-slack-status-008

- Vitest: "GET /api/integrations/slack > returns scopeMismatch=true when installation is missing scopes"
- Mode: run
- Given: An organization has Slack installed with only `chat:write,channels:read` bot scopes, and the signed-in admin has connected their Slack user.
- When: The admin requests `GET /api/integrations/slack` and follows the returned reinstall URL to `GET /api/slack/oauth/install`.
- Then: The status reports `scopeMismatch` true with a reinstall URL at `https://api.okou.ai/api/slack/oauth/install`. The install route redirects to Slack authorization with `team` set to the installed workspace and both `scope` and `user_scope` parameters.

## integrations-slack-status-009

- Vitest: "GET /api/integrations/slack > returns Okou reinstall URLs on the Okou API origin"
- Mode: run
- Given: An organization admin installed Slack through OAuth with only the `chat:write` bot scope, and the request is served on the `https://api.okou.ai` origin.
- When: The admin requests `GET /api/integrations/slack` and follows the returned reinstall URL to `GET /api/slack/oauth/install`.
- Then: The reinstall URL is at `https://api.okou.ai/api/slack/oauth/install`. The install route redirects to Slack authorization with `team` set to the installed workspace and both `scope` and `user_scope` parameters.

## integrations-slack-status-010

- Vitest: "GET /api/integrations/slack > treats null bot_scopes as mismatch (requires reinstall)"
- Mode: run
- Given: An organization has a Slack installation with no recorded bot scopes, and the signed-in admin has connected their Slack user.
- When: The admin requests `GET /api/integrations/slack`.
- Then: The status reports `scopeMismatch` true.

## integrations-slack-status-011

- Vitest: "GET /api/integrations/slack > does not expose scopeMismatch to non-admin users"
- Mode: run
- Given: An organization has Slack installed with only the `chat:write` bot scope, and a signed-in regular member has connected their Slack user.
- When: The member requests `GET /api/integrations/slack`.
- Then: The status has neither `scopeMismatch` nor `reinstallUrl`.

## integrations-slack-status-012

- Vitest: "GET /api/integrations/slack > returns scopeMismatch for admin when user is not connected"
- Mode: run
- Given: An organization has Slack installed with only the `chat:write` bot scope, and the signed-in admin has no Slack connection.
- When: The admin requests `GET /api/integrations/slack` and follows the returned reinstall URL to `GET /api/slack/oauth/install`.
- Then: The status reports `isConnected` false and `scopeMismatch` true. The install route redirects to Slack authorization with `team` set to the installed workspace and both `scope` and `user_scope` parameters.
