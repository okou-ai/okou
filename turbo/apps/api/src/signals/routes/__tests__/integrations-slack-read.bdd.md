# integrations-slack-read

## integrations-slack-read-001

- Vitest: "Slack bot channel discovery and history > keeps successive read requests scoped to their user and organization"
- Mode: run
- Given: Workspace A's admin installed Slack workspace A; a regular member of A has not connected Slack yet; another organization's admin installed Slack workspace B; a fourth user's organization has no Slack installation. Slack reports channel `C001` "general" as shared for any user. Callers use signed-in sessions.
- When: The callers request `GET /api/integrations/slack/channels` with `limit=10` in turn: admin A, the unconnected member, the member after connecting a Slack user to workspace A, admin B, the uninstalled user, and admin A again.
- Then: Admin A receives exactly one public, member channel `C001` with channel URL `https://slack.com/app_redirect?team=<A>&channel=C001` and null `nextCursor`. The unconnected member and the uninstalled user receive HTTP 404 with `NOT_FOUND` and the message "Your Slack account is not connected to this organization. Connect it from Settings > Slack before reading conversations." The connected member sees workspace A's result and admin B sees `C001` with team B's URL. Slack is called exactly four times, in order, with A's bot token for A's installer, A's bot token for the member's Slack user, B's bot token for B's installer, and A's bot token for A's installer.

## integrations-slack-read-002

- Vitest: "Slack bot channel discovery and history > lists only channels shared by the connected Slack user and bot"
- Mode: run
- Given: A workspace admin's organization has Slack installed with its own bot token, and the admin has connected their Slack user; the caller uses a run's Okou token. Slack returns public `C123` "general" and private `C456` "private" with next cursor `next-page`.
- When: The caller requests `GET /api/integrations/slack/channels` with `limit=20` and `cursor=previous-page`.
- Then: Slack is called with the installation's bot token and exactly `limit=20`, `cursor=previous-page`, `user=<connected Slack user>`, `types=public_channel,private_channel` and `exclude_archived=true`. The response is exactly both channels with `isPrivate` flags, `isMember: true` and `app_redirect` channel URLs for the workspace, plus `nextCursor` "next-page".

## integrations-slack-read-003

- Vitest: "Slack bot channel discovery and history > preserves continuation for an empty channel page"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token; Slack returns an empty channel page with next cursor `more-channels`.
- When: The caller requests `GET /api/integrations/slack/channels` with `limit=10`.
- Then: The response is HTTP 200 with exactly `{ channels: [], nextCursor: "more-channels" }`.

## integrations-slack-read-004

- Vitest: "Slack bot channel discovery and history > authorizes shared conversation C123 before reading one history page"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. Slack reports `C123` as shared with the connected user and returns one threaded message with a file, `has_more: true` and next cursor `next+page=`.
- When: The caller requests `GET /api/integrations/slack/history` for `C123` with `limit=15`, `oldest`, `latest` and `cursor=previous+page=`.
- Then: The membership check queries exactly the connected Slack user, `types=public_channel,private_channel` and `limit=200`. History is fetched with the bot token and exactly the channel, limit 15, oldest, latest and cursor. The response contains the channel, the Slack messages, `hasMore: true` and `nextCursor` "next+page=".

## integrations-slack-read-005

- Vitest: "Slack bot channel discovery and history > authorizes shared conversation G123 before reading one history page"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. Slack reports `G123` as shared with the connected user and returns one threaded message with a file, `has_more: true` and next cursor `next+page=`.
- When: The caller requests `GET /api/integrations/slack/history` for `G123` with `limit=15`, `oldest`, `latest` and `cursor=previous+page=`.
- Then: The membership check queries exactly the connected Slack user, `types=public_channel,private_channel` and `limit=200`. History is fetched with the bot token and exactly the channel, limit 15, oldest, latest and cursor. The response contains the channel, the Slack messages, `hasMore: true` and `nextCursor` "next+page=".

## integrations-slack-read-006

- Vitest: "Slack bot channel discovery and history > authorizes shared conversation D123 before reading one history page"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. Slack reports DM `D123` as shared with the connected user and returns one threaded message with a file, `has_more: true` and next cursor `next+page=`.
- When: The caller requests `GET /api/integrations/slack/history` for `D123` with `limit=15`, `oldest`, `latest` and `cursor=previous+page=`.
- Then: The membership check queries exactly the connected Slack user, `types=im` and `limit=200`. History is fetched with the bot token and exactly the channel, limit 15, oldest, latest and cursor. The response contains the channel, the Slack messages, `hasMore: true` and `nextCursor` "next+page=".

## integrations-slack-read-007

- Vitest: "Slack bot channel discovery and history > continues shared-membership pagination before reading history"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. Slack's shared-membership list returns `COTHER` on the first page with a next cursor and `CTARGET` on the second page; history for `CTARGET` is empty.
- When: The caller requests `GET /api/integrations/slack/history` for `CTARGET` with `limit=15`.
- Then: The response is HTTP 200 with no messages, and membership is requested with no cursor and then with `membership-page-2`.

## integrations-slack-read-008

- Vitest: "Slack bot channel discovery and history > does not read a bot DM that is not shared with the connected user"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token; Slack reports no shared conversations for the connected user.
- When: The caller requests `GET /api/integrations/slack/history` for `DOTHER`.
- Then: The response is HTTP 404 with error exactly `{ code: "NOT_FOUND", message: "This Slack conversation does not exist or is not shared by your connected Slack account and Okou." }`, and history is never requested.

## integrations-slack-read-009

- Vitest: "Slack bot channel discovery and history > returns an actionable channel URL if the bot leaves after authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token; `C123` is shared, but Slack's history call returns `not_in_channel`.
- When: The caller requests `GET /api/integrations/slack/history` for `C123`.
- Then: The response is HTTP 403 with error code `BOT_NOT_IN_CHANNEL`, `channelUrl` `https://slack.com/app_redirect?team=<workspace>&channel=C123`, and a message mentioning "Agents & apps" and "then retry".

## integrations-slack-read-010

- Vitest: "Slack bot channel discovery and history > does not claim an inaccessible channel is known to exist"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token; `C123` is shared, but Slack's history call returns `channel_not_found`.
- When: The caller requests `GET /api/integrations/slack/history` for `C123`.
- Then: The response is HTTP 404 with error code `SLACK_CHANNEL_NOT_FOUND` and a message containing "does not exist or is not accessible".

## integrations-slack-read-011

- Vitest: "Slack bot channel discovery and history > does not suggest channel invitations for inaccessible DMs (not_in_channel)"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token; DM `D123` is shared, but Slack's history call returns `not_in_channel`.
- When: The caller requests `GET /api/integrations/slack/history` for `D123`.
- Then: The response is HTTP 404 with a message containing "Only direct messages involving Okou", not mentioning "Agents & apps", and without a `channelUrl`.

## integrations-slack-read-012

- Vitest: "Slack bot channel discovery and history > does not suggest channel invitations for inaccessible DMs (channel_not_found)"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token; DM `D123` is shared, but Slack's history call returns `channel_not_found`.
- When: The caller requests `GET /api/integrations/slack/history` for `D123`.
- Then: The response is HTTP 404 with a message containing "Only direct messages involving Okou", not mentioning "Agents & apps", and without a `channelUrl`.

## integrations-slack-read-013

- Vitest: "Slack bot channel discovery and history > reports a missing scope while checking shared DM membership"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token; Slack's membership check fails with `missing_scope` (needed `im:read`).
- When: The caller requests `GET /api/integrations/slack/history` for `D123`.
- Then: The response is HTTP 403 with error code `SLACK_MISSING_SCOPE` and a message containing "update the Okou app installation".

## integrations-slack-read-014

- Vitest: "Slack bot channel discovery and history > propagates Slack's retry duration instead of retrying in the request"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token; `C123` is shared, but Slack's history call responds with HTTP 429 and `Retry-After: 60`.
- When: The caller requests `GET /api/integrations/slack/history` for `C123`.
- Then: The response is HTTP 429 with header `Retry-After: 60` and error code `SLACK_RATE_LIMITED` with `retryAfterSeconds` 60.

## integrations-slack-read-015

- Vitest: "Slack bot channel discovery and history > does not reuse a Slack installation from another organization"
- Mode: run
- Given: One organization has Slack installed and connected; a different organization has no Slack installation, and its user calls with a run's Okou token.
- When: The second organization's caller requests `GET /api/integrations/slack/history` for `C123`.
- Then: The response is HTTP 404 with a message containing "Your Slack account is not connected to this organization".

## integrations-slack-read-016

- Vitest: "Slack bot thread replies > reads one page in shared conversation C123 using the organization bot"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared with the connected user. Slack's thread replies return the parent message on the first page (with `has_more: false` and next cursor `next+page=`) and a reply with blocks and a file on the second page.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123`, thread `1750000000.000001` and `limit=1`, then again with the returned cursor.
- Then: The first response contains the channel, thread, only the parent message, `hasMore: true` and `nextCursor` "next+page=". The second contains only the reply, `hasMore: false` and null `nextCursor`. Membership is checked with exactly the connected Slack user, `types=public_channel,private_channel` and `limit=200`, and Slack replies are requested exactly twice with the bot token: first with channel, `ts` and `limit=1`, then with `cursor=next+page=` added.

## integrations-slack-read-017

- Vitest: "Slack bot thread replies > reads one page in shared conversation G123 using the organization bot"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `G123` is shared with the connected user. Slack's thread replies return the parent message on the first page (with `has_more: false` and next cursor `next+page=`) and a reply with blocks and a file on the second page.
- When: The caller requests `GET /api/integrations/slack/replies` for `G123`, thread `1750000000.000001` and `limit=1`, then again with the returned cursor.
- Then: The first response contains the channel, thread, only the parent message, `hasMore: true` and `nextCursor` "next+page=". The second contains only the reply, `hasMore: false` and null `nextCursor`. Membership is checked with exactly the connected Slack user, `types=public_channel,private_channel` and `limit=200`, and Slack replies are requested exactly twice with the bot token: first with channel, `ts` and `limit=1`, then with `cursor=next+page=` added.

## integrations-slack-read-018

- Vitest: "Slack bot thread replies > reads one page in shared conversation D123 using the organization bot"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `D123` is shared with the connected user. Slack's thread replies return the parent message on the first page (with `has_more: false` and next cursor `next+page=`) and a reply with blocks and a file on the second page.
- When: The caller requests `GET /api/integrations/slack/replies` for `D123`, thread `1750000000.000001` and `limit=1`, then again with the returned cursor.
- Then: The first response contains the channel, thread, only the parent message, `hasMore: true` and `nextCursor` "next+page=". The second contains only the reply, `hasMore: false` and null `nextCursor`. Membership is checked with exactly the connected Slack user, `types=im` and `limit=200`, and Slack replies are requested exactly twice with the bot token: first with channel, `ts` and `limit=1`, then with `cursor=next+page=` added.

## integrations-slack-read-019

- Vitest: "Slack bot thread replies > keeps time filters and Slack's has_more when a filtered page has no cursor"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack returns an empty replies page with `has_more: true` and no cursor.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`, `oldest`, `latest` and `cursor=previous-page`.
- Then: Slack is queried with exactly the channel, `ts`, limit 15, oldest, latest and cursor. The response has no messages, `hasMore: true` and null `nextCursor`.

## integrations-slack-read-020

- Vitest: "Slack bot thread replies > returns only the parent for a message with no replies"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies return only the parent message.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response contains only the parent message, `hasMore: false` and null `nextCursor`.

## integrations-slack-read-021

- Vitest: "Slack bot thread replies > does not expose a thread in an unshared channel, another user's DM or group DM (COTHER)"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. Across two membership pages Slack reports only `CSHARED` as shared, so `COTHER` is an unshared channel.
- When: The caller requests `GET /api/integrations/slack/replies` for `COTHER`.
- Then: The response is HTTP 404 with a message containing "does not exist or is not shared". Membership is checked for the connected Slack user with `types=public_channel,private_channel`, first without a cursor and then with `page-2`, and replies are never requested.

## integrations-slack-read-022

- Vitest: "Slack bot thread replies > does not expose a thread in an unshared channel, another user's DM or group DM (DOTHER)"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. Across two membership pages Slack reports only `CSHARED` as shared, so `DOTHER` is another user's DM.
- When: The caller requests `GET /api/integrations/slack/replies` for `DOTHER`.
- Then: The response is HTTP 404 with a message containing "does not exist or is not shared". Membership is checked for the connected Slack user with `types=im`, first without a cursor and then with `page-2`, and replies are never requested.

## integrations-slack-read-023

- Vitest: "Slack bot thread replies > does not expose a thread in an unshared channel, another user's DM or group DM (GMPIM)"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. Across two membership pages Slack reports only `CSHARED` as shared, so `GMPIM` is a group DM not shared with the user.
- When: The caller requests `GET /api/integrations/slack/replies` for `GMPIM`.
- Then: The response is HTTP 404 with a message containing "does not exist or is not shared". Membership is checked for the connected Slack user with `types=public_channel,private_channel`, first without a cursor and then with `page-2`, and replies are never requested.

## integrations-slack-read-024

- Vitest: "Slack bot thread replies > enforces the read boundary: Your Slack account is not connected to …"
- Mode: run
- Given: One organization has Slack installed and connected; the caller's own organization has no Slack installation and they use a run's Okou token.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123`.
- Then: The response is HTTP 404 with a message containing "Your Slack account is not connected to this organization".

## integrations-slack-read-025

- Vitest: "Slack bot thread replies > enforces the read boundary: Slack account is not connected"
- Mode: run
- Given: One organization has Slack installed and connected; the caller's organization has Slack installed but the caller has not connected a Slack user, and they use a run's Okou token.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123`.
- Then: The response is HTTP 404 with a message containing "Slack account is not connected".

## integrations-slack-read-026

- Vitest: "Slack bot thread replies > rejects invalid reply queries before reading Slack: {\"oldest\":\"20\",\"latest\":\"10\"}"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `oldest=20` and `latest=10`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-slack-read-027

- Vitest: "Slack bot thread replies > reports Slack thread_not_found without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `thread_not_found`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 404 with error code `SLACK_THREAD_NOT_FOUND`.

## integrations-slack-read-028

- Vitest: "Slack bot thread replies > reports Slack invalid_ts without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `invalid_ts`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-slack-read-029

- Vitest: "Slack bot thread replies > reports Slack invalid_timestamp without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `invalid_timestamp`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-slack-read-030

- Vitest: "Slack bot thread replies > reports Slack invalid_cursor without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `invalid_cursor`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-slack-read-031

- Vitest: "Slack bot thread replies > reports Slack invalid_ts_oldest without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `invalid_ts_oldest`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-slack-read-032

- Vitest: "Slack bot thread replies > reports Slack invalid_ts_latest without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `invalid_ts_latest`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-slack-read-033

- Vitest: "Slack bot thread replies > reports Slack missing_scope without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `missing_scope`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 403 with error code `SLACK_MISSING_SCOPE`.

## integrations-slack-read-034

- Vitest: "Slack bot thread replies > reports Slack not_in_channel without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `not_in_channel`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 403 with error code `BOT_NOT_IN_CHANNEL`.

## integrations-slack-read-035

- Vitest: "Slack bot thread replies > reports Slack channel_not_found without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `channel_not_found`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 404 with error code `SLACK_CHANNEL_NOT_FOUND`.

## integrations-slack-read-036

- Vitest: "Slack bot thread replies > reports Slack no_permission without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `no_permission`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 403 with error code `FORBIDDEN`.

## integrations-slack-read-037

- Vitest: "Slack bot thread replies > reports Slack method_not_supported_for_channel_type without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `method_not_supported_for_channel_type`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-slack-read-038

- Vitest: "Slack bot thread replies > reports Slack service_unavailable without misclassifying it as OAuth authorization"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call fails with `service_unavailable`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123` with `limit=15`.
- Then: The response is HTTP 502 with error code `SLACK_ERROR`.

## integrations-slack-read-039

- Vitest: "Slack bot thread replies > preserves Retry-After without retrying the thread read"
- Mode: run
- Given: A workspace admin with Slack installed and connected uses a run's Okou token. `C123` is shared, and Slack's replies call responds with HTTP 429 and `Retry-After: 60`.
- When: The caller requests `GET /api/integrations/slack/replies` for `C123`.
- Then: The response is HTTP 429 with header `Retry-After: 60` and error code `SLACK_RATE_LIMITED` with `retryAfterSeconds` 60. Slack is called exactly once.
