# agentphone-groups.bdd

## agentphone-groups.bdd-001

- Vitest: "iMessage group webhook content admission > returns a retryable rejection for empty content"
- Mode: run
- Given: The AgentPhone webhook signing secret is configured.
- When: AgentPhone delivers a signed iMessage group `agent.message` webhook to `POST /api/agentphone/webhook` whose content is empty: `message` "", `mediaUrl` null and `mediaUrls` [].
- Then: The webhook returns HTTP 500 with body "iMessage group webhook has no supported message content (empty_content)", so the provider retries.

## agentphone-groups.bdd-002

- Vitest: "iMessage group webhook content admission > returns a retryable rejection for whitespace content"
- Mode: run
- Given: The AgentPhone webhook signing secret is configured.
- When: AgentPhone delivers a signed iMessage group `agent.message` webhook to `POST /api/agentphone/webhook` whose content is whitespace only: `message` " \n ", `mediaUrl` " " and `mediaUrls` null.
- Then: The webhook returns HTTP 500 with body "iMessage group webhook has no supported message content (empty_content)", so the provider retries.

## agentphone-groups.bdd-003

- Vitest: "iMessage group webhook content admission > returns a retryable rejection for a structured message"
- Mode: run
- Given: The AgentPhone webhook signing secret is configured.
- When: AgentPhone delivers a signed iMessage group `agent.message` webhook to `POST /api/agentphone/webhook` whose `message` is an object `{ text: "group message" }`.
- Then: The webhook returns HTTP 500 with body "iMessage group webhook has no supported message content (unsupported_content_shape)".

## agentphone-groups.bdd-004

- Vitest: "iMessage group webhook content admission > returns a retryable rejection for a structured mediaUrl"
- Mode: run
- Given: The AgentPhone webhook signing secret is configured.
- When: AgentPhone delivers a signed iMessage group `agent.message` webhook to `POST /api/agentphone/webhook` whose `mediaUrl` is an object containing a URL.
- Then: The webhook returns HTTP 500 with body "iMessage group webhook has no supported message content (unsupported_content_shape)".

## agentphone-groups.bdd-005

- Vitest: "iMessage group webhook content admission > returns a retryable rejection for a non-array mediaUrls field"
- Mode: run
- Given: The AgentPhone webhook signing secret is configured.
- When: AgentPhone delivers a signed iMessage group `agent.message` webhook to `POST /api/agentphone/webhook` whose `mediaUrls` is a string instead of an array.
- Then: The webhook returns HTTP 500 with body "iMessage group webhook has no supported message content (unsupported_content_shape)".

## agentphone-groups.bdd-006

- Vitest: "iMessage group webhook content admission > returns a retryable rejection for plural-only media"
- Mode: run
- Given: The AgentPhone webhook signing secret is configured.
- When: AgentPhone delivers a signed iMessage group `agent.message` webhook to `POST /api/agentphone/webhook` with only a plural `mediaUrls` array containing one image URL and no message or `mediaUrl`.
- Then: The webhook returns HTTP 500 with body "iMessage group webhook has no supported message content (unsupported_media_urls)".

## agentphone-groups.bdd-007

- Vitest: "iMessage group webhook content admission > stores a corrected retry once after rejecting empty group content"
- Mode: run
- Given: A signed-in member has linked their phone to Okou through the AgentPhone connect prompt.
- When: AgentPhone delivers the same signed iMessage group webhook (same message ID and webhook ID) with empty content twice to `POST /api/agentphone/webhook`, then delivers the corrected message with text twice, and the member reads `GET /api/integrations/agentphone/group-history` for the group with limit 100.
- Then: Both empty deliveries return HTTP 500 mentioning `(empty_content)`. The history returns HTTP 200 with exactly one message, carrying the original message ID and the corrected text.

## agentphone-groups.bdd-008

- Vitest: "iMessage group discovery > discovers a group from messages received before the participant connected Okou"
- Mode: run
- Given: A linked member's phone and a second person's phone are both in an iMessage group, and a group message was received before the second person connected Okou. The second member then links their phone, and AgentPhone reports the conversation as a current group containing the second member's phone and the Okou number.
- When: The second member calls `GET /api/integrations/agentphone/groups` with limit 25.
- Then: The response returns HTTP 200 listing that group with `lastMessageAt` equal to the earlier message's receipt time.

## agentphone-groups.bdd-009

- Vitest: "iMessage group discovery > lists each shared group once with its current name and latest visible message time"
- Mode: run
- Given: A signed-in member has linked their phone and received two messages one second apart in one iMessage group plus a direct (non-group) message. AgentPhone now reports the group with the name "Renamed group".
- When: The member calls `GET /api/integrations/agentphone/groups` with limit 25.
- Then: The response returns HTTP 200 with exactly one group: its group ID, conversation ID, name "Renamed group", the Okou AgentPhone agent ID and `lastMessageAt` equal to the later message time, and `nextCursor` null.

## agentphone-groups.bdd-010

- Vitest: "iMessage group discovery > does not expose a known group to an another user"
- Mode: run
- Given: A linked member has an iMessage group conversation. A different member of the same workspace (another user) links a different phone; AgentPhone would report the group without that user's phone.
- When: The other user calls `GET /api/integrations/agentphone/groups` with limit 25.
- Then: The response returns HTTP 200 with `{ groups: [], nextCursor: null }`, and AgentPhone is never asked to look up the conversation.

## agentphone-groups.bdd-011

- Vitest: "iMessage group discovery > does not expose a known group to an another organization"
- Mode: run
- Given: A linked member has an iMessage group conversation. The same user calls from another organization (another workspace).
- When: The caller requests `GET /api/integrations/agentphone/groups` with limit 25 in the other workspace.
- Then: The request returns HTTP 404 with `NOT_FOUND`, and AgentPhone is never asked to look up the conversation.

## agentphone-groups.bdd-012

- Vitest: "iMessage group discovery > does not expose a known group to an unlinked phone"
- Mode: run
- Given: A linked member has an iMessage group conversation and then unlinks their phone with `DELETE /api/integrations/agentphone/link` (HTTP 204), so the phone is unlinked.
- When: The member calls `GET /api/integrations/agentphone/groups` with limit 25.
- Then: The request returns HTTP 404 with `NOT_FOUND`, and AgentPhone is never asked to look up the conversation.

## agentphone-groups.bdd-013

- Vitest: "iMessage group discovery > does not expose a known group to an departed member"
- Mode: run
- Given: A linked member has an iMessage group conversation, but AgentPhone now reports the group's participants without the member's phone (departed member).
- When: The member calls `GET /api/integrations/agentphone/groups` with limit 25.
- Then: The response returns HTTP 200 with `{ groups: [], nextCursor: null }` after AgentPhone is asked to look up exactly that conversation once.

## agentphone-groups.bdd-014

- Vitest: "iMessage group discovery > continues after an empty candidate page and does not repeat a group when new messages arrive"
- Mode: run
- Given: A linked member has messages in two iMessage groups whose IDs sort first and second. AgentPhone reports the first conversation as removed (HTTP 404) and the second as a current unnamed group.
- When: The member calls `GET /api/integrations/agentphone/groups` with limit 1, a new message then arrives in the first group, and the member requests the next page with the returned cursor.
- Then: The first page returns HTTP 200 with no groups and a continuation cursor. The second page returns exactly the second group (group ID, conversation ID, `groupName` null, agent ID, a `lastMessageAt`) with `nextCursor` null, without repeating the first group.

## agentphone-groups.bdd-015

- Vitest: "iMessage group discovery > omits a candidate when the provider resolves it to a foreign agent"
- Mode: run
- Given: A linked member has an iMessage group conversation, but AgentPhone resolves the conversation to a different (foreign) agent ID.
- When: The member calls `GET /api/integrations/agentphone/groups` with limit 25.
- Then: The response returns HTTP 200 with `{ groups: [], nextCursor: null }`.

## agentphone-groups.bdd-016

- Vitest: "iMessage group discovery > omits a candidate when the provider resolves it to a different group"
- Mode: run
- Given: A linked member has an iMessage group conversation, but AgentPhone resolves the conversation to a different group ID `grp_other`.
- When: The member calls `GET /api/integrations/agentphone/groups` with limit 25.
- Then: The response returns HTTP 200 with `{ groups: [], nextCursor: null }`.

## agentphone-groups.bdd-017

- Vitest: "iMessage group discovery > omits a candidate when the provider resolves it to a not a group"
- Mode: run
- Given: A linked member has an iMessage group conversation, but AgentPhone resolves the conversation as not a group (`isGroup: false`, no group ID).
- When: The member calls `GET /api/integrations/agentphone/groups` with limit 25.
- Then: The response returns HTTP 200 with `{ groups: [], nextCursor: null }`.

## agentphone-groups.bdd-018

- Vitest: "iMessage group discovery > omits a candidate when the provider resolves it to a different conversation"
- Mode: run
- Given: A linked member has an iMessage group conversation, but AgentPhone resolves it with a different conversation ID.
- When: The member calls `GET /api/integrations/agentphone/groups` with limit 25.
- Then: The response returns HTTP 200 with `{ groups: [], nextCursor: null }`.

## agentphone-groups.bdd-019

- Vitest: "iMessage group discovery > omits a candidate when the provider resolves it to a departed bot"
- Mode: run
- Given: A linked member has an iMessage group conversation, but AgentPhone resolves it with only the member as participant, so the Okou bot has departed.
- When: The member calls `GET /api/integrations/agentphone/groups` with limit 25.
- Then: The response returns HTTP 200 with `{ groups: [], nextCursor: null }`.

## agentphone-groups.bdd-020

- Vitest: "iMessage group discovery > reports provider failure instead of fabricating an empty list"
- Mode: run
- Given: A linked member has an iMessage group conversation, and AgentPhone's conversation lookup returns HTTP 503.
- When: The member calls `GET /api/integrations/agentphone/groups` with limit 25.
- Then: The request returns HTTP 502 with `AGENTPHONE_ERROR` instead of an empty list.

## agentphone-groups.bdd-021

- Vitest: "iMessage group discovery > requires authentication and rejects invalid pagination"
- Mode: run
- Given: A member has linked their phone through AgentPhone.
- When: An unauthenticated caller requests `GET /api/integrations/agentphone/groups` with limit 25, and the member requests it with cursor `invalid`.
- Then: The unauthenticated request returns HTTP 401 with `UNAUTHORIZED`, and the invalid cursor returns HTTP 400.
