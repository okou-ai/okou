# teams-browser-connect

## teams-browser-connect-001

- Vitest: "GET /api/teams/connect > redirects unauthenticated users to app sign-in with redirect_url"
- Mode: run
- Given: The Teams integration is configured with an Okou app origin and the browser is signed out.
- When: The browser opens `GET /api/teams/connect`.
- Then: The API returns HTTP 307 to the app origin's `/sign-in` with `redirect_url` equal to the original connect URL.

## teams-browser-connect-002

- Vitest: "GET /api/teams/connect > verifies a provider link through Microsoft OAuth for the active account"
- Mode: run
- Given: A workspace member is signed in and opens a provider link carrying a Teams tenant ID, a Teams user ID, and a receiving installation's organization ID.
- When: The browser requests `GET /api/teams/connect` with that link and the member's session.
- Then: The API returns HTTP 307 to the configured API origin at `/api/teams/oauth/connect`. The redirect query contains only the active session's `orgId` and `userId`.
