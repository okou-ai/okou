# org-cache

## org-cache-001

- Vitest: "trusted organization identity cache > reuses the provider update response when the cache is absent"
- Mode: run
- Given: A workspace was bootstrapped by a signed Clerk `organization.created` webhook that has no name, so no organization identity is cached (row `absent`); Clerk's profile update normalizes the name to "Provider-normalized workspace".
- When: The admin updates `PUT /api/org` with name "Requested workspace", then reads `GET /api/org`.
- Then: The update returns HTTP 200 with exactly the org ID, name "Provider-normalized workspace" and tier `limited-free-1`, and Clerk receives exactly one update with name "Requested workspace". The read returns exactly the org ID, the normalized name, the creator, role `admin` and tier `limited-free-1`, and Clerk's organization is never read.

## org-cache-002

- Vitest: "trusted organization identity cache > reuses the provider update response when the cache is present"
- Mode: run
- Given: A workspace was bootstrapped by a signed Clerk `organization.created` webhook with no name, and a first `GET /api/org` cached "Original workspace" from Clerk (row `present`); Clerk's profile update normalizes the name to "Provider-normalized workspace".
- When: The admin updates `PUT /api/org` with name "Requested workspace", then reads `GET /api/org`.
- Then: The update returns HTTP 200 with exactly the org ID, name "Provider-normalized workspace" and tier `limited-free-1`, and Clerk receives exactly one update with name "Requested workspace". The read returns exactly the org ID, the normalized name, the creator, role `admin` and tier `limited-free-1`, and Clerk's organization is not read again.

## org-cache-003

- Vitest: "trusted organization identity cache > prefills identity from a verified snake-case creation event"
- Mode: run
- Given: A signed Clerk `organization.created` webhook with name "Created workspace" and snake-case `created_by`/`created_at` fields has been accepted (body `OK`).
- When: The admin reads `GET /api/org`.
- Then: The response is exactly the org ID, name "Created workspace", the creator, role `admin` and tier `limited-free-1`, without reading the organization from Clerk.

## org-cache-004

- Vitest: "trusted organization identity cache > prefills identity from a verified camel-case creation event"
- Mode: run
- Given: A signed Clerk `organization.created` webhook with name "Created workspace" and camel-case `createdBy`/`createdAt` fields has been accepted (body `OK`).
- When: The admin reads `GET /api/org`.
- Then: The response is exactly the org ID, name "Created workspace", the creator, role `admin` and tier `limited-free-1`, without reading the organization from Clerk.

## org-cache-005

- Vitest: "trusted organization identity cache > keeps a profile update when a duplicate creation event arrives later"
- Mode: run
- Given: A workspace was created by a signed `organization.created` webhook named "Created workspace", and the admin renamed it to "Renamed workspace" via `PUT /api/org`.
- When: The same creation webhook is delivered again, then the admin reads `GET /api/org`.
- Then: The org reads "Renamed workspace" with role `admin` and tier `limited-free-1`, and Clerk's organization is never read.

## org-cache-006

- Vitest: "trusted organization identity cache > returns the winning identity when an older cold read finishes after an update"
- Mode: run
- Given: A workspace was bootstrapped without a cached identity, and Clerk's organization read stalls and would return an older name.
- When: The admin starts `GET /api/org`; while Clerk's read is in flight the admin renames the workspace to "Renamed workspace" via `PUT /api/org`; then the stalled read finishes and the admin reads again.
- Then: The update succeeds, the stalled read resolves with name "Renamed workspace", the later read also shows "Renamed workspace", and Clerk's organization is read exactly once.

## org-cache-007

- Vitest: "trusted organization identity cache > keeps bootstrap and read-through when the creation name is undefined"
- Mode: run
- Given: A signed `organization.created` webhook with an undefined name has been accepted, and Clerk returns "Read-through workspace".
- When: The admin reads `GET /api/org`.
- Then: The response shows "Read-through workspace", the creator, role `admin` and tier `limited-free-1`, and Clerk's organization is read exactly once for that organization ID.

## org-cache-008

- Vitest: "trusted organization identity cache > does not prefill identity when the creation event lacks its creator"
- Mode: run
- Given: A signed `organization.created` webhook named "Incomplete event workspace" but without its creator has been accepted, and Clerk returns "Read-through workspace".
- When: The admin reads `GET /api/org`.
- Then: The response shows "Read-through workspace" with the creator, and Clerk's organization is read once.

## org-cache-009

- Vitest: "trusted organization identity cache > rejects an invalid signature without caching the request's identity"
- Mode: run
- Given: Clerk's stored organization is named "Verified provider workspace".
- When: A `POST /api/webhooks/clerk` with an invalid Svix signature claims `organization.created` with name "Unverified workspace"; then the admin reads `GET /api/org`.
- Then: The webhook returns HTTP 401 with `{ error: "Invalid webhook signature" }`. The org reads "Verified provider workspace", and Clerk's organization is read once.

## org-cache-010

- Vitest: "trusted organization identity cache > preserves the cached identity when Clerk rejects a profile update"
- Mode: run
- Given: A workspace bootstrapped without identity has cached "Original workspace" from a first read, and Clerk rejects profile updates.
- When: The admin updates `PUT /api/org` with name "Rejected workspace", then reads `GET /api/org`.
- Then: The update returns HTTP 500, the org still reads "Original workspace", and Clerk's organization is not read again.
