# slack-channels

## slack-channels-001

- Vitest: "GET /api/slack/channels > keeps successive channel requests scoped to their user and organization"
- Mode: run
- Given: Two organizations have installed Slack workspaces A and B, each with its installer connected. A second member of organization A is not yet connected, and a user in another organization has no Slack installation. Slack's `users.conversations` returns channel `C001` `general`.
- When: The members call `GET /api/slack/channels` in turn: A's installer, the unconnected member, the same member after connecting to workspace A, B's installer, the uninstalled user, and A's installer again.
- Then: Connected callers receive HTTP 200 with `{ channels: [{ id: "C001", name: "general" }] }`. The unconnected member and the uninstalled user receive HTTP 404 with "No Slack account connected for this user" and `NOT_FOUND`. Slack receives exactly four requests, each with its own workspace's bot token and the caller's own Slack user ID.

## slack-channels-002

- Vitest: "GET /api/slack/channels > returns 401 when the authenticated session has no organization"
- Mode: run
- Given: An authenticated session has no organization.
- When: The caller requests `GET /api/slack/channels`.
- Then: The response is HTTP 401 with `{ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }`.

## slack-channels-003

- Vitest: "GET /api/slack/channels > returns channels shared by the connected user and bot"
- Mode: run
- Given: A signed-in member installed a Slack workspace as its installer, and Slack's `users.conversations` returns `general`, `random` and private `alpha`.
- When: The member requests `GET /api/slack/channels`.
- Then: Slack is queried with `limit` 200, the installer's Slack user ID, `types` `public_channel,private_channel` and `exclude_archived` true. The response is HTTP 200 with channels `alpha`, `general`, `random` sorted by name, each with only ID and name.

## slack-channels-004

- Vitest: "GET /api/slack/channels > handles pagination across multiple pages"
- Mode: run
- Given: A signed-in member installed a Slack workspace, and Slack's `users.conversations` returns `page-one` with a next cursor and then `page-two` with no cursor.
- When: The member requests `GET /api/slack/channels`.
- Then: The response is HTTP 200 with channels `page-one` (`C001`) and `page-two` (`C002`), after exactly two Slack requests.

## slack-channels-005

- Vitest: "GET /api/slack/channels > returns an empty array when the user and bot share no channels"
- Mode: run
- Given: A signed-in member installed a Slack workspace, and Slack's `users.conversations` returns no channels.
- When: The member requests `GET /api/slack/channels`.
- Then: The response is HTTP 200 with `{ channels: [] }`.
