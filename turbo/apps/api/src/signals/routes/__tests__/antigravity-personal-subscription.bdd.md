# antigravity-personal-subscription

## antigravity-personal-subscription-001

- Vitest: "member-owned Antigravity login > requires staff opt-in and assignment to an individual worker"
- Mode: run
- Given: A signed-in staff-organization member initially has not opted into the Gemini Antigravity feature switch.
- When: The member calls `GET` and `POST /api/me/subscriptions/antigravity` before opting in; after opting in, calls them with no assigned worker, then with a worker assignment that shares the member's machine with a peer; finally reads the status from another organization.
- Then: Before opting in both requests return HTTP 404. With no worker the status is `unassigned` and starting returns HTTP 503; with the shared-machine assignment starting still returns HTTP 503. The read from the other organization returns HTTP 404.

## antigravity-personal-subscription-002

- Vitest: "member-owned Antigravity login > binds the exact member, reuses a pending request, and tolerates a lost confirmation"
- Mode: run
- Given: Two opted-in members of the same staff organization each have their own assigned Antigravity login worker.
- When: Member A starts a login twice concurrently through `POST /api/me/subscriptions/antigravity`; the binding is confirmed through `POST /api/internal/antigravity/subscriptions/:bindingId/confirm` without a machine identity, as B's machine, as A's machine, and again as A's machine; then member B reads status and disconnects A's binding, and A reads status.
- Then: Both starts return the same pending binding for A's login host. Confirmation without machine identity returns HTTP 403 and from B's machine HTTP 404; A's machine gets HTTP 200 `{ status: "connected", bindingId, loginHost }` and the repeat returns the same body. B sees `{ status: "disconnected" }`, B's disconnect returns HTTP 200, and A's status still equals the connected body.

## antigravity-personal-subscription-003

- Vitest: "member-owned Antigravity login > returns only the member's HTTPS terminal and refuses to share it between members"
- Mode: run
- Given: An opted-in member is assigned an HTTPS login terminal `https://alice.agy.example.com`; another member of the organization later opts in and the same terminal is configured for both members.
- When: Member A starts a login and A's machine confirms it; member B then calls `POST /api/me/subscriptions/antigravity`.
- Then: A's pending binding exposes `loginOrigin` and no `loginHost`, and confirmation returns HTTP 200 `{ status: "connected", bindingId, loginOrigin }`. B's start returns HTTP 503.

## antigravity-personal-subscription-004

- Vitest: "member-owned Antigravity login > rejects a worker whose owner left the organization and still allows cleanup"
- Mode: run
- Given: An opted-in member has started a login on their assigned worker, but the organization membership list no longer contains the member.
- When: The worker machine confirms the binding through `POST /api/internal/antigravity/subscriptions/:bindingId/confirm`, then disconnects it through `DELETE /api/internal/antigravity/subscriptions/:bindingId`; the member reads `GET /api/me/subscriptions/antigravity`.
- Then: Confirmation returns HTTP 404, the worker disconnect returns HTTP 200, and the member's status is `disconnected`.

## antigravity-personal-subscription-005

- Vitest: "member-owned Antigravity login > expires an unconfirmed login, rotates the binding ID, and rejects the old proof"
- Mode: run
- Given: An opted-in member has started a login, and the clock moves one millisecond past its expiry.
- When: The member reads the status, the worker confirms the old binding, the member starts a new login, and the worker confirms the old and then the new binding.
- Then: The status is `expired` and confirming the expired binding returns HTTP 404. The new login has a different binding ID; the old binding is still rejected with HTTP 404 and the new one confirms with HTTP 200.

## antigravity-personal-subscription-006

- Vitest: "member-owned Antigravity login > reports the disabled cloud route separately from a successful native Google sign-in"
- Mode: run
- Given: An opted-in member's Antigravity login has been confirmed by their worker.
- When: The member creates a chat thread through `POST /api/chat-threads` with model `gemini-4-neon`.
- Then: The request returns HTTP 400 with the message "Your Google AI subscription is connected. Cloud runs for this model are not enabled yet."

## antigravity-personal-subscription-007

- Vitest: "member-owned Antigravity login > revokes with the switch off and fences old confirmations and old disconnects after reconnect"
- Mode: run
- Given: An opted-in member's Antigravity login has been confirmed, and the member's feature switch is then turned off.
- When: The worker reads `GET /api/internal/antigravity/subscriptions/:bindingId`; the member disconnects through `DELETE /api/me/subscriptions/antigravity/:bindingId`; after turning the switch back on the member starts a new login, the worker confirms the old binding, and the member disconnects the old binding and reads status.
- Then: The worker status returns HTTP 404 and the member's disconnect returns HTTP 200 with status `disconnected`. The new login has a new binding ID; confirming the old binding returns HTTP 404 and disconnecting it returns HTTP 404, and the status equals the new pending binding.
