# host-delivery-authorization

## host-delivery-authorization-001

- Vitest: "rejects malformed pointer identities at the anonymous request boundary"
- Mode: run
- Given: An anonymous caller (the host Worker) and random site and deployment IDs that do not exist.
- When: The caller requests `GET /api/host/delivery/:siteId/:deploymentId` once with prefix `private-sites/missing` and once with a well-formed `sites/missing` prefix, manifest key, alias, public slug, and `okou` brand.
- Then: The malformed-prefix request returns HTTP 400 with error code `BAD_REQUEST`. The well-formed request for the missing site returns HTTP 200 with exactly `{ allowed: false, decision: "deny" }` and `Cache-Control: private, no-store`.

## host-delivery-authorization-002

- Vitest: "denies late immutable writes after deletion even when R2 loses the response"
- Mode: run
- Given: A Pro member prepared a hosted site whose completion stalls while writing the version pointer; when it resumes, storage accepts the version delivery record but the response is lost.
- When: The owner deletes the site during the stall, the completion resumes, the owner reads the version's files, and the host Worker asks `GET /api/host/delivery/:siteId/:deploymentId` about the residual version pointer with alias `dpl-<deploymentId>`.
- Then: The completion returns HTTP 500 and the version's files return HTTP 409. The residual version delivery record is still present in storage, and delivery authorization returns HTTP 200 with `allowed` false.

## host-delivery-authorization-003

- Vitest: "waits for SQL readiness when the public pointer already exists"
- Mode: run
- Given: A member prepared a public hosted site, and its completion stalls right after the site's HTML delivery record has been written, with the site's active pointer already in storage.
- When: The host Worker requests `GET /api/host/delivery/:siteId/:deploymentId` with the pointer's identity and the site alias before and after the completion finishes.
- Then: Before completion finishes the request returns `allowed` false; after it finishes the same request returns `allowed` true.

## host-delivery-authorization-004

- Vitest: "authorizes ready owned identities, keeps immutable history and denies deleted content"
- Mode: run
- Given: A member prepared a public hosted site; another user publishes their own site.
- When: The host Worker checks `GET /api/host/delivery/:siteId/:deploymentId` for the first version before and after completion, with upper-cased IDs, with mismatched brand, slug, prefix, manifest key, or alias, with the other user's deployment or site ID, after a newer version is published (by site alias and by `dpl-<id>` alias), after the site is deleted, and for a replacement version published afterwards.
- Then: Every response has `Cache-Control: private, no-store`. The first version is denied before completion and allowed afterwards (also with upper-cased IDs), and its site pointer names it. Each mismatched field and each foreign site or deployment is denied. After the newer version, the old version is denied under the site alias but allowed under its `dpl-` alias. After deletion the old `dpl-` alias is denied, the replacement version is allowed with its own prefix, and the old `dpl-` alias stays denied.
