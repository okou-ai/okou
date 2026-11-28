# marketing-reward-settlement

## marketing-reward-settlement-001

- Vitest: "authenticates the dedicated financial capability and binds the immutable environment and terms before settling"
- Mode: run
- Given: The Marketing financial settlement secret is configured. A well-formed GitHub connector reward intent references a source event that does not exist.
- When: The caller calls `POST /api/internal/marketing/get-started/settlements` with a Clerk session token, the cron secret, a read-only receipt secret and a source-intake secret; then with the settlement secret; then with a forged `orgId` (identity unchanged); then with environment `production` and a recomputed identity; then after the settlement secret is unset.
- Then: The four wrong credentials each get HTTP 401 with `cache-control: no-store`. The settlement secret with the unknown source gets HTTP 404. The forged org and the other environment each get HTTP 409. The unconfigured service gets HTTP 503 with `cache-control: no-store`.

## marketing-reward-settlement-002

- Vitest: "settles for the original creator concurrently and recovers the receipt after deletion and expiry"
- Mode: run
- Given: In a team-tier workspace, an admin creates a Workflow and a member runs it to completion, producing a `workflow.run-completed` source fact. The admin then deletes the Workflow.
- When: Marketing sends the workflow reward intent (1000 credits for the creator) to `POST /api/internal/marketing/get-started/settlements` twice concurrently, once more, and again after the clock advances one day past the receipt expiry.
- Then: The concurrent requests return HTTP 200 or 202. The next request returns HTTP 200 with a `granted` receipt for the org, the executing member as actor, the Workflow creator as beneficiary, amount 1000, reward key `workflow:<creator>` and a member credit grant ID, expiring 168 hours after grant. After expiry the same request returns exactly the same body.

## marketing-reward-settlement-003

- Vitest: "rejects caller-chosen recipients, sources and amounts even when the caller recomputes a valid request identity"
- Mode: run
- Given: A member completed a Workflow run, producing a valid workflow reward intent for its creator.
- When: Marketing sends `POST /api/internal/marketing/get-started/settlements` with recomputed identities that change the beneficiary, the org, the source key or the completion time, and then with the reward amount inflated to 99,999.
- Then: Each changed recipient, org, source or time returns HTTP 409, and the inflated amount returns HTTP 400.

## marketing-reward-settlement-004

- Vitest: "returns a prior OAuth award by the complete request after a lost response without funding the reconnect or extending expiry"
- Mode: run
- Given: A member connected GitHub through OAuth, producing a `connector.oauth-authorized` source fact, and Marketing built the 100-credit connector reward intent.
- When: Marketing calls `POST /api/internal/marketing/get-started/settlements`, then repeats the identical request after the clock advances one day past the receipt expiry.
- Then: The first request returns HTTP 200 with a `granted` receipt of 100 credits. The repeat returns exactly the same body.

## marketing-reward-settlement-005

- Vitest: "preserves one user's ten-connector cap when Marketing settles real source facts from two organizations"
- Mode: run
- Given: One user connects nine Google-family connectors through OAuth in their organization and GitHub and Slack through OAuth in a second organization, producing eleven connector source facts.
- When: Marketing settles each fact with a 100-credit connector intent via `POST /api/internal/marketing/get-started/settlements`, repeating each request once.
- Then: Every request returns HTTP 200 and each repeat returns the same body. Ten receipts are `granted` and one is `ineligible`.

## marketing-reward-settlement-006

- Vitest: "recovers the original iMessage and organization Slack receipts without replaying their financial effects"
- Mode: run
- Given: A member linked iMessage through AgentPhone and installed Slack for their organization, producing `imessage.identity-linked` and `slack.oauth-authorized` facts, and then unlinked iMessage.
- When: Marketing settles each fact via `POST /api/internal/marketing/get-started/settlements` (iMessage: 1000 credits to the user; Slack: 2000 credits to the org), repeating each request.
- Then: Exactly two source facts exist. Each first settlement returns HTTP 200 with a `granted` receipt carrying its reward key and target (`user` or `org`), and each repeat returns exactly the same body.

## marketing-reward-settlement-007

- Vitest: "captures a signed acceptance and settles the original inviter exactly once"
- Mode: run
- Given: A member who completed onboarding invited a teammate with `POST /api/org/invite`, and Clerk delivers a correctly signed `organizationInvitation.accepted` webhook to `POST /api/webhooks/clerk` for that invitation.
- When: Marketing settles the resulting `invitation.accepted` fact via `POST /api/internal/marketing/get-started/settlements` and repeats the request.
- Then: The receipt has the invitation's claim ID, status `granted`, the inviter as beneficiary and reward key `invite:<invitee>`. The repeat returns exactly the same body.

## marketing-reward-settlement-008

- Vitest: "enforces the inviter's fifteen-award limit across organizations and rewards each invitee only once"
- Mode: run
- Given: One inviter belongs to two organizations. Sixteen invitations (eight per organization) are accepted through signed Clerk webhooks. Later another inviter's invitation is accepted by the first invitee.
- When: Marketing settles each invite reward via `POST /api/internal/marketing/get-started/settlements`, repeating each request, and then settles the other inviter's reward for the first invitee.
- Then: Each repeat returns the same body. Fifteen of the sixteen receipts are `granted` and one is `ineligible`. The other inviter's receipt is `ineligible` with reason `already_redeemed`.
