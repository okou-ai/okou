# membership-refresh

## membership-refresh-001

- Vitest: "membership refresh through public PAT and Agent requests > authenticates simultaneous PAT and Agent requests on a cold cache"
- Mode: run
- Given: A user holds a CLI personal access token and an Agent (sandbox) token for their organization; no membership is cached yet and Clerk's membership read is held until released, then reports them as admin.
- When: Sixteen requests to `GET /api/computer-use/commands/:id` for unknown command IDs are sent concurrently, alternating the PAT and the Agent token; then the PAT is used once more.
- Then: All sixteen requests and the follow-up return HTTP 404 (authenticated, command not found).

## membership-refresh-002

- Vitest: "membership refresh through public PAT and Agent requests > preserves the positive expiry across hits, demotion and revocation"
- Mode: run
- Given: A user holds a PAT and an Agent token, and Clerk first reports them as an organization admin.
- When: The user calls `GET /api/org` with the PAT; Clerk demotes them to member and the user reads again at +59.999 s and at +60 s; Clerk then removes the membership and at +120 s the Agent token calls `GET /api/computer-use/commands/:id` and the PAT calls `GET /api/auth/me`.
- Then: The first two reads return role `admin` with one Clerk read, and the read at 60 s returns `member` after a second Clerk read. After revocation the Agent request returns HTTP 401 after a third read, and `GET /api/auth/me` returns HTTP 200 with the user ID and `orgId` null.

## membership-refresh-003

- Vitest: "membership refresh through public PAT and Agent requests > fails closed on 429 and preserves provider recovery"
- Mode: run
- Given: A user holds a PAT and an Agent token, and Clerk's membership read fails with HTTP 429.
- When: The PAT calls `GET /api/computer-use/commands/:id`; Clerk then recovers and the Agent token makes the same kind of request.
- Then: The PAT request returns HTTP 500 after one Clerk read. After recovery the Agent request returns HTTP 404 with exactly one more Clerk read.

## membership-refresh-004

- Vitest: "membership refresh through public PAT and Agent requests > fails closed on 503 and preserves provider recovery"
- Mode: run
- Given: A user holds a PAT and an Agent token, and Clerk's membership read fails with HTTP 503.
- When: The PAT calls `GET /api/computer-use/commands/:id`; Clerk then recovers and the Agent token makes the same kind of request.
- Then: The PAT request returns HTTP 503 with `Cache-Control: no-store` after three Clerk reads. After recovery the Agent request returns HTTP 404 with exactly one more Clerk read.

## membership-refresh-005

- Vitest: "membership refresh through public PAT and Agent requests > fails closed on transport and preserves provider recovery"
- Mode: run
- Given: A user holds a PAT and an Agent token, and Clerk's membership read fails with a network error.
- When: The PAT calls `GET /api/computer-use/commands/:id`; Clerk then recovers and the Agent token makes the same kind of request.
- Then: The PAT request returns HTTP 500 after one Clerk read. After recovery the Agent request returns HTTP 404 with exactly one more Clerk read.

## membership-refresh-006

- Vitest: "membership refresh through public PAT and Agent requests > checks membership for the requested user and organization"
- Mode: run
- Given: Three Agent tokens exist: for a user in organization A, for the same user in organization B, and for another user in organization A. Clerk reports the first user only as a member of B and the other user as a member of A.
- When: Each token calls `GET /api/computer-use/commands/:id`.
- Then: The organization-A token of the first user returns HTTP 401, and the other two return HTTP 404. Clerk is queried for the first user, the first user again, and the other user, in that order.

## membership-refresh-007

- Vitest: "membership refresh through public PAT and Agent requests > keeps surviving callers alive when the first caller cancels"
- Mode: run
- Given: A user holds an Agent token, no membership is cached, and Clerk's membership read is held until released.
- When: One caller requests `GET /api/computer-use/commands/:id` and cancels after the Clerk read starts, while eight other callers make the same request.
- Then: The cancelled request ends with status 500, and after Clerk answers all eight surviving requests return HTTP 404.

## membership-refresh-008

- Vitest: "membership refresh through public PAT and Agent requests > ignores a late Clerk result after caller cancellation"
- Mode: run
- Given: A user holds an Agent token. Clerk's first membership read is held and will return 404; later reads report the membership.
- When: A caller requests `GET /api/computer-use/commands/:id` and cancels it during the first read; a second request is made; then the held read finishes late with 404 and a third request is made.
- Then: The cancelled request ends with status 500. The second and third requests both return HTTP 404 (authenticated), and Clerk is read only twice; the late 404 result is ignored.
