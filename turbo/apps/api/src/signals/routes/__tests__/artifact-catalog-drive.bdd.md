# artifact-catalog-drive

## artifact-catalog-drive-001

- Vitest: "artifact catalog lazy Drive detail metadata > keeps list and context-free detail provider-free and respects Chat access"
- Mode: run
- Given: A signed-in member has a Chat run that uploaded "report.csv" as an artifact and has connected a default Google Drive account; the Drive file search returns no files.
- When: The member lists `GET /api/artifacts/catalog?chatThreadId=<thread>` and reads `GET /api/artifacts/catalog/:artifactId` without context; then, with the Drive connection turned off for that Chat, reads the detail with `chatThreadId`; then reads it again with the connection allowed.
- Then: The list contains the artifact without `googleDriveSync`, and the context-free detail has neither `googleDriveSync` nor `googleDriveConnectionId`; Drive is not queried. With access denied the detail returns `{ status: "disconnected", recovery: { action: "unavailable" } }` without querying Drive. With access allowed it returns the connection ID and `{ status: "not_synced" }` after exactly one Drive query.

## artifact-catalog-drive-002

- Vitest: "artifact catalog lazy Drive detail metadata > uses exact upload identity across owned view threads and retains original plus conversion state"
- Mode: run
- Given: A member's Chat run uploaded "report.csv"; the member has a default Drive account and a second "Detail selected Drive" account selected on a separate view thread through `PUT /api/chat-threads/:id/connector-selections`. Drive lists an original copy and a converted spreadsheet tagged with the run and file IDs, plus an unrelated file tagged with the catalog ID.
- When: The member reads the artifact detail with the view thread, uploads it through `POST /api/artifacts/:artifactId/google-drive/chat-uploads` (with the old run token, with the default account, with the member session, and with a current run token of the view thread), then disables every Drive account for the view thread and reads and uploads again.
- Then: The detail returns the selected connection ID and `synced` with `originalUploaded: true` and the converted spreadsheet's ID, name, MIME type and link; the single Drive query uses the upload's file ID and run ID (not the view or catalog IDs) with the selected account's token. The old run token and the default account both return HTTP 400 (the latter "Google Drive account is unavailable in this Chat") without Drive calls; the member and current-run uploads return HTTP 200 (`selected-upload`) using the selected account. Once disabled, the detail is `disconnected`/`unavailable`, the upload returns HTTP 400, and only two uploads reached Drive.

## artifact-catalog-drive-003

- Vitest: "artifact catalog lazy Drive detail metadata > persists OAuth refresh and terminal reconnect through detail polling"
- Mode: run
- Given: A member's Chat run uploaded an artifact and the member connected Google Drive; Drive rejects the original access token with 401 and accepts a refreshed token.
- When: The member polls `GET /api/artifacts/catalog/:artifactId?chatThreadId=<thread>` twice; then, with token refresh failing terminally and Drive returning 401, polls twice more.
- Then: The first two polls return `not_synced` after a single token refresh, with Drive called with the original then refreshed token twice. The next two polls return the connection ID and `{ status: "disconnected", recovery: { action: "reconnect", connectionId } }` after a single refresh attempt and one Drive query, and the Drive account reads back as `reconnect-required`.

## artifact-catalog-drive-004

- Vitest: "artifact catalog lazy Drive detail metadata > rejects non-owned or missing context and independently rejects non-owned resources before provider access"
- Mode: run
- Given: A member's Chat run uploaded an artifact and the member connected Google Drive; a peer in the same organization owns another thread.
- When: The member reads `GET /api/artifacts/catalog/:artifactId` with `chatThreadId` set to the peer's thread and to a random ID; the peer reads the artifact with their own thread; another user reads it with the member's thread.
- Then: All four requests return HTTP 404 (the member's two with error code `NOT_FOUND`), and Drive is never queried.
