# projects

## projects-001

- Vitest: "archives and restores a Project with its original member"
- Mode: run
- Given: A signed-in workspace member owns a Project containing one conversation; Project snapshots are stored in object storage.
- When: The member archives the Project with `PATCH /api/projects/:id` `archived: true`, reads `GET /api/projects/snapshot`, restores it with `archived: false`, reads `GET /api/projects/events` since the snapshot, and lists `GET /api/projects/:id/threads?archived=all`.
- Then: Archiving returns `archived: true` with a `lastArchivedAt`, and the uploaded `project-snapshots/v1/` archive contains exactly the archived Project. The event tail has one event for the Project with `archived: false` and the original `lastArchivedAt`; the restored Project keeps that timestamp and its original `sortOrder`. The Project's thread list contains the original conversation, not archived.

## projects-002

- Vitest: "private Project order > moves whole groups before and after targets, preserves rank on rename and appends new Projects"
- Mode: run
- Given: A signed-in workspace member creates Projects `First`, `Second` and `Third`.
- When: The member moves Third before First and First after Second with `POST /api/projects/:id/reorder`, renames First, creates `Fourth`, and reads the list and `GET /api/projects/events`.
- Then: New Projects get a string `sortOrder` and list in creation order. Reorders return HTTP 204 and the list becomes Third, First, Second, then Third, Second, First. Renaming keeps First's rank and Fourth is appended last. The `sort_updated` events are exactly Third's move followed by First's move with First's final rank.

## projects-003

- Vitest: "private Project order > settles no-op and replayed moves by event identity without undoing a newer order"
- Mode: run
- Given: A signed-in workspace member owns Projects First, Second and Third.
- When: The member moves Third before First with an event ID, moves Third after Second, replays the first move with the same event ID, reuses that event ID for a different move, and sends a move to the current position with a new event ID.
- Then: The moves and the replay return HTTP 204 and the replay does not undo the newer order (First, Second, Third). Reusing the event ID for a different move returns HTTP 409. The no-op move returns 204 and records a `sort_updated` event for Third, the replayed event ID appears once, and the order stays First, Second, Third.

## projects-004

- Vitest: "private Project order > hides foreign source and target Projects from colleagues and other organizations"
- Mode: run
- Given: A member owns Projects First and Second; a colleague in the same organization owns `Foreign`, and the same user in another organization owns `Elsewhere`.
- When: The colleague and the member each try to reorder First relative to Foreign, and the other-organization identity and the member each try to reorder First relative to Elsewhere, via `POST /api/projects/:id/reorder`.
- Then: All four reorders return HTTP 404. Each identity's list contains only its own Projects in their original order.

## projects-005

- Vitest: "private Project order > arbitrates competing owner writes without duplicate tail ranks or partial event publication"
- Mode: run
- Given: A signed-in member owns one Project named `Initial`.
- When: The member concurrently creates two Projects with `POST /api/projects` (retrying any that return 409), then concurrently sends two identical reorders with the same event ID, and reads `GET /api/projects/events`.
- Then: At least one create returns 201, any others return 409 and succeed on retry. `Initial` stays first and all three Projects have distinct ranks. Both duplicate reorders return 204, and the event log has exactly sequence IDs 1 to 4, the last being a `sort_updated` for `Initial` with that event ID.

## projects-006

- Vitest: "private Projects > lets a dispatched member Run create and read its own Project"
- Mode: run
- Given: A member's dispatched Run holds its Okou token.
- When: The Run calls `POST /api/projects` with name `Run project` and then `GET /api/projects/:id` using the Run token.
- Then: Creation returns HTTP 201 and the read returns HTTP 200 with the same ID and name.

## projects-007

- Vitest: "private Projects > preserves structured Project references through member composer and Thread drafts"
- Mode: run
- Given: A signed-in member owns a Project and a conversation in it, with a chat model configured.
- When: The member saves a draft with a Project mention and a feedback note mentioning the Project via `PATCH /api/chat-threads/:id` and reads `GET /api/chat-threads/:id/draft`, then saves and reads the same draft through `PATCH`/`GET /api/chat-drafts/composer`.
- Then: Both saves return HTTP 204, and both reads return HTTP 200 with exactly the saved structured draft.

## projects-008

- Vitest: "private Projects > isolates each member’s Projects across colleagues and organizations"
- Mode: run
- Given: A signed-in member owns a Project; a colleague in the same organization and the same user in another organization also sign in.
- When: The colleague reads `GET /api/projects/:id` and lists `GET /api/projects`; the other-organization identity reads the Project.
- Then: The colleague's read returns HTTP 404 and their list is empty; the other-organization read returns HTTP 404.

## projects-009

- Vitest: "private Projects > keeps thread activity while moving across Projects and ignores a replayed old move"
- Mode: run
- Given: A signed-in member has two conversations; Project `Launch` was created from the first and Project `Research` is new.
- When: The member moves the second conversation into Launch, reorders Research before Launch, lists Launch's threads, then moves the first conversation into Launch with an event ID, into Research, replays the old move, reuses the old event ID for another conversation, and sends a move with an event ID older than 8 days.
- Then: Launch lists both conversations and the first keeps its creation time as `sortAt`. The moves and the replay return HTTP 200 but Research still lists only the first conversation. Reusing the old event ID for another conversation returns 409, and the expired event ID returns 409.

## projects-010

- Vitest: "private Projects > deletes the Project atomically, clears each membership and never resurrects an old creation"
- Mode: run
- Given: A signed-in member has Project `Launch` created from a first conversation, and a second conversation created inside it.
- When: The member deletes the Project with `DELETE /api/projects/:id`, reads it, reads `GET /api/chat-threads/events`, and recreates it with the original ID, event ID and source conversation.
- Then: The second conversation reports the Project's ID. Deletion returns HTTP 204 and the read returns 404. Each conversation's last `project_updated` event has a null Project and neither conversation is deleted. Recreating with the old creation identity returns 404.

## projects-011

- Vitest: "private Projects > rejects a missing or foreign source without creating a Project or publishing events"
- Mode: run
- Given: A signed-in member has no Projects.
- When: The member calls `POST /api/projects` with a `fromThreadId` that does not exist.
- Then: The request returns HTTP 404, the Project list is empty, and the Project events list is empty.

## projects-012

- Vitest: "serializes concurrent moves, duplicate creates and deletion against new memberships"
- Mode: run
- Given: A signed-in member has a conversation and Projects Launch and Review.
- When: The member sends two identical concurrent Project creations from the conversation, concurrently moves the conversation into Launch and Review via `PUT /api/chat-threads/:id/project`, then concurrently deletes Launch and moves the conversation into it.
- Then: Both duplicate creates return 201 and both moves return 200; the Project named by the conversation's last `project_updated` event lists exactly that conversation. The deletion returns 204 or 409 and the move 200 or 404; if the deletion succeeded, Launch returns 404 and the conversation's last membership event does not point to it.

## projects-013

- Vitest: "publishes immutable owner-scoped metadata snapshots with an exact event tail fence"
- Mode: run
- Given: A signed-in member has no Projects; Project snapshots are stored in object storage.
- When: The member reads `GET /api/projects/snapshot`, creates Project `Original`, reads the snapshot, creates `Second`, reorders it before Original, renames Original, reads `GET /api/projects/events` since the snapshot, and reads the snapshot again.
- Then: The empty snapshot has `latestEventId` null and `latestSeqId` 0. After creation the snapshot has a URL and the stored archive contains exactly the Project with `latestSeqId` 1, matching the response. The tail lists `created` (seq 2), `sort_updated` (seq 3) and `renamed` (seq 4) with the expected ranks and name. The new snapshot fences at seq 4, the list is Second then Original, and the earlier archive object is unchanged.
