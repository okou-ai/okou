# workflow-recency

## workflow-recency-001

- Vitest: "workspace member workflow recency > distinguishes an uninitialized history from an initialized empty history"
- Mode: run
- Given: A workspace admin has created three public Workflows, and a signed-in workspace member has no recent-Workflow history yet.
- When: The member reads `GET /api/workflows/recent`, imports an empty list via `POST /api/workflows/recent/import`, reads again, imports the first Workflow, and records its use via `POST /api/workflows/recent/use`.
- Then: The first read returns `workflowIds` null. Importing `[]` returns `[]` and the next read returns `[]`. The later import of the first Workflow still returns `[]`, while recording its use returns `[first]`.

## workflow-recency-002

- Vitest: "workspace member workflow recency > moves all used IDs to the front in order without duplicating IDs or changing model preferences"
- Mode: run
- Given: A workspace admin has created three public Workflows, and a signed-in workspace member with no history has saved model preferences via `PUT /api/user-model-preference` with null model and service tier and image model `gpt-image-2`.
- When: The member records uses `[first, second, first]` and then `[third, first, third]` via `POST /api/workflows/recent/use`, reads `GET /api/workflows/recent`, and reads `GET /api/user-model-preference`.
- Then: The initial history is null. The first use returns `[first, second]`, the second returns `[third, first, second]`, and the read returns `[third, first, second]`. The model preferences keep the saved selected model, service tier, model settings and `gpt-image-2`.

## workflow-recency-003

- Vitest: "workspace member workflow recency > imports surviving IDs once in their original order and returns the server history on later imports"
- Mode: run
- Given: A workspace admin has created three public Workflows and deleted the second via `DELETE /api/workflows/:workflowId` (HTTP 204); a signed-in workspace member has no history.
- When: The member imports `[third, second, first, third, <unknown id>]` via `POST /api/workflows/recent/import`, imports `[first]` again, and reads `GET /api/workflows/recent`.
- Then: The first import returns `[third, first]`. The second import returns the existing server history `[third, first]`, and the read returns `[third, first]`.

## workflow-recency-004

- Vitest: "workspace member workflow recency > merges concurrent uses without losing either record when member metadata does not yet exist"
- Mode: run
- Given: A workspace admin has created three public Workflows, and a signed-in workspace member has no history (read returns null).
- When: The member records `[first, second]` and `[third, first]` concurrently via `POST /api/workflows/recent/use`, then reads `GET /api/workflows/recent`.
- Then: The final history is not null, contains exactly the three Workflow IDs once each, and equals one of the two use responses.

## workflow-recency-005

- Vitest: "workspace member workflow recency > keeps a concurrent use whether the import wins initialization or arrives too late"
- Mode: run
- Given: A workspace admin has created three public Workflows, and a signed-in workspace member has no history.
- When: The member concurrently imports `[second, third]` via `POST /api/workflows/recent/import` and records use of `[first]` via `POST /api/workflows/recent/use`, then reads `GET /api/workflows/recent`.
- Then: If the import result includes the second Workflow, the history is `[first, second, third]`; otherwise it is `[first]`.

## workflow-recency-006

- Vitest: "workspace member workflow recency > returns one canonical winner to both concurrent importers"
- Mode: run
- Given: A workspace admin has created three public Workflows, and a signed-in workspace member has no history.
- When: The member concurrently imports `[second, first]` and `[third, second]` via `POST /api/workflows/recent/import`, then reads `GET /api/workflows/recent`.
- Then: Both imports return the same list, which equals one of the two submitted histories, and the read returns that same list.

## workflow-recency-007

- Vitest: "workspace member workflow recency > isolates members and workspaces while retaining visible public shadows and rechecking revoked access"
- Mode: run
- Given: In one workspace, the admin owns public Workflow X, member Alice owns a private Workflow also named X, and member Bob owns a private Workflow; an admin of another workspace owns a public Workflow.
- When: Alice records uses of all four Workflows via `POST /api/workflows/recent/use` and reads `GET /api/workflows/for-composer`; Bob imports all four via `POST /api/workflows/recent/import`; Alice reads her history in the other workspace and in her own; the admin then demotes X via `POST /api/workflows/:workflowId/demote`.
- Then: Alice's use returns `[shared X, Alice's private X]`, while the composer lists only her private Workflow under name X. Bob starts with null history and his import returns `[shared X, Bob's private]`. Alice's history in the other workspace is null and in her own is `[shared X, private X]`. After the demotion, Alice's history reads `[private X]` and Bob's reads `[Bob's private]`.

## workflow-recency-008

- Vitest: "workspace member workflow recency > requires organization member authentication and returns private, uncached history"
- Mode: run
- Given: A signed-in workspace member has no history; separately, a signed-in user has no organization, and a caller is not authenticated.
- When: The member reads `GET /api/workflows/recent`; the organization-less user calls `GET /api/workflows/recent`, `POST /api/workflows/recent/use` and `POST /api/workflows/recent/import` with empty lists; the unauthenticated caller reads `GET /api/workflows/recent`.
- Then: The member gets HTTP 200 with `workflowIds` null and `Cache-Control: private, no-store`. Every organization-less request and the unauthenticated request return HTTP 401.
