# chat-events-model-snapshot

## chat-events-model-snapshot-001

- Vitest: "accepted model source snapshots > keeps the accepted Claude source through disconnection and uses a new source on the next Run"
- Mode: run
- Given: An authenticated workspace member has a connected personal Claude provider and owns an attachment whose metadata response is delayed.
- When: The member starts a send selecting Claude with the attachment, deletes the model provider and creates a replacement while the metadata response is outstanding. The first Run finishes preparation and the member subsequently starts another Run with the same model.
- Then: The first dispatch still uses Claude Code, the original provider ID and the requested Anthropic model. The next dispatch uses the replacement provider ID.

## chat-events-model-snapshot-002

- Vitest: "accepted model source snapshots > keeps coherent Codex routing and recovery identity across reconnect (native=true)"
- Mode: run
- Given: An authenticated member has personal Codex identity, native Codex enabled, and an attachment whose metadata response is delayed.
- When: The member starts a Luna send with the attachment, reconnects the Codex provider to a different upstream identity by device auth before metadata arrives, then starts another Run after the first.
- Then: The first dispatch uses Codex, the original OAuth account and its credential source ID, and the Run's account readback is unavailable once replaced upstream. The next Run's account reads as connected with the replacement ID and the dispatch uses the replacement source ID and account identity.

## chat-events-model-snapshot-003

- Vitest: "accepted model source snapshots > keeps coherent Codex routing and recovery identity across reconnect (native=false)"
- Mode: run
- Given: An authenticated member has personal Codex identity, native Codex disabled, and an attachment whose metadata response is delayed.
- When: The member starts a Luna send with the attachment, reconnects the Codex provider to a different upstream identity by device auth before metadata arrives, then starts another Run after the first.
- Then: The first dispatch uses Pi with Luna and the Codex Responses dialect and declares access-token and account-ID credential bindings from the original source. Its Run's account reads as unavailable once replaced upstream. The next Run reads back connected with the replacement ID and its dispatch uses the replacement credential source.
