# hosted-site-access

## hosted-site-access-001

- Vitest: "creation establishes undefined visibility"
- Mode: run
- Given: A signed-in member prepares a new hosted site without specifying a visibility (row: visibility omitted, expected `private`).
- When: The member calls `POST /api/host/deployments/prepare`, an anonymous caller requests `GET /api/host/sites/:siteId/access` with origin `https://<slug>.okou.app`, the member completes the deployment, reads `GET /api/host/sites/:siteId/visibility`, and sends `PATCH /api/host/sites/:siteId/visibility` to `public` with the current revision.
- Then: Prepare reports visibility `private` and the anonymous access decision is `authenticate`. The visibility read returns HTTP 200 with `private` and a non-null revision, and the PATCH returns HTTP 200 with visibility `public`.

## hosted-site-access-002

- Vitest: "creation establishes private visibility"
- Mode: run
- Given: A signed-in member prepares a new hosted site with visibility `private` (row: `private`, expected `private`).
- When: The member calls `POST /api/host/deployments/prepare`, an anonymous caller requests `GET /api/host/sites/:siteId/access` with origin `https://<slug>.okou.app`, the member completes the deployment, reads `GET /api/host/sites/:siteId/visibility`, and sends `PATCH /api/host/sites/:siteId/visibility` to `public` with the current revision.
- Then: Prepare reports visibility `private` and the anonymous access decision is `authenticate`. The visibility read returns HTTP 200 with `private` and a non-null revision, and the PATCH returns HTTP 200 with visibility `public`.

## hosted-site-access-003

- Vitest: "creation establishes organization visibility"
- Mode: run
- Given: A signed-in member prepares a new hosted site with visibility `organization` (row: `organization`, expected `organization`).
- When: The member calls `POST /api/host/deployments/prepare`, an anonymous caller requests `GET /api/host/sites/:siteId/access` with origin `https://<slug>.okou.app`, the member completes the deployment, reads `GET /api/host/sites/:siteId/visibility`, and sends `PATCH /api/host/sites/:siteId/visibility` to `public` with the current revision.
- Then: Prepare reports visibility `organization` and the anonymous access decision is `authenticate`. The visibility read returns HTTP 200 with `organization` and a non-null revision, and the PATCH returns HTTP 200 with visibility `public`.

## hosted-site-access-004

- Vitest: "creation establishes public visibility"
- Mode: run
- Given: A signed-in member prepares a new hosted site with visibility `public` (row: `public`, expected `public`).
- When: The member calls `POST /api/host/deployments/prepare`, an anonymous caller requests `GET /api/host/sites/:siteId/access` with origin `https://<slug>.okou.app`, the member completes the deployment, reads `GET /api/host/sites/:siteId/visibility`, and sends `PATCH /api/host/sites/:siteId/visibility` to `public` with the current revision.
- Then: Prepare reports visibility `public` and the anonymous access decision is `allow`. The visibility read returns HTTP 200 with `public` and a non-null revision, and the PATCH returns HTTP 200 with visibility `public`.

## hosted-site-access-005

- Vitest: "redeployments preserve an existing public site's visibility"
- Mode: run
- Given: A signed-in owner has published a public hosted site.
- When: The owner prepares and completes a redeployment of the same site without a visibility field, then an anonymous caller requests `GET /api/host/sites/:siteId/access` for the site's `okou.app` origin.
- Then: The redeployment prepare reports visibility `public` and the anonymous access decision is `allow`.

## hosted-site-access-006

- Vitest: "an explicitly private redeployment restricts the site before new bytes are uploaded"
- Mode: run
- Given: A signed-in owner has published a public hosted site.
- When: The owner prepares a redeployment with visibility `private`; an anonymous caller requests delivery authorization `GET /api/host/delivery/:siteId/:deploymentId` for the original deployment through the public slug before and after the owner completes the redeployment, and once more through the immutable alias `dpl-<original deploymentId>`.
- Then: Prepare reports `private`. Before completion the delivery decision is already `authenticate`; after completion the public-slug request is `deny` and the immutable-alias request is `authenticate`.

## hosted-site-access-007

- Vitest: "site banners default on and persist independently of visibility and redeployment"
- Mode: run
- Given: A signed-in owner with a Pro entitlement has published a public hosted site.
- When: The owner reads `GET /api/host/sites/:siteId/branding`, an anonymous caller requests delivery authorization with presentation `banner`, the owner sends `PATCH /api/host/sites/:siteId/branding` with `showBanner: false` and then a second PATCH with `showBanner: true` and the stale `expectedRevision: null`, reads the visibility, checks delivery for both the public slug and `dpl-<deploymentId>` aliases, and redeploys the site.
- Then: The initial branding is exactly `{siteId, showBanner: true, revision: null}` and delivery is allowed with presentation `showBanner: true` and `siteUrl` `https://<slug>.okou.app/`. The first PATCH returns HTTP 200 with `showBanner` false and a non-null revision; the stale PATCH returns HTTP 409. Visibility stays `public` with its original revision, both aliases are allowed with `showBanner: false`, and after redeployment the branding read equals the hidden-banner result.

## hosted-site-access-008

- Vitest: "banner management requires ownership without revealing restricted metadata"
- Mode: run
- Given: A signed-in owner has published a public hosted site, and another member of the same workspace is signed in.
- When: The other member calls `GET` and `PATCH /api/host/sites/:siteId/branding`; the owner then makes the site private, and an anonymous caller requests delivery authorization (`GET /api/host/delivery/:siteId/:deploymentId`) with and without presentation `banner`.
- Then: Both of the other member's branding requests return HTTP 404. The anonymous banner request returns exactly `{allowed: false, decision: "authenticate"}` with no presentation metadata, and the plain request's decision is `authenticate`.

## hosted-site-access-009

- Vitest: "explicitly public creation ignores stale credentials before Clerk is called"
- Mode: run
- Given: A signed-in owner has published a site with explicit public visibility, and afterwards Clerk authentication is unavailable and throws on every request.
- When: The owner reads `GET /api/host/sites/:siteId/visibility` (before the outage), then a caller requests delivery authorization `GET /api/host/delivery/:siteId/:deploymentId` with the stale header `Authorization: Bearer expired`.
- Then: The visibility read is exactly `{siteId, visibility: "public", revision}`. The delivery request returns HTTP 200 with exactly `{allowed: true, decision: "allow"}`.

## hosted-site-access-010

- Vitest: "only the owner changes visibility and stale edits cannot overwrite it"
- Mode: run
- Given: A signed-in owner has published a public site; a member of another workspace is signed in, and both the owner and the other member have exchanged site session tokens (`okou_site_` plus 64 hex characters) for the site's `okou.app` origin through the session-authorization callback.
- When: The other member and then the owner send `PATCH /api/host/sites/:siteId/visibility` to `private` with the current revision, the owner retries `public` with the stale revision, delivery authorization is requested anonymously, with each session token and with legacy brand `vm0`, and the owner finally restores `public` with the new revision.
- Then: The other member gets HTTP 404; the owner gets HTTP 200 with `private` and a new string revision; the stale edit gets HTTP 409. While private, anonymous delivery is `authenticate` (`allowed` false), the other member's session is `deny`, the owner's session is `allow`, and the `vm0` brand is `deny`. After the restore returns HTTP 200 `public`, anonymous delivery is `allow` and the `vm0` brand request is still `deny`.

## hosted-site-access-011

- Vitest: "organization access follows current membership in the site's organization"
- Mode: run
- Given: A signed-in owner's site is set to `organization` visibility, and a viewer from another workspace is reported by Clerk as a member of the owner's organization and holds a site session token.
- When: The viewer requests delivery authorization with the site session and `GET /api/host/sites/:publicSlug/preview` with the site hostname; Clerk then stops listing the viewer as a member and the viewer repeats both; finally the Clerk membership lookup fails.
- Then: As a member, delivery is allowed and the preview returns HTTP 200 with a non-null `expiresAt`. After membership removal the preview returns HTTP 404 and delivery is `deny`. When the membership lookup fails, delivery authorization returns HTTP 500.

## hosted-site-access-012

- Vitest: "redeployment preserves an explicit policy for both aliases and immutable addresses"
- Mode: run
- Given: A signed-in owner published a public site and then changed it to `private`.
- When: The owner prepares and completes a redeployment with new content but no visibility field, an anonymous caller requests delivery authorization for the original deployment through `dpl-<original deploymentId>`, and the owner reads `GET /api/host/sites/:siteId/visibility`.
- Then: The immutable-address delivery decision is `authenticate`, and the visibility remains `private`.

## hosted-site-access-013

- Vitest: "issued download grants stop working after a policy revision changes"
- Mode: run
- Given: A signed-in owner with a Pro entitlement published a public site and re-saved `public` visibility, producing a new revision.
- When: The owner lists `GET /api/host/sites/dpl-<deploymentId>/files`, an anonymous caller redeems the download token with `GET /api/host/downloads/:token` for `/index.html`, the owner changes visibility to `private`, and the token is redeemed again.
- Then: The first redemption returns a file with content type `text/html; charset=utf-8`; after the policy revision changes, the redemption returns HTTP 200 with `file: null`.

## hosted-site-access-014

- Vitest: "a caller-supplied identity or foreign origin cannot authorize a private preview"
- Mode: run
- Given: A signed-in owner has made their hosted site private.
- When: The owner, with valid Clerk credentials, calls `GET /api/host/sites/:siteId/access` with origin `https://attacker.example`.
- Then: The response is HTTP 200 with decision `authenticate`.

## hosted-site-access-015

- Vitest: "concurrent edits cannot both replace the same policy revision"
- Mode: run
- Given: A signed-in owner has a published public site with a known policy revision.
- When: The owner sends two concurrent `PATCH /api/host/sites/:siteId/visibility` requests (`private` and `organization`) with the same expected revision.
- Then: Exactly one request returns HTTP 200 and the other returns HTTP 409.

## hosted-site-access-016

- Vitest: "anonymous OG metadata stops exposing a Site after it becomes private"
- Mode: run
- Given: A signed-in owner has published a public site.
- When: An anonymous caller requests `GET /api/artifact-og/metadata?kind=host&id=<deploymentId>`, the owner makes the site private, and the anonymous caller requests the metadata again.
- Then: The metadata is `available` before the change and not available afterwards.

## hosted-site-access-017

- Vitest: "private downloads remain controlled and stop after deletion"
- Mode: run
- Given: A signed-in owner with a Pro entitlement has a published site that is now private.
- When: The owner lists `GET /api/host/sites/dpl-<deploymentId>/files`; an anonymous caller redeems the download token via `GET /api/host/downloads/:token` with the correct deployment and `/index.html`, with a random deployment ID, and with path `/missing.html`; the owner deletes the site with `DELETE /api/host/sites/:site` and the token is redeemed again.
- Then: The download URL host is `dpl-<deploymentId>.okou.app`. The correct redemption returns a file; the wrong deployment and wrong path return `file: null`; after deletion the redemption returns `file: null`.

## hosted-site-access-018

- Vitest: "authorization codes require the correct proof, Site and origin, and are single-use"
- Mode: run
- Given: A signed-in owner has published a site and obtained an authorization code via `POST /api/host/sites/:siteId/session-authorizations` with a PKCE challenge for `https://<slug>.okou.app`; the callback goes to that origin at `/.okou/auth/callback` with the same state.
- When: An anonymous caller exchanges the code with `POST /api/host/sites/:siteId/sessions` using a wrong verifier, origin `https://other.okou.app`, and a random site ID, then sends two concurrent exchanges with the correct values, then one more.
- Then: The wrong verifier, wrong origin and wrong site each return HTTP 401. Of the concurrent exchanges exactly one returns HTTP 200 and one HTTP 401, and the later exchange returns HTTP 401.

## hosted-site-access-019

- Vitest: "expired authorization codes cannot be exchanged"
- Mode: run
- Given: A signed-in owner has obtained a site authorization code for their public site, and the clock then advances 121 seconds.
- When: The code is exchanged with `POST /api/host/sites/:siteId/sessions`.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## hosted-site-access-020

- Vitest: "site sessions survive 60 seconds without a Clerk JWT and stop after primary revocation"
- Mode: run
- Given: A signed-in owner holds a site session token for `https://<slug>.okou.app` and then makes the site private.
- When: The site token is used on `GET /api/auth/me`; the clock advances 61 seconds; `GET /api/host/sites/:siteId/access` is called with the site token for the site origin and for `https://sibling.okou.app`, and with the owner's Clerk credentials; then Clerk reports the owner's primary session as revoked and the site token is used again.
- Then: `/api/auth/me` returns HTTP 401. After 61 seconds the site token on its own origin is `allow`, on the sibling origin `authenticate`, and the Clerk credentials alone are `authenticate`. After primary-session revocation the site token gets `authenticate`.

## hosted-site-access-021

- Vitest: "pending sessions and untrusted return origins cannot mint site authorization codes"
- Mode: run
- Given: A signed-in owner has a published site, but Clerk reports the owner's session status as `pending`.
- When: The owner calls `POST /api/host/sites/:siteId/session-authorizations` for the site's own origin, then for `https://attacker.example`.
- Then: The first request returns HTTP 401 with error code `UNAUTHORIZED`; the untrusted origin returns HTTP 403.

## hosted-site-access-022

- Vitest: "one publisher cannot redirect another Site's authorization to its own origin"
- Mode: run
- Given: A signed-in owner has published two sites in the same workspace.
- When: The owner calls `POST /api/host/sites/:siteId/session-authorizations` for the first site with the second site's origin; the owner then obtains a site session for the first site's immutable origin `https://dpl-<deploymentId>.okou.app`, makes the first site private, and calls `GET /api/host/sites/:siteId/access` with that session for the immutable origin.
- Then: The cross-site authorization returns HTTP 403. The immutable-origin session is `allow` after the site becomes private.

## hosted-site-access-023

- Vitest: "the App bridge rejects a Clerk JWT issued to an untrusted hosted origin"
- Mode: run
- Given: A signed-in owner has a published site, and Clerk accepts the presented JWT only when verification allows the hosted origin `https://<slug>.okou.app` as an authorized party.
- When: The owner calls `POST /api/host/sites/:siteId/session-authorizations` for that hosted origin.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## hosted-site-access-024

- Vitest: "general API endpoints reject verified Clerk credentials from https://demo.okou.app"
- Mode: run
- Given: A signed-in owner's Clerk credentials verify, but their authorized-party (`azp`) claim is `https://demo.okou.app`.
- When: The owner calls `GET /api/auth/me`.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## hosted-site-access-025

- Vitest: "general API endpoints reject verified Clerk credentials from https://demo.okou.app."
- Mode: run
- Given: A signed-in owner's Clerk credentials verify, but their authorized-party (`azp`) claim is `https://demo.okou.app.` (trailing dot).
- When: The owner calls `GET /api/auth/me`.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## hosted-site-access-026

- Vitest: "general API endpoints reject verified Clerk credentials from https://demo.sites.example.com"
- Mode: run
- Given: A signed-in owner's Clerk credentials verify, but their authorized-party (`azp`) claim is `https://demo.sites.example.com`.
- When: The owner calls `GET /api/auth/me`.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## hosted-site-access-027

- Vitest: "restricted previews reuse private-artifact credentials only after current access checks"
- Mode: run
- Given: The clock is 2026-10-22T00:00:00Z and a signed-in owner has made their published site private; a member of another workspace is also signed in.
- When: The owner calls `GET /api/host/sites/:publicSlug/preview` with the site hostname twice; the outsider calls it; the owner calls it with hostname `unrelated.okou.app`, with an invalid `dpl-` slug, and with `dpl-<deploymentId>`; the clock then moves to 1 ms before and exactly 47 hours after issue.
- Then: The owner gets a `https://pv-<48 hex>.okou.app/` URL expiring exactly 48 hours after issue, and the repeat returns the same body. The outsider, unrelated hostname and invalid deployment slug each return HTTP 404; the immutable address returns the same preview. Just before 47 hours the same preview is returned; at 47 hours a new URL is issued that expires 48 hours from then.

## hosted-site-access-028

- Vitest: "public viewers use anonymous addresses while owners use an independent preview capability"
- Mode: run
- Given: A signed-in owner has published a public site, and a member of another workspace is signed in.
- When: The owner and then the stranger call `GET /api/host/sites/:publicSlug/preview` with the site hostname.
- Then: The owner gets a `https://pv-<48 hex>.okou.app/` URL with a non-null `expiresAt`. The stranger gets exactly `{url: "https://<slug>.okou.app/", expiresAt: null}`.
