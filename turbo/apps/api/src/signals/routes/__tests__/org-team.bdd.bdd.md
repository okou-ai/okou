# org-team.bdd

## org-team.bdd-001

- Vitest: "ORG-00: user-level organization creation count > counts owned workspaces independently of the active workspace"
- Mode: run
- Given: A signed-in user's active workspace was created by another user, and Clerk lists a second workspace created by this user.
- When: The user requests `GET /api/org/created-count`.
- Then: The count is 1.

## org-team.bdd-002

- Vitest: "ORG-01: org logo lifecycle through the Clerk boundary > serves, uploads, and removes the org logo across auth, validation, and clerk error arms [ORG-LOGO-A]"
- Mode: run
- Given: A workspace has an admin and a member, and a user without an organization exists; Clerk serves the workspace logo and accepts logo uploads.
- When: Callers use `GET /api/org/logo` and `POST /api/org/logo` (multipart `file`) across these arms: admin reads with a Clerk image and with an empty image, anonymous and no-organization reads, admin read when Clerk reports not found; admin uploads of a PNG, a WebP and an upload that clears the image; anonymous, no-organization and member uploads; admin uploads of a file over 2 MB and a `text/plain` file; admin uploads when Clerk reports not found and forbidden.
- Then: Reads return `{ logoUrl: "https://img.clerk.test/org-logo.png", hasImage: true }` after looking up the organization ID, then `{ logoUrl: null, hasImage: false }`; anonymous read is HTTP 401 `UNAUTHORIZED`, and both no-organization and Clerk-not-found reads are HTTP 404 "Org not found". PNG and WebP uploads return the new logo URL and Clerk receives the file with its name, size and type; the clearing upload returns `logoUrl: null`. Anonymous upload is HTTP 401 "Not authenticated", no-organization upload HTTP 404 "Org not found", member upload HTTP 403 "Only admins can upload the logo", oversize HTTP 400 "File too large (max 2 MB)", text file HTTP 400 "Unsupported file type: text/plain", Clerk not-found HTTP 404 "Org not found", and Clerk forbidden HTTP 403 "Access denied".

## org-team.bdd-003

- Vitest: "ORG-01: org update and delete error matrix > maps no-org, rename, admin-leave, and delete failure arms [ORG-UPDATE-B]"
- Mode: run
- Given: A user without an organization; an onboarded admin of "BDD R5 Org" with a member and a CLI token; and an admin whose organization no longer exists in Clerk.
- When: The no-organization user calls `PUT /api/org`; the admin renames the org via `PUT /api/org` and tries `POST /api/org/leave`; the member calls `POST /api/org/delete`; the admin's CLI token calls `POST /api/org/delete`; the admin posts `POST /api/org/delete` with `confirm: "delete"`; the admin reads `GET /api/org`; the orphaned admin calls `POST /api/org/delete`.
- Then: The no-organization update returns HTTP 400 "No organization is selected for this request". The rename returns HTTP 200 with the org ID and new name and Clerk is updated with that name. Admin leave returns HTTP 403 "Admins cannot leave the organization". Member delete returns HTTP 403 "Only admins can delete the organization", the CLI token delete returns HTTP 403 `FORBIDDEN`, and the wrong confirmation returns HTTP 400 `BAD_REQUEST`. The org still reads "BDD R5 Org Renamed". The orphaned delete returns HTTP 404 `{ error: { message: "Resource not found", code: "NOT_FOUND" } }`.

## org-team.bdd-004

- Vitest: "ORG-01: org update and delete error matrix > does not retry Clerk 5xx mutation failures"
- Mode: run
- Given: An onboarded workspace admin, and Clerk fails organization updates with a 521 server error (row `5xx`).
- When: The admin renames the org via `PUT /api/org`.
- Then: The response is HTTP 500, Clerk's update is attempted exactly once, and no retry wait occurs.

## org-team.bdd-005

- Vitest: "ORG-01: org update and delete error matrix > does not retry Clerk transport mutation failures"
- Mode: run
- Given: An onboarded workspace admin, and Clerk organization updates fail at the transport level (row `transport`).
- When: The admin renames the org via `PUT /api/org`.
- Then: The response is HTTP 500, Clerk's update is attempted exactly once, and no retry wait occurs.

## org-team.bdd-006

- Vitest: "ORG-02: membership admin matrix > retries Clerk 5xx reads and immediately exposes rate limits"
- Mode: run
- Given: A workspace admin; Clerk's membership list responds in turn with a 429 (`Retry-After` 2), a 521 followed by success, a persistent 521, and finally success while membership requests return 429 with `Retry-After: 7`.
- When: The admin requests `GET /api/org/members` four times.
- Then: The 429 read returns HTTP 503 with `Retry-After: 2` after one Clerk call and no wait. The transient 521 recovers with HTTP 200 and one member after two Clerk calls and a single wait of 1,000 to 1,250 ms. The persistent 521 returns HTTP 500 after three calls and two waits. The membership-request rate limit returns HTTP 503 `{ error: { message: "Organization members are temporarily unavailable", code: "PROVIDER_UNAVAILABLE" } }` with `Retry-After: 7` and `Cache-Control: no-store`, after one request listing and no wait.

## org-team.bdd-007

- Vitest: "ORG-02: membership admin matrix > does not retry Clerk 4xx or malformed read failures"
- Mode: run
- Given: A workspace admin; Clerk's membership list first fails with a 404, then with a malformed `{ status: 521 }` error.
- When: The admin requests `GET /api/org/members` once for each failure.
- Then: Both return HTTP 500 after exactly one Clerk membership call each, with no retry wait.

## org-team.bdd-008

- Vitest: "ORG-02: membership admin matrix > stops sibling Clerk work on the first directory rate limit"
- Mode: run
- Given: A workspace admin; Clerk's organization read fails once with 521 and starts a retry wait, the membership list then fails with a 429 (`Retry-After` 1), and the invitation page is still pending.
- When: The admin requests `GET /api/org/members`.
- Then: The response is HTTP 503 with `Retry-After: 1`; the membership list and organization read are each called once and the sibling retry wait is aborted. When the pending invitation page later resolves, invitations were requested only once.

## org-team.bdd-009

- Vitest: "ORG-02: membership admin matrix > shares the 5xx retry deadline across organization member reads"
- Mode: run
- Given: A workspace admin; Clerk's membership list fails once with 521 then succeeds, Clerk's user list always fails with 521, and each retry wait lets 14.5 seconds pass.
- When: The admin requests `GET /api/org/members`.
- Then: The response is HTTP 500 after two membership list calls, one user list call and one retry wait.

## org-team.bdd-010

- Vitest: "ORG-02: membership admin matrix > enforces role, self, nonmember, and clerk-failure arms across member routes [ORG-MEMBERS-C]"
- Mode: run
- Given: An onboarded workspace has an admin and a member; later a second admin joins, and a stranger outside the workspace exists. Clerk's membership-request accept and reject both return 404.
- When: Through `PATCH`/`DELETE /api/org/members`, `DELETE /api/org/invite`, `POST`/`DELETE /api/org/membership-requests` and `GET /api/org/members`, the member and admin exercise role changes, removals, invitation revocation, membership-request decisions and listings (including a Clerk organization without the membership-request feature).
- Then: Member role change, removal, invitation revoke, accept and reject all return HTTP 403 "Access denied" and never reach Clerk's membership-request endpoints. The sole admin demoting themself returns HTTP 400 "Invalid request"; with a second admin the demotion returns "Updated role for <email>". Self-removal returns HTTP 400 "Invalid request" and removing the stranger returns HTTP 404 "Resource not found". Admin accept and reject return HTTP 400 "Invalid request" after one Clerk call each. The admin listing shows role `admin`, the pending invitation, and an empty membership-request list after one 404 listing; the member listing shows role `member` with empty invitations and requests and no membership-request call.

## org-team.bdd-011

- Vitest: "ORG-02: member cleanup detaches Slack connections > disconnects slack-linked members on leave, removal, and org deletion [ORG-SLACK-D]"
- Mode: run
- Given: An onboarded workspace with an installed Slack workspace has two members connected to Slack; a second workspace with Slack installed has a connected member.
- When: The first member leaves via `POST /api/org/leave`, the admin removes the second member via `DELETE /api/org/members`, and the second workspace's admin deletes it via `POST /api/org/delete`; each affected member reads `GET /api/integrations/slack/connect`.
- Then: Each member is connected before. Leave returns "Left org", removal returns "Removed <email> from org", deletion returns "Organization deleted", and afterwards each affected member's Slack status shows `isConnected: false`.

## org-team.bdd-012

- Vitest: "AUTH-02/ORG-01: run-scoped agent tokens on org routes > serves the org read to a dispatched Run's agent token and rejects member reads and org writes [ORG-TOKEN-G]"
- Mode: run
- Given: A Pro admin with a personal subscription has a dispatched thread Run whose execution environment carries an `OKOU_TOKEN` starting with `vm0_sandbox_`.
- When: The Run token calls `GET /api/org`, `GET /api/org/members`, `PUT /api/org` and `POST /api/org/logo`; then the admin cancels the Run.
- Then: The org read returns HTTP 200 with the org ID and role `admin`. The member listing, update and logo upload each return HTTP 403 `{ error: { message: "This endpoint is not available for sandbox tokens", code: "FORBIDDEN" } }`. The cancelled Run reads `cancelled`.
