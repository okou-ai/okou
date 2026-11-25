# github-install-authorization

## github-install-authorization-001

- Vitest: "GitHub installation authorization > requires sign-in before accepting a named administrator"
- Mode: run
- Given: A workspace admin is signed in and the GitHub App is configured, but the install request carries no session.
- When: The browser requests `GET /api/github/oauth/install` with the admin's user and organization IDs and no sign-in.
- Then: The redirect goes to `/sign-in` with `Cache-Control: no-store`, and `GET /api/integrations/github` returns HTTP 404 for the admin.

## github-install-authorization-002

- Vitest: "GitHub installation authorization > rejects another user's principal even when that user is an administrator"
- Mode: run
- Given: A workspace admin is signed in and the GitHub App is configured (the victim). A different signed-in user (the attacker) knows the victim's user and organization IDs.
- When: The attacker requests `GET /api/github/oauth/install` naming the victim's user and organization IDs.
- Then: The redirect carries an error mentioning a "different account or organization", and `GET /api/integrations/github` returns HTTP 404 for both the victim and the attacker.

## github-install-authorization-003

- Vitest: "GitHub installation authorization > requires an organization administrator"
- Mode: run
- Given: A workspace admin is signed in and the GitHub App is configured. A plain member of the same workspace is signed in.
- When: The member requests `GET /api/github/oauth/install`.
- Then: The redirect carries an error mentioning "Only organization admins".

## github-install-authorization-004

- Vitest: "GitHub installation authorization > checks the user's provider access before associating an installation"
- Mode: run
- Given: A workspace admin is signed in and the GitHub App is configured and started an install, receiving a signed state. GitHub reports installation 2002 belongs to the organization `foreign-org`, where the user's GitHub account is only a `member`.
- When: The admin's browser calls `GET /api/github/app/setup/callback` with the state, an authorization code, `installation_id=2002`, and `setup_action=install`.
- Then: The redirect carries an error mentioning "active organization administrator", and `GET /api/integrations/github` returns HTTP 404.

## github-install-authorization-005

- Vitest: "GitHub installation authorization > rejects a callback after the authenticated Okou actor switches"
- Mode: run
- Given: A workspace admin is signed in and the GitHub App is configured and started an install; a different member of the same workspace is now the signed-in actor.
- When: The other member's browser calls `GET /api/github/app/setup/callback` with the admin's state, a code, and an installation ID.
- Then: The redirect carries an error mentioning "active account or organization changed", and `GET /api/integrations/github` returns HTTP 404 for the admin.

## github-install-authorization-006

- Vitest: "GitHub installation authorization > verifies the provider account, persists the installation, and rejects state replay"
- Mode: run
- Given: A workspace admin is signed in and the GitHub App is configured, and GitHub verifies the admin's GitHub account 702 as authorized for the new installation.
- When: The admin completes the install flow through `GET /api/github/oauth/install` and `GET /api/github/app/setup/callback`, reads `GET /api/integrations/github`, then replays the same state and code on `GET /api/github/app/setup/callback`.
- Then: The installation reads `isConnected: true`, `connectedGithubUserId: "702"`, and the remote installation ID. The replay redirect carries an error mentioning "expired or was already used", and the installation is unchanged.

## github-install-authorization-007

- Vitest: "GitHub installation authorization > accepts a personal installation only for the verified GitHub account owner"
- Mode: run
- Given: A workspace admin is signed in and the GitHub App is configured, and GitHub reports a personal (`User`) installation owned by the verified GitHub account 703.
- When: The admin completes the install flow through `GET /api/github/oauth/install` and `GET /api/github/app/setup/callback` and reads `GET /api/integrations/github`.
- Then: The installation reads `connectedGithubUserId: "703"` with the remote installation ID and `targetType: "User"`.

## github-install-authorization-008

- Vitest: "GitHub installation authorization > rejects a personal installation owned by a different GitHub account"
- Mode: run
- Given: A workspace admin is signed in and the GitHub App is configured and started an install. GitHub reports personal installation 7007 belongs to GitHub account 704, while the authorization code verifies account 705.
- When: The admin's browser calls `GET /api/github/app/setup/callback` with the state, the code, and `installation_id=7007`.
- Then: The redirect carries an error mentioning "GitHub account owner", and `GET /api/integrations/github` returns HTTP 404.

## github-install-authorization-009

- Vitest: "GitHub installation authorization > requires user verification when installation returns no authorization code"
- Mode: run
- Given: A workspace admin is signed in and the GitHub App is configured and started an install.
- When: GitHub redirects to `GET /api/github/app/setup/callback` with the state, `installation_id=3003`, `setup_action=install`, and no code; the admin then returns with the continuation state, a code, and a different `installation_id=4004`.
- Then: The first callback redirects to GitHub's `/login/oauth/authorize` without creating an installation (`GET /api/integrations/github` returns HTTP 404). The switched callback's redirect carries an error mentioning "does not match this authorization", and the installation still returns HTTP 404.

## github-install-authorization-010

- Vitest: "GitHub installation authorization > recovers an existing provider installation only after verifying its administrator"
- Mode: run
- Given: A workspace admin is signed in and the GitHub App is configured and started an install. GitHub reports an existing installation for the organization `verified-org`, where the admin's GitHub account 706 is verified.
- When: GitHub redirects to `GET /api/github/app/setup/callback` with `setup_action=update`, the installation ID, and no code; the admin then completes the continuation with the code `verify-existing-installation`.
- Then: The first callback redirects to `/login/oauth/authorize` and `GET /api/integrations/github` returns HTTP 404. The completion redirects to `/workflows`, and the installation reads `isConnected: false` with the installation ID and `targetName: "verified-org"`.

## github-install-authorization-011

- Vitest: "GitHub installation authorization > expires an abandoned authorization without creating an installation"
- Mode: run
- Given: A workspace admin is signed in and the GitHub App is configured and started an install; the clock then advances 15 minutes.
- When: The admin's browser calls `GET /api/github/app/setup/callback` with the state, a late code, and `installation_id=5005`.
- Then: The redirect carries an error mentioning "expired or was already used", and `GET /api/integrations/github` returns HTTP 404.

## github-install-authorization-012

- Vitest: "GitHub installation authorization > requires the GitHub installation completing actor (missing)"
- Mode: run
- Given: Row `missing`. A workspace admin is signed in and the GitHub App is configured, started an install, and GitHub reports a personal installation owned by the verified GitHub account 888001. The completing browser sends no credentials.
- When: The callback first lands on `GET /api/github/app/setup/callback` without a session; the browser then completes it with `responseMode=json`, and after sign-in the admin repeats the callback.
- Then: The unauthenticated landing redirects with `integration=github` and creates nothing (`GET /api/integrations/github` returns HTTP 404). The JSON completion returns HTTP 401 and the installation still returns HTTP 404. After sign-in the repeated callback redirects without an error and the installation reads `isConnected: true` with `connectedGithubUserId: "888001"`.

## github-install-authorization-013

- Vitest: "GitHub installation authorization > requires the GitHub installation completing actor (expired-cookie)"
- Mode: run
- Given: Row `expired-cookie`. A workspace admin is signed in and the GitHub App is configured, started an install, and GitHub reports a personal installation owned by the verified GitHub account 888001. The completing browser sends a session cookie that no longer authenticates.
- When: The callback first lands on `GET /api/github/app/setup/callback` without a session; the browser then completes it with `responseMode=json`, and after sign-in the admin repeats the callback.
- Then: The unauthenticated landing redirects with `integration=github` and creates nothing (`GET /api/integrations/github` returns HTTP 404). The JSON completion returns HTTP 401 and the installation still returns HTTP 404. After sign-in the repeated callback redirects without an error and the installation reads `isConnected: true` with `connectedGithubUserId: "888001"`.

## github-install-authorization-014

- Vitest: "GitHub installation authorization > requires the GitHub installation completing actor (matching-cookie)"
- Mode: run
- Given: Row `matching-cookie`. A workspace admin is signed in and the GitHub App is configured, started an install, and GitHub reports a personal installation owned by the verified GitHub account 888001. The completing browser sends the admin's own session cookie.
- When: The callback first lands on `GET /api/github/app/setup/callback` without a session; the browser then completes it with `responseMode=json`.
- Then: The unauthenticated landing redirects with `integration=github` and creates nothing. The JSON completion returns HTTP 200 with a redirect URL that has no error, and `GET /api/integrations/github` reads `isConnected: true`, `connectedGithubUserId: "888001"`, and the installation ID.

## github-install-authorization-015

- Vitest: "GitHub installation authorization > requires the GitHub installation completing actor (different-user)"
- Mode: run
- Given: Row `different-user`. A workspace admin is signed in and the GitHub App is configured, started an install, and GitHub reports a personal installation owned by the verified GitHub account 888001. The completing browser sends the session cookie of another user in the same workspace.
- When: The callback first lands on `GET /api/github/app/setup/callback` without a session; the browser then completes it with `responseMode=json`.
- Then: The unauthenticated landing redirects with `integration=github` and creates nothing. The JSON completion returns HTTP 200 with a redirect URL whose error mentions "active account or organization changed", and `GET /api/integrations/github` returns HTTP 404 for the admin.

## github-install-authorization-016

- Vitest: "GitHub installation authorization > requires the GitHub installation completing actor (different-org)"
- Mode: run
- Given: Row `different-org`. A workspace admin is signed in and the GitHub App is configured, started an install, and GitHub reports a personal installation owned by the verified GitHub account 888001. The completing browser sends the admin's session cookie for a different workspace.
- When: The callback first lands on `GET /api/github/app/setup/callback` without a session; the browser then completes it with `responseMode=json`.
- Then: The unauthenticated landing redirects with `integration=github` and creates nothing. The JSON completion returns HTTP 200 with a redirect URL whose error mentions "active account or organization changed", and `GET /api/integrations/github` returns HTTP 404 for the admin.

## github-install-authorization-017

- Vitest: "GitHub installation authorization > requires the GitHub installation completing actor (invalid-bearer)"
- Mode: run
- Given: Row `invalid-bearer`. A workspace admin is signed in and the GitHub App is configured, started an install, and GitHub reports a personal installation owned by the verified GitHub account 888001. The completing browser sends an invalid bearer token.
- When: The callback first lands on `GET /api/github/app/setup/callback` without a session; the browser then completes it with `responseMode=json`, and after sign-in the admin repeats the callback.
- Then: The unauthenticated landing redirects with `integration=github` and creates nothing (`GET /api/integrations/github` returns HTTP 404). The JSON completion returns HTTP 401 and the installation still returns HTTP 404. After sign-in the repeated callback redirects without an error and the installation reads `isConnected: true` with `connectedGithubUserId: "888001"`.

## github-install-authorization-018

- Vitest: "GitHub installation authorization > protects GitHub no-code continuation (missing)"
- Mode: run
- Given: Row `missing`. A workspace admin is signed in and the GitHub App is configured and started an install; GitHub later verifies the admin's GitHub account 888002 as owner of the personal installation. The continuation browser sends no credentials.
- When: GitHub redirects to `GET /api/github/app/setup/callback` with `setup_action=install` and no code; the browser completes the continuation with a code and `responseMode=json`, and the signed-in admin then repeats that completion.
- Then: The first callback redirects to `/login/oauth/authorize` with no installation created. The unauthenticated completion returns HTTP 401 and `GET /api/integrations/github` still returns HTTP 404. The signed-in completion returns HTTP 200 with a redirect URL that has no error, and the installation reads `isConnected: false` with the installation ID.

## github-install-authorization-019

- Vitest: "GitHub installation authorization > protects GitHub no-code continuation (expired-cookie)"
- Mode: run
- Given: Row `expired-cookie`. A workspace admin is signed in and the GitHub App is configured and started an install; GitHub later verifies the admin's GitHub account 888002 as owner of the personal installation. The continuation browser sends a session cookie that no longer authenticates.
- When: GitHub redirects to `GET /api/github/app/setup/callback` with `setup_action=install` and no code; the browser completes the continuation with a code and `responseMode=json`, and the signed-in admin then repeats that completion.
- Then: The first callback redirects to `/login/oauth/authorize` with no installation created. The unauthenticated completion returns HTTP 401 and `GET /api/integrations/github` still returns HTTP 404. The signed-in completion returns HTTP 200 with a redirect URL that has no error, and the installation reads `isConnected: false` with the installation ID.

## github-install-authorization-020

- Vitest: "GitHub installation authorization > keeps GitHub update without valid state read only (undefined)"
- Mode: run
- Given: Row `undefined`. A workspace admin is signed in and the GitHub App is configured; the callback arrives unauthenticated.
- When: The browser calls `GET /api/github/app/setup/callback` with `setup_action=update`, `installation_id=988000`, and no state parameter.
- Then: The callback redirects to `/workflows`, and `GET /api/integrations/github` returns HTTP 404 for the admin.

## github-install-authorization-021

- Vitest: "GitHub installation authorization > keeps GitHub update without valid state read only (invalid-state)"
- Mode: run
- Given: Row `invalid-state`. A workspace admin is signed in and the GitHub App is configured; the callback arrives unauthenticated.
- When: The browser calls `GET /api/github/app/setup/callback` with `setup_action=update`, `installation_id=988000`, and `state=invalid-state`.
- Then: The callback redirects to `/workflows`, and `GET /api/integrations/github` returns HTTP 404 for the admin.
