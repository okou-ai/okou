# discord-conversation-parity

## discord-conversation-parity-001

- Vitest: "Discord context parity through public OAuth bindings > uses Slack history limits and readable sections while retaining the starter, quoted message and attachments"
- Mode: run
- Given: A Discord-connected member can read the parent channel and thread. The installation has message-content access. The parent has more than ten messages before the starter, and the thread has more than a hundred messages including an older cited decision and a recent attachment-only PDF.
- When: Discord delivers a signed mention in the thread quoting the older decision, and the Runner reads the resulting execution.
- Then: The Runner's context separates the newest ten parent messages from 100 thread entries. It retains the starter, explicitly marks the older quote, preserves sender and relative index, and retains full recent multiline text in chronological order. It represents the PDF by name, MIME type, file, channel and message IDs, without leaking its URL capability. The triggering prompt is not duplicated in history.

## discord-conversation-parity-002

- Vitest: "Discord context parity through public OAuth bindings > includes exactly ten recent channel messages with sender identities, resolved mentions and real newlines"
- Mode: run
- Given: A connected Discord installation can read content from a guild channel. Discord has twelve earlier messages with user mentions and line breaks, plus a later message.
- When: Discord posts the signed guild mention and the Runner fetches execution input.
- Then: Runner history has exactly the ten most recent preceding entries, with indices -10 through -1, the sender identity, display-name-expanded mentions with IDs, and real newlines. It excludes the earlier overflow, the future and triggering messages, and any thread section.

## discord-conversation-parity-003

- Vitest: "Discord context parity through public OAuth bindings > includes a referenced thread starter once in thread context, separate from parent history"
- Mode: run
- Given: A Discord thread has a starter in its parent channel, another parent discussion message, and an earlier reply in the thread.
- When: A connected member mentions the bot and explicitly quotes the parent-channel starter inside the thread.
- Then: The Runner's parent history contains only the separate discussion message. The thread section contains the prior reply and marks the starter as explicitly referenced. The starter's text appears exactly once across the full context.

## discord-conversation-parity-004

- Vitest: "Discord context parity through public OAuth bindings > omits unavailable parent history and never follows a reference into another channel"
- Mode: run
- Given: The connected Discord member can read a thread's history, but Discord denies the parent channel history with HTTP 403. An unrelated channel has a message referenced by the triggering event.
- When: Discord delivers the signed bot mention from inside the thread and the Runner reads context.
- Then: The context retains authorized thread history and excludes both the unavailable parent history and the unrelated channel message.

## discord-conversation-parity-005

- Vitest: "Discord context parity through public OAuth bindings > keeps an explicit DM reference out of the Agent's context"
- Mode: run
- Given: A connected member's Discord DM includes an explicit message reference to private content from another organization.
- When: Discord delivers the DM and the Runner reads the resulting execution input.
- Then: The current prompt contains the triggering DM text. The Runner's context does not contain the other organization's private content.

## discord-conversation-parity-006

- Vitest: "Discord context parity through public OAuth bindings > adds run attribution once to a split native send"
- Mode: run
- Given: A connected Discord actor triggered an active guild run and the Runner has its native integration bearer token.
- When: The Runner sends a long native update with `POST /api/integrations/discord/message`, then reads the channel's history with the same token.
- Then: Both calls return HTTP 200. The send has multiple receipts, whose messages reconstruct the original update followed by exactly one attribution to the Discord member who triggered the run.

## discord-conversation-parity-007

- Vitest: "Discord reply parity through public OAuth bindings > references the same-channel message only on the first long-message chunk"
- Mode: run
- Given: An authenticated native Discord caller may write to a channel and read the target message in that same channel.
- When: The caller sends a 4,001-character reply to the message and reads the returned message IDs through history.
- Then: The API returns HTTP 200 and three receipts. Concatenating their contents restores exactly the text. Only the first chunk references the target, and no outbound chunk enables mention parsing or replied-user mentions.

## discord-conversation-parity-008

- Vitest: "Discord reply parity through public OAuth bindings > does not deliver a reply to a deleted message"
- Mode: run
- Given: An authenticated native caller chooses a reply target that has been deleted.
- When: The caller sends a Discord reply to the selected destination through the native send endpoint.
- Then: The API returns HTTP 404 with an empty `deliveredMessages` list. Reading destination history shows no bot message from the attempted send.

## discord-conversation-parity-009

- Vitest: "Discord reply parity through public OAuth bindings > does not deliver a reply to a other-channel message"
- Mode: run
- Given: An authenticated native caller chooses a reply target that exists in another channel.
- When: The caller sends a Discord reply to the selected destination through the native send endpoint.
- Then: The API returns HTTP 404 with an empty `deliveredMessages` list. Reading destination history shows no bot message from the attempted send.

## discord-conversation-parity-010

- Vitest: "Discord reply parity through public OAuth bindings > revalidates write access after reading a reply target"
- Mode: run
- Given: The authenticated Discord caller initially has write access and the target is visible. Discord changes the member's channel permissions to deny sends while returning the target lookup.
- When: The caller attempts a native reply to the target.
- Then: The API rechecks permissions after the lookup, returns HTTP 404 `NOT_FOUND` with no delivered messages, and sends no Discord message.

## discord-conversation-parity-011

- Vitest: "Discord reply parity through public OAuth bindings > requires shared history access for a guild reply without restricting ordinary writes"
- Mode: run
- Given: The authenticated caller has guild channel write access but is denied permission to read history.
- When: The caller attempts a native reply to a known guild message, then sends ordinary text without a reply target.
- Then: The reply returns HTTP 404 with no delivered messages. The ordinary write still returns HTTP 200 with one receipt.

## discord-conversation-parity-012

- Vitest: "Discord reply parity through public OAuth bindings > references an own bot DM without reading its content"
- Mode: run
- Given: The caller has a native Discord integration token and names a bot DM for their own Discord identity. Discord would fail if the referenced message's content were read.
- When: The caller sends a native reply with the target's message ID.
- Then: The API returns HTTP 200 with a receipt for the DM channel, the outbound Discord request includes the message reference, and the API response does not expose the target's private content.

## discord-conversation-parity-013

- Vitest: "Discord reply parity through public OAuth bindings > references an other bot DM without reading its content"
- Mode: run
- Given: The caller has a native Discord integration token and names a bot DM for another Discord identity. Discord would fail if the referenced message's content were read.
- When: The caller sends a native reply with the target's message ID.
- Then: The API returns HTTP 200 with a receipt for the DM channel, the outbound Discord request includes the message reference, and the API response does not expose the target's private content.
