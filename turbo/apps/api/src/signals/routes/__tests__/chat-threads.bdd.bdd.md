# chat-threads.bdd

## chat-threads.bdd-001

- Vitest: "CHAT-01 thread detail, create, and delete cascades > rejects unauthenticated Clerk bearers"
- Mode: run
- Given: A caller presents a Clerk bearer token that Clerk reports as unauthenticated.
- When: The caller requests `GET /api/chat-threads/snapshot`.
- Then: The API responds with HTTP 401 and error code `UNAUTHORIZED`.

## chat-threads.bdd-002

- Vitest: "CHAT-01 thread detail, create, and delete cascades > allows execution agent tokens to sync their owner's snapshots and events"
- Mode: run
- Given: A signed-in member has sent a chat message that launched a Run, and the Runner execution environment exposes the Run's sandbox-scoped `OKOU_TOKEN`.
- When: The execution token calls `GET /api/chat-threads/snapshot` and `GET /api/chat-threads/events`, and the owner then calls the same routes with a Clerk session.
- Then: Both token reads return HTTP 200; the snapshot is empty (`chatThreads: []`, null latest event and seq IDs) and the events include a `created` event for the Run's thread. The token responses are identical to the owner's session responses.

## chat-threads.bdd-003

- Vitest: "CHAT-01 thread detail, create, and delete cascades > requires a signed-in organization member to create a thread"
- Mode: run
- Given: An unauthenticated caller, a signed-in organization member, a signed-in user without an organization, and an unrelated outsider exist.
- When: Each calls `POST /api/chat-threads` with a title, and the outsider reads `GET /api/chat-threads/events`.
- Then: The unauthenticated and organization-less requests return HTTP 401 `UNAUTHORIZED`; the member's request returns HTTP 201. The outsider sees no thread events.

## chat-threads.bdd-004

- Vitest: "CHAT-01 thread detail, create, and delete cascades > returns chat thread snapshot and lifecycle events with cursor expiry"
- Mode: run
- Given: A signed-in member with a personal subscription model has no threads.
- When: The member reads `GET /api/chat-threads/snapshot`, creates a thread with a client event ID, renames it, updates its model selection to `claude-sonnet-5-5`, then reads `GET /api/chat-threads/events` with no cursor, with `sinceSeqId` at the model-selection event, at the created event, and at `999999`.
- Then: The empty snapshot has no threads and null latest IDs. The full page has `hasMore` false and four events with seq IDs 1–4: `created`, `renamed`, `model_selection_updated` (`selectedModel` `claude-sonnet-5-5`) and `service_tier_updated` (null tier) sharing the model-selection timestamp at the next seq ID. The cursor after model selection returns only the service-tier event, the cursor after creation returns the other three events, and the unknown cursor returns HTTP 410 `CHAT_THREAD_EVENTS_EXPIRED` ("Chat thread events cursor has expired").

## chat-threads.bdd-005

- Vitest: "CHAT-01 thread detail, create, and delete cascades > keeps no-snapshot cursors anchored to real scoped rows"
- Mode: run
- Given: A signed-in member has created one thread with a known event ID.
- When: The member reads `GET /api/chat-threads/events?sinceSeqId=<created seq>`, renames the thread reusing the same event ID (reserving a sequence gap without a new event), and reads the events after `<created seq + 1>`.
- Then: The first cursor read returns an empty page with `hasMore` false. The cursor pointing at the gap returns HTTP 410 `CHAT_THREAD_EVENTS_EXPIRED`.

## chat-threads.bdd-006

- Vitest: "CHAT-01 thread detail, create, and delete cascades > preserves member threads across sidebar event replay"
- Mode: run
- Given: A signed-in member has created three threads and replayed the lifecycle events into a sidebar list of three threads; stored chat objects exist.
- When: The member reads `GET /api/chat-threads/events` after the latest seq ID and reads `GET /api/chat-threads/:id` for two of the threads.
- Then: The tail page is empty with `hasMore` false, the replayed list contains exactly the three created thread IDs, and each thread read returns HTTP 200.

## chat-threads.bdd-007

- Vitest: "CHAT-01 thread detail, create, and delete cascades > touches thread sort from existing direct user sends and run-finished markers"
- Mode: run
- Given: An entitled member with a configured Runner group has an existing thread.
- When: The member sends a prompt to that thread via `POST /api/chat/events` with a `chatThreadSortEventId`, then the Runner executes and the sandbox completes the Run successfully.
- Then: After the send, the thread events contain exactly one `sort_touched` event whose ID is the supplied sort event ID. After the Run completes, there are two `sort_touched` events for the thread.

## chat-threads.bdd-008

- Vitest: "CHAT-01 thread detail, create, and delete cascades > rejects explicit thread models without the member's subscription"
- Mode: run
- Given: An entitled member's personal subscription supports `claude-opus-5-5` but not `gpt-6-astra`.
- When: The member calls `POST /api/chat-threads` with a client thread ID and model `gpt-6-astra`, then creates a thread with `claude-opus-5-5` and calls `POST /api/chat-threads/:id/model-selection` with `gpt-6-astra`.
- Then: The create and the update both return HTTP 400 with "Select Auto or a model from your connected personal subscription", and the rejected client thread ID reads back as HTTP 404.

## chat-threads.bdd-009

- Vitest: "CHAT-01 thread detail, create, and delete cascades > rejects the internal Auto run model as a thread selection"
- Mode: run
- Given: An entitled member has a personal subscription model selected.
- When: The member calls `POST /api/chat-threads` with model `okou-1.0`, then creates a thread with `claude-fable-5-1` and calls `POST /api/chat-threads/:id/model-selection` with `okou-1.0`.
- Then: Both requests return HTTP 400, the rejected client thread ID reads as HTTP 404, and the thread metadata still shows `selectedModel` `claude-fable-5-1`.

## chat-threads.bdd-010

- Vitest: "CHAT-01 thread detail, create, and delete cascades > creates a thread without a model as Auto when the member has no preference"
- Mode: run
- Given: A signed-in member has no model preference.
- When: The member calls `POST /api/chat-threads` with only an event ID.
- Then: The response is HTTP 201 with `selectedModel` `auto`, the thread metadata shows `auto`, and the thread events include a `created` event with that ID and `selectedModel` `auto`.

## chat-threads.bdd-011

- Vitest: "CHAT-01 thread detail, create, and delete cascades > stores canonical Auto intent null for limited-free-1 workspaces"
- Mode: run
- Given: A funded member whose Pro subscription is deleted through a Stripe `customer.subscription.deleted` webhook, leaving the workspace on the active `limited-free-1` tier with credits unchanged. This row uses model `null`.
- When: The member creates a titled thread via `POST /api/chat-threads` with model `null` and updates its model selection to `null`.
- Then: The billing status reads `limited-free-1`, `active` with the same credits; the thread keeps its title and its metadata shows `selectedModel` `auto`.

## chat-threads.bdd-012

- Vitest: "CHAT-01 thread detail, create, and delete cascades > stores canonical Auto intent auto for limited-free-1 workspaces"
- Mode: run
- Given: A funded member whose Pro subscription is deleted through a Stripe `customer.subscription.deleted` webhook, leaving the workspace on the active `limited-free-1` tier with credits unchanged. This row uses model `"auto"`.
- When: The member creates a titled thread via `POST /api/chat-threads` with model `auto` and updates its model selection to `auto`.
- Then: The billing status reads `limited-free-1`, `active` with the same credits; the thread keeps its title and its metadata shows `selectedModel` `auto`.

## chat-threads.bdd-013

- Vitest: "CHAT-01 thread detail, create, and delete cascades > updates the Computer Use host binding on a chat thread"
- Mode: run
- Given: An onboarded member has a thread and a running Computer Use host; a peer in the same organization exists.
- When: The member calls `POST /api/chat-threads/:id/computer-use-host` with the host ID, with an unknown host ID, the peer calls it with the host ID, the member clears it with `null`, and the member calls it on an unknown thread.
- Then: The unknown host returns HTTP 404 "Computer-use host not found"; the peer and the unknown thread return HTTP 404 "Chat thread not found". The thread events contain exactly two `computer_use_host_updated` events with host IDs `[hostId, null]`.

## chat-threads.bdd-014

- Vitest: "CHAT-01 thread detail, create, and delete cascades > cancels in-flight runs and cascades schedules when a thread is deleted"
- Mode: run
- Given: An entitled member has a thread with a running Run, a sibling thread whose Run completed, and a third thread with its own pending Run; a peer in the same organization exists.
- When: An unauthenticated caller, the member (unknown ID), the peer, and finally the member call `DELETE /api/chat-threads/:id` for the running thread.
- Then: Unauthenticated returns HTTP 401 `UNAUTHORIZED`; unknown and peer return HTTP 404 `NOT_FOUND` ("Chat thread not found") and the thread stays readable. The owner's delete returns HTTP 204 with no body, publishes a hard `cancel` for the running Run, and the Run becomes `cancelled` while the sibling stays `completed` and the other Run stays `running`. The deleted thread reads as HTTP 404 and the events include a `deleted` event for it. The active-thread list contained the running thread and not the completed sibling.

## chat-threads.bdd-015

- Vitest: "CHAT-01 chat thread read state > lists unread agent and thread indicators"
- Mode: run
- Given: An entitled owner, an onboarded peer in the same organization with a completed Run thread, and the same user in another organization with a completed Run thread.
- When: Callers read `GET /api/indicators` (unauthenticated, organization-less, and each member), the owner runs a Run to completion, marks the thread read twice via `POST /api/chat-threads/:id/mark-read`, then completes two more threads and marks them read one at a time.
- Then: Unauthenticated and organization-less reads return HTTP 401 `UNAUTHORIZED`. Each member sees only its own unread threads. An active Run's thread is not unread until it completes. The first mark-read publishes `chatThreadReadCursorUpdated` with the thread ID and `lastReadAt` on the `user-org:<userId>:<orgId>` channel; the repeated mark-read returns the same `lastReadAt` and publishes nothing. Unread sets shrink from both new threads to the remaining one to empty as each is read.

## chat-threads.bdd-016

- Vitest: "CHAT-01 chat thread read state > does not let a muted thread hide another unread thread under the same agent"
- Mode: run
- Given: An entitled member has two threads with completed Runs, both unread.
- When: The member mutes one thread via `POST /api/chat-threads/:id/mute`, reads indicators, marks the other thread read, unmutes the first via `POST /api/chat-threads/:id/unmute`, and reads indicators again.
- Then: Mute and unmute return HTTP 204. While muted only the other thread is unread; after reading it and unmuting, only the previously muted thread is unread.

## chat-threads.bdd-017

- Vitest: "CHAT-01 chat thread read state > lists active thread ids without hiding the agent's unread state"
- Mode: run
- Given: An entitled owner has a thread whose Run completed; an onboarded peer in the same organization and the same user in another organization each have an active Run.
- When: The owner starts one Run that the Runner executes and a second send that is admitted as a queued Run, reads `GET /api/indicators`, then the running Run completes and the owner reads indicators again.
- Then: Before completion the active IDs are exactly the running and queued threads, and indicators show the completed thread `unread`, the running and queued threads `active`, with `unreadAt` only for the completed thread. After completion the active IDs are only the queued thread, and the formerly running thread is `unread` with its own `unreadAt`; peer and other-organization threads never appear.

## chat-threads.bdd-018

- Vitest: "CHAT-01 chat thread read state > limits unified unread indicators to seven days without limiting active threads"
- Mode: run
- Given: An entitled member has a thread whose Run completed just over seven days ago, a thread whose Run completed now, and a thread whose Run was started just over seven days ago and is still active.
- When: The member reads `GET /api/indicators` at the current time.
- Then: The indicators contain only the recent thread as `unread` (with an `unreadAt` timestamp) and the old active thread as `active`; the expired unread thread is absent.

## chat-threads.bdd-019

- Vitest: "CHAT-01 chat thread read state > returns the 50 newest unread indicators across the organization"
- Mode: run
- Given: An entitled member has 51 threads whose Runs completed one second apart.
- When: The member reads `GET /api/indicators` one minute after the first completion.
- Then: Exactly 50 threads and 50 `unreadAt` entries are returned, covering the 50 newest threads, each marked `unread` with a timestamp.

## chat-threads.bdd-020

- Vitest: "CHAT-01 chat thread read state > marks all unread chat threads for the current member"
- Mode: run
- Given: An entitled member has three threads with completed Runs, all unread.
- When: The member calls `POST /api/chat-thread-unreads/mark-read` twice.
- Then: Each call returns HTTP 204. The first call publishes `chatIndicatorsChanged` (null payload) on the `user-org:<userId>:<orgId>` channel; the second call publishes nothing. Afterwards no threads are unread.

## chat-threads.bdd-021

- Vitest: "CHAT-01 chat thread read state > tails thread event rows after a sequence cursor"
- Mode: run
- Given: A signed-in member in an Auto workspace with no credits and accepted storage writes.
- When: The member sends two prompts to the same thread via `POST /api/chat/events`, then reads `GET /api/chat-threads/:threadId/event-rows` in full and after the first `output.error` cursor (its event ID and seq ID).
- Then: The full list is `input.prompt`, `input.rejected` (error `insufficient_credits`, revoking the prompt), `output.error` containing "Insufficient credits", repeated for the second prompt, with display texts matching each prompt; seq IDs are strictly increasing and unique. The cursor read returns exactly the second prompt, its rejection and its error.

## chat-threads.bdd-022

- Vitest: "CHAT-03 run usage events > reads zero-credit usage and omits runs without settled usage"
- Mode: run
- Given: An entitled member's Run reports a connector usage event for an unknown provider, and a second Run completes without reporting usage.
- When: The sandbox posts `POST /api/webhooks/run/usage-event` for the first Run, both Runs complete, and the member reads `POST /api/chat-threads/:id/usage` for each Run.
- Then: The first Run's usage is version 1 with `totalCredits` 0 and a single `connector` breakdown with 0 credits. The quiet Run has no usage, including when requested through the quiet thread with the first Run's ID.

## chat-threads.bdd-023

- Vitest: "CHAT-01 chat search > rejects search without an org session or the chat-event:read capability"
- Mode: run
- Given: An unauthenticated caller, a user without an organization, and a Run's sandbox token (which lacks the `chat-event:read` capability).
- When: Each calls `GET /api/chat/search` for "hello".
- Then: The unauthenticated and organization-less requests return HTTP 401 `UNAUTHORIZED`; the sandbox token returns HTTP 403 `FORBIDDEN` with a message mentioning `chat-event:read`.

## chat-threads.bdd-024

- Vitest: "CHAT-03 thread artifacts and google drive status > exports a hosted hosted-site as an owned bundle to Google Drive"
- Mode: run
- Given: A member's Run publishes a `hosted-site` artifact with `index.html` and a stylesheet through `POST /api/host/deployments/prepare` and `.../complete` using its `OKOU_TOKEN`, and the member connects Google Drive via OAuth.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with the thread ID and mode `original`.
- Then: The response is HTTP 200 with the Drive file ID, `artifact:changed` is published for the artifact, and Drive receives one `application/zip` resumable upload containing exactly `index.html` and `assets/style-5e0c7a94.css` with the original contents. No copies are written under `artifacts/` in object storage.

## chat-threads.bdd-025

- Vitest: "CHAT-03 thread artifacts and google drive status > exports a hosted presentation-html as an owned bundle to Google Drive"
- Mode: run
- Given: A member's Run publishes a `presentation-html` artifact with `index.html` and a stylesheet through the host deployment routes using its `OKOU_TOKEN`, and the member connects Google Drive via OAuth.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with the thread ID and mode `original`.
- Then: The response is HTTP 200 with the Drive file ID, `artifact:changed` is published for the artifact, and Drive receives one `application/zip` resumable upload containing exactly `index.html` and `assets/style-5e0c7a94.css` with the original contents. No copies are written under `artifacts/` in object storage.

## chat-threads.bdd-026

- Vitest: "CHAT-03 thread artifacts and google drive status > exports a public presentation deck to Google Drive as an owned bundle"
- Mode: run
- Given: A member's Run publishes a public `presentation-html` deck with `index.html` and a stylesheet through the host deployment routes, the thread artifacts list it under its canonical artifact URL, and the member connects Google Drive via OAuth.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The request returns HTTP 200 and Drive receives an `application/zip` upload containing exactly `index.html` and `assets/deck-8c4a2f60.css` with their original contents.

## chat-threads.bdd-027

- Vitest: "CHAT-03 thread artifacts and google drive status > exports a self-contained hosted page to Google Drive as that page"
- Mode: run
- Given: A member's Run publishes a single self-contained `index.html` presentation through the host deployment routes, and the member connects Google Drive via OAuth.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The request returns HTTP 200 and Drive receives the page itself with a `text/html` content type and the exact HTML body.

## chat-threads.bdd-028

- Vitest: "CHAT-03 thread artifacts and google drive status > groups run uploads and reports google drive sync status"
- Mode: run
- Given: An entitled member has a running Run that records `data.csv` (2048 bytes) and `report.pdf` uploads through its `OKOU_TOKEN`; a peer in the same organization exists; Google Drive is initially not connected.
- When: The member lists `GET /api/chat-threads/:threadId/artifacts` and uploads via `POST /api/artifacts/:artifactId/google-drive/chat-uploads` through a sequence of Drive states: not connected, connected via OAuth but disabled in the Chat, enabled, iOS client listing, token refresh success, upload refresh, transient refresh failures, terminal refresh failure, reconnect, `invalid_rapt` session expiry, and an unknown `invalid_grant` subtype.
- Then: Unauthenticated listing returns HTTP 401 and the peer gets HTTP 404 `NOT_FOUND`. One run group lists both files (`text/csv`, `application/pdf`) with status `disconnected` and recovery `connect`; uploading returns HTTP 400 "Google Drive account is unavailable in this Chat" both before connecting and while disabled in the Chat (recovery `unavailable`), and an unknown artifact returns HTTP 404 "Artifact file not found". Once enabled, the upload returns HTTP 200 with the Drive file ID, name and link, uses the Drive bearer, two folder queries, `text/csv` content and no explicit content length. iOS clients get files without Drive sync fields and no Drive query. Web listing reports the csv as `synced` with `originalUploaded` true and the pdf as `not_synced`. A refreshed token is persisted (one refresh, later polls reuse it), an upload refresh token is reused by later status reads, transient refresh failures report `unknown` while the account stays `connected`, a terminal failure reports `disconnected` with `reconnect` recovery and `reconnect-required` (`authorization_expired_or_revoked`) without further provider calls, reconnecting restores `synced`, `invalid_rapt` yields reason `provider_session_expired`, and an unknown subtype yields `reconnect-required` with a null reason.

## chat-threads.bdd-029

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion preserves the report.doc source and verifies the native result"
- Mode: run
- Given: An entitled member's Run uploads a legacy binary Word artifact `report.doc` and the member has connected Google Drive; Drive accepts the upload and returns a native Google Docs document that can be read back.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 with the native file. The upload metadata requests the Google Workspace document MIME type, the content is uploaded as `application/msword` with the original bytes unchanged, the native file is read back once, and nothing is trashed.

## chat-threads.bdd-030

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion preserves the table.xls source and verifies the native result"
- Mode: run
- Given: An entitled member's Run uploads a legacy binary Excel artifact `table.xls` and the member has connected Google Drive; Drive accepts the upload and returns a native Google Sheets spreadsheet that can be read back.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 with the native file. The upload metadata requests the Google Workspace spreadsheet MIME type, the content is uploaded as `application/vnd.ms-excel` with the original bytes unchanged, the native file is read back once, and nothing is trashed.

## chat-threads.bdd-031

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion preserves the report.odt source and verifies the native result"
- Mode: run
- Given: An entitled member's Run uploads a OpenDocument text artifact `report.odt` and the member has connected Google Drive; Drive accepts the upload and returns a native Google Docs document that can be read back.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 with the native file. The upload metadata requests the Google Workspace document MIME type, the content is uploaded as `application/vnd.oasis.opendocument.text` with the original bytes unchanged, the native file is read back once, and nothing is trashed.

## chat-threads.bdd-032

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion preserves the table.ods source and verifies the native result"
- Mode: run
- Given: An entitled member's Run uploads a OpenDocument spreadsheet artifact `table.ods` and the member has connected Google Drive; Drive accepts the upload and returns a native Google Sheets spreadsheet that can be read back.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 with the native file. The upload metadata requests the Google Workspace spreadsheet MIME type, the content is uploaded as `application/vnd.oasis.opendocument.spreadsheet` with the original bytes unchanged, the native file is read back once, and nothing is trashed.

## chat-threads.bdd-033

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion preserves the report.docx source and verifies the native result"
- Mode: run
- Given: An entitled member's Run uploads a Word OOXML artifact `report.docx` and the member has connected Google Drive; Drive accepts the upload and returns a native Google Docs document that can be read back.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 with the native file. The upload metadata requests the Google Workspace document MIME type, the content is uploaded as `application/vnd.openxmlformats-officedocument.wordprocessingml.document` with the original bytes unchanged, the native file is read back once, and nothing is trashed.

## chat-threads.bdd-034

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion preserves the report.md source and verifies the native result"
- Mode: run
- Given: An entitled member's Run uploads a Markdown artifact `report.md` and the member has connected Google Drive; Drive accepts the upload and returns a native Google Docs document that can be read back.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 with the native file. The upload metadata requests the Google Workspace document MIME type, the content is uploaded as `text/markdown` with the original bytes unchanged, the native file is read back once, and nothing is trashed.

## chat-threads.bdd-035

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion preserves the report.txt source and verifies the native result"
- Mode: run
- Given: An entitled member's Run uploads a plain-text artifact `report.txt` and the member has connected Google Drive; Drive accepts the upload and returns a native Google Docs document that can be read back.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 with the native file. The upload metadata requests the Google Workspace document MIME type, the content is uploaded as `text/plain` with the original bytes unchanged, the native file is read back once, and nothing is trashed.

## chat-threads.bdd-036

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion preserves the report.rtf source and verifies the native result"
- Mode: run
- Given: An entitled member's Run uploads a RTF artifact `report.rtf` and the member has connected Google Drive; Drive accepts the upload and returns a native Google Docs document that can be read back.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 with the native file. The upload metadata requests the Google Workspace document MIME type, the content is uploaded as `application/rtf` with the original bytes unchanged, the native file is read back once, and nothing is trashed.

## chat-threads.bdd-037

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion preserves the table.xlsx source and verifies the native result"
- Mode: run
- Given: An entitled member's Run uploads a Excel OOXML artifact `table.xlsx` and the member has connected Google Drive; Drive accepts the upload and returns a native Google Sheets spreadsheet that can be read back.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 with the native file. The upload metadata requests the Google Workspace spreadsheet MIME type, the content is uploaded as `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` with the original bytes unchanged, the native file is read back once, and nothing is trashed.

## chat-threads.bdd-038

- Vitest: "CHAT-03 thread artifacts and google drive status > google docs conversion preserves Chinese and Latin font choices in Word text"
- Mode: run
- Given: A member's Run publishes a bilingual `bilingual.docx` artifact through the public upload routes, the member connects Google Drive, and Drive returns a native Google Docs file that can be read back.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200. The uploaded Word text equals the source text; Chinese runs use `Noto Serif SC` or `Noto Sans SC` across all script slots according to their style, Latin runs keep `Times New Roman` (and `Arial` for the title), run size `24`, color `123456` and bold are preserved, the link stays italic, custom and theme font declarations are kept as-is, and a conditional run has no East Asian font. Paragraph spacing, table width, page size, margins, hyperlink tooltip and the footer PAGE field are preserved, package metadata parts are byte-identical, and the stored source file is unchanged.

## chat-threads.bdd-039

- Vitest: "CHAT-03 thread artifacts and google drive status > google docs conversion accepts UTF-16 Word XML"
- Mode: run
- Given: A member's Run publishes a DOCX whose `word/document.xml` is UTF-16 encoded with a byte-order mark, and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200, the uploaded Chinese run "合同（中文），" uses `Noto Serif SC`, and the stored source file is unchanged.

## chat-threads.bdd-040

- Vitest: "CHAT-03 thread artifacts and google drive status > original uploads keep DOCX font declarations intact"
- Mode: run
- Given: A member's Run publishes a bilingual DOCX artifact and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 200, Drive receives the source bytes unchanged, and the stored source file is unchanged.

## chat-threads.bdd-041

- Vitest: "CHAT-03 thread artifacts and google drive status > google docs conversion rejects DTD before creating a Drive file"
- Mode: run
- Given: A member's Run publishes a DOCX whose `word/document.xml` contains a DTD entity declaration, and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with an API error, no content is uploaded to Drive, and the stored source file is unchanged.

## chat-threads.bdd-042

- Vitest: "CHAT-03 thread artifacts and google drive status > google docs conversion rejects cyclic styles before creating a Drive file"
- Mode: run
- Given: A member's Run publishes a DOCX whose styles form a cycle (a heading style based on itself through `basedOn`), and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with an API error, no content is uploaded to Drive, and the stored source file is unchanged.

## chat-threads.bdd-043

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion preserves csv fields as literal text"
- Mode: run
- Given: An entitled member's Run uploads `table.csv` (comma-delimited, with a BOM, leading zeros, a 20-digit number, a `=SUM` formula, a date, a quoted multi-line field, escaped quotes, XML special characters and `_x0041_`), and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 with the Google Sheets MIME type and edit link. The content is uploaded as an XLSX workbook whose first sheet contains all eight values as literal inline strings (properly escaped, `_x005F_x0041_` for the literal escape) and no formulas.

## chat-threads.bdd-044

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion preserves tsv fields as literal text"
- Mode: run
- Given: An entitled member's Run uploads `table.tsv` (tab-delimited, with a BOM, leading zeros, a 20-digit number, a `=SUM` formula, a date, a quoted multi-line field, escaped quotes, XML special characters and `_x0041_`), and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 with the Google Sheets MIME type and edit link. The content is uploaded as an XLSX workbook whose first sheet contains all eight values as literal inline strings (properly escaped, `_x005F_x0041_` for the literal escape) and no formulas.

## chat-threads.bdd-045

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion rejects invalid renamed.docx before creating a Drive file"
- Mode: run
- Given: An entitled member's Run uploads `renamed.docx` whose bytes are actually an XLSX workbook, and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with an error message containing "does not match", and nothing is uploaded to Drive.

## chat-threads.bdd-046

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion rejects invalid script.py before creating a Drive file"
- Mode: run
- Given: An entitled member's Run uploads `script.py`, and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with an error message containing "cannot be converted", and nothing is uploaded to Drive.

## chat-threads.bdd-047

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion rejects invalid table.csv before creating a Drive file"
- Mode: run
- Given: An entitled member's Run uploads `table.csv` containing an unfinished quoted field, and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with an error message containing "unclosed quoted field", and nothing is uploaded to Drive.

## chat-threads.bdd-048

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion rejects invalid table.tsv before creating a Drive file"
- Mode: run
- Given: An entitled member's Run uploads `table.tsv` whose bytes are not valid UTF-8 (a UTF-16 byte-order mark followed by a lone surrogate), and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with an error message containing "UTF-8 text file", and nothing is uploaded to Drive.

## chat-threads.bdd-049

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion rejects invalid table.csv before creating a Drive file"
- Mode: run
- Given: An entitled member's Run uploads `table.csv` containing a single 50,001-character field, and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with an error message containing "50,000", and nothing is uploaded to Drive.

## chat-threads.bdd-050

- Vitest: "CHAT-03 thread artifacts and google drive status > original uploads preserve document source bytes"
- Mode: run
- Given: An entitled member's Run uploads `report.txt` containing "Hello", and the member connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` without a mode (default `original`).
- Then: The response is HTTP 200, Drive receives exactly the source bytes, and the upload metadata keeps MIME type `text/plain`.

## chat-threads.bdd-051

- Vitest: "CHAT-03 thread artifacts and google drive status > uploads native cropped picture frames only for Google Slides conversion (google)"
- Mode: run
- Given: A member with Google Slides conversion enabled publishes a PPTX deck containing cropped, edge-cropped, in-bounds and grouped off-page picture frames, and connects Google Drive; Drive returns a native Google Slides file whose readback shows five page elements. This row uses mode `google`.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response returns the native file. Drive receives one session with the Slides MIME type and one PPTX upload with a full content range. Package parts, media, relationships and presentation XML are preserved, and pictures 2, 3, 4, 5 and grouped 7 remain `rIdImage` rectangles. Off-page frames are clamped onto the slide with equivalent crops (picture 2 crop r≈22581, b≈20511; picture 3 crop l/t 10000; picture 4 crop 16000/27000/36000/17000), the in-bounds frame keeps no crop, all ungrouped frames fit the 12192000×6858000 slide, and the grouped picture is left unchanged. The stored source is unchanged.

## chat-threads.bdd-052

- Vitest: "CHAT-03 thread artifacts and google drive status > uploads native cropped picture frames only for Google Slides conversion (original)"
- Mode: run
- Given: A member with Google Slides conversion enabled publishes a PPTX deck containing off-page and cropped picture frames, and connects Google Drive. This row uses mode `original`.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response returns the PPTX file. Drive receives one PPTX upload with a full content range whose bytes are identical to the source, with pictures 2, 3, 4, 5 and grouped 7 as `rIdImage` rectangles. The stored source is unchanged.

## chat-threads.bdd-053

- Vitest: "CHAT-03 thread artifacts and google drive status > preserves unsupported, fully outside and timed pictures during Slides conversion"
- Mode: run
- Given: A member with Google Slides conversion enabled publishes a PPTX deck whose pictures are unsupported, fully outside the slide or timed, and connects Google Drive; Drive returns a native Slides file whose readback shows the expected page elements.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response returns the native file, Drive receives one PPTX upload with the Slides MIME type, the uploaded deck is byte-identical to the source with the same pictures and preserved package parts, and the stored source is unchanged.

## chat-threads.bdd-054

- Vitest: "CHAT-03 thread artifacts and google drive status > non-chart Slides fidelity converts fixed spacing and explicit table borders"
- Mode: run
- Given: A member with Google Slides conversion enabled publishes a PPTX deck with fixed line spacing on text shapes and a 2×2 table with explicit 0.25pt cell borders, connects Google Drive, and the font provider serves the import fonts.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response returns the native Slides file. In the uploaded deck, fixed line spacing becomes percentage spacing (90013/90013, 100000/104167 and 100000 for shapes 2, 3 and 14), each shared 0.25pt (`w=3175`) border is mirrored onto the opposite cell edge, zero-width solid edges become `noFill`, and everything else in the slide (text, IDs, geometry, other spacing, merged tables, media) and the package parts are unchanged. The stored source is unchanged.

## chat-threads.bdd-055

- Vitest: "CHAT-03 thread artifacts and google drive status > non-chart Slides fidelity serializes table-only repairs without editable text frames"
- Mode: run
- Given: A member with Google Slides conversion enabled publishes a table-only PPTX deck with explicit 0.25pt cell borders and connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response returns the native Slides file. The uploaded deck has no editable text frames, table border repairs are applied (shared borders mirrored, zero-width solid edges become `noFill`) with all other content and package parts unchanged, and the stored source is unchanged.

## chat-threads.bdd-056

- Vitest: "CHAT-03 thread artifacts and google drive status > preserves the original deck with Slides conversion disabled"
- Mode: run
- Given: A member with Google Slides conversion disabled publishes a PPTX deck and connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`, then with mode `original`.
- Then: The `google` request returns HTTP 400 with "Google Slides conversion is not enabled" and uploads nothing. The `original` request returns the PPTX file and uploads bytes identical to the source; the stored source is unchanged.

## chat-threads.bdd-057

- Vitest: "CHAT-03 thread artifacts and google drive status > prepares editable presentation text for Slides conversion"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a `deck.pptx` artifact, connects Google Drive, and the font provider serves the import fonts.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 and the uploaded deck has 12 text items: the 192pt topic number "05" is widened to between 259.95 and 261.2pt, item 3 is about 300.52pt wide, "White Green" keeps colors `FFFFFF`/`00FF00` at size 20, there are two "Column" items, items 8 and 10 are 251 and 235pt wide, "Unknown font" stays 100pt wide, and the small "05" items 12 and 14 stay 27pt wide at size 20.

## chat-threads.bdd-058

- Vitest: "CHAT-03 thread artifacts and google drive status > reserves positive font kerning for editable Slides text (split runs: false)"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a deck whose 192pt topic number "06" is a single run (split runs: false), connects Google Drive, and the font provider serves the import fonts.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 and the uploaded "06" text has size `[192]`, color `["242121"]`, and a width between 256.11 and 257.36pt, reserving room for the positive kerning pair.

## chat-threads.bdd-059

- Vitest: "CHAT-03 thread artifacts and google drive status > reserves positive font kerning for editable Slides text (split runs: true)"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a deck whose 192pt topic number "06" is split into two differently colored runs (split runs: true), connects Google Drive, and the font provider serves the import fonts.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200 and the uploaded "06" text has sizes `[192, 192]`, colors `["242121", "00FF00"]`, and a width between 256.11 and 257.36pt, so the color boundary does not hide the kerning adjustment.

## chat-threads.bdd-060

- Vitest: "CHAT-03 thread artifacts and google drive status > keeps rotated text intact while preparing other text on its slide"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a deck whose first text shape is rotated 90 degrees, and connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200; the rotated "05" text keeps its 251pt width while item 3 is still prepared to about 300.52pt.

## chat-threads.bdd-061

- Vitest: "CHAT-03 thread artifacts and google drive status > uses a rotated group's page bounds when checking text clearance"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a deck with an extra rotated group shape placed near the text, and connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200; using the group's rotated page bounds as an obstacle, item 2 stays 251pt wide and item 3 is prepared to about 300.52pt.

## chat-threads.bdd-062

- Vitest: "CHAT-03 thread artifacts and google drive status > imports a real CLI deck with groups, aliases and numeric weights (alternate relationships: false)"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a real CLI-generated deck with groups, font aliases and numeric weights using standard relationship prefixes (alternate relationships: false), and connects Google Drive; Slides accepts font restoration writes.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200. The upload metadata marks `okouTextImport` `pending-v1`, font restoration writes include weights 500 and 600, and the import completes with `okouTextImport` `complete-v1`. The uploaded text is "05guardrailsWhite Green guardrails" with one "White Green guardrails" item, all text widths are positive, and slide 1 still contains a group.

## chat-threads.bdd-063

- Vitest: "CHAT-03 thread artifacts and google drive status > imports a real CLI deck with groups, aliases and numeric weights (alternate relationships: true)"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a real CLI-generated deck with groups, font aliases and numeric weights whose presentation uses an alternate relationship namespace prefix and an absolute slide target (alternate relationships: true), and connects Google Drive.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 200. The upload metadata marks `okouTextImport` `pending-v1`, font restoration writes include weights 500 and 600, and the import completes with `complete-v1`. The uploaded text is "05guardrailsWhite Green guardrails" with one "White Green guardrails" item, all text widths are positive, and slide 1 still contains a group.

## chat-threads.bdd-064

- Vitest: "CHAT-03 thread artifacts and google drive status > does not complete or replay an unfinished Slides import after write failure"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a CLI deck and connects Google Drive; the Slides font restoration write fails (`write` failure).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`, Drive then lists the converted file still marked `okouTextImport` `pending-v1`, and the member retries.
- Then: The first request returns HTTP 400 and no completion is recorded. The retry returns HTTP 400 with "unfinished font restoration" without a second upload, and the thread artifact is not reported as `synced`.

## chat-threads.bdd-065

- Vitest: "CHAT-03 thread artifacts and google drive status > does not complete or replay an unfinished Slides import after ambiguous failure"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a CLI deck and connects Google Drive; the Slides font restoration state is ambiguous (`ambiguous` failure).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`, Drive then lists the converted file still marked `okouTextImport` `pending-v1`, and the member retries.
- Then: The first request returns HTTP 400 with no restoration writes and no completion. The retry returns HTTP 400 with "unfinished font restoration" without a second upload, and the thread artifact is not reported as `synced`.

## chat-threads.bdd-066

- Vitest: "CHAT-03 thread artifacts and google drive status > does not complete or replay an unfinished Slides import after readback failure"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a CLI deck and connects Google Drive; the Slides readback after font restoration fails (`readback` failure).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`, Drive then lists the converted file still marked `okouTextImport` `pending-v1`, and the member retries.
- Then: The first request returns HTTP 400 and no completion is recorded. The retry returns HTTP 400 with "unfinished font restoration" without a second upload, and the thread artifact is not reported as `synced`.

## chat-threads.bdd-067

- Vitest: "CHAT-03 thread artifacts and google drive status > does not complete or replay an unfinished Slides import after complete failure"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a CLI deck and connects Google Drive; marking the import complete fails (`complete` failure).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`, Drive then lists the converted file still marked `okouTextImport` `pending-v1`, and the member retries.
- Then: The first request returns HTTP 400. The retry returns HTTP 400 with "unfinished font restoration" without a second upload, and the thread artifact is not reported as `synced`.

## chat-threads.bdd-068

- Vitest: "CHAT-03 thread artifacts and google drive status > reports a font provider outage before uploading a partly prepared deck"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a `deck.pptx` artifact and connects Google Drive; the font provider responds with 503.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with a message containing "Could not load the fonts", and nothing is uploaded to Drive.

## chat-threads.bdd-069

- Vitest: "CHAT-03 thread artifacts and google drive status > explicit Google conversion still rejects and removes an empty Slides deck"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads an invalid `deck.pptx`, connects Google Drive, and Drive's conversion yields a Slides deck with zero page elements.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with a message containing "empty deck", and the created `blank-deck` file is trashed.

## chat-threads.bdd-070

- Vitest: "CHAT-03 thread artifacts and google drive status > does not report a previously converted empty Slides deck as success or delete it on retry"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a `deck.pptx`, connects Google Drive, and Drive already lists a previously converted Slides file for it whose readback has zero page elements.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with a message containing "previously converted presentation is empty"; nothing new is uploaded and no file is trashed.

## chat-threads.bdd-071

- Vitest: "CHAT-03 thread artifacts and google drive status > drive upload returns HTTP 201 success with node adapter globals (after refresh: false)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact through the public upload routes and the member connects Google Drive; the API runs with the lightweight Node adapter Request/Response globals, and Drive answers the content upload with HTTP 201 on the first attempt (after refresh: false).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 200 with exactly the Drive file (ID, name, view link), after one content upload and no token refresh.

## chat-threads.bdd-072

- Vitest: "CHAT-03 thread artifacts and google drive status > drive upload returns HTTP 200 success with node adapter globals (after refresh: true)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the API runs with the lightweight Node adapter Request/Response globals, and Drive rejects the first content upload with 401 and then accepts the retry with HTTP 200 (after refresh: true) once the token is refreshed.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 200 with exactly the Drive file, after two content uploads and one token refresh.

## chat-threads.bdd-073

- Vitest: "CHAT-03 thread artifacts and google drive status > folder lookup recovery fixture: scope 403 with errors"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the Drive folder lookup returns 403 with an `errors` reason `insufficientPermissions` (scenario "scope 403 with errors").
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 403 `GOOGLE_DRIVE_SCOPE_REQUIRED` ("Reconnect Google Drive and allow Drive access before uploading artifacts. No file was uploaded.") with recovery `reconnect` for the account. There is one lookup, no refresh, no upload metadata or content, and the account stays `connected`.

## chat-threads.bdd-074

- Vitest: "CHAT-03 thread artifacts and google drive status > folder lookup recovery fixture: scope 403 with details"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the Drive folder lookup returns 403 with a `details` reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT` (scenario "scope 403 with details").
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 403 `GOOGLE_DRIVE_SCOPE_REQUIRED` with recovery `reconnect` for the account. There is one lookup, no refresh, no upload metadata or content, and the account stays `connected`.

## chat-threads.bdd-075

- Vitest: "CHAT-03 thread artifacts and google drive status > folder lookup recovery fixture: other 403"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the Drive folder lookup returns 403 with non-scope reasons (`insufficientFilePermissions`, `domainPolicy`, `rateLimitExceeded`) (scenario "other 403").
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive folder lookup failed with HTTP 403". There is one lookup, no refresh, no upload, and the account stays `connected`.

## chat-threads.bdd-076

- Vitest: "CHAT-03 thread artifacts and google drive status > folder lookup recovery fixture: 401"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the Drive folder lookup returns 401 for the stored token and succeeds once the token is refreshed (scenario "401").
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 200 with the uploaded file and a null `webViewLink`. There are three lookups, one token refresh, one upload session and one content upload, and the account stays `connected`.

## chat-threads.bdd-077

- Vitest: "CHAT-03 thread artifacts and google drive status > drive folder creation returns a controlled error before opening an upload session"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; Drive lists no existing folder and rejects folder creation with 403.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive folder creation failed with HTTP 403" after one creation attempt and one lookup, with no token refresh and no upload session or content.

## chat-threads.bdd-078

- Vitest: "CHAT-03 thread artifacts and google drive status > drive upload returns a controlled error when the session location is missing"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the API runs with the Node adapter globals and Drive answers the upload session request with 200 but no session location.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive did not open an upload session", with no refresh, two folder queries, one session request and no content upload.

## chat-threads.bdd-079

- Vitest: "CHAT-03 thread artifacts and google drive status > drive upload returns a controlled error for session HTTP 403 with node adapter globals (after refresh: true)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; with Node adapter globals, Drive rejects the upload session first with 401 and, after a token refresh, with 403 (phase session, after refresh: true).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive upload failed with HTTP 403" with no provider body. Drive saw two rejected session attempts, one refresh, four folder queries, two session requests and no content upload.

## chat-threads.bdd-080

- Vitest: "CHAT-03 thread artifacts and google drive status > drive upload returns a controlled error for session HTTP 401 with node adapter globals (after refresh: true)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; with Node adapter globals, Drive rejects the upload session with 401 both before and after a token refresh (phase session, after refresh: true).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive upload failed with HTTP 401". Drive saw two rejected session attempts, one refresh, four folder queries, two session requests and no content upload.

## chat-threads.bdd-081

- Vitest: "CHAT-03 thread artifacts and google drive status > drive upload returns a controlled error for content HTTP 503 with node adapter globals (after refresh: false)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; with Node adapter globals, Drive rejects the content upload with 503 (phase content, after refresh: false).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive upload failed with HTTP 503" after one rejected attempt, no refresh, two folder queries, one session request and one content upload.

## chat-threads.bdd-082

- Vitest: "CHAT-03 thread artifacts and google drive status > drive upload keeps unexpected transport failure as an internal server error"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; with Node adapter globals, the Drive upload session request fails at the network transport level.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The request fails with HTTP 500 (an unexpected internal error), with no token refresh, one session request and no content upload.

## chat-threads.bdd-083

- Vitest: "CHAT-03 thread artifacts and google drive status > drive upload keeps unexpected invalid success payload as an internal server error"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; with Node adapter globals, Drive answers the content upload with a success payload that is not a valid file.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The request fails with HTTP 500 (an unexpected internal error), with no token refresh, one session request and one content upload.

## chat-threads.bdd-084

- Vitest: "CHAT-03 thread artifacts and google drive status > retains bounded Google Drive failure diagnostics without private provider content"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; Drive folder lookups fail with a series of error bodies containing private content (mixed allowlisted and private reasons with scope details, empty body, invalid JSON, missing reasons, invalid reason type, invalid envelope with 503, an oversized 429 body, and a scope rejection after a token refresh), and then the upload session and the upload content are each rejected with 403 bodies containing private content.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original` once per scenario.
- Then: Scope scenarios return HTTP 403 `GOOGLE_DRIVE_SCOPE_REQUIRED` with reconnect recovery; the others return HTTP 400 `BAD_REQUEST` "Google Drive folder lookup failed with HTTP <status>". Only the refreshed-token scenario refreshes once and looks up twice; no lookup failure opens an upload. Session and content rejections return HTTP 400 "Google Drive upload failed with HTTP 403" without a refresh. Logged diagnostics contain none of the private content, the filename, or the access tokens.

## chat-threads.bdd-085

- Vitest: "CHAT-03 thread artifacts and google drive status > folder lookup returns a controlled error when its provider stream is unreadable"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the Drive folder lookup returns 403 with a body stream that errors while being read.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive folder lookup failed with HTTP 403" after one lookup, with no refresh and no upload.

## chat-threads.bdd-086

- Vitest: "CHAT-03 thread artifacts and google drive status > folder lookup diagnostics preserve request-owner cancellation"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the Drive folder lookup returns 403 with a partial body and the caller aborts the request while the body is being read.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `original`.
- Then: The request fails with HTTP 500 rather than a controlled lookup error, with no token refresh and no upload session or content.

## chat-threads.bdd-087

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion offers scope recovery for errors reason (after refresh: false)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns 403 with `errors` reason `insufficientPermissions` (after refresh: false).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 403 `GOOGLE_DRIVE_SCOPE_REQUIRED` ("Reconnect Google Drive and allow Drive access before uploading artifacts. No file was uploaded.") with recovery `reconnect` for the account. There is no token refresh and one lookup, each querying by `vm0FileId` and the Google Docs MIME type; nothing is uploaded and the account stays `connected`.

## chat-threads.bdd-088

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion offers scope recovery for details reason (after refresh: false)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns 403 with `details` reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT` (after refresh: false).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 403 `GOOGLE_DRIVE_SCOPE_REQUIRED` ("Reconnect Google Drive and allow Drive access before uploading artifacts. No file was uploaded.") with recovery `reconnect` for the account. There is no token refresh and one lookup, each querying by `vm0FileId` and the Google Docs MIME type; nothing is uploaded and the account stays `connected`.

## chat-threads.bdd-089

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion offers scope recovery for errors reason (after refresh: true)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns 401 for the stored token and then 403 with `errors` reason `insufficientPermissions` after a token refresh (after refresh: true).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 403 `GOOGLE_DRIVE_SCOPE_REQUIRED` ("Reconnect Google Drive and allow Drive access before uploading artifacts. No file was uploaded.") with recovery `reconnect` for the account. There is one token refresh and two lookups, each querying by `vm0FileId` and the Google Docs MIME type; nothing is uploaded and the account stays `connected`.

## chat-threads.bdd-090

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion offers scope recovery for details reason (after refresh: true)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns 401 for the stored token and then 403 with `details` reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT` after a token refresh (after refresh: true).
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 403 `GOOGLE_DRIVE_SCOPE_REQUIRED` ("Reconnect Google Drive and allow Drive access before uploading artifacts. No file was uploaded.") with recovery `reconnect` for the account. There is one token refresh and two lookups, each querying by `vm0FileId` and the Google Docs MIME type; nothing is uploaded and the account stays `connected`.

## chat-threads.bdd-091

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion reports Google HTTP 403 for insufficientFilePermissions without creating another file (after refresh: false)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns HTTP 403 (after refresh: false) with reason `insufficientFilePermissions`, detail reason `domainPolicy`, and private file IDs, accounts and tokens in the body.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive could not check previous conversions (HTTP 403). Try again." with no provider content. There is no token refresh and one lookup, and nothing is uploaded.

## chat-threads.bdd-092

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion reports Google HTTP 403 for dailyLimitExceeded without creating another file (after refresh: false)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns HTTP 403 (after refresh: false) with reason `dailyLimitExceeded`, detail reason `userRateLimitExceeded`, and private file IDs, accounts and tokens in the body.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive could not check previous conversions (HTTP 403). Try again." with no provider content. There is no token refresh and one lookup, and nothing is uploaded.

## chat-threads.bdd-093

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion reports Google HTTP 403 for private-unknown-reason without creating another file (after refresh: true)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns 401 for the stored token and, after a token refresh, HTTP 403 (after refresh: true) with reason `private-unknown-reason`, detail reason `private-unknown-detail`, and private file IDs, accounts and tokens in the body.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive could not check previous conversions (HTTP 403). Try again." with no provider content. There is one token refresh and two lookups, and nothing is uploaded.

## chat-threads.bdd-094

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion reports Google HTTP 429 for rateLimitExceeded without creating another file (after refresh: false)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns HTTP 429 (after refresh: false) with reason `rateLimitExceeded`, detail reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, and private file IDs, accounts and tokens in the body.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive could not check previous conversions (HTTP 429). Try again." with no provider content. There is no token refresh and one lookup, and nothing is uploaded.

## chat-threads.bdd-095

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion reports Google HTTP 503 for backendError without creating another file (after refresh: true)"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns 401 for the stored token and, after a token refresh, HTTP 503 (after refresh: true) with reason `backendError`, detail reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, and private file IDs, accounts and tokens in the body.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive could not check previous conversions (HTTP 503). Try again." with no provider content. There is one token refresh and two lookups, and nothing is uploaded.

## chat-threads.bdd-096

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion keeps an unproven scope failure controlled for empty body"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns 403 with an empty body (scenario "empty body").
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive could not check previous conversions (HTTP 403). Try again." rather than a scope-recovery response. There is no token refresh, one lookup, and nothing is uploaded.

## chat-threads.bdd-097

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion keeps an unproven scope failure controlled for invalid JSON"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns 403 with an invalid JSON (HTML) body (scenario "invalid JSON").
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive could not check previous conversions (HTTP 403). Try again." rather than a scope-recovery response. There is no token refresh, one lookup, and nothing is uploaded.

## chat-threads.bdd-098

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion keeps an unproven scope failure controlled for unreadable stream"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns 403 with a body stream that errors while being read (scenario "unreadable stream").
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive could not check previous conversions (HTTP 403). Try again." rather than a scope-recovery response. There is no token refresh, one lookup, and nothing is uploaded.

## chat-threads.bdd-099

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion keeps an unproven scope failure controlled for oversized body"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns 403 with an oversized (16 KiB message) body with an `insufficientPermissions` reason (scenario "oversized body").
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive could not check previous conversions (HTTP 403). Try again." rather than a scope-recovery response. There is no token refresh, one lookup, and nothing is uploaded.

## chat-threads.bdd-100

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion rejects a stalled lookup without uploading another file"
- Mode: run
- Given: A member's Run publishes a DOCX artifact and the member connects Google Drive; the previous-conversion lookup returns 503 with a body stream that starts but never finishes.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 `BAD_REQUEST` "Google Drive could not check previous conversions (HTTP 503). Try again.", and nothing is uploaded.

## chat-threads.bdd-101

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion reuses a completed editable copy when the caller retries"
- Mode: run
- Given: An entitled member's Run uploads `report.txt`, the member connects Google Drive, and Drive returns a native Google Docs file and lists it as an existing conversion on later lookups.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google` twice.
- Then: The first request returns HTTP 200; the retry returns the same native file ID and Docs MIME type, and Drive receives only one content upload.

## chat-threads.bdd-102

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion status keeps a native result alongside an original (native first: true)"
- Mode: run
- Given: An entitled member's Run uploads `report.txt` and the member connects Google Drive; Drive lists both a native Google Docs conversion and the original text file for the artifact, with the native file first (native first: true).
- When: The member reads `GET /api/chat-threads/:threadId/artifacts`.
- Then: The file's Drive sync is `synced` with the native file ID, `originalUploaded` true, the Docs MIME type, and the Docs edit link.

## chat-threads.bdd-103

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion status keeps a native result alongside an original (native first: false)"
- Mode: run
- Given: An entitled member's Run uploads `report.txt` and the member connects Google Drive; Drive lists both the original text file and a native Google Docs conversion for the artifact, with the original first (native first: false).
- When: The member reads `GET /api/chat-threads/:threadId/artifacts`.
- Then: The file's Drive sync is `synced` with the native file ID, `originalUploaded` true, the Docs MIME type, and the Docs edit link.

## chat-threads.bdd-104

- Vitest: "CHAT-03 thread artifacts and google drive status > workspace conversion rejects and removes a provider result in the wrong format"
- Mode: run
- Given: An entitled member's Run uploads `report.txt` and the member connects Google Drive; Drive's conversion result comes back as `text/plain` instead of a Google Docs file.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with a message containing "unsuccessful copy was removed", and the raw file is trashed.

## chat-threads.bdd-105

- Vitest: "CHAT-03 thread artifacts and google drive status > discards a conversion that produced an …"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a `deck.pptx` artifact and connects Google Drive; the converted Slides deck has zero page elements and Drive accepts trashing it.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 "Google Slides converted this presentation to an empty deck". The upload metadata requests `application/vnd.google-apps.presentation` while the content is sent as PPTX, the deck is read back once, and it is trashed.

## chat-threads.bdd-106

- Vitest: "CHAT-03 thread artifacts and google drive status > reports an empty deck drive refused to …"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a `deck.pptx` artifact and connects Google Drive; the converted Slides deck has zero page elements and Drive refuses to trash it.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 "Google Slides converted this presentation to an empty deck that could not be removed from Drive". The upload metadata requests the Slides MIME type while the content is sent as PPTX, the deck is read back once, and a trash attempt is made.

## chat-threads.bdd-107

- Vitest: "CHAT-03 thread artifacts and google drive status > preserves Slides conversion failure messages for standard provider rejection"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a `deck.pptx` artifact and connects Google Drive; Drive rejects the upload session with 400 and a standard error envelope whose reason is `conversionUnsupportedConversionPath`.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with the message "Google Slides could not read this presentation".

## chat-threads.bdd-108

- Vitest: "CHAT-03 thread artifacts and google drive status > preserves Slides conversion failure messages for large canonical provider rejection"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a `deck.pptx` artifact and connects Google Drive; Drive rejects the upload session with 400 and a very large (over 17 KiB) error envelope whose reason is `conversionUnsupportedConversionPath`.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with the message "Google Slides could not read this presentation".

## chat-threads.bdd-109

- Vitest: "CHAT-03 thread artifacts and google drive status > preserves Slides conversion failure messages for provider details without the canonical …"
- Mode: run
- Given: An entitled member with Google Slides conversion enabled uploads a `deck.pptx` artifact and connects Google Drive; Drive rejects the upload session with 400 whose `conversionUnsupportedConversionPath` reason appears only in `details`, not in the canonical `errors` list.
- When: The member calls `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with mode `google`.
- Then: The response is HTTP 400 with the generic message "Google Drive upload failed with HTTP 400".

## chat-threads.bdd-110

- Vitest: "CHAT-03 thread artifacts and google drive status > uses the selected google drive account for artifact status and sync"
- Mode: run
- Given: An entitled member's Run publishes `account.txt`, and the member connects two Google Drive accounts: a default account and a second "Selected Drive" account.
- When: The member reads `GET /api/chat-threads/:threadId/artifacts` while the default account's token is rejected, selects the second account via `PUT /api/chat-threads/:id/connector-selections`, re-reads artifacts, uploads via `POST /api/artifacts/:artifactId/google-drive/chat-uploads` with the selected connection, retries in `original` and `google` modes while Drive returns a scope error, reconnects the default account, and reads and uploads again after the selected account's refresh token is rejected.
- Then: The default account's 401 yields `disconnected` with reconnect recovery for the default account after one refresh. After selection (HTTP 200), status is `not_synced` using the selected token, and the upload returns HTTP 200 using the selected token for both folder queries and the upload. Scope errors return HTTP 403 `GOOGLE_DRIVE_SCOPE_REQUIRED` with reconnect recovery for the selected account, querying folders and then previous conversions. A terminal refresh failure uses the selected refresh token and yields reconnect recovery for the selected account; the default account stays `connected` while the selected one becomes `reconnect-required` (`authorization_expired_or_revoked`), and a further upload returns HTTP 400 "Connect Google Drive before syncing artifacts" without contacting Drive.

## chat-threads.bdd-111

- Vitest: "CHAT-03 thread artifacts and google drive status > dedupes artifact urls and lists hosted sites beside run files"
- Mode: run
- Given: An entitled member has two Runs in one thread: the first records its own HTML upload and a shared one, and the second re-completes the shared upload and publishes a hosted site.
- When: The member lists `GET /api/chat-threads/:threadId/artifacts` before and after the hosted-site publication, renames the site via `PATCH /api/host/sites/:siteId/url`, and lists again after connecting a Google Drive account without a refresh token whose status reads return 401.
- Then: There are two run groups: the first has only its own file and the second owns the shared file. After publishing, the second group lists the shared file followed by the hosted site (`hosted-site`, canonical artifact URL, alias URL, `text/html`) and the first group is unchanged. After the rename the hosted-site entry keeps its URL and shows the new alias URL. With the refresh-less Drive connection every file's Drive sync is `unknown`.

## chat-threads.bdd-112

- Vitest: "CHAT-03 thread artifacts and google drive status > keeps files generated beside a hosted site visible"
- Mode: run
- Given: An entitled member's Run records `kitten.mp4` (explicit `video/mp4`), `kitten.jpg` and `kitten.pdf` uploads and then publishes a hosted site.
- When: The member reads `GET /api/chat-threads/:threadId/artifacts`.
- Then: The Run's group has four files: the three uploads in order (the video with `video/mp4` and filename `kitten.mp4`) followed by the `hosted-site` entry at the artifact URL.
