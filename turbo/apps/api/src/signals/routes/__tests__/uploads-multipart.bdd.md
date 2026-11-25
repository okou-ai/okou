# uploads-multipart

## uploads-multipart-001

- Vitest: "multipart user artifact uploads > preserves the public complete error when storage cannot find the multipart upload"
- Mode: run
- Given: Row `complete`. A signed-in workspace member; storage reports that the multipart upload does not exist (`NoSuchUpload`) when its parts are listed.
- When: The member calls `POST /api/uploads/multipart/complete` for `recording.mp4` with an upload ID and `partCount: 1`.
- Then: The API responds with HTTP 500 and the body `{ "error": "Internal server error" }`.

## uploads-multipart-002

- Vitest: "multipart user artifact uploads > preserves the public abort error when storage cannot find the multipart upload"
- Mode: run
- Given: Row `abort`. A signed-in workspace member; storage reports that the multipart upload does not exist (`NoSuchUpload`) when its parts are listed.
- When: The member calls `POST /api/uploads/multipart/abort` for `recording.mp4` with an upload ID.
- Then: The API responds with HTTP 500 and the body `{ "error": "Internal server error" }`.

## uploads-multipart-003

- Vitest: "multipart user artifact uploads > prepares 5 MiB parts for a large upload"
- Mode: run
- Given: A signed-in user without an organization; storage creates multipart upload `multipart-upload-1` and signs per-part URLs.
- When: The user calls `POST /api/uploads/prepare` for `recording.mp4` (`video/mp4`, 20 MiB) with `multipart: true`.
- Then: The API responds with HTTP 200 with the filename, content type, size, a short `https://a.okou.io/<10 chars>.mp4` URL, and multipart details: upload ID `multipart-upload-1`, 5 MiB part size and four signed part URLs, each signed for 172800 seconds. A public `legacy-file` registration is written before the multipart upload is created in the user-artifacts bucket under `artifacts/<10 chars>.mp4` with artifact ID, filename, `okou` brand and user ID metadata.

## uploads-multipart-004

- Vitest: "multipart user artifact uploads > prepares and completes a 5 GiB attachment within the 1000-part contract"
- Mode: run
- Given: A signed-in workspace member; storage creates multipart upload `five-gib-upload`, reports 512 uploaded parts, and a 5 GiB object.
- When: The member calls `POST /api/uploads/prepare` for a 5 GiB `long-recording.mp4` with `multipart: true`, then `POST /api/uploads/multipart/complete` with the returned upload ID and part count.
- Then: Preparation returns HTTP 200 with a 10 MiB part size and 512 parts. Completion returns HTTP 200 with exactly the prepared ID and URL.

## uploads-multipart-005

- Vitest: "multipart user artifact uploads > stores the declared text charset when preparing a multipart artifact"
- Mode: run
- Given: A signed-in user without an organization; storage accepts the registration and creates multipart upload `text-multipart-upload`.
- When: The user calls `POST /api/uploads/prepare` for `report.csv` (6 MiB, `Text/CSV; Charset="UTF-8"`, purpose `artifact`) with `multipart: true`.
- Then: The API responds with HTTP 200 with content type `text/csv; charset=utf-8` and the multipart upload ID. Both the `legacy-file` registration and the multipart upload are stored with `text/csv; charset=utf-8`.

## uploads-multipart-006

- Vitest: "multipart user artifact uploads > keeps the legacy single PUT response for small multipart requests"
- Mode: run
- Given: A signed-in user without an organization.
- When: The user calls `POST /api/uploads/prepare` for `small.mp4` of 5 MiB minus 1 byte with `multipart: true`.
- Then: The API responds with HTTP 200 with a single `uploadUrl`, a short `https://a.okou.io/<10 chars>.mp4` URL and upload headers carrying artifact ID, filename `small.mp4`, `okou` brand and user ID metadata, and no `multipart` property.

## uploads-multipart-007

- Vitest: "multipart user artifact uploads > aborts the default-private multipart session when the API owner is cancelled after creation"
- Mode: run
- Given: A signed-in workspace member; the API request is cancelled immediately after storage creates the multipart upload `multipart-upload-cancelled`.
- When: The member calls `POST /api/uploads/prepare` for `cancelled.mp4` (5 MiB) with `multipart: true`.
- Then: The API responds with HTTP 500, no part URLs are signed, and the multipart upload is aborted in the private-artifacts bucket under `private-artifacts/<uuid>/cancelled.mp4`.

## uploads-multipart-008

- Vitest: "multipart user artifact uploads > lists uploaded parts and completes the multipart upload"
- Mode: run
- Given: A signed-in workspace member; storage lists two uploaded parts with ETags for the upload and reports a 20 MiB `video/mp4` object with Okou brand metadata for artifact `my recording.mp4`.
- When: The member calls `POST /api/uploads/multipart/complete` with the artifact ID, filename, upload ID `multipart-upload-1` and `partCount: 2`.
- Then: The API responds with HTTP 200 with exactly the artifact ID and a short `https://a.okou.io/<10 chars>.mp4` URL. The multipart upload is completed in the user-artifacts bucket under `artifacts/<10 chars>.mp4` with both parts and ETags.

## uploads-multipart-009

- Vitest: "multipart user artifact uploads > rejects completion when an uploaded part is missing"
- Mode: run
- Given: A signed-in workspace member; storage lists only part 1 for the upload.
- When: The member calls `POST /api/uploads/multipart/complete` for `recording.mp4` with `partCount: 2`.
- Then: The API responds with HTTP 400 "Multipart upload is incomplete", and storage receives only the single parts listing.

## uploads-multipart-010

- Vitest: "multipart user artifact uploads > aborts an unfinished multipart upload"
- Mode: run
- Given: A signed-in workspace member with an unfinished multipart upload `multipart-upload-3` for `my recording.mp4`.
- When: The member calls `POST /api/uploads/multipart/abort` with the artifact ID, filename and upload ID.
- Then: The API responds with HTTP 200 with exactly the artifact ID, and the multipart upload is aborted in the user-artifacts bucket under `artifacts/<10 chars>.mp4`.
