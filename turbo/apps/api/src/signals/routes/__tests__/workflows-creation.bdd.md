# workflows-creation

## workflows-creation-001

- Vitest: "keeps a Workflow unlisted until its attachment is ready and publishes readable contents"
- Mode: run
- Given: A signed-in user with completed free onboarding creates a Workflow with instruction "Read the attached reference" and attachment `reference.md` ("附件"); the attachment archive upload to storage is held in flight.
- When: While the upload is held the user lists `GET /api/workflows`; the upload then completes and the user reads `GET /api/workflows/:workflowId` for the created Workflow.
- Then: The list during the upload does not include the Workflow name. Creation returns HTTP 201, and the read returns HTTP 200 with the submitted instruction and `fileContents` equal to the submitted files.

## workflows-creation-002

- Vitest: "publishes one readable Workflow for duplicate creates"
- Mode: run
- Given: A signed-in user with completed free onboarding sends `POST /api/workflows` with a name, instruction and `reference.md` attachment, and that first request's archive upload is held in flight.
- When: The user sends a second identical `POST /api/workflows`, then the first upload is released, and the user reads the winning Workflow via `GET /api/workflows/:workflowId`.
- Then: The second create returns HTTP 201 and the first returns HTTP 409. The winner's `fileContents` equal the submitted files.

## workflows-creation-003

- Vitest: "keeps the name available after an aborted attachment upload"
- Mode: run
- Given: A signed-in user with completed free onboarding creates a Workflow with a `reference.md` attachment, and the client aborts the request right after the attachment archive is written.
- When: The aborted `POST /api/workflows` ends, then the user repeats the same create and reads `GET /api/workflows/:workflowId`.
- Then: The first request ends with an `AbortError`. The repeated create with the same name returns HTTP 201, and the read shows `fileContents` equal to the submitted files.

## workflows-creation-004

- Vitest: "preserves the original upload error and another Workflow's files"
- Mode: run
- Given: A signed-in user with completed free onboarding has created a Workflow with a `reference.md` attachment (HTTP 201). Storage then rejects the next attachment upload with "Original provider upload failure".
- When: The user creates a second Workflow with a different name via `POST /api/workflows`, then reads the first Workflow via `GET /api/workflows/:workflowId`.
- Then: The second create fails with the original error "Original provider upload failure". The first Workflow still reads with `fileContents` equal to its files.

## workflows-creation-005

- Vitest: "does not reserve a Workflow name when its files conflict with a directory"
- Mode: run
- Given: A signed-in user with completed free onboarding.
- When: The user sends `POST /api/workflows` with files `reference` and `reference/nested.md`, then repeats the create with the same name and a single `reference.md` file.
- Then: The first create fails with "Workflow attachment file conflicts with a directory" and writes nothing to storage. The second create with the same name returns HTTP 201.

## workflows-creation-006

- Vitest: "publishes without linking a chat deleted while the attachment upload is in flight"
- Mode: run
- Given: A signed-in user with completed free onboarding has a chat Thread "Workflow discussion" and creates a Workflow linked to it via `chatThreadId`; the attachment upload is held in flight.
- When: While the upload is held the user deletes the Thread via `DELETE /api/chat-threads/:id`; the upload then completes, and the user reads `GET /api/chat-threads/:id`.
- Then: Creation returns HTTP 201 with the submitted Workflow name, and reading the deleted Thread returns HTTP 404.
