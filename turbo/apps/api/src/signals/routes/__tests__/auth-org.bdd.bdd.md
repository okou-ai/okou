# auth-org.bdd

## auth-org.bdd-001

- Vitest: "AUTH-01 and ORG-03 > reads current identity and completes workspace onboarding"
- Mode: run
- Given: A signed-in organization administrator's workspace "BDD Chain Org" exists in the identity provider and storage accepts writes; a second user has no active organization.
- When: The admin calls `GET /api/auth/me` and `GET /api/org`; the user without an organization calls `GET /api/org`; the admin completes the limited-free onboarding bootstrap, reads `GET /api/onboarding/status`, repeats the bootstrap, and reads billing status.
- Then: `/api/auth/me` returns exactly the admin's user ID, email and organization ID, and `/api/org` returns the organization ID, name "BDD Chain Org" and role `admin`. The user without an organization gets HTTP 404 `NOT_FOUND`. After onboarding the status shows `onboardingComplete` true, the repeated bootstrap returns HTTP 200, and billing shows tier `limited-free-1` with `onboardingPaymentPending` false.

## auth-org.bdd-002

- Vitest: "AUTH-01 and ORG-03 > reads and caches a Clerk organization whose slug is null"
- Mode: run
- Given: A signed-in administrator's organization "Slugless Workspace" has a null slug in the identity provider.
- When: The admin calls `GET /api/org` twice.
- Then: Both reads return the organization ID, name "Slugless Workspace" and role `admin`.

## auth-org.bdd-003

- Vitest: "AUTH-03 > manages user preferences through safe visible reads"
- Mode: run
- Given: A signed-in administrator has completed workspace onboarding.
- When: The admin updates preferences with `POST /api/user-preferences` (timezone `UTC`, locale `en-US`, send mode `cmd-enter`, 3 network-body captures remaining) and reads them with `GET /api/user-preferences`.
- Then: The update returns timezone `UTC`, send mode `cmd-enter` and `captureNetworkBodiesRemaining` 3, and the read returns exactly the updated preferences.

## auth-org.bdd-004

- Vitest: "ORG-01 and ORG-02 > uses entitlement status for invitations and allows a reactivated workspace"
- Mode: run
- Given: A signed-in administrator has completed onboarding, and the workspace plan is canceled.
- When: The admin calls `POST /api/org/invite` for a member email; the plan is then reactivated, the admin reads billing status and invites again.
- Then: The first invitation returns HTTP 403 with message "Reactivate your workspace plan to invite members" and no invitation is created in the identity provider. After reactivation billing status is `active`, and the invitation succeeds and creates an identity-provider invitation for that email.

## auth-org.bdd-005

- Vitest: "ORG-01 and ORG-02 > projects direct invitation redirects to Okou"
- Mode: run
- Given: The app URL is `https://app.okou.ai`, and a signed-in administrator has completed onboarding.
- When: The admin calls `POST /api/org/invite` for a new email with role `member`.
- Then: The identity provider receives exactly one invitation for the organization and email, with the admin as inviter, role `org:member`, redirect URL `https://app.okou.ai` and private metadata containing a get-started claim ID.

## auth-org.bdd-006

- Vitest: "ORG-01 and ORG-02 > reads, updates, lists, invites, changes membership, handles requests, and leaves orgs through APIs"
- Mode: run
- Given: A signed-in administrator has onboarded "BDD Org" with a member, a pending invitation and a pending membership request from another user.
- When: The admin and member read `GET /api/org`; the admin renames the org with `PUT /api/org` and the member tries to; the admin lists `GET /api/org/members` and invites via `POST /api/org/invite` while the member tries to invite; the admin revokes the invitation (`DELETE /api/org/invite`), promotes the member (`PATCH /api/org/members`), accepts and rejects the request (`POST`/`DELETE /api/org/membership-requests`), removes the member (`DELETE /api/org/members`) and lists again; the member leaves (`POST /api/org/leave`) and the admin deletes the org (`POST /api/org/delete`).
- Then: The admin sees "BDD Org" with role `admin` and the member sees role `member`. The rename returns "BDD Org Updated"; the member's rename and invite return HTTP 403 `FORBIDDEN`. The member list has the renamed org, admin role, the member, the pending invitation and the membership request. The invite message contains "Invitation sent" and the identity provider gets an invitation with role `org:member` and redirect `http://localhost:3002`. The remaining calls return "Invitation revoked", "Updated role for <email>", "Membership request accepted", "Membership request rejected" and "Removed <email> from org"; the member is absent from the next list, leaving returns "Left org", and deletion returns "Organization deleted".

## auth-org.bdd-007

- Vitest: "ORG-03 onboarding status mapping > maps onboarding status across setup, payment, and entitlement"
- Mode: run
- Given: Three signed-in users exist: one without an organization, a new administrator, and a member of the administrator's organization. Storage accepts writes.
- When: Each reads `GET /api/onboarding/status`; the admin's workspace is provisioned and billing and usage-pack credits are read; the member and then the admin call `POST /api/onboarding/complete`; the admin is granted a Pro entitlement and reads status and billing again.
- Then: The no-organization user gets all flags false; the member needs onboarding with `hasOrg` true and not admin; the admin needs onboarding and is admin. After provisioning, billing shows 0 credits, no grants, tier `limited-free-1` and no pending onboarding payment, with 1000 total and bonus usage-pack credits. The member's completion (HTTP 200) leaves the admin still needing onboarding. The admin's completion returns exactly `{ onboardingComplete: true, needsOnboarding: false }` and the status follows. With Pro, the status is complete and not needing onboarding, and billing shows tier `pro`.

## auth-org.bdd-008

- Vitest: "workspace custom connector connection > connects a workspace custom connector"
- Mode: run
- Given: A signed-in administrator has completed onboarding.
- When: The admin creates a manual HTTP custom connector "BDD Custom Connector", sets its secret, lists custom connectors and their accounts via `GET /api/connector-accounts/connections`, deletes the default connector account, lists again, deletes the connector and lists again.
- Then: The created connector has the requested slug and display name. After setting the secret the connector is listed, its account list has one `connected` account, and the listing never contains the secret. After disconnecting, the connector is still listed with no accounts. After deletion it is no longer listed.
