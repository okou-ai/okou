# chat-connector-access

## chat-connector-access-001

- Vitest: "Chat connector account configuration > aggregates owned identities and Chat preferences, and refreshes an exact target"
- Mode: run
- Given: A signed-in member owns a Chat and has two OpenAI API-token accounts, "Work" (default) and "Personal", plus an unauthenticated custom HTTP connector "Private service". In the Chat, "Personal" is set as current and "Work" is overridden off.
- When: The member reads `GET /api/chat-connector-overview` and `GET /api/chat-connector-overview/target` for the Chat (OpenAI and the custom connector), `GET /api/chat-threads/:threadId/connector-access`, the overview without a Chat, then adds a second custom connector, overrides "Personal" off, and deletes both accounts through `DELETE /api/connector-accounts/:connectionId`.
- Then: The Chat overview returns two entries: OpenAI (label "OpenAI", current "Personal") with "Work" as default, default-enabled, override false and disabled, and "Personal" as non-default, enabled with no override, all identity fields null; and the custom connector with its label, null icon and no permissions. Each single-target read equals its overview entry and matches the Chat access current account and preferences. Without a Chat, the current account is "Work" and both accounts are enabled with no override. After adding a connector the overview has three entries; after overriding "Personal" off the current account is null; after both deletions the OpenAI target connector is null.

## chat-connector-access-002

- Vitest: "Chat connector account configuration > isolates overview reads by member, organization and Chat ownership"
- Mode: run
- Given: A signed-in member owns a Chat and an OpenAI account "Owner"; another member of the same organization owns a Chat and an account, and the same user has an account in another organization.
- When: The member reads `GET /api/chat-connector-overview` for their Chat and for the other member's Chat, `GET /api/chat-connector-overview/target` for the other member's Chat, and the target endpoint for an unknown custom connector without a Chat.
- Then: The own Chat overview lists only the "Owner" account. Both reads of the other member's Chat return HTTP 404, and the unknown custom connector target returns HTTP 200 with a null connector.

## chat-connector-access-003

- Vitest: "Chat connector account configuration > starts accounts enabled, replaces defaults and promotes only enabled siblings on deletion"
- Mode: run
- Given: A signed-in member owns a Chat and adds OpenAI accounts "A" and "B".
- When: The member reads `GET /api/connector-account-access/defaults`, disables A's default through `PUT /api/connector-account-access/:connectionId/default-enabled`, tries to make A default via `POST /api/connector-accounts/:connectionId/default`, disables B, re-enables A, deletes A, adds account "C", re-enables B and deletes C.
- Then: Initially both accounts are default-enabled and A is the default. After disabling A, B becomes default and setting disabled A as default returns HTTP 404. With both disabled the Chat has no current account; re-enabling A makes it default. Deleting A promotes nobody and leaves B listed as not enabled and not default. The new account C becomes the Chat's current account, and after re-enabling B, deleting C promotes B, which becomes the Chat's current account.

## chat-connector-access-004

- Vitest: "Chat connector account configuration > inherits live defaults, isolates Chat overrides and retains valid replacement selections"
- Mode: run
- Given: A signed-in member owns two Chats and OpenAI accounts "A" (default) and "B"; the first Chat selects B as current.
- When: The member toggles B's default-enabled setting, overrides A off in the first Chat, tries to select A as current, disables A's default and overrides A on and selects it in the first Chat, disables B, and finally clears A's override (`enabled: null`) through `PUT /api/chat-threads/:threadId/connector-access/:connectionId`.
- Then: The first Chat uses B and the second uses A. Disabling B moves the first Chat to A, and re-enabling B keeps A. Overriding A off returns current B with A's override and enabled both false, without affecting the second Chat (still A); selecting overridden-off A returns HTTP 400. After the override on, A can be selected and stays current when B is disabled, while the second Chat has no current account and is unavailable. Clearing the override returns no current account, unavailable, and A with no override, default disabled and not enabled.

## chat-connector-access-005

- Vitest: "Chat connector account configuration > rejects foreign accounts, Chats and mismatched targets"
- Mode: run
- Given: A signed-in member owns a Chat and an OpenAI account; another member of the same organization owns a Chat and an account, and the same user has an account in another organization.
- When: The member reads their account through `GET /api/connector-accounts/:connectionId`, then for the foreign, other-organization and random account IDs calls `PUT /api/connector-account-access/:connectionId/default-enabled` and `PUT /api/chat-threads/:threadId/connector-access/:connectionId`; also updates the default with a mismatched Slack target and reads the other member's Chat access.
- Then: The own account read returns HTTP 200 with its ID. Every foreign, other-organization and unknown account update returns HTTP 404, the mismatched-target update returns HTTP 404, and the other member's Chat access returns HTTP 404. The own Chat still uses the member's account.

## chat-connector-access-006

- Vitest: "Chat connector account configuration > does not let an agent with a real Run credential self-enable an account"
- Mode: run
- Given: A signed-in member owns a Chat and an OpenAI account whose default is disabled, and an agent holds a real Run credential for that member.
- When: The agent calls `PUT /api/chat-threads/:threadId/connector-access/:connectionId` with the Run token to enable the account for the Chat.
- Then: The request returns HTTP 403 with code `FORBIDDEN`, and the member's Chat access remains unavailable with no current account.
