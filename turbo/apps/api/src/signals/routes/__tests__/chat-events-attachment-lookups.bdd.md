# chat-events-attachment-lookups

## chat-events-attachment-lookups-001

- Vitest: "chat attachment lookup ownership > reuses the original shared by annotated and plain file parts"
- Mode: run
- Given: An entitled member owns an image and an annotated derivative they can both reference.
- When: The member sends a structured prompt including the annotated image with its original reference and the same original as a plain file part.
- Then: Storage sees exactly one metadata read for each artifact. Public thread history preserves both structured parts, and the Run prompt references both artifact IDs.

## chat-events-attachment-lookups-002

- Vitest: "chat attachment lookup ownership > shares storage reads across different filename hints and retains their snapshots"
- Mode: run
- Given: An entitled member owns one image whose current stored filename differs from two separately supplied filename hints.
- When: The member submits the same image with the stale, archived and current filename snapshots.
- Then: Storage attempts the stale and archived keys, uses one listing and reads the current key once. Run readback preserves all three requested display names with the real image MIME type.

## chat-events-attachment-lookups-003

- Vitest: "chat attachment lookup ownership > does not reuse private attachment authorization for a different user"
- Mode: run
- Given: An entitled member has access to a private attachment, and a different user in that same workspace lacks access.
- When: The owner first sends the attachment successfully. The other user then attempts to send the same reference in their own thread.
- Then: The owner's Run prompt contains the file ID. The other user's send returns HTTP 500 with "Internal server error" and no user input appears in that thread.

## chat-events-attachment-lookups-004

- Vitest: "chat attachment lookup ownership > does not reuse private attachment authorization for a different organization"
- Mode: run
- Given: An entitled member has access to a private attachment and can also authenticate as the same user in another workspace lacking access to that attachment.
- When: The owner first sends the attachment in its original workspace, then submits the same reference on a thread in the other workspace.
- Then: The original Run prompt contains the file ID. The other-workspace send returns HTTP 500 with "Internal server error" and no user input appears.

## chat-events-attachment-lookups-005

- Vitest: "chat attachment lookup ownership > stops refilling and joins four in-flight lookups on failure without publishing input"
- Mode: run
- Given: An entitled member has eight owned attachments and the initial four metadata requests can all be held in flight, with one set to fail.
- When: The member submits the attachments and the initial reads are released.
- Then: No later reads start after the failure. The first four complete, the send returns HTTP 500 with "Internal server error", and no user input becomes visible on the thread.

## chat-events-attachment-lookups-006

- Vitest: "chat attachment lookup ownership > stops refilling and joins four in-flight lookups on cancellation without publishing input"
- Mode: run
- Given: An entitled member has eight owned attachments, and the storage provider holds the first four metadata reads.
- When: The member cancels the send while those reads are outstanding, then releases the provider.
- Then: All four started requests finish and no further reads start. The response is HTTP 500 with "Internal server error" and the thread has no user input.

## chat-events-attachment-lookups-007

- Vitest: "chat attachment lookup ownership > joins later reads already started before a slow first attachment fails"
- Mode: run
- Given: An entitled member has eight owned attachments. The first metadata read is delayed until other reads can start, then fails.
- When: The member sends a message containing all eight attachments and the provider releases the failing first response after all eight have started.
- Then: The send returns HTTP 500 with "Internal server error" and no input appears in the public thread history.
