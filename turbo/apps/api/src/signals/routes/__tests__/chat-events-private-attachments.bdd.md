# chat-events-private-attachments

## chat-events-private-attachments-001

- Vitest: "private attachments through normal chat send > preserves no files in the input and run"
- Mode: run
- Given: A signed-in entitled member prefers the `claude-fable-5-1` model and has uploaded no private files (scenario "no files").
- When: The member sends a chat message containing only the text "Read no files" with `POST /api/chat/events`, then reads the thread events and the created Run.
- Then: The send issues no storage HEAD for any attachment, the `input.prompt` event for the Run carries no file parts, and the Run prompt contains no `[ID]` file references.

## chat-events-private-attachments-002

- Vitest: "private attachments through normal chat send > preserves one file in the input and run"
- Mode: run
- Given: A signed-in entitled member prefers the `claude-fable-5-1` model and has prepared, uploaded and completed one private PNG file through `POST /api/uploads/prepare` and `POST /api/uploads/complete` (scenario "one file").
- When: The member sends a chat message with one file part referencing that file plus text with `POST /api/chat/events`, then reads the thread events, the Run and `GET /api/web/file-url` for the file.
- Then: The send issues no storage HEAD for the completed attachment, the `input.prompt` event keeps exactly the sent file part, the Run prompt lists exactly that file ID as `[ID]`, and the file still resolves to `private-artifacts/<id>/<filename>`.

## chat-events-private-attachments-003

- Vitest: "private attachments through normal chat send > preserves empty file in the input and run"
- Mode: run
- Given: A signed-in entitled member prefers the `claude-fable-5-1` model and has uploaded and completed one zero-byte private PNG file (scenario "empty file").
- When: The member sends a chat message with one file part referencing the empty file plus text with `POST /api/chat/events`, then reads the thread events, the Run and `GET /api/web/file-url` for the file.
- Then: The send issues no storage HEAD for the attachment, the `input.prompt` event keeps exactly the sent file part, the Run prompt lists that file ID as `[ID]`, and the file resolves to `private-artifacts/<id>/<filename>`.

## chat-events-private-attachments-004

- Vitest: "private attachments through normal chat send > preserves multiple files in the input and run"
- Mode: run
- Given: A signed-in entitled member prefers the `claude-fable-5-1` model and has uploaded and completed three private PNG files (scenario "multiple files").
- When: The member sends a chat message whose file parts reference the files in the order third, first, second, plus text, with `POST /api/chat/events`, then reads the thread events, the Run and each file URL.
- Then: The send issues no storage HEAD for the attachments, the `input.prompt` event keeps the three file parts in the sent order, the Run prompt lists the three `[ID]` references in that same order, and each file resolves to its own `private-artifacts/<id>/<filename>` key.

## chat-events-private-attachments-005

- Vitest: "private attachments through normal chat send > preserves repeated file in the input and run"
- Mode: run
- Given: A signed-in entitled member prefers the `claude-fable-5-1` model and has uploaded and completed one private PNG file (scenario "repeated file").
- When: The member sends a chat message with two file parts that both reference the same file, plus text, with `POST /api/chat/events`, then reads the thread events, the Run and the file URL.
- Then: The send issues no storage HEAD for the attachment, the `input.prompt` event keeps both file parts, the Run prompt lists the same `[ID]` twice, and the file resolves to `private-artifacts/<id>/<filename>`.

## chat-events-private-attachments-006

- Vitest: "private attachments through normal chat send > preserves annotated file in the input and run"
- Mode: run
- Given: A signed-in entitled member prefers the `claude-fable-5-1` model and has uploaded and completed an original PNG and its annotated copy `file-0.annotated.png` (scenario "annotated file").
- When: The member sends a chat message with one file part referencing the original file, with `annotatedFileId` set to the annotated copy and one box annotation mark with a note, plus text, with `POST /api/chat/events`.
- Then: The send issues no storage HEAD for either attachment, the `input.prompt` event keeps the annotated file part unchanged, the Run prompt lists only the annotated copy's ID as `[ID]`, and both files resolve to their own `private-artifacts/<id>/<filename>` keys.

## chat-events-private-attachments-007

- Vitest: "private attachments through normal chat send > reuses completed metadata across same-length PUT retries and repeated sends"
- Mode: run
- Given: A signed-in entitled member prepares a 5-byte private text upload with `POST /api/uploads/prepare`; the presigned PUT is signed with `ContentLength` 5 and a signed `content-length` header. A wrong-size PUT is rejected with `SignatureDoesNotMatch`; the member then PUTs "first", completes it with `POST /api/uploads/complete`, PUTs a same-length "retry" and completes again. Afterwards any storage HEAD for that object fails.
- When: The member sends two chat messages with `POST /api/chat/events`, each with three file parts referencing the file ID in lowercase, uppercase and lowercase.
- Then: Both sends create Runs despite the failing HEAD, and each Run prompt contains `[ID] <uppercase file ID>`.

## chat-events-private-attachments-008

- Vitest: "private attachments through normal chat send > verifies a pending upload once before reusing its registered metadata"
- Mode: run
- Given: A signed-in entitled member prepared a 7-byte private text upload and PUT its content to storage but never called the complete endpoint.
- When: The member sends two chat messages with `POST /api/chat/events`, each referencing the pending file.
- Then: Each send creates a Run whose prompt contains `[ID] <file ID>`, and storage receives exactly one HEAD for the object across both sends.

## chat-events-private-attachments-009

- Vitest: "private attachments through normal chat send > reuses completed multipart metadata after part upload credentials stop writing"
- Mode: run
- Given: A signed-in entitled member prepares a multipart private upload of 5 MiB + 4 bytes with `POST /api/uploads/prepare`, PUTs every part and completes it with `POST /api/uploads/multipart/complete` (HTTP 200). A later PUT to a part URL fails with `NoSuchUpload`, and any storage HEAD for the object fails.
- When: The member sends a chat message referencing the multipart file with `POST /api/chat/events`.
- Then: The send creates a Run whose prompt contains `[ID] <file ID>`.

## chat-events-private-attachments-010

- Vitest: "private attachments through normal chat send > keeps verifying completed private uploads without the bounded-size protocol"
- Mode: run
- Given: A signed-in entitled member obtains an unbounded upload URL for a 5-byte text file from `POST /api/integrations/github/upload-file/init`, PUTs "first", completes it with `POST /api/uploads/complete`, and then overwrites the object with longer content.
- When: The member sends a chat message referencing that upload with `POST /api/chat/events`.
- Then: The send performs exactly one storage HEAD for the object and creates a Run whose prompt contains `[ID] <upload ID>`.

## chat-events-private-attachments-011

- Vitest: "private attachments through normal chat send > accepts an uppercase private UUID without changing its reference"
- Mode: run
- Given: A signed-in entitled member prefers the `claude-fable-5-1` model and has uploaded and completed a private text file.
- When: The member sends a chat message whose file part uses the file ID in uppercase with `POST /api/chat/events`.
- Then: The send creates a Run whose prompt contains `[ID] <uppercase file ID>`.

## chat-events-private-attachments-012

- Vitest: "private attachments through normal chat send > handles private attachment withdrawal before selection"
- Mode: run
- Given: A signed-in entitled member has a completed private artifact upload listed by `GET /api/artifacts/catalog`, plus a second upload that was PUT but not completed. The member deletes the artifact with `DELETE /api/artifacts/catalog/:artifactId` (HTTP 200) before sending (row "before selection"), and creates a thread with `POST /api/chat-threads`.
- When: The member sends a chat message to that thread with `POST /api/chat/events` referencing both the deleted artifact and the pending upload.
- Then: The send returns HTTP 500, the thread has no user messages, and `GET /api/web/file-url` for the deleted artifact returns HTTP 404.

## chat-events-private-attachments-013

- Vitest: "private attachments through normal chat send > handles private attachment withdrawal after selection"
- Mode: run
- Given: A signed-in entitled member has a completed private artifact upload listed by `GET /api/artifacts/catalog`, plus a second upload that was PUT but not completed, and a thread created with `POST /api/chat-threads`. Storage holds the HEAD for the pending upload (row "after selection").
- When: The member sends a chat message referencing both files with `POST /api/chat/events`; while the pending upload's HEAD is held, the member deletes the artifact with `DELETE /api/artifacts/catalog/:artifactId` (HTTP 200), and then storage answers the HEAD.
- Then: The send returns HTTP 201 and creates a Run whose prompt contains `[ID]` references for both files, and afterwards `GET /api/web/file-url` for the deleted artifact returns HTTP 404.

## chat-events-private-attachments-014

- Vitest: "private attachments through normal chat send > rejects a set containing a missing object without publishing its input"
- Mode: run
- Given: A signed-in entitled member has one completed private file and has prepared a second upload whose object was never written to storage (row "missing object").
- When: The member sends `POST /api/chat/events` with a new `clientThreadId`, model `claude-fable-5-1` and file parts for both uploads.
- Then: The response is HTTP 500 with `{ "error": "Internal server error" }`, reading the client thread returns HTTP 404, `GET /api/logs?limit=100` lists no Run with that prompt, and the completed file still resolves to `private-artifacts/<id>/<filename>`.

## chat-events-private-attachments-015

- Vitest: "private attachments through normal chat send > rejects a set containing a foreign owner without publishing its input"
- Mode: run
- Given: A signed-in entitled member has one completed private file, and a different entitled user has prepared and written a second upload (row "foreign owner").
- When: The member sends `POST /api/chat/events` with a new `clientThreadId`, model `claude-fable-5-1` and file parts for both uploads.
- Then: The response is HTTP 500 with `{ "error": "Internal server error" }`, reading the client thread returns HTTP 404, `GET /api/logs?limit=100` lists no Run with that prompt, and the member's own file still resolves to `private-artifacts/<id>/<filename>`.

## chat-events-private-attachments-016

- Vitest: "private attachments through normal chat send > accepts completion of a private upload while its send HEAD is pending"
- Mode: run
- Given: A signed-in entitled member prefers the `claude-fable-5-1` model and has prepared a 10-byte private text upload and PUT its content without completing it. Storage holds the first HEAD response.
- When: The member sends a chat message referencing the file with `POST /api/chat/events`; while the send's HEAD is held, the member calls `POST /api/uploads/complete` for the file, and then storage releases the HEAD.
- Then: The completion returns the file ID with size 10, the send creates a Run whose prompt contains `[ID] <file ID>`, and the file resolves to `private-artifacts/<id>/<filename>`.
