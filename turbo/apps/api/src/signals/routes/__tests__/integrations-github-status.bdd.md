# integrations-github-status

## integrations-github-status-001

- Vitest: "GitHub installation status > removes only the deleted installation and accepts a replayed webhook"
- Mode: run
- Given: Two users in different workspaces have each installed the GitHub App, and the GitHub webhook secret is configured.
- When: GitHub sends signed `installation` webhooks to `POST /api/webhooks/github` for the first installation with actions `created`, `suspend`, `deleted` and a replayed `deleted`; after each, both users read `GET /api/integrations/github`.
- Then: Every webhook returns HTTP 200. After `created` and `suspend` the first user still sees the installation with `isConnected: true`; after each `deleted` the first user's read returns HTTP 404 with error code `NOT_FOUND`. The second user always sees their own installation with `isConnected: true`.

## integrations-github-status-002

- Vitest: "GitHub installation status > reads installation and linked profile changes on subsequent requests"
- Mode: run
- Given: A signed-in workspace user has no GitHub installation, and the GitHub App slug is `bdd-github-app`.
- When: The user reads `GET /api/integrations/github`, installs the GitHub App linked to GitHub user 701 `github-status-before`, reads again, re-authorizes the GitHub connector as the same GitHub user now named `github-status-after`, and reads again.
- Then: The first read returns HTTP 404 with `NOT_FOUND` and an `installUrl` containing `https://github.com/apps/bdd-github-app/installations/new`. After installing, the status shows the installation `active`, `isAdmin: true`, `isConnected: true`, GitHub user ID "701" and username `github-status-before`. After re-authorization it shows the same installation, still active and connected, with username `github-status-after`.

## integrations-github-status-003

- Vitest: "GitHub installation status > keeps linked account details scoped to the authenticated user and organization"
- Mode: run
- Given: A workspace admin installed the GitHub App linked to GitHub user 801 `github-status-owner`; a regular member of the same workspace has no linked GitHub account; an outsider belongs to another workspace.
- When: The member, the owner and the outsider each read `GET /api/integrations/github`.
- Then: The member sees the installation with `isAdmin: false`, `isConnected: false` and null GitHub user ID and username. The owner sees `isAdmin: true`, `isConnected: true`, user ID "801" and username `github-status-owner`. The outsider receives HTTP 404 with error code `NOT_FOUND`.
