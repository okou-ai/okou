# cron-compact-chat-thread-snapshots

## cron-compact-chat-thread-snapshots-001

- Vitest: "publishes scoped sidebars with pinned and archived threads"
- Mode: run
- Given: A signed-in user has pinned, archived and ordinary chat threads in one organization and a separate thread in another organization. Snapshot storage is available.
- When: An operator calls the chat thread snapshot compaction cron with its valid bearer credential. The user reads the sidebar snapshot over HTTP and calls the MCP chat thread listing under the first organization, then reads the snapshot under the other organization.
- Then: Compaction returns HTTP 200. The first organization sees only its three threads, with the pinned thread first and the archived flag set. MCP returns their IDs in the same order without exposing the storage URL. The other organization sees only its own thread.
