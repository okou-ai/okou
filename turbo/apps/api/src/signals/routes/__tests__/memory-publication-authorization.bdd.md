# memory-publication-authorization

## memory-publication-authorization-001

- Vitest: "Memory publication authorization > offers the committed archive only to the host of the completed publishing Run while its version is current"
- Mode: run
- Given: A funded member with native Memory and a connected personal subscription starts a thread Run whose Runner execution mounts one Memory storage, and the Run prepares and commits a new Memory version.
- When: The Run's host reads `GET /api/webhooks/run/storages/memory-archive` with the execution's firewall token before and after the Run completes with that version as its Memory output, the sandbox token tries the same read, and a later Run publishes a newer version.
- Then: Before completion the host read returns HTTP 200 with an empty body. After completion the sandbox token gets HTTP 401, while the host gets HTTP 200 with `cache-control: private, no-store` and an archive with the committed version ID and size whose URL downloads exactly the committed file archive. Once a newer version is published the host read returns HTTP 200 with an empty body again.

## memory-publication-authorization-002

- Vitest: "Memory publication authorization > offers the captured base and fresh HEAD only to the active Memory owner"
- Mode: run
- Given: A member's Memory has a published base version; two more Runs start on that base, and one of them publishes a newer HEAD before the other (stale) Run merges.
- When: The stale Run calls `POST /api/webhooks/run/storages/prepare` with `includeMemoryMerge: true` while claiming HEAD as its parent, then prepares and commits a merged candidate on HEAD and completes; afterwards it requests merge inputs again.
- Then: The prepare returns HTTP 200 with `memoryMerge` whose base is the originally captured version and whose head is the newest HEAD, both non-empty with manifest and archive URLs; the manifests list `base.md` and `head.md` respectively. The merged commit and completion succeed, the next Run mounts the merged version, both Runs read as `completed`, and the final merge-input request after completion returns HTTP 404.

## memory-publication-authorization-003

- Vitest: "Memory publication authorization > describes initialized empty Memory without requiring object downloads"
- Mode: run
- Given: A member's native Memory is initialized but empty, and a Run has started with that Memory mounted.
- When: The Run calls `POST /api/webhooks/run/storages/prepare` with no files and `includeMemoryMerge: true`.
- Then: The response is HTTP 200 with `memoryMerge` base and head both set to the mounted version ID and marked `empty: true`.

## memory-publication-authorization-004

- Vitest: "Memory publication authorization > keeps another member's Memory merge inputs private"
- Mode: run
- Given: Two different members each have native Memory and a running Run.
- When: The first member's Run calls `POST /api/webhooks/run/storages/prepare` with `includeMemoryMerge: true` for the other member's Memory storage ID.
- Then: The request returns HTTP 404.

## memory-publication-authorization-005

- Vitest: "Memory publication authorization > commits native memory and preserves its version on the next Runner execution"
- Mode: run
- Given: A member's native Memory is initialized and a Run has started with the pinned Memory version mounted.
- When: The Run calls `POST /api/webhooks/run/storages/commit` with the already-mounted version ID and no files, then a new Run starts.
- Then: The commit returns HTTP 200 with `success: true`, the same version ID, and `deduplicated: true`. The next Runner execution mounts the same Memory version.

## memory-publication-authorization-006

- Vitest: "Memory publication authorization > publishes memory content and returns its version in the next Runner execution"
- Mode: run
- Given: A member's native Memory is initialized and a Run has started with Memory mounted.
- When: The Run prepares and commits a `notes.md` file to its Memory storage through the storage webhooks, then a new Run starts.
- Then: The committed version differs from the originally mounted version, and the next Runner execution mounts the same Memory storage at the newly committed version.

## memory-publication-authorization-007

- Vitest: "Memory publication authorization > preserves the winning Memory when another dispatched Run publishes a stale candidate or no-op"
- Mode: run
- Given: Two Runs of the same member start from the same Memory version; the first publishes a new `notes.md` version.
- When: The second (stale) Run commits a competing candidate, then commits its unchanged base version as a no-op; the first Run completes successfully and the stale Run completes with exit code 1; a third Run starts and publishes a freshly reviewed consolidation, then a fourth Run starts.
- Then: The stale candidate commit returns HTTP 409 with a different version than the winner, and the no-op commit returns HTTP 200. The third Run mounts the first Run's winning version, and the fourth Run mounts the third Run's reviewed version.

## memory-publication-authorization-008

- Vitest: "Memory publication authorization > publishes exactly one winner when two Runs concurrently finalize different Memory candidates"
- Mode: run
- Given: Two Runs of the same member start from the same Memory version.
- When: Both Runs concurrently commit different `notes.md` candidates through the storage commit webhook, then a new Run starts.
- Then: Exactly one commit returns HTTP 200 and the other returns HTTP 409. The next Run mounts the version from the successful commit.

## memory-publication-authorization-009

- Vitest: "Memory publication authorization > deduplicates concurrent identical Memory publications and keeps their shared version readable"
- Mode: run
- Given: Two Runs of the same member start concurrently from the same Memory version.
- When: Both Runs prepare the identical `notes.md` content and concurrently call `POST /api/webhooks/run/storages/commit` with their candidate, then a new Run starts.
- Then: Both commits return HTTP 200; exactly one reports `deduplicated: true` and the other does not. Both prepared candidates have the same version ID, and the next Run mounts that shared version.

## memory-publication-authorization-010

- Vitest: "Memory publication authorization > rejects a prepared Memory publication after its Run is cancelled"
- Mode: run
- Given: A member's Memory has an accepted published version, and a second Run has prepared a new candidate.
- When: The second Run is cancelled by the member and completes with an error, then it calls `POST /api/webhooks/run/storages/commit` with the prepared candidate; a new Run then starts.
- Then: The commit returns HTTP 404, and the next Run mounts the previously accepted version.

## memory-publication-authorization-011

- Vitest: "Memory publication authorization > acknowledges an exact completed Run retry without rewinding newer Memory"
- Mode: run
- Given: A member's first Run published a Memory version and completed, and a later Run published a newer version.
- When: The first Run retries `POST /api/webhooks/run/storages/commit` with exactly the same parent, version and files, then a new Run starts.
- Then: The retry returns HTTP 200 with `success: true`, the first version ID, and `deduplicated: true`. The next Run still mounts the newest version.
