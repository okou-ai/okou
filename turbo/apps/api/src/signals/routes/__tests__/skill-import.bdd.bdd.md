# skill-import.bdd

## skill-import.bdd-001

- Vitest: "POST /api/skill-import/sessions > keeps parallel sessions and late uploads attributed to their own credentials"
- Mode: run
- Given: A signed-in workspace member opened a `claudeCode` import session and then a `codex` import session with `POST /api/skill-import/sessions`.
- When: The second session's token uploads `new-session-skill` and then the first session's token uploads `late-old-session-skill` with `POST /api/skill-import/skills`; the member lists each session with `GET /api/skill-import/sessions/:sessionId/skills`.
- Then: The sessions have different session IDs and tokens, and both uploads return HTTP 201. Each session's list returns HTTP 200 with exactly the workflow its own token created.

## skill-import.bdd-002

- Vitest: "POST /api/skill-import/sessions > does not expose another member or organization's import results"
- Mode: run
- Given: A signed-in workspace member opened an import session and uploaded a skill with its token. Another member of the same organization and a user from another workspace exist.
- When: The other two users, each signed in as themselves, call `GET /api/skill-import/sessions/:sessionId/skills` for that session ID, and a caller with only the upload token (no Clerk session) calls the same route.
- Then: Both other users receive HTTP 200 with an empty list, and the upload-token caller receives HTTP 401.

## skill-import.bdd-003

- Vitest: "POST /api/skill-import/sessions > issues an upload session for the workspace member"
- Mode: run
- Given: A signed-in workspace member.
- When: The member opens a `claudeCode` import session with `POST /api/skill-import/sessions`.
- Then: The response returns HTTP 200 with `uploadUrl` `http://localhost:3000/api/skill-import/skills`, a token starting with `vm0_skillimport_`, the published import limits, and an expiry more than 23 and at most 24 hours away.

## skill-import.bdd-004

- Vitest: "POST /api/skill-import/sessions > refuses an unauthenticated caller"
- Mode: run
- Given: The caller presents a bearer token that Clerk does not authenticate.
- When: The caller calls `POST /api/skill-import/sessions` with provider `claudeCode`.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## skill-import.bdd-005

- Vitest: "POST /api/skill-import/skills > imports a skill as a private workflow for the workspace member"
- Mode: run
- Given: A signed-in workspace member opened a `claudeCode` import session.
- When: The session token uploads skill "Release Notes" with `POST /api/skill-import/skills`, including the aliases `./references//tone.md`, `references//tone.md` and `references/tone.md`; the member then reads `GET /api/workflows/:workflowId` and `GET /api/workflows`.
- Then: The upload returns HTTP 201 with `outcome` `created`, a workflow ID and name `release-notes`. The workflow is private, owned by the member, with the given display name, description and instruction, and exactly one file `references/tone.md` containing "Keep it short. 世界". The workflow list includes it as private `release-notes`.

## skill-import.bdd-006

- Vitest: "POST /api/skill-import/skills > tags the workflow with the tool the session was opened for"
- Mode: run
- Given: A signed-in workspace member opened a `codex` import session.
- When: The session token uploads a skill with `POST /api/skill-import/skills`, then the member lists `GET /api/workflows`.
- Then: The upload returns HTTP 201 and the listed workflow has `importSource` `codex`.

## skill-import.bdd-007

- Vitest: "POST /api/skill-import/skills > skips a skill whose name is already imported"
- Mode: run
- Given: A signed-in workspace member's import session already created `release-notes`.
- When: The same token uploads `release-notes` again with a different instruction via `POST /api/skill-import/skills`.
- Then: The response is HTTP 200 with `outcome` `skipped`, `reason` `name_exists`, the existing workflow ID and name `release-notes`.

## skill-import.bdd-008

- Vitest: "POST /api/skill-import/skills > reports a name taken by a built-in workflow"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token uploads a skill named `workflow-setup`, a built-in workflow name, with `POST /api/skill-import/skills`.
- Then: The response is HTTP 409 with error code `SKILL_NAME_TAKEN`.

## skill-import.bdd-009

- Vitest: "POST /api/skill-import/skills > rejects a request body over the size limit"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token uploads a skill whose instruction is one byte over the 2 MiB request limit with `POST /api/skill-import/skills`.
- Then: The response is HTTP 413 with error code `SKILL_TOO_LARGE`.

## skill-import.bdd-010

- Vitest: "POST /api/skill-import/skills > rejects an instruction over the instruction limit"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token uploads a skill whose instruction is one byte over the 256 KiB instruction limit with `POST /api/skill-import/skills`.
- Then: The response is HTTP 413 with error code `SKILL_TOO_LARGE`.

## skill-import.bdd-011

- Vitest: "POST /api/skill-import/skills > rejects content that is not valid UTF-8"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token posts a raw JSON body to `POST /api/skill-import/skills` whose instruction contains the invalid UTF-8 bytes `0xFF 0xFE`.
- Then: The response is HTTP 400 with error code `BINARY_FILE_UNSUPPORTED`.

## skill-import.bdd-012

- Vitest: "POST /api/skill-import/skills > rejects metadata that carries binary content"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token uploads a skill whose description contains a NUL character with `POST /api/skill-import/skills`.
- Then: The response is HTTP 400 with error code `BINARY_FILE_UNSUPPORTED`.

## skill-import.bdd-013

- Vitest: "POST /api/skill-import/skills > repairs relative Windows paths and preserves the attachment text"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token uploads a skill with files `references\tone.md` and `.\scripts\\check.sh` via `POST /api/skill-import/skills`, then the member reads `GET /api/workflows/:workflowId`.
- Then: The upload returns HTTP 201 with `outcome` `created` and name `release-notes`. The workflow files are exactly `references/tone.md` ("Keep it short. 世界") and `scripts/check.sh` ("echo ok\n").

## skill-import.bdd-014

- Vitest: "POST /api/skill-import/skills > imports the instruction and valid files while reporting unusable attachments"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token uploads a skill via `POST /api/skill-import/skills` with valid files, 19 invalid paths (absolute, drive, UNC, parent-escaping, `SKILL.md` variants, directories, and names over 255 bytes), a file with a NUL byte, and a file one byte over the 64 KiB file limit; the member reads `GET /api/workflows/:workflowId`.
- Then: The upload returns HTTP 201 and `skippedFiles` lists each invalid path as `invalid_path`, `data.txt` as `binary_content` and `large.txt` as `size_limit`, in order. The workflow keeps the instruction and exactly `references/tone.md`, `scripts/check.sh` and the 255-byte filename file.

## skill-import.bdd-015

- Vitest: "POST /api/skill-import/skills > deduplicates identical path aliases before enforcing the file count limit"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token uploads 51 entries alternating `./references/tone.md` and `references/tone.md` plus `scripts/check.sh`, all with the same text, via `POST /api/skill-import/skills` (row `file count`), then the member reads `GET /api/workflows/:workflowId`.
- Then: The upload returns HTTP 201 with `outcome` `created` and name `release-notes`, and the workflow files are exactly `references/tone.md` and `scripts/check.sh`.

## skill-import.bdd-016

- Vitest: "POST /api/skill-import/skills > deduplicates identical path aliases before enforcing the combined bytes limit"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token uploads 17 entries of 64 KiB alternating `./references/tone.md` and `references/tone.md` plus a 64 KiB `scripts/check.sh` via `POST /api/skill-import/skills` (row `combined bytes`), then the member reads `GET /api/workflows/:workflowId`.
- Then: The upload returns HTTP 201 with `outcome` `created` and name `release-notes`, and the workflow files are exactly `references/tone.md` and `scripts/check.sh`.

## skill-import.bdd-017

- Vitest: "POST /api/skill-import/skills > imports the instruction when every attachment is invalid"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token uploads a skill whose only file has path `.` via `POST /api/skill-import/skills`, then the member reads `GET /api/workflows/:workflowId`.
- Then: The upload returns HTTP 201 with `skippedFiles` `[{ path: ".", reason: "invalid_path" }]`. The workflow has the instruction and no files.

## skill-import.bdd-018

- Vitest: "POST /api/skill-import/skills > keeps accepted files when the file count limit is reached"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token uploads 51 small text files `file-0.txt` to `file-50.txt` via `POST /api/skill-import/skills` (row `file count`, limit 50), then the member reads `GET /api/workflows/:workflowId`.
- Then: The upload returns HTTP 201 with only `file-50.txt` skipped as `size_limit`, and the workflow has 50 files.

## skill-import.bdd-019

- Vitest: "POST /api/skill-import/skills > keeps accepted files when the combined bytes limit is reached"
- Mode: run
- Given: A signed-in workspace member opened an import session.
- When: The token uploads 17 files of 64 KiB `file-0.txt` to `file-16.txt` via `POST /api/skill-import/skills` (row `combined bytes`, 1 MiB total limit), then the member reads `GET /api/workflows/:workflowId`.
- Then: The upload returns HTTP 201 with only `file-16.txt` skipped as `size_limit`, and the workflow has 16 files.

## skill-import.bdd-020

- Vitest: "POST /api/skill-import/skills > imports only the instruction when attachment upload fails at start"
- Mode: run
- Given: A signed-in workspace member opened an import session, and object storage fails to start the multipart attachment upload (row `start`).
- When: The token uploads a skill with `references/tone.md` via `POST /api/skill-import/skills`, then the member reads the workflow and `GET /api/skill-import/sessions/:sessionId/skills`.
- Then: The upload returns HTTP 201 with `references/tone.md` skipped as `upload_failed`. The workflow has the instruction and no files, and the session lists exactly that workflow.

## skill-import.bdd-021

- Vitest: "POST /api/skill-import/skills > imports only the instruction when attachment upload fails at part"
- Mode: run
- Given: A signed-in workspace member opened an import session, and object storage fails a multipart attachment part upload (row `part`).
- When: The token uploads a skill with `references/tone.md` via `POST /api/skill-import/skills`, then the member reads the workflow and `GET /api/skill-import/sessions/:sessionId/skills`.
- Then: The upload returns HTTP 201 with `references/tone.md` skipped as `upload_failed`. The workflow has the instruction and no files, and the session lists exactly that workflow.

## skill-import.bdd-022

- Vitest: "POST /api/skill-import/skills > imports only the instruction when attachment upload fails at completion"
- Mode: run
- Given: A signed-in workspace member opened an import session, and object storage fails to complete the multipart attachment upload (row `completion`).
- When: The token uploads a skill with `references/tone.md` via `POST /api/skill-import/skills`, then the member reads the workflow and `GET /api/skill-import/sessions/:sessionId/skills`.
- Then: The upload returns HTTP 201 with `references/tone.md` skipped as `upload_failed`. The workflow has the instruction and no files, and the session lists exactly that workflow.

## skill-import.bdd-023

- Vitest: "POST /api/skill-import/skills > imports only the instruction when the content bundle with attachments cannot be uploaded"
- Mode: run
- Given: A signed-in workspace member opened an import session, and object storage rejects the first object write (the content bundle with attachments).
- When: The token uploads a skill with `references/tone.md` via `POST /api/skill-import/skills`, then the member reads `GET /api/workflows/:workflowId`.
- Then: The upload returns HTTP 201 with `references/tone.md` skipped as `upload_failed`, and the workflow has the instruction and no files.

## skill-import.bdd-024

- Vitest: "POST /api/skill-import/skills > does not report success after instruction upload failure"
- Mode: run
- Given: A signed-in workspace member opened an import session, and every object write fails with a storage error (row `instruction upload failure`).
- When: The token uploads a skill with one attachment via `POST /api/skill-import/skills`, then the member lists `GET /api/skill-import/sessions/:sessionId/skills`.
- Then: The upload returns HTTP 500 and the session lists no imported skills.

## skill-import.bdd-025

- Vitest: "POST /api/skill-import/skills > does not report success after cancellation"
- Mode: run
- Given: A signed-in workspace member opened an import session, and every object write is aborted (row `cancellation`).
- When: The token uploads a skill with one attachment via `POST /api/skill-import/skills`, then the member lists `GET /api/skill-import/sessions/:sessionId/skills`.
- Then: The upload returns HTTP 500 and the session lists no imported skills.

## skill-import.bdd-026

- Vitest: "POST /api/skill-import/skills > rejects an expired session token"
- Mode: run
- Given: A signed-in workspace member has a validly signed skill-import token that was issued two hours ago and expired after one hour.
- When: The expired token uploads a skill with `POST /api/skill-import/skills`.
- Then: The response is HTTP 401 with error code `SKILL_IMPORT_SESSION_INVALID`.

## skill-import.bdd-027

- Vitest: "POST /api/skill-import/skills > rejects a token that does not verify"
- Mode: run
- Given: A signed-in workspace member opened an import session and the token is altered by appending text.
- When: The tampered token uploads a skill with `POST /api/skill-import/skills`.
- Then: The response is HTTP 401 with error code `SKILL_IMPORT_SESSION_INVALID`.

## skill-import.bdd-028

- Vitest: "POST /api/skill-import/skills > does not authenticate any other route"
- Mode: run
- Given: A signed-in workspace member opened an import session, and Clerk does not authenticate the import token.
- When: The import token is used as the bearer for `GET /api/workflows`.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## skill-import.bdd-029

- Vitest: "POST /api/skill-import/skills > stops importing once the session cap is reached"
- Mode: run
- Given: A signed-in workspace member opened an import session and also created an unrelated private workflow through `POST /api/workflows`.
- When: The token uploads 50 distinct skills, then a 51st, via `POST /api/skill-import/skills`; the member then opens a new session and uploads with its token.
- Then: The unrelated workflow returns HTTP 201 and all 50 uploads return HTTP 201. The 51st returns HTTP 429 with `SKILL_IMPORT_LIMIT_REACHED`. The new session opens with HTTP 200 and its upload returns HTTP 201.
