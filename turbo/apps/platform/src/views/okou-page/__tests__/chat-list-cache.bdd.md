# Chat list cache

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-list-cache.test.tsx](chat-list-cache.test.tsx).

## chat-list-cache-001

Original test `Cached conversations appear before remote synchronization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-cache.test.tsx#L32).

- **Given** An authenticated user opens the chat page with a cached conversation and a cached rename event; remote conversation synchronization and agent loading have not completed.
- **When** The page starts displaying the conversation list.
- **Then** The latest cached title appears before remote synchronization or agent loading completes.

## chat-list-cache-002

Original test `A complete cached conversation list remains navigable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-cache.test.tsx#L60).

- **Given** An authenticated user has 26 cached conversations and remote synchronization is still pending.
- **When** The user views the conversation list.
- **Then** All 26 cached conversations appear in reverse order, each links to a chat, and the list is available before remote synchronization completes.

## chat-list-cache-003

Original test `Rename dialog uses the latest cached title`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-cache.test.tsx#L95).

- **Given** An authenticated user has a cached conversation renamed to “Cached renamed title”; the remote conversation and detail requests have not completed.
- **When** The user opens that conversation’s menu and chooses Rename chat.
- **Then** The rename dialog is prefilled with “Cached renamed title,” without waiting for either remote request.

## chat-list-cache-004

Original test `Signed-out pages do not sync private conversations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-cache.test.tsx#L151).

- **Given** A signed-out user opens the sign-in page.
- **When** The page loads.
- **Then** The sign-in page remains at /sign-in, and no private conversation snapshot, events, indicators, or agent-list requests are made.

**Batch 28, unverified.** The signed-out Router rendered the Clerk sign-in surface at `/sign-in`. Neither observation establishes that snapshot, event, indicator and agent-list reads were absent. Recording those requests would measure the synchronization protocol. The two cached-list cases (001 and 002) passed; 004 remains open. [Batch 28 evidence](../../../../test-rebuild-rework-checkpoint.md#batch-28-evidence).

## chat-list-cache-005

Original test `The unread filter applies to cached conversations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-cache.test.tsx#L192).

- **Given** An authenticated user has cached unread and read conversations, the unread indicator marks the first conversation unread, and remote synchronization is pending.
- **When** The user selects the unread-only filter from the conversation-list menu.
- **Then** Initially both cached conversations appear; after filtering, only the unread conversation appears, before remote synchronization completes.
