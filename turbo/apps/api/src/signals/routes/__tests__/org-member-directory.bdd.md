# org-member-directory

## org-member-directory-001

- Vitest: "organization member directory > serves the members view to org:admin without failed management reads"
- Mode: run
- Given: A signed-in `org:admin` belongs to "Members only workspace" with one peer member; Clerk invitation listing fails and membership-request listing would return 429.
- When: The admin requests `GET /api/org/members?view=members`.
- Then: The response has the workspace name, role `admin`, creation time 2026-01-01T00:00:00.000Z, and members listing the caller with email, first name `BDD`, last name `Actor`, avatar URL, role `admin` and join time, followed by the peer as `member`. It has no `pendingInvitations` or `membershipRequests`, and neither invitations nor membership requests are fetched from Clerk.

## org-member-directory-002

- Vitest: "organization member directory > serves the members view to org:member without failed management reads"
- Mode: run
- Given: A signed-in `org:member` belongs to "Members only workspace" with one peer member; Clerk invitation listing fails and membership-request listing would return 429.
- When: The member requests `GET /api/org/members?view=members`.
- Then: The response has the workspace name, role `member`, creation time 2026-01-01T00:00:00.000Z, and members listing the caller with email, first name `BDD`, last name `Actor`, avatar URL, role `member` and join time, followed by the peer as `member`. It has no `pendingInvitations` or `membershipRequests`, and neither invitations nor membership requests are fetched from Clerk.

## org-member-directory-003

- Vitest: "organization member directory > serves members without admin transport while preserving admin invitation failures"
- Mode: run
- Given: "Directory workspace" has an admin and a member; Clerk's invitation endpoint returns 429 `rate_limit_exceeded` with `Retry-After: 7`, and membership-request listing also returns 429.
- When: The member requests the default `GET /api/org/members`, then the admin requests the same.
- Then: The member gets the workspace name, role `member`, empty `pendingInvitations` and `membershipRequests`, and both members with their roles, without any invitation or membership-request call. The admin gets HTTP 503 `{ error: { code: "PROVIDER_UNAVAILABLE", message: "Organization members are temporarily unavailable" } }` with `Retry-After: 7` and `Cache-Control: no-store`, after exactly one invitation call.

## org-member-directory-004

- Vitest: "organization member directory > returns every pending invitation page and membership requests for admins"
- Mode: run
- Given: A workspace admin's organization has 101 pending invitations served by Clerk in pages, and one membership request from a user without an organization.
- When: The admin requests `GET /api/org/members`.
- Then: Clerk invitations are requested with status `pending`. The response role is `admin`, `pendingInvitations` lists all 101 invitations in order with ID, email, role `member` and creation time, and `membershipRequests` contains the one request with its ID, user ID and email.

## org-member-directory-005

- Vitest: "organization member directory > preserves membership-request failures for the default admin view"
- Mode: run
- Given: A workspace admin's Clerk membership-request listing returns 429 with `Retry-After: 7`.
- When: The admin requests the default `GET /api/org/members`.
- Then: The response is HTTP 503 `{ error: { code: "PROVIDER_UNAVAILABLE", message: "Organization members are temporarily unavailable" } }` with `Retry-After: 7` and `Cache-Control: no-store`.

## org-member-directory-006

- Vitest: "organization member directory > requires authentication and an active organization for the members view"
- Mode: run
- Given: An anonymous caller and a signed-in user with no active organization.
- When: Both request `GET /api/org/members?view=members`.
- Then: Both return HTTP 401, and Clerk membership lists are never requested.

## org-member-directory-007

- Vitest: "organization member directory > scopes a warm profile cache to current membership after changing organizations"
- Mode: run
- Given: A user listed the members of their first workspace (warming the profile cache), and the same user is the admin of "Second workspace" with a different peer.
- When: The user requests `GET /api/org/members?view=members` in the second workspace.
- Then: The response is named "Second workspace" and lists exactly the user and the second peer, and the latest Clerk membership read is for the second organization.

## org-member-directory-008

- Vitest: "organization member directory > omits departed members and refreshes missing profiles after the cache expires"
- Mode: run
- Given: A workspace admin listed three members (admin, a soon-departed member and a member whose profile will disappear). Fifteen minutes later Clerk's membership list has only the admin and the second member, and Clerk returns a profile only for the admin.
- When: The admin requests `GET /api/org/members?view=members` again.
- Then: The initial list has 3 members. The refreshed list has exactly the admin with email, and the second member with empty email, null names, empty avatar URL, role `member` and join time 2026-01-01T00:00:00.000Z; the departed member is omitted.

## org-member-directory-009

- Vitest: "organization member directory > reduces cold and warm HTTP reads for a 3-member directory"
- Mode: run
- Given: A workspace admin's organization has 3 members, and all Clerk organization, membership, user, user-count, invitation and membership-request reads go over HTTP.
- When: The admin requests the default `GET /api/org/members` twice, then fifteen minutes later `GET /api/org/members?view=members` twice.
- Then: The cold default view lists 3 members with empty invitations and requests using 6 Clerk HTTP reads; the warm default view is identical using 4. The cold members view lists all emails in order without invitations or requests using 4 reads: one profile batch of 3 IDs, one user-count read, one membership page at offset 0, and no invitation or membership-request reads. The warm members view is identical using 2 reads, all organization or membership reads.

## org-member-directory-010

- Vitest: "organization member directory > reduces cold and warm HTTP reads for a 101-member directory"
- Mode: run
- Given: A workspace admin's organization has 101 members, and all Clerk organization, membership, user, user-count, invitation and membership-request reads go over HTTP.
- When: The admin requests the default `GET /api/org/members` twice, then fifteen minutes later `GET /api/org/members?view=members` twice.
- Then: The cold default view lists 101 members with empty invitations and requests using 9 Clerk HTTP reads; the warm default view is identical using 5. The cold members view lists all emails in order without invitations or requests using 7 reads: profile batches of 100 and 1 IDs, two user-count reads, membership pages at offsets 0 and 100, and no invitation or membership-request reads. The warm members view is identical using 3 reads, all organization or membership reads.

## org-member-directory-011

- Vitest: "organization member directory > keeps required getOrganization failures visible in the default member view"
- Mode: run
- Given: A signed-in workspace member, and Clerk's organization read (`getOrganization`) fails.
- When: The member requests the default `GET /api/org/members`.
- Then: The response is HTTP 500.

## org-member-directory-012

- Vitest: "organization member directory > keeps required getOrganizationMembershipList failures visible in the default member view"
- Mode: run
- Given: A signed-in workspace member, and Clerk's organization membership list (`getOrganizationMembershipList`) fails.
- When: The member requests the default `GET /api/org/members`.
- Then: The response is HTTP 500.

## org-member-directory-013

- Vitest: "organization member directory > keeps required getOrganization failures visible to admins in the members view"
- Mode: run
- Given: A signed-in workspace admin, and Clerk's organization read (`getOrganization`) fails.
- When: The admin requests `GET /api/org/members?view=members`.
- Then: The response is HTTP 500.

## org-member-directory-014

- Vitest: "organization member directory > keeps required getOrganizationMembershipList failures visible to admins in the members view"
- Mode: run
- Given: A signed-in workspace admin, and Clerk's organization membership list (`getOrganizationMembershipList`) fails.
- When: The admin requests `GET /api/org/members?view=members`.
- Then: The response is HTTP 500.
