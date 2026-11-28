# artifact-shares

## artifact-shares-001

- Vitest: "artifact deletion > withdraws private files from the catalog, owner access, and shares"
- Mode: run
- Given: A signed-in organization member owns an uploaded and completed `report.pdf` artifact that is shared with the `private` audience.
- When: The owner deletes it with `DELETE /api/artifacts/catalog/:artifactId`, then reads the catalog, the artifact, and its owner reference, tries to share it publicly, re-completes the upload, and deletes it again.
- Then: The deletion returns HTTP 200 and the catalog list is empty. `GET /api/artifacts/catalog/:artifactId` and `GET /api/artifact-references/:reference` for the owner URL return HTTP 404, `PUT /api/artifact-shares` with `public` returns HTTP 404, and `POST /api/uploads/complete` returns HTTP 404. The repeated deletion returns HTTP 200 and the catalog stays empty.

## artifact-shares-002

- Vitest: "artifact deletion > withdraws organization files from the catalog, owner access, and shares"
- Mode: run
- Given: A signed-in organization member owns an uploaded and completed `report.pdf` artifact that is shared with the `organization` audience.
- When: The owner deletes it with `DELETE /api/artifacts/catalog/:artifactId`, then reads the catalog, the artifact, and its owner reference, tries to share it publicly, re-completes the upload, and deletes it again.
- Then: The deletion returns HTTP 200 and the catalog list is empty. `GET /api/artifacts/catalog/:artifactId` and `GET /api/artifact-references/:reference` for the owner URL return HTTP 404, `PUT /api/artifact-shares` with `public` returns HTTP 404, and `POST /api/uploads/complete` returns HTTP 404. The repeated deletion returns HTTP 200 and the catalog stays empty.

## artifact-shares-003

- Vitest: "artifact deletion > withdraws public files from the catalog, owner access, and shares"
- Mode: run
- Given: A signed-in organization member owns an uploaded and completed `report.pdf` artifact that is shared with the `public` audience.
- When: The owner deletes it with `DELETE /api/artifacts/catalog/:artifactId`, then reads the catalog, the artifact, and its owner reference, tries to share it publicly again, re-completes the upload, and deletes it again.
- Then: The deletion returns HTTP 200 and the catalog list is empty. `GET /api/artifacts/catalog/:artifactId` and `GET /api/artifact-references/:reference` for the owner URL return HTTP 404, `PUT /api/artifact-shares` with `public` returns HTTP 404, and `POST /api/uploads/complete` returns HTTP 404. The repeated deletion returns HTTP 200 and the catalog stays empty.

## artifact-shares-004

- Vitest: "artifact deletion > requires the original organization and owner"
- Mode: run
- Given: A signed-in organization member owns an uploaded artifact in the catalog.
- When: Another user in the same organization, and then the owner signed into a different organization, each call `DELETE /api/artifacts/catalog/:artifactId`; the owner then reads the artifact in the original organization.
- Then: Both deletion attempts return HTTP 404. The owner's `GET /api/artifacts/catalog/:artifactId` returns HTTP 200 with the same artifact ID.

## artifact-shares-005

- Vitest: "artifact deletion > a delayed first public share cannot resurrect a deleted artifact"
- Mode: run
- Given: A signed-in owner has an uploaded private artifact whose owner reference resolves, and copying the file into share storage is held until released.
- When: The owner starts `PUT /api/artifact-shares` with `public`, deletes the artifact with `DELETE /api/artifacts/catalog/:artifactId` while the copy is pending, and then the copy completes.
- Then: The deletion returns HTTP 200 and the delayed share request does not return HTTP 200. Afterwards the owner reference returns HTTP 404 from `GET /api/artifact-references/:reference` and `POST /api/artifact-shares/status` returns HTTP 404.

## artifact-shares-006

- Vitest: "artifact deletion > a retry finishes revocation after its storage write failed"
- Mode: run
- Given: A signed-in owner has publicly shared an uploaded artifact, and the first write to the share-policy storage during deletion fails with a temporary storage error.
- When: The owner calls `DELETE /api/artifacts/catalog/:artifactId`, reads the catalog and owner reference, and then retries the deletion.
- Then: The first deletion returns HTTP 500; the artifact is still listed in the catalog and `GET /api/artifacts/catalog/:artifactId` returns HTTP 200, but the owner reference already returns HTTP 404. The retry returns HTTP 200, after which the artifact read returns HTTP 404 and the owner reference still returns HTTP 404.

## artifact-shares-007

- Vitest: "private share status reuses the fresh membership name and observes renames"
- Mode: run
- Given: A signed-in member of the organization "Original organization" owns an uploaded file.
- When: The owner sets the `private` audience with `PUT /api/artifact-shares`, reads `POST /api/artifact-shares/status` twice, renames the organization to "Renamed organization", and reads the status again.
- Then: The update returns HTTP 200 with audience `private` and the organization ID and name "Original organization". Both status reads return HTTP 200 with the same body and `cache-control: private, no-store`. After the rename, the status shows "Renamed organization". The organization lookup is never called and the membership list is queried exactly 4 times.

## artifact-shares-008

- Vitest: "organization share status reuses the fresh membership name and observes renames"
- Mode: run
- Given: A signed-in member of the organization "Original organization" owns an uploaded file.
- When: The owner sets the `organization` audience with `PUT /api/artifact-shares`, reads `POST /api/artifact-shares/status` twice, renames the organization to "Renamed organization", and reads the status again.
- Then: The update returns HTTP 200 with audience `organization` and the organization ID and name "Original organization". Both status reads return HTTP 200 with the same body and `cache-control: private, no-store`. After the rename, the status shows "Renamed organization". The organization lookup is never called and the membership list is queried exactly 4 times.

## artifact-shares-009

- Vitest: "public share status reuses the fresh membership name and observes renames"
- Mode: run
- Given: A signed-in member of the organization "Original organization" owns an uploaded file.
- When: The owner sets the `public` audience with `PUT /api/artifact-shares`, reads `POST /api/artifact-shares/status` twice, renames the organization to "Renamed organization", and reads the status again.
- Then: The update returns HTTP 200 with audience `public` and the organization ID and name "Original organization". Both status reads return HTTP 200 with the same body and `cache-control: private, no-store`. After the rename, the status shows "Renamed organization". The organization lookup is never called and the membership list is queried exactly 4 times.

## artifact-shares-010

- Vitest: "removing the owner denies status and updates after successful name reads"
- Mode: run
- Given: A signed-in owner has publicly shared an uploaded file and can read its share status, and then the owner is removed from the organization.
- When: The owner calls `POST /api/artifact-shares/status` and `PUT /api/artifact-shares` with `organization`.
- Then: The status request returns HTTP 404 with error code `NOT_FOUND` and message "Artifact not found". The update returns HTTP 404.

## artifact-shares-011

- Vitest: "viewing and copying stable references grant nothing; only the owner can manage sharing"
- Mode: run
- Given: A signed-in owner has an uploaded file, and another member of the same organization is signed in for part of the test.
- When: The owner reads `POST /api/artifact-shares/status`; the peer then calls the status endpoint, `PUT /api/artifact-shares` with `public`, and `GET /api/web/file-url?file_id=...`; finally the owner shares the file publicly.
- Then: The owner's initial status is HTTP 200 with audience `private`, `shareId` null and `url` null, and no share-policy object is stored. The peer's status, update and file URL requests each return HTTP 404. The owner's public update returns HTTP 200 with audience `public`.

## artifact-shares-012

- Vitest: "agent sharing and the Share menu reuse one policy, including revocation"
- Mode: run
- Given: An owner has an uploaded file, and an agent run token for the same user and organization has `artifact:read` and `artifact:write` capabilities.
- When: The agent reads `POST /api/artifact-shares/status`, then shares the file with `organization` and then `public` via `PUT /api/artifact-shares`, the signed-in owner reads status and repeats each update, and finally the agent sets `private`.
- Then: The initial status is HTTP 200 with an owner URL matching `https://app.okou.ai/artifacts/<10 chars>.pdf`, audience `private`, and null share ID and URL. Each agent share returns a non-null URL with the unchanged owner URL (the organization URL equals the owner URL), and the owner's status and repeated update return identical bodies. The final revocation returns audience `private`, `url` null and the same owner URL, matching the owner's status.

## artifact-shares-013

- Vitest: "artifact capabilities do not let agents manage another owner's share"
- Mode: run
- Given: An owner has an uploaded private file, and a peer in the same organization holds an agent run token with `artifact:read` and `artifact:write`.
- When: The peer's agent calls `POST /api/artifact-shares/status` and `PUT /api/artifact-shares` with `public` for the owner's file.
- Then: Both requests return HTTP 404. The owner's status still shows audience `private` with null share ID and URL.

## artifact-shares-014

- Vitest: "artifact availability requires artifact read access"
- Mode: run
- Given: An agent run token for an organization member has only `artifact:read`, and a second token has only `file:write` and `host:write`.
- When: Each token calls `GET /api/artifact-shares/availability`.
- Then: The `artifact:read` token gets HTTP 200 with `{ enabled: true }`, `cache-control: private, no-store` and `referrer-policy: no-referrer`. The other token gets HTTP 403.

## artifact-shares-015

- Vitest: "upload, hosting and read-only run capabilities cannot change sharing"
- Mode: run
- Given: An owner has an uploaded private file. Agent run tokens for the owner carry `file:write` plus `host:write`, only `artifact:read`, or no capabilities, and a sandbox-scoped token also exists for the owner.
- When: Each run token calls `PUT /api/artifact-shares` with `public` and `POST /api/artifact-shares/status`; the sandbox token calls `PUT /api/artifact-shares` with `public`.
- Then: Every update returns HTTP 403, including the sandbox token. Status returns HTTP 200 only for the `artifact:read` token and HTTP 403 for the others. The owner's status still shows audience `private` with null share ID and URL.

## artifact-shares-016

- Vitest: "hostless owner references authorize before signing and ignore extension hints"
- Mode: run
- Given: A signed-in owner has an uploaded `report.pdf` and a reference built for the name `renamed.html`; a peer in the same organization and an unauthenticated caller also exist.
- When: The owner calls `GET /api/artifact-references/:reference` twice, then the peer calls it, then an unauthenticated caller calls it without credentials.
- Then: The owner gets HTTP 200 with filename `report.pdf`, content type `application/pdf`, the file target, a signed URL containing `signature=temporary` and `cache-control: private, no-store`, and no share-policy object is stored; the second read also returns HTTP 200. The peer gets HTTP 404 and no new URL is signed. The unauthenticated caller gets HTTP 401 with `cache-control: private, no-store`.

## artifact-shares-017

- Vitest: "resolves report.html without inventing a poster and preserves file share authorization"
- Mode: run
- Given: A signed-in owner has an uploaded `report.html` (`text/html`) file, and a peer in the same organization exists.
- When: The owner and peer call `GET /api/artifact-references/:reference` before sharing, after the owner shares to `organization`, with `kind=file`, after the peer is removed, and after the owner revokes to `private` and the peer is re-added.
- Then: The owner gets HTTP 200 with the filename, content type and target, no `previewImageUrl`, and `cache-control: private, no-store`. The peer gets HTTP 404 before sharing and HTTP 200 without `previewImageUrl` after organization sharing, but HTTP 404 for the `kind=file` typed resolution. After removal from the organization and after revocation, the peer gets HTTP 404.

## artifact-shares-018

- Vitest: "resolves demo.mp4 without inventing a poster and preserves file share authorization"
- Mode: run
- Given: A signed-in owner has an uploaded `demo.mp4` (`video/mp4`) file, and a peer in the same organization exists.
- When: The owner and peer call `GET /api/artifact-references/:reference` before sharing, after the owner shares to `organization`, with `kind=file`, after the peer is removed, and after the owner revokes to `private` and the peer is re-added.
- Then: The owner gets HTTP 200 with the filename, content type and target, no `previewImageUrl`, and `cache-control: private, no-store`. The peer gets HTTP 404 before sharing and HTTP 200 without `previewImageUrl` after organization sharing, but HTTP 404 for the `kind=file` typed resolution. After removal from the organization and after revocation, the peer gets HTTP 404.

## artifact-shares-019

- Vitest: "a private file keeps the same short reference through organization sharing and revocation"
- Mode: run
- Given: A signed-in owner prepares and completes an artifact upload of `report.pdf`, and another member of the same organization exists.
- When: The recipient resolves the upload's URL reference via `GET /api/artifact-references/:reference`, the owner shares with `organization` via `PUT /api/artifact-shares`, the recipient resolves again, the owner revokes to `private`, and both resolve again.
- Then: The prepared URL matches `https://app.okou.ai/artifacts/<10 chars>.pdf`. The recipient first gets HTTP 404. The share returns HTTP 200 with `shortUrl` and `url` equal to the prepared URL and writes no new reference-registry object. The recipient then resolves the same file target with HTTP 200. After revocation the owner still gets HTTP 200 and the recipient gets HTTP 404.

## artifact-shares-020

- Vitest: "agent reference resolution enforces resource capability, type and ownership"
- Mode: run
- Given: An owner has an uploaded file shared with the `organization` audience, and another organization member exists. Agent run tokens each carry a single capability.
- When: Each token calls `GET /api/artifact-references/:reference` with a `kind` query.
- Then: Owner with `file:read` and `kind=file` gets HTTP 200 with the file target; owner with `host:read` and `kind=file` gets HTTP 403; owner with `host:read` and `kind=html` gets HTTP 404; recipient with `file:read` and `kind=file` gets HTTP 404; owner with `artifact:read` and `kind=artifact` gets HTTP 200 with the file target; owner with `file:read` and `kind=artifact` gets HTTP 403; recipient with `artifact:read` and `kind=artifact` gets HTTP 404.

## artifact-shares-021

- Vitest: "GET /api/artifact-references/:reference/read > the owner can read a private file without granting recipient access"
- Mode: run
- Given: An owner has an uploaded private `report.pdf`, and another organization member exists. Both hold agent run tokens with `artifact:read`.
- When: The owner's agent calls `GET /api/artifact-references/:reference/read` with the owner reference renamed to `.html`; the recipient's agent calls it with the real reference and with a reference for a nonexistent file.
- Then: The owner gets HTTP 200 with exactly the signed URL, filename `report.pdf` and content type `application/pdf`, plus `cache-control: private, no-store` and `referrer-policy: no-referrer`. The recipient gets HTTP 404 for both references with identical bodies and no `url`. The owner's share status is unchanged.

## artifact-shares-022

- Vitest: "GET /api/artifact-references/:reference/read > short organization reads require current membership and retain owner-only management"
- Mode: run
- Given: An owner has shared an uploaded `report.pdf` with the `organization` audience and the caller uses the short share URL reference. A recipient holds an agent run token with `artifact:read` and `artifact:write`, and a non-member holds a run token claiming the same organization.
- When: The non-member and then the recipient (once added to the organization) call `GET /api/artifact-references/:reference/read`; the recipient also reads with a token for another organization, calls share status, update and typed `kind=artifact` resolution; the recipient is removed and re-added, and the owner revokes to `private`.
- Then: The non-member gets HTTP 404. The current member gets HTTP 200 with exactly the signed URL, `report.pdf` and `application/pdf`, and also HTTP 200 with a token claiming another organization. The recipient's `POST /api/artifact-shares/status`, `PUT /api/artifact-shares` and `GET /api/artifact-references/:reference?kind=artifact` all return HTTP 404. After removal and after revocation the recipient's read returns HTTP 404, while the owner's agent read still returns HTTP 200.

## artifact-shares-023

- Vitest: "GET /api/artifact-references/:reference/read > legacy organization reads require current membership and retain owner-only management"
- Mode: run
- Given: An owner has shared an uploaded `report.pdf` with the `organization` audience and the caller uses the legacy share-ID path reference. A recipient holds an agent run token with `artifact:read` and `artifact:write`, and a non-member holds a run token claiming the same organization.
- When: The non-member and then the recipient (once added to the organization) call `GET /api/artifact-references/:reference/read`; the recipient also reads with a token for another organization, calls share status, update and typed `kind=artifact` resolution; the recipient is removed and re-added, and the owner revokes to `private`.
- Then: The non-member gets HTTP 404. The current member gets HTTP 200 with exactly the signed URL, `report.pdf` and `application/pdf`, and also HTTP 200 with a token claiming another organization. The recipient's `POST /api/artifact-shares/status`, `PUT /api/artifact-shares` and `GET /api/artifact-references/:reference?kind=artifact` all return HTTP 404. After removal and after revocation the recipient's read returns HTTP 404, while the owner's agent read still returns HTTP 200.

## artifact-shares-024

- Vitest: "GET /api/artifact-references/:reference/read > legacy-short organization reads require current membership and retain owner-only management"
- Mode: run
- Given: An owner has shared an uploaded `report.pdf` with the `organization` audience and the caller uses the legacy short reference stored in the reference registry. A recipient holds an agent run token with `artifact:read` and `artifact:write`, and a non-member holds a run token claiming the same organization.
- When: The non-member and then the recipient (once added to the organization) call `GET /api/artifact-references/:reference/read`; the recipient also reads with a token for another organization, calls share status, update and typed `kind=artifact` resolution; the recipient is removed and re-added, and the owner revokes to `private`.
- Then: The non-member gets HTTP 404. The current member gets HTTP 200 with exactly the signed URL, `report.pdf` and `application/pdf`, and also HTTP 200 with a token claiming another organization. The recipient's `POST /api/artifact-shares/status`, `PUT /api/artifact-shares` and `GET /api/artifact-references/:reference?kind=artifact` all return HTTP 404. After removal and after revocation the recipient's read returns HTTP 404, while the owner's agent read still returns HTTP 200.

## artifact-shares-025

- Vitest: "GET /api/artifact-references/:reference/read > an outside agent can read public file references until the owner revokes sharing"
- Mode: run
- Given: An owner has shared an uploaded `report.pdf` publicly, and a legacy short reference for the share also exists. An outside user in a different organization holds an agent run token with `artifact:read`.
- When: The outsider calls `GET /api/artifact-references/:reference/read` with the owner reference, the legacy share-ID path, and the legacy short reference, before and after the owner revokes to `private`.
- Then: Before revocation each read returns HTTP 200 with exactly the public share URL, `report.pdf` and `application/pdf`. After revocation each read returns HTTP 404 without a `url`.

## artifact-shares-026

- Vitest: "GET /api/artifact-references/:reference/read > even public references require authentication and artifact read capability"
- Mode: run
- Given: An owner has shared an uploaded file publicly. Agent run tokens for the owner carry no capabilities or only `file:read`, `host:read` and `artifact:write`; an unauthenticated caller also exists.
- When: Each caller calls `GET /api/artifact-references/:reference/read` with the owner reference.
- Then: Both run tokens get HTTP 403 and the unauthenticated caller gets HTTP 401; none of the responses contain a `url`.

## artifact-shares-027

- Vitest: "short organization references use current membership and support revocation"
- Mode: run
- Given: An owner has shared an uploaded `report.pdf` with the `organization` audience (the returned short URL matches `https://app.okou.ai/artifacts/<10 chars>.pdf`), and the caller uses the short share URL reference. Another member of the original organization is signed into a different organization.
- When: The recipient calls `GET /api/artifact-references/:reference`, is removed from the original organization and calls again, is re-added; the owner revokes to `private` and resolves; the recipient resolves again.
- Then: The recipient first gets HTTP 200 with the file target, then HTTP 404 after removal. After revocation the owner still gets HTTP 200 and the recipient gets HTTP 404.

## artifact-shares-028

- Vitest: "legacy organization references use current membership and support revocation"
- Mode: run
- Given: An owner has shared an uploaded `report.pdf` with the `organization` audience (the returned short URL matches `https://app.okou.ai/artifacts/<10 chars>.pdf`), and the caller uses the legacy share-ID path reference. Another member of the original organization is signed into a different organization.
- When: The recipient calls `GET /api/artifact-references/:reference`, is removed from the original organization and calls again, is re-added; the owner revokes to `private` and resolves; the recipient resolves again.
- Then: The recipient first gets HTTP 200 with the file target, then HTTP 404 after removal. After revocation the owner still gets HTTP 200 and the recipient gets HTTP 404.

## artifact-shares-029

- Vitest: "legacy-short organization references use current membership and support revocation"
- Mode: run
- Given: An owner has shared an uploaded `report.pdf` with the `organization` audience (the returned short URL matches `https://app.okou.ai/artifacts/<10 chars>.pdf`), and the caller uses the legacy short reference stored in the reference registry. Another member of the original organization is signed into a different organization.
- When: The recipient calls `GET /api/artifact-references/:reference`, is removed from the original organization and calls again, is re-added; the owner revokes to `private` and resolves; the recipient resolves again.
- Then: The recipient first gets HTTP 200 with the file target, then HTTP 404 after removal. After revocation the owner still gets HTTP 200 and the recipient gets HTTP 404.

## artifact-shares-030

- Vitest: "older organization policies allocate a short link only on explicit sharing (index retained=false)"
- Mode: run
- Given: An owner has shared an uploaded file with the `organization` audience, and its stored policy is rewritten to an older format without an organization reference; the short-link index entry is deleted.
- When: The owner calls `POST /api/artifact-shares/status`, then `PUT /api/artifact-shares` with `organization`.
- Then: The status returns HTTP 200 with `shortUrl` and `url` null and writes nothing to storage. The explicit update returns HTTP 200 with the original short URL and URL.

## artifact-shares-031

- Vitest: "older organization policies allocate a short link only on explicit sharing (index retained=true)"
- Mode: run
- Given: An owner has shared an uploaded file with the `organization` audience, and its stored policy is rewritten to an older format without an organization reference; the short-link index entry is retained.
- When: The owner calls `POST /api/artifact-shares/status`, then `PUT /api/artifact-shares` with `organization`.
- Then: The status returns HTTP 200 with `shortUrl` and `url` null and writes nothing to storage. The explicit update returns HTTP 200 with the original short URL and URL.

## artifact-shares-032

- Vitest: "reading a pre-registry public grant preserves its working URL without publishing a new alias"
- Mode: run
- Given: An owner has a public share whose stored policy is rewritten to a pre-registry format with a 24-character public token and no delivery alias, and all delivery alias objects are removed.
- When: The owner calls `POST /api/artifact-shares/status`.
- Then: The response is HTTP 200 with the URL `https://sh-<shareId without dashes>-<token>.okou.app/`, and storage is unchanged.

## artifact-shares-033

- Vitest: "public filename collisions retry without replacing a historical file"
- Mode: run
- Given: An owner has an uploaded file, and while publishing, the first public delivery alias name it tries is already registered to a historical file `old.pdf`.
- When: The owner calls `PUT /api/artifact-shares` with `public` twice.
- Then: The first update returns HTTP 200 with a URL whose path matches `<10 chars>.pdf`, on a different alias than the colliding one, and the historical registration is left unchanged. The repeated update returns HTTP 200 with the same URL and writes no new delivery alias.

## artifact-shares-034

- Vitest: "existing 24-character public file links survive updates and revoke normally"
- Mode: run
- Given: An owner has a public share whose stored policy is rewritten to use an existing 24-character public token.
- When: The owner calls `PUT /api/artifact-shares` with `public`, then with `private`.
- Then: The public update returns HTTP 200 with URL `https://a.okou.io/<24 a's>.pdf` and a delivery alias for that token exists. The private update returns HTTP 200, after which the stored policy has status `revoked` and `publicToken` null.

## artifact-shares-035

- Vitest: "exhausted public hash collisions preserve registrations and grant no publication"
- Mode: run
- Given: An owner has an uploaded file, and every public delivery alias the publication tries to register is already taken by a historical file `old.pdf`.
- When: The owner calls `PUT /api/artifact-shares` with `public`, then `POST /api/artifact-shares/status`.
- Then: The update returns HTTP 500 and the conflicting historical registration is unchanged. The status returns HTTP 200 with audience `private` and `url` null.

## artifact-shares-036

- Vitest: "organization resolution checks current original-org membership and never grants reshare rights"
- Mode: run
- Given: An owner has shared an uploaded file with the `organization` audience; a recipient is signed into a different organization, and the clock is at `2026-09-09T12:00:00.123Z` for the resolution.
- When: The recipient calls `GET /api/artifact-shares/:id/resolve` before and after joining the original organization, resolves again after the signer would return a different URL, calls share status, is removed and resolves again; an unauthenticated caller also resolves.
- Then: The share returns HTTP 200 with `url` equal to `shortUrl` and `cache-control: private, no-store`. The non-member gets HTTP 404; the member gets HTTP 200 with a signed URL, `expiresAt` `2026-09-11T12:00:00.000Z` and `cache-control: private, no-store`, signed for 172,800 seconds at the whole-second signing date with response cache control `private, max-age=31536000, must-revalidate`. The repeated resolution returns the same URL. The recipient's status request returns HTTP 404, resolution after removal returns HTTP 404, and the unauthenticated request returns HTTP 401 with `cache-control: private, no-store`.

## artifact-shares-037

- Vitest: "a deleted original organization makes an existing share unavailable"
- Mode: run
- Given: An owner has shared an uploaded file with the `organization` audience, and the identity provider then reports the original organization as not found (404) for membership lookups.
- When: A user from another organization calls `GET /api/artifact-shares/:id/resolve`; the owner then calls `POST /api/artifact-shares/status` and `PUT /api/artifact-shares` with `public`.
- Then: The resolution returns HTTP 404 with error code `NOT_FOUND`, message "Artifact unavailable" and `cache-control: private, no-store`. The owner's status and update both return HTTP 404.

## artifact-shares-038

- Vitest: "a membership provider outage remains an error rather than a missing organization > resolve returns an error without a delivery URL"
- Mode: run
- Given: A signed-in owner has shared an uploaded file with the `organization` audience, and the organization membership lookup then fails with a provider outage (HTTP 503).
- When: The owner calls `GET /api/artifact-shares/:id/resolve` for that file.
- Then: The response is HTTP 500 and the body contains no `url`.

## artifact-shares-039

- Vitest: "a membership provider outage remains an error rather than a missing organization > status returns an error without a delivery URL"
- Mode: run
- Given: A signed-in owner has shared an uploaded file with the `organization` audience, and the organization membership lookup then fails with a provider outage (HTTP 503).
- When: The owner calls `POST /api/artifact-shares/status` for that file.
- Then: The response is HTTP 500 and the body contains no `url`.

## artifact-shares-040

- Vitest: "a membership provider outage remains an error rather than a missing organization > update returns an error without a delivery URL"
- Mode: run
- Given: A signed-in owner has shared an uploaded file with the `organization` audience, and the organization membership lookup then fails with a provider outage (HTTP 503).
- When: The owner calls `PUT /api/artifact-shares` with `public` for that file.
- Then: The response is HTTP 500 and the body contains no `url`.

## artifact-shares-041

- Vitest: "a membership rate limit remains an error rather than a missing organization > resolve returns an error without a delivery URL"
- Mode: run
- Given: A signed-in owner has shared an uploaded file with the `organization` audience, and the organization membership lookup then fails with a rate limit (HTTP 429).
- When: The owner calls `GET /api/artifact-shares/:id/resolve` for that file.
- Then: The response is HTTP 500 and the body contains no `url`.

## artifact-shares-042

- Vitest: "a membership rate limit remains an error rather than a missing organization > status returns an error without a delivery URL"
- Mode: run
- Given: A signed-in owner has shared an uploaded file with the `organization` audience, and the organization membership lookup then fails with a rate limit (HTTP 429).
- When: The owner calls `POST /api/artifact-shares/status` for that file.
- Then: The response is HTTP 500 and the body contains no `url`.

## artifact-shares-043

- Vitest: "a membership rate limit remains an error rather than a missing organization > update returns an error without a delivery URL"
- Mode: run
- Given: A signed-in owner has shared an uploaded file with the `organization` audience, and the organization membership lookup then fails with a rate limit (HTTP 429).
- When: The owner calls `PUT /api/artifact-shares` with `public` for that file.
- Then: The response is HTTP 500 and the body contains no `url`.

## artifact-shares-044

- Vitest: "a membership unclassified failure remains an error rather than a missing organization > resolve returns an error without a delivery URL"
- Mode: run
- Given: A signed-in owner has shared an uploaded file with the `organization` audience, and the organization membership lookup then fails with a unclassified failure (a generic error carrying status 404).
- When: The owner calls `GET /api/artifact-shares/:id/resolve` for that file.
- Then: The response is HTTP 500 and the body contains no `url`.

## artifact-shares-045

- Vitest: "a membership unclassified failure remains an error rather than a missing organization > status returns an error without a delivery URL"
- Mode: run
- Given: A signed-in owner has shared an uploaded file with the `organization` audience, and the organization membership lookup then fails with a unclassified failure (a generic error carrying status 404).
- When: The owner calls `POST /api/artifact-shares/status` for that file.
- Then: The response is HTTP 500 and the body contains no `url`.

## artifact-shares-046

- Vitest: "a membership unclassified failure remains an error rather than a missing organization > update returns an error without a delivery URL"
- Mode: run
- Given: A signed-in owner has shared an uploaded file with the `organization` audience, and the organization membership lookup then fails with a unclassified failure (a generic error carrying status 404).
- When: The owner calls `PUT /api/artifact-shares` with `public` for that file.
- Then: The response is HTTP 500 and the body contains no `url`.

## artifact-shares-047

- Vitest: "audience changes revoke old public tokens and permit stopping"
- Mode: run
- Given: A signed-in owner has an uploaded file.
- When: The owner calls `PUT /api/artifact-shares` with `public`, then `organization`, then `public` again, resolves the share with `GET /api/artifact-shares/:id/resolve`, sets `private`, and resolves again.
- Then: The first public URL matches `https://a.okou.io/<10 chars>.pdf`. The organization update keeps the same share ID and stores audience `organization` with `publicToken` null. Republishing returns a different URL than the first. Resolution returns HTTP 200 before stopping and HTTP 404 after the private update, and the stored policy has status `revoked`, audience `private` and `publicToken` null.

## artifact-shares-048

- Vitest: "organization sharing preserves the file reference allocated after a collision"
- Mode: run
- Given: An owner has one file shared with the `organization` audience, and when a second file is shared, the first short reference it tries is already registered to the first file's share.
- When: The owner shares the second file with `organization` via `PUT /api/artifact-shares`, then resolves both the returned short reference and the colliding reference with `GET /api/artifact-references/:reference`.
- Then: The share returns HTTP 200 with a short reference matching `<10 chars>.pdf`, which resolves with HTTP 200 to the second file. The colliding reference still resolves with HTTP 200 to the first file.

## artifact-shares-049

- Vitest: "a failed publication write does not report a narrower audience, and unavailable policy fails closed"
- Mode: run
- Given: An owner has publicly shared an uploaded file, and writes to share-policy storage then fail; later, all storage requests fail.
- When: The owner calls `PUT /api/artifact-shares` with `organization`, reads `POST /api/artifact-shares/status`, and after storage becomes fully unavailable calls `GET /api/artifact-shares/:id/resolve`.
- Then: The update returns HTTP 500. The status returns HTTP 200 still showing audience `public` with the original public URL. The resolution returns HTTP 500.

## artifact-shares-050

- Vitest: "stopping an unpublished file records revocation and preserves its snapshot for a later explicit share"
- Mode: run
- Given: A signed-in owner has an uploaded file that has never been shared, and another member of the organization exists.
- When: The owner calls `PUT /api/artifact-shares` with `private` and reads status; the recipient resolves the share with `GET /api/artifact-shares/:id/resolve`; the owner then shares with `organization` and the recipient resolves again.
- Then: The stop returns HTTP 200 with audience `private`, null `url` and `shortUrl`, the selected target, and a share ID; the status matches it exactly. The recipient's first resolution returns HTTP 404. The organization share keeps the same share ID, and the recipient's resolution returns HTTP 200 with a signed URL for a key under `private-artifacts/<file id>/shares/`.

## artifact-shares-051

- Vitest: "sharing copies file bytes once into private storage without changing the owner reference"
- Mode: run
- Given: A signed-in owner has an uploaded `report.pdf`.
- When: The owner shares it with `organization`, then with `public` via `PUT /api/artifact-shares`, and then calls `GET /api/web/file-url?file_id=...`.
- Then: Exactly one storage copy happens, from `test-private-artifacts/private-artifacts/<file id>/report.pdf` into a `/shares/` key in the `test-private-artifacts` bucket, and the public update makes no further copy. The owner's file URL response is HTTP 200 with `publicUrl` null.

## artifact-shares-052

- Vitest: "a delayed publication cannot restore public access after a newer organization update"
- Mode: run
- Given: An owner has publicly shared an uploaded file, and a second public publication is held while writing its share policy.
- When: While the publication is pending, the owner calls `PUT /api/artifact-shares` with `organization`; the held publication then resumes, and the owner reads status and requests `GET /api/artifact-references/:reference/public` for the file.
- Then: The organization update returns HTTP 200 and the delayed publication returns HTTP 500. The status shows audience `organization` with the original share ID, and the public URL lookup returns HTTP 404.

## artifact-shares-053

- Vitest: "a delayed publication cannot restore public access after a newer private update"
- Mode: run
- Given: An owner has publicly shared an uploaded file, and a second public publication is held while writing its share policy.
- When: While the publication is pending, the owner calls `PUT /api/artifact-shares` with `private`; the held publication then resumes, and the owner reads status, resolves the share and requests `GET /api/artifact-references/:reference/public` for the file.
- Then: The private update returns HTTP 200 and the delayed publication returns HTTP 500. The status shows audience `private` with the original share ID and `url` null, `GET /api/artifact-shares/:id/resolve` returns HTTP 404, and the public URL lookup returns HTTP 404.

## artifact-shares-054

- Vitest: "a first publication preparing its snapshot cannot grant access after an initial stop"
- Mode: run
- Given: An owner has a never-shared uploaded file, and the first public publication is held while copying its snapshot.
- When: While the copy is pending, the owner calls `PUT /api/artifact-shares` with `private`; the copy then resumes, and the owner reads status, resolves the share, and requests `GET /api/artifact-references/:reference/public`.
- Then: The stop returns HTTP 200 and the delayed publication returns HTTP 500. The status shows audience `private` and `url` null, the share resolution returns HTTP 404, and the public URL lookup returns HTTP 404.

## artifact-shares-055

- Vitest: "canonical file links disclose public previews only while explicitly public, without authentication"
- Mode: run
- Given: A signed-in owner has an uploaded `report.pdf` that has never been shared, and another organization member exists. Public lookups are made without authentication.
- When: Callers request `GET /api/artifact-references/:reference/public` for the file reference and a missing file, after organization sharing (file and short references), after public sharing (file, short, and `.html`-renamed references, anonymously), and after the owner revokes to `private`; the owner and the recipient then resolve the short reference and the recipient tries to publish.
- Then: The private and missing lookups return identical HTTP 404 bodies with `NOT_FOUND` "Artifact unavailable", and the organization-only lookups return the same 404. While public, all three references return HTTP 200 with exactly the public URL, a download URL, and preview `report.pdf`/`application/pdf`, plus `cache-control: private, no-store` and `referrer-policy: no-referrer`. After revocation the lookups return the same 404 with those headers. The owner still resolves the short reference with HTTP 200, while the recipient gets HTTP 404 for resolution and for `PUT /api/artifact-shares` with `public`.

## artifact-shares-056

- Vitest: "oG checks anonymous sharing again for old image URLs after a public share becomes organization-only or revoked"
- Mode: run
- Given: A signed-in owner has an uploaded PNG image `confidential-report.png`, and open graph requests are made anonymously by file reference.
- When: Callers request `GET /api/artifact-og/metadata` before and after public sharing, `GET /api/artifact-og/image` (default and `slack` variant) and `GET /api/artifact-og/default.png`; the owner then switches the share to `organization` and to `private` and repeats the requests, and finally republishes and requests the old image URL.
- Then: Metadata is `{ available: false }` before sharing. When public, metadata has title `confidential-report.png` and a scaled `/cdn-cgi/image/` URL wrapping `/api/artifact-og/image` with the reference and a version; the image request redirects (HTTP 302, `cache-control: private, no-store`) to a signed 60-second URL under `private-artifacts/<file id>/shares/.../confidential-report.png` with response cache control `private, no-store, must-revalidate`, the `slack` variant redirects to the same path, and the default image redirects to the brand image. After the organization and private updates, metadata is unavailable and both image variants redirect to the brand image with `cache-control: private, no-store`. After republishing, the old versioned image URL still redirects to the brand image.

## artifact-shares-057

- Vitest: "only the owner can resolve a private artifact reference for deletion"
- Mode: run
- Given: A signed-in owner has an uploaded catalog artifact shared with the `private` audience, and another organization member exists.
- When: The owner calls `GET /api/artifact-references/:reference/owner-artifact` with the owner reference and with the legacy file reference; the recipient calls it; an unauthenticated request is made; the owner deletes the artifact and calls it again.
- Then: Both owner requests return HTTP 200 with exactly `{ artifactId }`. The recipient gets HTTP 404 and the unauthenticated request gets HTTP 401. After `DELETE /api/artifacts/catalog/:artifactId` returns HTTP 200, the owner request returns HTTP 404.

## artifact-shares-058

- Vitest: "only the owner can resolve a organization artifact reference for deletion"
- Mode: run
- Given: A signed-in owner has an uploaded catalog artifact shared with the `organization` audience, and another organization member exists.
- When: The owner calls `GET /api/artifact-references/:reference/owner-artifact` with the owner reference and with the legacy file reference; the recipient calls it; an unauthenticated request is made; the owner deletes the artifact and calls it again.
- Then: Both owner requests return HTTP 200 with exactly `{ artifactId }`. The recipient gets HTTP 404 and the unauthenticated request gets HTTP 401. After `DELETE /api/artifacts/catalog/:artifactId` returns HTTP 200, the owner request returns HTTP 404.

## artifact-shares-059

- Vitest: "only the owner can resolve a public artifact reference for deletion"
- Mode: run
- Given: A signed-in owner has an uploaded catalog artifact shared with the `public` audience, and another organization member exists.
- When: The owner calls `GET /api/artifact-references/:reference/owner-artifact` with the owner reference and with the legacy file reference; the recipient calls it; an unauthenticated request is made; the owner deletes the artifact and calls it again.
- Then: Both owner requests return HTTP 200 with exactly `{ artifactId }`. The recipient gets HTTP 404 and the unauthenticated request gets HTTP 401. After `DELETE /api/artifacts/catalog/:artifactId` returns HTTP 200, the owner request returns HTTP 404.
