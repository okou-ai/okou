# github-oauth-account-mutations

## github-oauth-account-mutations-001

- Vitest: "GitHub OAuth account mutation selection > links connector callbacks only to their organization's active installation"
- Mode: run
- Given: Two members in different workspaces have each installed the GitHub App for their own workspace.
- When: The first member connects GitHub account 901 through `POST /api/connectors/github/oauth/start` (intent `add`) and the OAuth callback `GET /api/connectors/github/callback`; both read `GET /api/integrations/github`; then the second member connects GitHub account 902 the same way and both read again.
- Then: After the first connection, the first workspace's installation reads `connectedGithubUserId: "901"`, `isConnected: true`, and status `active`, while the second reads `connectedGithubUserId: null` and `isConnected: false`. After the second connection, the second reads `connectedGithubUserId: "902"` and `isConnected: true`, and the first still reads `"901"` and connected; both installations remain `active` with their own installation IDs.

## github-oauth-account-mutations-002

- Vitest: "GitHub OAuth account mutation selection > redirects state-less GitHub App updates to the configured Okou app"
- Mode: run
- Given: The Okou app URL is `https://app.okou.ai` and a member has installed the GitHub App for the organization `bdd-org`.
- When: GitHub calls `GET /api/github/app/setup/callback` with the installation ID and `setup_action=update` but no state.
- Then: The installation reads `active`, `targetType: "Organization"`, `targetName: "bdd-org"`, and the callback responds with HTTP 307 redirecting to the `https://app.okou.ai` origin.

## github-oauth-account-mutations-003

- Vitest: "GitHub OAuth account mutation selection > adds a new identity and refreshes the exact existing sibling"
- Mode: run
- Given: A member connected GitHub account 101 ("First") and then account 202 ("Second", login `github-second`) through the GitHub connector OAuth flow.
- When: The member reconnects account 202 with intent `add`, display name "Ignored on refresh", and the new login `github-second-updated`, then lists connector accounts via `GET /api/connector-accounts/connections`.
- Then: Before and after the refresh there are exactly two GitHub accounts. Account 101 keeps its ID, display name "First", username `github-first`, and default status. Account 202 keeps its ID and display name "Second", updates its username to `github-second-updated`, and stays non-default.

## github-oauth-account-mutations-004

- Vitest: "GitHub OAuth account mutation selection > deduplicates concurrent callbacks and their connector reward"
- Mode: run
- Given: A member starts two GitHub connector OAuth flows concurrently with intent `add`, and GitHub resolves both codes to account 303 (`github-concurrent`).
- When: Both OAuth callbacks complete concurrently, the member lists connector accounts, and then reconnects account 303 once more.
- Then: The list contains exactly one GitHub account with external ID `303`, username `github-concurrent`, and `isDefault: true`, and the later reconnect completes.

## github-oauth-account-mutations-005

- Vitest: "GitHub OAuth account mutation selection > does not match a provider identity owned by another organization"
- Mode: run
- Given: Two members in different workspaces each connect the same GitHub account 304 through the GitHub connector OAuth flow, with display names "First owner" and "Second owner".
- When: Each member lists their GitHub connector accounts via `GET /api/connector-accounts/connections`.
- Then: Each workspace has exactly one default account with external ID `304` and its own display name, and the two account IDs differ.

## github-oauth-account-mutations-006

- Vitest: "GitHub OAuth account mutation selection > uses the same exact-identity selection for GitHub App setup"
- Mode: run
- Given: A member connected GitHub accounts 501 and 502 through the connector OAuth flow; a second member in another workspace connected account 601.
- When: The first member installs the GitHub App and GitHub verifies account 502 with the new login `github-setup-existing-updated`; the second member installs the GitHub App verified as new account 602; both list connector accounts and read `GET /api/integrations/github`.
- Then: The first member still has two accounts; account 502 keeps its ID, takes the new username, and stays non-default, and the installation reads `connectedGithubUserId: "502"`, connected and `active`. The second member now has two accounts, with account 602 (`github-setup-new-sibling`) non-default, and the installation reads `connectedGithubUserId: "602"`, connected and `active`.
