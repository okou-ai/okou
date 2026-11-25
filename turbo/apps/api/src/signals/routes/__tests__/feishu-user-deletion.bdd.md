# feishu-user-deletion

## feishu-user-deletion-001

- Vitest: "feishu integration > preserves the surviving member connection after a verified user deletion"
- Mode: run
- Given: Two users have connected separate Feishu identities through the same configured workspace bot. The departing user's status was HTTP 200 and showed a connected provider account. The surviving member's integration remains enabled.
- When: Clerk sends a verified `user.deleted` event at `POST /api/webhooks/clerk` for the departing user, then the surviving member reads `GET /api/integrations/feishu` under their own session.
- Then: The webhook responds HTTP 200 with `OK`. The status read responds HTTP 200 with `isConnected: true`, connected name `Feishu User`, and the original installation ID.

## feishu-user-deletion-002

- Vitest: "lark integration > preserves the surviving member connection after a verified user deletion"
- Mode: run
- Given: Two users have connected separate Lark identities through the same configured workspace bot. The departing user's status was HTTP 200 and showed a connected provider account. The surviving member's integration remains enabled.
- When: Clerk sends a verified `user.deleted` event at `POST /api/webhooks/clerk` for the departing user, then the surviving member reads `GET /api/integrations/lark` under their own session.
- Then: The webhook responds HTTP 200 with `OK`. The status read responds HTTP 200 with `isConnected: true`, connected name `Feishu User`, and the original installation ID.
