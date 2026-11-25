# run-uploaded-files-publication

## run-uploaded-files-publication-001

- Vitest: "keeps one file identity and captured owner across concurrent replay and metadata updates"
- Mode: run
- Given: A signed-in member with an entitled native chat model has a dispatched chat run whose platform environment issues an `OKOU_TOKEN`. The member prepared a 7-byte `report.txt` (`text/plain`, purpose `artifact`) through `POST /api/uploads/prepare` without an organization, and the object is stored with matching metadata.
- When: The run token completes the upload twice concurrently via `POST /api/uploads/complete`; the object grows to 19 bytes; the token completes with `contentType: "text/markdown"` and then again with `text/plain`. The member and two outsiders (another organization, and another user in the same organization) read `GET /api/chat-threads/:threadId/artifacts` and `GET /api/artifacts/catalog` and `GET /api/artifacts/catalog/:artifactId`.
- Then: Both concurrent completions return HTTP 200 with identical bodies and the thread lists exactly one `report.txt` file of size 7. The `text/markdown` completion returns HTTP 500 and the thread still shows size 7 `text/plain`. The final completion returns size 19 `text/plain`, and the thread file keeps its original ID with size 19. The catalog has exactly one file artifact titled `report.txt` with the same ID, and its detail keeps the original file ID with size 19, the prepared URL and no preview image. Both outsiders get HTTP 404 for the thread artifacts and catalog entry and an empty catalog list.

## run-uploaded-files-publication-002

- Vitest: "records late completion through the issued token"
- Mode: run
- Given: A signed-in member with an entitled native chat model has a chat run that issued an `OKOU_TOKEN`, and a prepared, stored 7-byte `report.txt` upload; the run has already completed successfully.
- When: The run token completes the upload via `POST /api/uploads/complete` after the run finished.
- Then: The completion returns HTTP 200, and the member's `GET /api/artifacts/catalog` contains exactly one artifact titled `report.txt`.

## run-uploaded-files-publication-003

- Vitest: "leaves an unavailable upload absent and permits completion after the object arrives"
- Mode: run
- Given: A signed-in member with an entitled native chat model has a chat run that issued an `OKOU_TOKEN`, and a prepared `report.txt` upload whose object has not yet been stored.
- When: The run token completes the upload via `POST /api/uploads/complete`, the object is then stored, and the token completes again.
- Then: The first completion returns HTTP 404 and the thread's `GET /api/chat-threads/:threadId/artifacts` has no runs. The second completion returns HTTP 200 and the thread lists a run with the `report.txt` file.
