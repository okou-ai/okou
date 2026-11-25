# chat-files.bdd

## chat-files.bdd-001

- Vitest: "CHAT-01 chat thread lifecycle > creates, mutates, searches, and deletes a thread through visible APIs"
- Mode: run
- Given: A signed-in member.
- When: The member creates a thread titled "Launch notes" with `POST /api/chat-threads`, saves and then clears a composer draft (text plus a `chat_thread` reference and one attachment) with `PATCH /api/chat-threads/:id/composer-draft`, renames, pins, unpins, marks read and unread, clears the model selection, lists events, artifacts and searches "launch", then deletes the thread with `DELETE /api/chat-threads/:id`.
- Then: The thread is created with its title and initially reads with a `lastReadAt` and `cancellationRecoveryPending: false` and an empty draft. The saved draft reads back with the same message and one attachment and the thread appears in `GET /api/chat-thread-drafts`; after clearing, the draft is empty and the thread leaves the drafts list. Mark read returns a `lastReadAt`; mark unread returns `lastReadAt: null`, publishes `chatThreadReadCursorUpdated` with `lastReadAt: null` on only the `user-org:<userId>:<orgId>` channel, and the thread reads back unread. Events, artifact runs and search results are empty, and after deletion reading the thread returns HTTP 404 `NOT_FOUND`.

## chat-files.bdd-002

- Vitest: "CHAT-01 chat thread lifecycle > hides owned threads from peer users and other organizations"
- Mode: run
- Given: An owner and a peer in the same organization and an outsider in another organization; the owner creates a thread titled "Private planning".
- When: The peer and outsider read the thread with `GET /api/chat-threads/:id`, the peer reads its draft, the owner saves a private text draft, and the peer reads the draft again, lists drafts and lists thread events with `GET /api/chat-threads/events`.
- Then: The owner can read the thread and the saved draft. The peer and the outsider get HTTP 404 `NOT_FOUND` on the thread read, the peer gets HTTP 404 on the draft both before and after it is saved, the peer's draft list omits the thread, and the peer's thread events contain no event for the thread.

## chat-files.bdd-003

- Vitest: "CHAT-01 chat thread lifecycle > given an owned thread, when mutation routes are chained, then only owner-visible state changes"
- Mode: run
- Given: An owner and a peer in the same organization; the owner has a connected personal Codex subscription, no model preference, and a thread renamed to "Pinned launch plan".
- When: The owner sets the thread model selection to `gpt-6-luna`, pins and marks the thread read; the peer then tries to rename, clear the model selection, unpin, pin, mark read and mark unread the thread; finally the owner unpins and clears the model selection.
- Then: Mark read returns a `lastReadAt` and the owner's thread events include `model_selection_updated` with `gpt-6-luna`. Every peer mutation returns HTTP 404 `NOT_FOUND`, and the owner's thread keeps its `lastReadAt`. After the owner clears the selection, the thread events include `model_selection_updated` with `auto`.

## chat-files.bdd-004

- Vitest: "CHAT-02 chat messages and visible validation > sends chat messages through API-visible no-credit, recall, and interrupt branches"
- Mode: run
- Given: A signed-in member without credits and a peer in the same organization; the member has a completed 24-byte upload `launch-plan.txt`.
- When: The member sends `POST /api/chat/events` with a text-and-file user message and a client event ID, retries with the same client event ID, reuses it in a second thread, sends a stale recommended follow-up that revokes the rejected input, the peer and then the member recall the rejected input (the member twice), and the member sends an interrupt for an unknown Run ID.
- Then: The first send returns HTTP 201 with a thread ID, the thread has an empty draft and exactly three events: the `input.prompt` with the user message, an `input.rejected` with error `insufficient_credits` revoking it, and an `output.error` containing "Insufficient credits". The retry returns HTTP 201 for the same thread without adding events, and the second thread has no events. The stale follow-up returns HTTP 400 `BAD_REQUEST` "Recommended follow-up is no longer available", the peer recall returns HTTP 404 `NOT_FOUND`, the recall returns HTTP 201 and repeated recall yields exactly one revoking event, and the interrupt returns HTTP 400 `BAD_REQUEST` "Only active chat runs can be interrupted".

## chat-files.bdd-005

- Vitest: "CHAT-02 chat messages and visible validation > rejects invalid generation template and reused client thread ids through the send API"
- Mode: run
- Given: A signed-in member and a peer in the same organization.
- When: The member sends `POST /api/chat/events` with a new `clientThreadId`, retries and reuses the same `clientThreadId` with different prompts, the peer sends to a thread the member created, and the member sends a new message with model `gpt-6-luna`.
- Then: The first send returns HTTP 201 with the thread ID equal to the client thread ID; the retry and the reuse return the same body, and the thread has exactly one original `input.prompt`. The peer's send returns HTTP 404 `NOT_FOUND`. The model-selected send creates a thread whose `created` event in `GET /api/chat-threads/events` has selected model `gpt-6-luna`.

## chat-files.bdd-006

- Vitest: "CHAT-02 chat messages and visible validation > lists visible events and rejects invalid send requests without hidden fixtures"
- Mode: run
- Given: A signed-in member with an empty thread and a peer in the same organization.
- When: The member lists the thread events, an unauthenticated caller sends `POST /api/chat/events` with prompt "hello", the member sends "hello" without a thread, and the peer sends to the member's thread.
- Then: The thread has no events, the unauthenticated send returns HTTP 401 `UNAUTHORIZED`, the member's send returns HTTP 201 with a thread ID, and the peer's send returns HTTP 404 `NOT_FOUND`.

## chat-files.bdd-007

- Vitest: "CHAT-02 chat messages and visible validation > given an empty chat thread, when event rows are requested, then only the owner sees zero rows"
- Mode: run
- Given: An owner and a peer in the same organization; the owner has an empty thread.
- When: The owner lists the thread events with limit 1, the peer requests `GET /api/chat-threads/:threadId/event-rows` with limit 1, and the owner requests event rows for an unknown thread ID.
- Then: The owner receives `{ events: [] }`, while the peer request and the unknown-thread request each return HTTP 404 `NOT_FOUND`.

## chat-files.bdd-008

- Vitest: "CHAT-03 artifacts > exposes empty artifact state through the list API"
- Mode: run
- Given: A signed-in member with a new empty thread.
- When: The member lists `GET /api/chat-threads/:threadId/artifacts` for that thread and for an unknown thread ID.
- Then: The thread returns an empty `runs` list, and the unknown thread returns HTTP 404 `NOT_FOUND`.

## chat-files.bdd-009

- Vitest: "FILE-01 uploads, storage, and host APIs > prepares and completes an upload through S3 boundary state"
- Mode: run
- Given: A signed-in member; object storage signs upload URLs and accepts private artifact objects.
- When: The member prepares a 12-byte `notes.txt` upload with content type `Text/Plain; Charset=UTF-8` via `POST /api/uploads/prepare`, the object appears in storage, the member completes it via `POST /api/uploads/complete`, another user tries to complete it, and the member prepares a 10-byte `capture.custom` with content type `application/x-custom`.
- Then: The prepare returns the filename, normalized content type `text/plain; charset=utf-8`, size 12, an HTTP(S) upload URL and a public URL of the form `/artifacts/<10 chars>.txt` without the user ID. Completion returns the same ID, filename, content type, size and URL. The other user's completion returns HTTP 404 `NOT_FOUND`, and the custom file is prepared with content type `application/octet-stream`.

## chat-files.bdd-010

- Vitest: "FILE-01 uploads, storage, and host APIs > prepares and completes a hosted-site deployment through host APIs"
- Mode: run
- Given: A signed-in member; hosted-site storage accepts uploads.
- When: The member prepares a hosted-site deployment with `/index.html` and a hashed JS asset via `POST /api/host/deployments/prepare`, another user and then the member complete it via `POST /api/host/deployments/:deploymentId/complete`, and the member prepares another site containing only `/about.html`.
- Then: The prepare returns the site as public slug, alias URL equal to the URL, deployment version 1, an artifact URL containing `dpl-<deploymentId>.`, and two uploads. The other user's completion returns HTTP 404 `NOT_FOUND`. The member's completion returns status `ready`, version 1, active with active deployment version 1 and the prepared URLs. The site without an index returns HTTP 400 with a message containing "must include /index.html".
