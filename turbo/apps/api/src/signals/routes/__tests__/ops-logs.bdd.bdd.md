# ops-logs.bdd

## ops-logs.bdd-001

- Vitest: "OPS-01: user data export > rejects unauthenticated and org-less export requests"
- Mode: run
- Given: An unauthenticated caller and a signed-in user without an organization.
- When: The unauthenticated caller requests `GET /api/user/export` and `POST /api/user/export`; the user without an organization requests `POST /api/user/export`.
- Then: All three return HTTP 401 with `{ error: { code: "UNAUTHORIZED", message: "Not authenticated" } }`.

## ops-logs.bdd-002

- Vitest: "OPS-01: user data export > admits one active export and isolates its public status by owner"
- Mode: run
- Given: At 2026-05-12T05:00Z a signed-in workspace member has never exported, and export storage is available; a peer user exists.
- When: The member reads `GET /api/user/export`, starts `POST /api/user/export` twice, and reads the status; after background work runs the peer reads their own status.
- Then: The first read returns `job: null`, `canExport: true`, `nextExportAt: null`. The first start returns HTTP 202 `pending`, and the repeat returns HTTP 202 with the same job ID in `pending` or `running`. The status shows that job in `pending` or `running` with no download URL and `canExport: false`. The peer sees `job: null`, `canExport: true`, `nextExportAt: null`.

## ops-logs.bdd-003

- Vitest: "OPS-01: user data export > keeps public export-source resources separate from a peer"
- Mode: run
- Given: A Pro member in a provisioned workspace has personal instructions, a workflow, and a pinned empty thread (pin order `a0`); an onboarded peer in the same workspace has a private thread.
- When: The member reads their thread, requests the peer's thread via `GET /api/chat-threads/:id`, reads `GET /api/instructions`, and reads the workflow via `GET /api/workflows/:workflowId`.
- Then: The member's thread reads back with its ID, title and pin order `a0`. The peer's thread returns HTTP 404. The instructions content is "Use the exported personal instructions." and the workflow reads back with its ID and instruction "Use the exported workflow instructions."

## ops-logs.bdd-004

- Vitest: "OPS-01: user data export > keeps current memory and its retained version separate from a peer"
- Mode: run
- Given: A Pro member and an onboarded peer share a workspace. The member's earlier Run committed an old Memory version, a later Run committed `MEMORY.md` and a binary `notes/data.bin`, and the peer's Run committed its own Memory file.
- When: A new Run starts for the member and its Runner execution input is read.
- Then: The member's two commits share one Memory storage with different versions, and the peer's Memory uses a different storage. The new Run's storage manifest mounts `memory` at the member's storage and current (latest) version.
