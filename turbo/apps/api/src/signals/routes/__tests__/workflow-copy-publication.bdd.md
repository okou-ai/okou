# workflow-copy-publication

## workflow-copy-publication-001

- Vitest: "rejects a prepared copy after the source Workflow changes"
- Mode: run
- Given: A workspace owner on limited free onboarding has a public workflow with instruction "# Before preparation" and a `notes.md` file; another workspace member is signed in.
- When: The member copies the workflow via `POST /api/workflows/:workflowId/copy`, and while the copy's archive upload is in progress the owner updates the workflow instruction to "# Changed during preparation".
- Then: The copy returns HTTP 409 with error code `CONFLICT`. The member's workflow list contains no private workflow with that name, and the source workflow reads back via `GET /api/workflows/:workflowId` with instruction "# Changed during preparation".

## workflow-copy-publication-002

- Vitest: "rejects a prepared member copy after its public source is deleted"
- Mode: run
- Given: A workspace admin on limited free onboarding has a public workflow with a `notes.md` file; another workspace member is signed in.
- When: The member copies the workflow via `POST /api/workflows/:workflowId/copy`, and while the copy's archive upload is in progress the admin deletes the source workflow (HTTP 204).
- Then: The copy returns HTTP 409 with error code `CONFLICT`, and the member's workflow list contains no private workflow with that name.
