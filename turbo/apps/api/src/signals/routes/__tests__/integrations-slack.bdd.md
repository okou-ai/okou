# integrations-slack

## integrations-slack-001

- Vitest: "GET /api/integrations/slack > returns isAdmin: true for admin users"
- Mode: run
- Given: An onboarded organization admin installed the Slack app through the OAuth install flow, which connected the admin's Slack user.
- When: The admin, signed in with the `org:admin` role, calls `GET /api/integrations/slack`.
- Then: The response is HTTP 200 with `isAdmin`, `isConnected` and `isInstalled` all true and `workspaceName` "BDD Slack App <team ID>". It includes `scopeMismatch` and `reinstallUrl` and omits `installUrl` and `connectUrl`.

## integrations-slack-002

- Vitest: "GET /api/integrations/slack > returns isAdmin: false for non-admin users"
- Mode: run
- Given: An onboarded organization admin installed the Slack app through the OAuth install flow, which connected the admin's Slack user.
- When: The same user, signed in with the `org:member` role, calls `GET /api/integrations/slack`.
- Then: The response is HTTP 200 with `isAdmin` false and omits `scopeMismatch`, `reinstallUrl`, `installUrl` and `connectUrl`.

## integrations-slack-003

- Vitest: "GET /api/integrations/slack > returns isConnected: false when user has no connection"
- Mode: run
- Given: An organization has the Slack app installed by its admin. Another admin of the same organization has never connected a Slack account.
- When: The unconnected admin, signed in with the `org:admin` role, calls `GET /api/integrations/slack`.
- Then: The response is HTTP 200 with `isConnected` false, `isInstalled` true and `isAdmin` true. It includes `installUrl`, `connectUrl`, `scopeMismatch` and `reinstallUrl` and omits `workspaceName`.

## integrations-slack-004

- Vitest: "GET /api/integrations/slack > returns the connected workspace for a connected user"
- Mode: run
- Given: An organization has the Slack app installed by its admin, and a second member has connected their own Slack user to that workspace through the connect flow.
- When: The second member, signed in with the `org:admin` role, calls `GET /api/integrations/slack`.
- Then: The response is HTTP 200 with `isConnected` and `isInstalled` true and a non-empty `workspaceName`.

## integrations-slack-005

- Vitest: "DELETE /api/integrations/slack > returns 404 when the user has no Slack connection"
- Mode: run
- Given: An organization has the Slack app installed and connected by its admin. A signed-in member of the same organization has never connected Slack.
- When: The member calls `DELETE /api/integrations/slack` with no query parameters.
- Then: The response is HTTP 404 with code `NOT_FOUND` and message "No Slack connection found". The admin's status still reports installed and connected, and no Slack App Home view or realtime notification is published.

## integrations-slack-006

- Vitest: "DELETE /api/integrations/slack > returns 401 for a session that is unauthenticated"
- Mode: run
- Given: The caller is not authenticated.
- When: The caller calls `DELETE /api/integrations/slack` without an authorization header.
- Then: The response is HTTP 401 with code `UNAUTHORIZED`, and no Slack App Home view or realtime notification is published.

## integrations-slack-007

- Vitest: "DELETE /api/integrations/slack > returns 401 for a session that is without an organization"
- Mode: run
- Given: The caller has a valid signed-in session without an active organization.
- When: The caller calls `DELETE /api/integrations/slack` with the session token.
- Then: The response is HTTP 401 with code `UNAUTHORIZED`, and no Slack App Home view or realtime notification is published.

## integrations-slack-008

- Vitest: "DELETE /api/integrations/slack?action=uninstall > returns 403 when a non-admin tries to uninstall"
- Mode: run
- Given: An organization admin installed the Slack app and a non-admin member has connected their Slack user. The member is signed in with the `org:member` role.
- When: The member calls `DELETE /api/integrations/slack?action=uninstall`.
- Then: The response is HTTP 403 with code `FORBIDDEN` and message "Admin access required". Both the admin and the member still see the integration installed and connected, and no Slack App Home view or realtime notification is published.

## integrations-slack-009

- Vitest: "DELETE /api/integrations/slack?action=uninstall > publishes uninstalled App Home while preserving account connections"
- Mode: run
- Given: An organization admin installed the Slack app (connecting their own Slack user) and a member has connected a separate Slack user. The admin is signed in.
- When: The admin calls `DELETE /api/integrations/slack?action=uninstall`, then `DELETE /api/integrations/slack`, and then repeats both requests.
- Then: The uninstall returns HTTP 200 `{ ok: true }` and publishes exactly two App Home views, one per connected Slack user, each containing an "Open Okou Settings" button linking to `<APP_URL>/settings/slack`. Both users then see `isInstalled` false and `isConnected` true, a `slack:changed` realtime notification is published, on each user's `user:<id>` realtime channel. The admin's disconnect returns 200, after which the admin is not connected while the member stays connected. The repeated uninstall returns 404 "No Slack installation found" and the repeated disconnect 404 "No Slack connection found", with no further App Home views or notifications.

## integrations-slack-010

- Vitest: "GET /api/integrations/slack/download-file > selects each request's installation across users in the same organization and restores the first"
- Mode: run
- Given: Two members of one organization are both connected to the same installed Slack workspace. Each request uses a newly launched run's agent token, in the order first member, second member, first member. Slack file info returns a text file on `files.slack.com` and Slack serves that request's bytes.
- When: Each run calls `GET /api/integrations/slack/download-file?file_id=F_GRAPH_<n>`.
- Then: Every response is HTTP 200 with that request's bytes, `content-type` `text/plain`, the matching `content-length`, `x-file-name` `F_GRAPH_<n>.txt` and `x-file-mimetype` `text/plain`. Slack file info is requested once with the shared installation's bot token for that file, and the file is fetched once from its private download URL with the same bot token.

## integrations-slack-011

- Vitest: "GET /api/integrations/slack/download-file > selects each request's installation across organizations and restores the first"
- Mode: run
- Given: Two admins of different organizations each have their own installed and connected Slack workspace. Each request uses a newly launched run's agent token, in the order first admin, second admin, first admin. Slack file info returns a text file on `files.slack.com` and Slack serves that request's bytes.
- When: Each run calls `GET /api/integrations/slack/download-file?file_id=F_GRAPH_<n>`.
- Then: Every response is HTTP 200 with that request's bytes, `content-type` `text/plain`, the matching `content-length`, `x-file-name` `F_GRAPH_<n>.txt` and `x-file-mimetype` `text/plain`. Slack file info is requested once with the requesting organization's own bot token for that file, and the file is fetched once from its private download URL with that same bot token.

## integrations-slack-012

- Vitest: "GET /api/integrations/slack/download-file > selects each request's installation across an uninstalled organization and restores the first"
- Mode: run
- Given: The first admin's organization has an installed and connected Slack workspace; a second admin belongs to another organization without a Slack installation. Each request uses a newly launched run's agent token, in the order first admin, second admin, first admin.
- When: Each run calls `GET /api/integrations/slack/download-file?file_id=F_GRAPH_<n>`.
- Then: The first admin's two requests return HTTP 200 with their bytes and file headers, using the first organization's bot token for one file info request and one file fetch each. The second admin's request returns HTTP 404 `NOT_FOUND` without any Slack file info request or file fetch.

## integrations-slack-013

- Vitest: "GET /api/integrations/slack/download-file > returns 404 when Slack reports file not found"
- Mode: run
- Given: A member connected to the organization's installed Slack workspace calls with a run-scoped agent token, and Slack file info reports `file_not_found`.
- When: The agent calls `GET /api/integrations/slack/download-file?file_id=F-MISSING`.
- Then: The response is HTTP 404 with error code `NOT_FOUND`.

## integrations-slack-014

- Vitest: "GET /api/integrations/slack/download-file > does not download a bot-visible file from another user's private conversation"
- Mode: run
- Given: A member connected to the organization's installed Slack workspace calls with a run-scoped agent token. Slack file info reports the file only in another user's private group `G_OTHER_USER`, not in any channel the caller shares.
- When: The agent calls `GET /api/integrations/slack/download-file?file_id=F-OK`.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and the file bytes are never fetched from Slack.

## integrations-slack-015

- Vitest: "GET /api/integrations/slack/download-file > returns 404 when the Slack file has no downloadable URL"
- Mode: run
- Given: A member connected to the organization's installed Slack workspace calls with a run-scoped agent token. Slack file info returns the file without any private download URL.
- When: The agent calls `GET /api/integrations/slack/download-file?file_id=F1`.
- Then: The response is HTTP 404 with error code `NOT_FOUND`.

## integrations-slack-016

- Vitest: "GET /api/integrations/slack/download-file > returns 400 for disallowed download hostnames"
- Mode: run
- Given: A member connected to the organization's installed Slack workspace calls with a run-scoped agent token. Slack file info reports a download URL on `evil.example.com`, which the Slack file fetch rejects as an invalid URL.
- When: The agent calls `GET /api/integrations/slack/download-file?file_id=F-BAD`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-slack-017

- Vitest: "GET /api/integrations/slack/download-file > returns 413 when file metadata exceeds the 100MB limit"
- Mode: run
- Given: A member connected to the organization's installed Slack workspace calls with a run-scoped agent token. Slack file info reports a 200 MB file.
- When: The agent calls `GET /api/integrations/slack/download-file?file_id=F-BIG`.
- Then: The response is HTTP 413 with error code `PAYLOAD_TOO_LARGE`.

## integrations-slack-018

- Vitest: "GET /api/integrations/slack/download-file > returns 502 when Slack file download fails"
- Mode: run
- Given: A member connected to the organization's installed Slack workspace calls with a run-scoped agent token. Slack file info returns a valid file, but downloading it fails with HTTP 503.
- When: The agent calls `GET /api/integrations/slack/download-file?file_id=F1`.
- Then: The response is HTTP 502 with error code `BAD_GATEWAY`.

## integrations-slack-019

- Vitest: "GET /api/integrations/slack/download-file > returns 502 when Slack returns an HTML response"
- Mode: run
- Given: A member connected to the organization's installed Slack workspace calls with a run-scoped agent token. Slack file info returns a valid file, but the download returns an HTML login page with `content-type` `text/html`.
- When: The agent calls `GET /api/integrations/slack/download-file?file_id=F1`.
- Then: The response is HTTP 502 with error code `BAD_GATEWAY`.

## integrations-slack-020

- Vitest: "GET /api/integrations/slack/download-file > returns 400 when Slack files.info returns a platform error"
- Mode: run
- Given: A member connected to the organization's installed Slack workspace calls with a run-scoped agent token. Slack file info returns the platform error `invalid_auth`.
- When: The agent calls `GET /api/integrations/slack/download-file?file_id=F1`.
- Then: The response is HTTP 400 with error code `SLACK_ERROR`.

## integrations-slack-021

- Vitest: "GET /api/integrations/slack/download-file > streams file bytes from Slack with file metadata headers"
- Mode: run
- Given: A member connected to the organization's installed Slack workspace calls with a run-scoped agent token. Slack file info reports `pic.png` (`image/png`) shared in `C123`, and Slack serves the bytes "real file contents".
- When: The agent calls `GET /api/integrations/slack/download-file?file_id=F-OK`.
- Then: The response is HTTP 200 with `content-type` and `x-file-mimetype` `image/png`, `x-file-name` `pic.png`, a `content-length` equal to the byte count, and a body identical to the Slack bytes.

## integrations-slack-022

- Vitest: "GET /api/integrations/slack/download-file > accepts a Clerk session with an active organization"
- Mode: run
- Given: A member connected to the organization's installed Slack workspace is signed in with a session whose active organization is that organization. Slack file info reports `pic.png` and Slack serves its bytes.
- When: The member calls `GET /api/integrations/slack/download-file?file_id=F-OK` with the session token.
- Then: The response is HTTP 200.
