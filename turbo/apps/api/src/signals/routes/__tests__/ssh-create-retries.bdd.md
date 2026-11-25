# ssh-create-retries

## ssh-create-retries-001

- Vitest: "concurrent host retries acknowledge the same resource without duplicate writes"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS. The host payload is `ssh.example.com` port 443 with an inline password login and an inline Cloudflare Access protection.
- When: The member concurrently sends two host creates with `POST /api/ssh/connections` using the same resource ID in lower and upper case, then repeats the create with the same ID and a changed name.
- Then: One create returns HTTP 201 and the other HTTP 204. The member then has one host, one SSH credential and one Cloudflare Access config. The repeated create returns HTTP 204 with no body, and the host, credential (`GET /api/ssh/credentials`) and access (`GET /api/cloudflare-access/configs`) lists are unchanged.

## ssh-create-retries-002

- Vitest: "concurrent credential retries acknowledge the same resource without duplicate writes"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS. The payload is a named password login.
- When: The member concurrently sends two credential creates with `POST /api/ssh/credentials` using the same resource ID in lower and upper case, then repeats the create with the same ID and a changed name.
- Then: One create returns HTTP 201 and the other HTTP 204. The member then has no host, one SSH credential and no Cloudflare Access config. The repeated create returns HTTP 204 with no body, and all three lists are unchanged.

## ssh-create-retries-003

- Vitest: "concurrent access retries acknowledge the same resource without duplicate writes"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS. The payload is a named Cloudflare Access service token.
- When: The member concurrently sends two access creates with `POST /api/cloudflare-access/configs` using the same resource ID in lower and upper case, then repeats the create with the same ID and a changed name.
- Then: One create returns HTTP 201 and the other HTTP 204. The member then has no host, no SSH credential and one Cloudflare Access config. The repeated create returns HTTP 204 with no body, and all three lists are unchanged.

## ssh-create-retries-004

- Vitest: "a delayed credential create preserves the winning create from same owner"
- Mode: run
- Given: A signed-in member starts a credential create named "Delayed original" whose KMS encryption stalls.
- When: While it is stalled, the same member sends `POST /api/ssh/credentials` with the same ID in upper case named "Winning create"; then the stalled request completes.
- Then: The second create returns HTTP 201 and the delayed original returns HTTP 204. The credential list contains exactly the winning credential with the ID, name `Winning create`, revision 1 and no hosts.

## ssh-create-retries-005

- Vitest: "a delayed credential create preserves the winning create from another user in the same org"
- Mode: run
- Given: A signed-in member starts a credential create named "Delayed original" whose KMS encryption stalls.
- When: While it is stalled, another user in the same organization sends `POST /api/ssh/credentials` with the same ID in upper case named "Winning create"; then the stalled request completes.
- Then: The other user's create returns HTTP 201. The delayed original returns HTTP 409 with `SSH_RESOURCE_ID_CONFLICT` and message "This resource ID cannot be used for this SSH configuration.". The other user's credential list contains exactly the winning credential (ID, name `Winning create`, revision 1, no hosts), and the original member's credential list is empty.

## ssh-create-retries-006

- Vitest: "a delayed original request and its retry create only one set of inline resources"
- Mode: run
- Given: A signed-in member starts a host create (with inline login and Cloudflare Access protection) whose KMS encryption stalls.
- When: While it is stalled, the member retries the same `POST /api/ssh/connections` with the same ID; then the stalled request completes.
- Then: The retry returns HTTP 201 and the original returns HTTP 204. The member has exactly one host with that ID, one SSH credential and one Cloudflare Access config.

## ssh-create-retries-007

- Vitest: "same-ID creation never acknowledges another owner sharing the orgId"
- Mode: run
- Given: A signed-in member has created a host, a credential and an access config all with the same resource ID. A second caller shares the member's organization ID but has a different user ID.
- When: The second caller creates a host, a credential and an access config with that same ID, lists their resources, and then the original member repeats the host create.
- Then: Each of the second caller's creates returns HTTP 409: hosts and credentials with `SSH_RESOURCE_ID_CONFLICT` ("This resource ID cannot be used for this SSH configuration."), access with `CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT` ("This resource ID cannot be used for this Cloudflare Access configuration."). The second caller has no hosts, credentials or access configs. The original member's repeated host create returns HTTP 204 and they still have one host.

## ssh-create-retries-008

- Vitest: "same-ID creation never acknowledges another owner sharing the userId"
- Mode: run
- Given: A signed-in member has created a host, a credential and an access config all with the same resource ID. A second caller shares the member's user ID but is in a different organization.
- When: The second caller creates a host, a credential and an access config with that same ID, lists their resources, and then the original member repeats the host create.
- Then: Each of the second caller's creates returns HTTP 409: hosts and credentials with `SSH_RESOURCE_ID_CONFLICT` ("This resource ID cannot be used for this SSH configuration."), access with `CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT` ("This resource ID cannot be used for this Cloudflare Access configuration."). The second caller has no hosts, credentials or access configs. The original member's repeated host create returns HTTP 204 and they still have one host.

## ssh-create-retries-009

- Vitest: "an owner whose delayed create loses an ID race has no orphan inline resources"
- Mode: run
- Given: A signed-in member starts a host create (with inline login and Cloudflare Access protection) whose KMS encryption stalls.
- When: While it is stalled, another user in the same organization creates a host with the same ID in upper case; then the stalled request completes and the original member lists resources.
- Then: The other user's create returns HTTP 201. The delayed create returns HTTP 409 with `SSH_RESOURCE_ID_CONFLICT`, and the original member has no hosts, SSH credentials or Cloudflare Access configs.

## ssh-create-retries-010

- Vitest: "a known invalid create can be corrected without consuming its resource ID"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS.
- When: The member sends `POST /api/ssh/connections` with host `https://ssh.example.com`, then sends a valid host create with the same ID.
- Then: The invalid create returns HTTP 400 and leaves no hosts, credentials or access configs. The corrected create with the same ID returns HTTP 201.

## ssh-create-retries-011

- Vitest: "a host can be saved again after overlapping low-frequency edits"
- Mode: run
- Given: A signed-in member has a host at generation 1 with a password login.
- When: The member concurrently sends two identical `PATCH /api/ssh/connections/:connectionId` edits at generation 1 that replace the login (named "Replacement"), set port 443 and add inline Cloudflare Access protection; then saves the host again with the current generation and display name "Saved again".
- Then: Each concurrent edit returns HTTP 200 or 409 and the host remains listed. The follow-up save returns HTTP 200, and the host shows display name `Saved again`, generation incremented by one, credential name `Replacement`, username `deploy`, and a credential ID that appears in the member's credential list.
