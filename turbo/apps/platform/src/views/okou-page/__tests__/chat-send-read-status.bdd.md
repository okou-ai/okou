# Chat send read status

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-send-read-status.test.tsx](chat-send-read-status.test.tsx).

## chat-send-read-status-001

Original test `Send in an existing conversation while unread indicators are pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.test.tsx#L27).

- **Given** The user is sending a message in an existing conversation while unread-indicator refresh is pending.
- **When** They send “Continue the release review,” then wait for the refresh to remain pending.
- **Then** The submitted message and agent response appear, and the message box clears. A follow-up message stays disabled until unread refresh completes; sending is available afterward.

## chat-send-read-status-002

Original test `Send in an existing conversation while unread indicators are unauthorized`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.test.tsx#L27).

- **Given** The user is sending a message in an existing conversation while unread-indicator refresh is pending and will return unauthorized.
- **When** They send “Continue the release review,” then the unread refresh returns unauthorized.
- **Then** The submitted message and agent response appear, and the message box clears. A follow-up message can be sent even though the refresh was unauthorized.

## chat-send-read-status-003

Original test `Unread refresh failure ends submission without cancelling the pending POST`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.test.tsx#L97).

- **Given** The user has an unread-indicator refresh in progress and a message send whose POST response is pending.
- **When** They send “Review the release while read status refreshes,” enter “Keep the follow-up ready,” and the refresh fails with unauthorized.
- **Then** The follow-up message becomes sendable while the original POST is still pending, and its text remains in the composer. After the POST completes, the agent receives the submitted review and the follow-up text remains.

## chat-send-read-status-004

Original test `Forwarding dismisses its composer before unread refresh or POST completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.test.tsx#L157).

- **Given** The user selects a passage in a completed conversation and opens its forwarding composer, with an existing draft reading “Keep the existing notes.”
- **When** They forward the passage with “Review these stages with the team” while unread refresh and the send POST are both pending.
- **Then** “Forwarded successfully” appears and the forwarding dialog closes before either request completes. The original conversation’s draft remains unchanged; after the POST completes, the agent receives the forwarded passage.
- **Upstream change** `4e5707de` (#49556) retires the Forward target picker and removes this upstream test: a passage can no longer be forwarded into an existing conversation (“Forwarded successfully”), and the toolbar action is now `Fork`, whose `Okou` composer still closes on optimistic send with “New chat created” and starts a new chat. Only forwarding into an existing conversation is retired; rebuild this scenario with `Fork`, expecting “New chat created” and the dialog closing before the unread refresh or POST completes with the source draft unchanged, without expecting the agent's reply in the source conversation.

## chat-send-read-status-005

Original test `A failed read mark does not prevent sending to the agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.test.tsx#L235).

- **Given** A previous conversation run has completed, and marking it as read fails with unauthorized.
- **When** The user sends “Review the deployment risks” to the agent.
- **Then** The agent receives the message despite the failed read mark, and the composer clears.
