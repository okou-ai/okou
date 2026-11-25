# teams-connect

## teams-connect-001

- Vitest: "GET /api/integrations/teams/connect > returns 401 when the request is unauthenticated"
- Mode: run
- Given: The Teams integration is configured and the caller has no session.
- When: The caller requests `GET /api/integrations/teams/connect`.
- Then: The response is HTTP 401 with code `UNAUTHORIZED` and message `Not authenticated`.

## teams-connect-002

- Vitest: "GET /api/integrations/teams/connect > returns independent account and installation actions without a Teams installation"
- Mode: run
- Given: A signed-in workspace admin has neither installed Teams nor linked a Teams account, and the API origin is configured.
- When: The admin requests `GET /api/integrations/teams/connect`.
- Then: HTTP 200 reports workspace identity enabled, no installation or connection, no linked accounts or pending installation, and admin privileges. Separate install and connect actions both point to the API origin's Teams OAuth endpoint with a Teams start state.

## teams-connect-003

- Vitest: "GET /api/integrations/teams/connect > uses the web origin when the API backend URL is unset"
- Mode: run
- Given: A workspace admin is signed in and the API backend origin is unset. The web origin is configured.
- When: The admin requests the Teams connection status.
- Then: HTTP 200 includes a connect link on the web origin at `/api/teams/oauth/connect` with a Teams start state.

## teams-connect-004

- Vitest: "GET /api/integrations/teams/connect > returns installed but disconnected status for an unlinked user"
- Mode: run
- Given: Teams is installed and a different member is already linked in the caller's workspace. The signed-in caller is an unlinked nonadmin member.
- When: The caller requests the Teams connection status.
- Then: HTTP 200 reports installed but disconnected, no admin privileges, no linked accounts, a connect URL, and no install URL.

## teams-connect-005

- Vitest: "GET /api/integrations/teams/connect > returns a Teams reinstall URL to admins when the installed app id is stale"
- Mode: run
- Given: The signed-in workspace admin is connected, but the installed Teams app ID is stale.
- When: The admin requests the Teams connection status.
- Then: HTTP 200 reports the account remains connected, flags `permissionMismatch: true`, and gives a Microsoft Teams app reinstall URL.

## teams-connect-006

- Vitest: "GET /api/integrations/teams/connect > keeps status identity isolated across users and organizations"
- Mode: run
- Given: A user linked a Microsoft Entra identity in one Teams-enabled organization and can sign in to another organization as the same user.
- When: The user gets Teams status in the original organization, changes the active organization, then returns to the original.
- Then: Each request returns HTTP 200. The original status shows the correct tenant and Entra account and stays connected across the switch. The other organization reports no installation, connection, or linked accounts.

## teams-connect-007

- Vitest: "DELETE /api/integrations/teams/connect > disconnects the current user without uninstalling Teams"
- Mode: run
- Given: A signed-in user has linked their account in a workspace with an installed Teams integration.
- When: The user calls `DELETE /api/integrations/teams/connect` without an uninstall action and reads status.
- Then: Both calls return HTTP 200. Status remains installed with the same tenant and reports the user disconnected.

## teams-connect-008

- Vitest: "DELETE /api/integrations/teams/connect > lets admins uninstall Teams while keeping their account connected"
- Mode: run
- Given: A signed-in workspace admin has a linked account and an installed Teams integration.
- When: The admin calls `DELETE /api/integrations/teams/connect?action=uninstall` and reads status.
- Then: Both calls return HTTP 200. Status shows no installation and no pending installation, retains the admin's connected Entra account, and exposes an install URL with no connect URL.
