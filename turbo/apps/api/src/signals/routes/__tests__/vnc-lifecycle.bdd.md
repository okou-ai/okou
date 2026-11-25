# vnc-lifecycle

## vnc-lifecycle-001

- Vitest: "signed membership departure erases mixed resources before the living user rejoins"
- Mode: run
- Given: A workspace member has two VNC hosts sharing one saved password credential, an unused saved credential, and a credential-free `x509_none` host (parameter row `mixed`). A peer in the same workspace and the same user in another workspace each have their own VNC host with an inline credential.
- When: The member's membership is removed and a signed Clerk `organizationMembership.deleted` webhook is delivered twice to `POST /api/webhooks/clerk`; the member lists `GET /api/vnc/connections` and `GET /api/vnc/credentials`; the member then rejoins (a signed `organizationMembership.created` webhook), lists again, and tries to rename each former host and credential; finally the peer and the other-organization identity list their own resources.
- Then: Each webhook returns HTTP 200 with `OK`. While departed, both lists return HTTP 404. After rejoining, both lists are empty and every rename of a former host or credential returns HTTP 404. The peer and the other-organization identity each still list exactly their own host and its credential.

## vnc-lifecycle-002

- Vitest: "signed membership departure erases unused credentials resources before the living user rejoins"
- Mode: run
- Given: A workspace member has only an unused saved VNC password credential (parameter row `unused credentials`). A peer in the same workspace and the same user in another workspace each have their own VNC host with an inline credential.
- When: The member's membership is removed and a signed Clerk `organizationMembership.deleted` webhook is delivered twice to `POST /api/webhooks/clerk`; the member lists `GET /api/vnc/connections` and `GET /api/vnc/credentials`; the member then rejoins (a signed `organizationMembership.created` webhook), lists again, and tries to rename each former host and credential; finally the peer and the other-organization identity list their own resources.
- Then: Each webhook returns HTTP 200 with `OK`. While departed, both lists return HTTP 404. After rejoining, both lists are empty and every rename of a former host or credential returns HTTP 404. The peer and the other-organization identity each still list exactly their own host and its credential.

## vnc-lifecycle-003

- Vitest: "signed membership departure erases credential-free hosts resources before the living user rejoins"
- Mode: run
- Given: A workspace member has only a credential-free `x509_none` host (parameter row `credential-free hosts`). A peer in the same workspace and the same user in another workspace each have their own VNC host with an inline credential.
- When: The member's membership is removed and a signed Clerk `organizationMembership.deleted` webhook is delivered twice to `POST /api/webhooks/clerk`; the member lists `GET /api/vnc/connections` and `GET /api/vnc/credentials`; the member then rejoins (a signed `organizationMembership.created` webhook), lists again, and tries to rename each former host and credential; finally the peer and the other-organization identity list their own resources.
- Then: Each webhook returns HTTP 200 with `OK`. While departed, both lists return HTTP 404. After rejoining, both lists are empty and every rename of a former host or credential returns HTTP 404. The peer and the other-organization identity each still list exactly their own host and its credential.

## vnc-lifecycle-004

- Vitest: "signed membership departure erases empty resources before the living user rejoins"
- Mode: run
- Given: A workspace member has no VNC hosts or credentials (parameter row `empty`). A peer in the same workspace and the same user in another workspace each have their own VNC host with an inline credential.
- When: The member's membership is removed and a signed Clerk `organizationMembership.deleted` webhook is delivered twice to `POST /api/webhooks/clerk`; the member lists `GET /api/vnc/connections` and `GET /api/vnc/credentials`; the member then rejoins (a signed `organizationMembership.created` webhook), lists again, and tries to rename each former host and credential; finally the peer and the other-organization identity list their own resources.
- Then: Each webhook returns HTTP 200 with `OK`. While departed, both lists return HTTP 404. After rejoining, both lists are empty and every rename of a former host or credential returns HTTP 404. The peer and the other-organization identity each still list exactly their own host and its credential.

## vnc-lifecycle-005

- Vitest: "erases a departed owner's VNC data when an admitted rotation finishes during cleanup"
- Mode: run
- Given: A workspace member has a VNC host with an inline credential. Encryption of the next secret pauses. Parameter row `during cleanup`: encryption resumes right after the departure webhook is dispatched, while cleanup may still be running.
- When: The member starts a password rotation via `PATCH /api/vnc/credentials/:credentialId` at revision 1; while it is paused, the membership is removed and a signed `organizationMembership.deleted` webhook is delivered to `POST /api/webhooks/clerk`; the member later rejoins and lists hosts and credentials.
- Then: The rotation returns HTTP 200 or HTTP 404, and if 404 the error code is `VNC_CREDENTIAL_NOT_FOUND`. After rejoining, both the host list and the credential list are empty.

## vnc-lifecycle-006

- Vitest: "erases a departed owner's VNC data when an admitted rotation finishes after cleanup"
- Mode: run
- Given: A workspace member has a VNC host with an inline credential. Encryption of the next secret pauses. Parameter row `after cleanup`: encryption resumes only after the departure webhook has been fully processed.
- When: The member starts a password rotation via `PATCH /api/vnc/credentials/:credentialId` at revision 1; while it is paused, the membership is removed and a signed `organizationMembership.deleted` webhook is delivered to `POST /api/webhooks/clerk`; the member later rejoins and lists hosts and credentials.
- Then: The rotation returns HTTP 404 with `VNC_CREDENTIAL_NOT_FOUND`. After rejoining, both the host list and the credential list are empty.

## vnc-lifecycle-007

- Vitest: "signed user deletion with referenced VNC credentials preserves a surviving owner's configuration"
- Mode: run
- Given: A workspace member has a VNC host with an inline credential and an unused credential. Parameter row `user`: the same user in a second organization also has a host, and a different user in the first organization (the survivor) has a host. Both of the deleted user's memberships are removed.
- When: A signed Clerk `user.deleted` webhook for the user is delivered twice to `POST /api/webhooks/clerk`, then the survivor lists `GET /api/vnc/connections` and `GET /api/vnc/credentials`.
- Then: Each webhook returns HTTP 200 with `OK`. The survivor's host list equals exactly its own host and its credential list contains exactly that host's credential.

## vnc-lifecycle-008

- Vitest: "signed organization deletion with referenced VNC credentials preserves a surviving owner's configuration"
- Mode: run
- Given: A workspace member has a VNC host with an inline credential and an unused credential. Parameter row `organization`: a different user in the same organization also has a host, and the same user in another organization (the survivor) has a host. Both memberships in the deleted organization are removed.
- When: A signed Clerk `organization.deleted` webhook for the organization is delivered twice to `POST /api/webhooks/clerk`, then the survivor lists `GET /api/vnc/connections` and `GET /api/vnc/credentials`.
- Then: Each webhook returns HTTP 200 with `OK`. The survivor's host list equals exactly its own host and its credential list contains exactly that host's credential.

## vnc-lifecycle-009

- Vitest: "requires current membership while retaining the same owner's configuration after rejoining"
- Mode: run
- Given: A workspace member has a VNC host with an inline credential, and the membership is then removed without a departure webhook.
- When: While not a member, the user lists hosts and credentials and creates a host; after the membership is restored, the user lists again, creates another host at the same address, renames the credential to "Rejoined" via `PATCH /api/vnc/credentials/:credentialId`, and creates a host bound to the saved credential.
- Then: While not a member, all three requests return HTTP 404. After rejoining, the host list equals exactly the previous host and the credential list contains exactly its credential. The additional host is created with the same host and port, the rename returns HTTP 200 with name "Rejoined", and the shared-credential host returns HTTP 201.

## vnc-lifecycle-010

- Vitest: "a missing Clerk identity denies owner reads while provider failures remain server errors"
- Mode: run
- Given: A signed-in workspace member. The identity provider's membership lookup first fails with a 404, then with a generic outage.
- When: The member lists `GET /api/vnc/connections` twice.
- Then: The first request returns HTTP 404 with `VNC_UNAVAILABLE`, and the second returns HTTP 500.
