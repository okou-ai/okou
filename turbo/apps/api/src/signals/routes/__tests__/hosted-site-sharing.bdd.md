# hosted-site-sharing

## hosted-site-sharing-001

- Vitest: "an owner searches verified accounts, shares privately, and revokes an existing browser session"
- Mode: run
- Given: A signed-in owner with hosted-site email sharing enabled has published a private site; a verified viewer is a member of the owner's workspace, and a stranger outside the workspace has an unverified email. Resend accepts emails.
- When: The owner calls `GET /api/host/sites/:siteId/share-accounts?query=viewer`, shares with `POST /api/host/sites/:siteId/shares` using `VIEWER@EXAMPLE.COM` and again with the plain email; the viewer obtains a site session and checks `GET /api/host/sites/:siteId/access`; the stranger requests `POST /api/host/sites/:siteId/session-authorizations`; the owner revokes the share with `DELETE /api/host/sites/:siteId/shares/:shareId`, and the viewer checks access and `GET /api/host/sites/:publicSlug/preview`.
- Then: The search returns exactly the viewer's user ID, email and name `Website Viewer`. Both shares return the same `{share: {id, email}}` with the normalized email, and exactly one Resend email is sent from `Okou <noreply@okou.ai>` to the viewer with template `okou-hosted-site-invitation-v1` and the inviter name, recipient email and site URL `https://<slug>.okou.app/`. The viewer's access is `allow`, the stranger gets HTTP 403, and after revocation the viewer's existing session is `deny` and the preview returns HTTP 404.

## hosted-site-sharing-002

- Vitest: "an email invitation uses the Resend template once and can only be claimed by its verified recipient"
- Mode: run
- Given: A signed-in owner with email sharing enabled has a private site; the invitee `invited@example.com` belongs to no workspace and another user is unrelated. Resend accepts emails.
- When: The owner shares the site with the invitee twice via `POST /api/host/sites/:siteId/shares`; while the invitee's email is unverified the invitee and the stranger request `POST /api/host/sites/:siteId/session-authorizations`; after verification the invitee sends two concurrent authorization requests, and the owner lists `GET /api/host/sites/:siteId/shares`.
- Then: Both shares return the same share ID and exactly one Resend email is sent with template `okou-hosted-site-invitation-v1`, inviter `Website Viewer`, the recipient email and site URL. The unverified invitee and the stranger get HTTP 403; both concurrent verified authorizations return HTTP 200, and the listing contains exactly the original share.

## hosted-site-sharing-003

- Vitest: "sharing management is owner-only and disabled features cannot search or grant access"
- Mode: run
- Given: A signed-in owner has a private site with email sharing turned off, and a peer is in the same workspace.
- When: The owner tries `POST /api/host/sites/:siteId/shares`; sharing is enabled for both users and the peer calls search and share on the owner's site; the owner shares with the peer; the peer calls `GET /api/host/sites/:siteId/shares` and `DELETE /api/host/sites/:siteId/shares/:shareId`; the owner turns sharing off and the peer requests a site session authorization.
- Then: The owner's share with the feature off returns HTTP 404. The peer's search, share, list and remove each return HTTP 404, while the owner's share succeeds. After the switch is turned off the peer's authorization still returns HTTP 200.

## hosted-site-sharing-004

- Vitest: "revoking a pending invitation prevents a later verified sign-up from claiming it"
- Mode: run
- Given: A signed-in owner with email sharing enabled has a private site and invites `later@example.com`, who is not yet a verified account.
- When: The owner revokes the pending invitation with `DELETE /api/host/sites/:siteId/shares/:shareId`, the invitee then has a verified account and requests `POST /api/host/sites/:siteId/session-authorizations`.
- Then: The authorization returns HTTP 403 with error code `FORBIDDEN`.

## hosted-site-sharing-005

- Vitest: "account lookup returns only verified current workspace members for names, nicknames, and full emails"
- Mode: run
- Given: A signed-in owner with email sharing enabled has a private site; the workspace has a verified member, an unverified member and a banned member, and an external user has a verified account but is outside the workspace.
- When: The owner calls `GET /api/host/sites/:siteId/share-accounts` with the member's full name, nickname and email, and with the external user's email, nickname and the partial text `external`.
- Then: Each member query returns exactly the verified member with name `Website Viewer`. Every external query returns an empty account list; the unverified and banned members never appear.

## hosted-site-sharing-006

- Vitest: "external registered and unregistered emails have the same invitation response and list representation"
- Mode: run
- Given: A signed-in owner with email sharing enabled has a private site; one external recipient has a registered account outside the workspace and another has no account yet. Resend accepts emails.
- When: The owner shares with both emails via `POST /api/host/sites/:siteId/shares` and lists the shares; the registered recipient and then the unregistered recipient request site session authorization; the unregistered recipient then registers and retries; the owner lists the shares again.
- Then: Both shares return `{share: {id, email}}` with the same shape and one invitation email is sent to each address. The registered recipient gets HTTP 200, the unregistered recipient HTTP 403 until registered and then HTTP 200, and the share listing is identical before and after the claims.

## hosted-site-sharing-007

- Vitest: "search admission is atomic across concurrent requests and shared across owned websites"
- Mode: run
- Given: The clock is 2026-11-23T00:00:00Z and a signed-in owner with email sharing enabled owns two private sites.
- When: The owner sends 31 concurrent `GET /api/host/sites/:siteId/share-accounts?query=nobody` requests alternating between the two sites, one more search on the second site, then the clock advances 60 seconds and the owner searches again.
- Then: Exactly 30 concurrent requests return HTTP 200 and one returns HTTP 429. The next search returns HTTP 429 with `RATE_LIMITED`, and after 60 seconds the search returns HTTP 200.

## hosted-site-sharing-008

- Vitest: "sharing attempts are limited per user before creating another invitation"
- Mode: run
- Given: The clock is 2026-11-23T00:00:00Z and a signed-in owner with email sharing enabled has a private site. Resend accepts emails.
- When: The owner shares with ten different recipients via `POST /api/host/sites/:siteId/shares`, tries an eleventh, lists the shares, and after the clock advances 60 seconds shares with another recipient.
- Then: The first ten shares return HTTP 200, the eleventh returns HTTP 429, the listing contains exactly 10 shares, and the share after 60 seconds returns HTTP 200.

## hosted-site-sharing-009

- Vitest: "recipient quotas survive revocation and switching websites"
- Mode: run
- Given: A signed-in owner with email sharing enabled owns two private sites. Resend accepts emails.
- When: The owner shares with `recipient@example.com` three times, alternating sites and revoking each share immediately, then shares with `RECIPIENT@EXAMPLE.COM` on the second site and lists that site's shares.
- Then: The fourth share returns HTTP 429 and the second site's share list is empty.

## hosted-site-sharing-010

- Vitest: "workspace search quotas cannot be bypassed by using another owner"
- Mode: run
- Given: Five signed-in owners in the same workspace each have email sharing enabled and a private site.
- When: Each of the first four owners sends 30 `GET /api/host/sites/:siteId/share-accounts?query=nobody` searches, then the fifth owner searches once.
- Then: All 120 searches return HTTP 200, and the fifth owner's search returns HTTP 429 with `RATE_LIMITED`.

## hosted-site-sharing-011

- Vitest: "workspace sharing quotas apply across owners and do not create a grant when exhausted"
- Mode: run
- Given: Seven signed-in owners in the same workspace each have email sharing enabled and a private site, and the workspace has 60 verified member recipients.
- When: The first six owners each share their site with ten different members via `POST /api/host/sites/:siteId/shares`, then the seventh owner shares with `blocked@example.com` and lists its shares.
- Then: All 60 shares return HTTP 200; the seventh owner's share returns HTTP 429 and its share list is empty.

## hosted-site-sharing-012

- Vitest: "a partial name cannot be submitted as an external invitation address"
- Mode: run
- Given: A signed-in owner with email sharing enabled has a private site.
- When: The owner sends `POST /api/host/sites/:siteId/shares` with `email: "External Viewer"` and then lists `GET /api/host/sites/:siteId/shares`.
- Then: The share returns HTTP 400 and the share list is empty.
