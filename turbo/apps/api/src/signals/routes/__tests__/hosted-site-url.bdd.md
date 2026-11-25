# hosted-site-url

## hosted-site-url-001

- Vitest: "renames only the active address while immutable versions and the CLI site identity survive"
- Mode: run
- Given: A signed-in owner with a Pro entitlement has published a public hosted site at `<name>.okou.app`.
- When: The owner renames it with `PATCH /api/host/sites/:siteId/url` to `<name>-new` (expected `<name>`), reads `GET /api/host/sites/dpl-<deploymentId>/url`, resolves `GET /api/host/aliases/:publicSlug` for both names, checks delivery authorization for the new name, old name and `dpl-<deploymentId>`, redeploys with the CLI site name `<name>`, and renames back to `<name>`.
- Then: The rename returns `{siteId, publicSlug: <name>-new, url: https://<name>-new.okou.app, isActive: true}` and the immutable-address read returns the same body. The new alias points to the original site and deployment (pointer `publicSlug` `<name>`) and the old alias has no pointer. Delivery is allowed for the new name and `dpl-` address and refused for the old name. The redeployment keeps the same site ID, reports public slug `<name>-new` and completes at `https://<name>-new.okou.app`; after renaming back, `<name>` resolves to the new deployment.

## hosted-site-url-002

- Vitest: "validates addresses and hides other owners' websites"
- Mode: run
- Given: A signed-in owner with a Pro entitlement has published a public site, and a peer is in the same workspace.
- When: The owner tries `PATCH /api/host/sites/:siteId/url` with `dpl-reserved` and `pv-private`; the peer tries the rename, `GET /api/host/sites/:siteId/url-availability`, and `GET /api/host/sites/:publicSlug/url`; the owner reads the site URL.
- Then: Both reserved slugs return HTTP 400 and each peer request returns HTTP 404. The owner's read returns HTTP 200 with the unchanged site ID, public slug, `https://<name>.okou.app` URL and `isActive: true`.

## hosted-site-url-003

- Vitest: "rejects stale edits and reserves previous published names for their owner"
- Mode: run
- Given: A signed-in owner with a Pro entitlement has published a site at `<name>` and renamed it to `<name>-new`; another Pro user in a different workspace is signed in.
- When: The owner sends a second rename to `<name>-other` with the stale expected slug `<name>`; the other user publishes a site named `<name>`, calls `GET /api/host/sites/:siteId/url-availability?publicSlug=<name>` and tries `PATCH /api/host/sites/:siteId/url` to `<name>`.
- Then: The stale rename returns HTTP 409. The other user's site gets a different public slug, availability reports `<name>` unavailable, and the rename returns HTTP 409.

## hosted-site-url-004

- Vitest: "an upload prepared before renaming completes at the new address"
- Mode: run
- Given: A signed-in owner with a Pro entitlement has published a site and has prepared but not completed a new upload for it.
- When: The owner renames the site with `PATCH /api/host/sites/:siteId/url` to `<name>-new`, then completes the pending upload and resolves `GET /api/host/aliases/<name>-new`.
- Then: Completion reports URL `https://<name>-new.okou.app` and the new alias points to the pending upload's deployment.

## hosted-site-url-005

- Vitest: "concurrent websites cannot claim the same address"
- Mode: run
- Given: A signed-in owner with a Pro entitlement has two published sites.
- When: The owner concurrently renames both sites with `PATCH /api/host/sites/:siteId/url` to the same `<name>-claimed`, resolves `GET /api/host/aliases/<name>-claimed`, deletes the winning site with `DELETE /api/host/sites/<name>-claimed`, and resolves again.
- Then: One rename returns HTTP 200 and the other HTTP 409. The alias points to the winning site, and after deletion it has no pointer.
