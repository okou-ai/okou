# chat-event-annotations

## chat-event-annotations-001

- Vitest: "chat event annotations > projects precise source links for Slack messages"
- Mode: run
- Given: A connected Slack integration receives a channel mention with the Slack workspace, channel and message timestamp available.
- When: Slack delivers the message and the member reads its Chat event.
- Then: The event's source part is `slack` and points to the exact Slack message permalink `https://vm0.slack.com/archives/C123/p1753257600000100`.

## chat-event-annotations-002

- Vitest: "chat event annotations > projects precise source links for Feishu messages"
- Mode: run
- Given: A connected Feishu integration receives a message with an open chat ID.
- When: Feishu delivers the message and the member reads its Chat event.
- Then: The event includes a `feishu` source that points to the chat's Feishu app link using `openChatId=oc_123`.

## chat-event-annotations-003

- Vitest: "chat event annotations > projects precise source links for Teams channel messages"
- Mode: run
- Given: A connected Teams integration receives a channel message with a tenant, conversation and activity ID.
- When: Teams delivers the message and the user reads the resulting Chat input.
- Then: The event has a `teams` source link to the exact encoded channel and activity, including the tenant ID.

## chat-event-annotations-004

- Vitest: "chat event annotations > omits source links for Teams personal messages without a bot recipient"
- Mode: run
- Given: A connected Teams integration receives a personal message without a bot recipient ID.
- When: Teams delivers the message and the user reads the resulting Chat input.
- Then: The event has a `teams` source part without a link.

## chat-event-annotations-005

- Vitest: "chat event annotations > projects precise source links for Telegram supergroup messages"
- Mode: run
- Given: A connected Telegram integration receives a supergroup message with its group and message IDs.
- When: Telegram delivers the message and the user reads the Chat event.
- Then: The event has a `telegram` source linking to the exact message at `https://t.me/c/1234567890/42`.

## chat-event-annotations-006

- Vitest: "chat event annotations > omits source links for Telegram private messages without a bot username"
- Mode: run
- Given: A connected Telegram integration receives a private message without an available bot username.
- When: Telegram delivers the message and the user reads the Chat event.
- Then: The event includes the `telegram` source kind without a link.

## chat-event-annotations-007

- Vitest: "chat event annotations > omits source links for Telegram basic group messages"
- Mode: run
- Given: A connected Telegram integration receives a basic group message.
- When: Telegram delivers the message and the user reads the resulting Chat input.
- Then: The event includes the `telegram` source kind without a link.

## chat-event-annotations-008

- Vitest: "chat event annotations > projects precise source links for GitHub issue comments"
- Mode: run
- Given: An authenticated member can start a Chat Run with a source part containing a GitHub issue-comment URL and comment anchor.
- When: The member sends the source as part of a prompt and reads the resulting input event.
- Then: The event includes a `github` source linked to the exact issue comment, preserving the comment anchor.

## chat-event-annotations-009

- Vitest: "chat event annotations > projects precise source links for GitHub pull requests"
- Mode: run
- Given: An authenticated member can start a Chat Run with a source part containing a GitHub pull request URL.
- When: The member sends the source as part of a prompt and reads the resulting input event.
- Then: The event includes a `github` source linking to the exact pull request.

## chat-event-annotations-010

- Vitest: "chat event annotations > inherits precise source links across claimed and rejected replacements"
- Mode: run
- Given: A permitted member submits a prompt with a GitHub issue-comment source. A different member has no usable paid credits and a connected Teams integration that receives a channel mention.
- When: A Runner claims the first prompt and the API rejects admission of the Teams input after accepting its webhook with HTTP 200. Each member reads the replacement input event.
- Then: The claimed replacement preserves the full GitHub comment link and Run readback is running. The rejected replacement preserves the Teams link for the encoded channel, activity and tenant.
