# chat-thread-draft-store

## chat-thread-draft-store-001

- Vitest: "thread drafts > saves, replaces and clears the document and its attachments"
- Mode: run
- Given: An authenticated member owns a new thread with no saved draft.
- When: The member saves a text draft with an attachment and suggestion preset, replaces it with text only, and finally clears it.
- Then: Readback and the draft list initially show no draft, then retain the exact document, attachment and preset. Replacement retains only the new text, with null attachments and no preset. Clearing restores an empty draft and removes its thread from the draft list.

## chat-thread-draft-store-002

- Vitest: "thread drafts > round-trips artifact quote snapshots without requiring an attachment"
- Mode: run
- Given: An authenticated thread owner has a feedback quote referring to an artifact through its captured filename.
- When: The owner saves that feedback part as a draft without attaching the artifact itself.
- Then: Readback returns the exact quote, note, artifact source and filename snapshot with null attachments, and the thread is listed as drafted.

## chat-thread-draft-store-003

- Vitest: "thread drafts > saves rich draft edits containing unpaired surrogates"
- Mode: run
- Given: An authenticated owner has a text draft and edits it to include an image and invalid unpaired UTF-16 surrogates alongside valid Unicode and punctuation.
- When: The owner saves and reads the rich draft.
- Then: The saved version replaces the old text and round-trips the image and attachment. Only the unpaired surrogates become Unicode replacement characters.

## chat-thread-draft-store-004

- Vitest: "thread drafts > keeps drafts separate per thread and per user"
- Mode: run
- Given: A workspace member owns two private threads and a second member is in the workspace.
- When: The owner clears one thread and saves text in the other. The second member lists and reads drafts, and the owner reads an unknown thread ID.
- Then: The cleared thread returns null document and attachments. The second member's list omits the saved thread, and reading that thread or the unknown ID returns HTTP 404.

## chat-thread-draft-store-005

- Vitest: "thread drafts > isolates drafts between the same user's workspaces"
- Mode: run
- Given: A member has a saved draft in one workspace and can also sign into another workspace.
- When: Using the other workspace, the member attempts to replace and clear the draft and then lists and reads drafts.
- Then: All three direct accesses return HTTP 404 and the draft is absent from that workspace's list. The owner still reads the original text in the correct workspace.

## chat-thread-draft-store-006

- Vitest: "thread drafts > returns the same miss for another owner's private thread as for a deleted thread"
- Mode: run
- Given: A member owns a private thread with a saved draft, and a peer is in the same workspace.
- When: The peer tries to save new text and then clear the private draft.
- Then: Both mutations return HTTP 404 and the owner still reads their original draft.

## chat-thread-draft-store-007

- Vitest: "thread drafts > preserves installed clients' member drafts and empty responses on the original routes"
- Mode: run
- Given: An owner and a peer use the installed clients' legacy composer draft routes for the same thread.
- When: They save and read independent drafts, and the owner clears theirs through the current thread API. The owner then deletes the thread and issues a late legacy save and clear.
- Then: The owner draft is readable on current and legacy routes and independent of the peer's draft. The legacy owner read becomes empty after clear. The deleted-thread legacy calls continue to succeed with an empty draft on readback.

## chat-thread-draft-store-008

- Vitest: "thread drafts > removes the draft with the thread it belongs to"
- Mode: run
- Given: A thread owner has a saved draft and its thread appears in the draft list.
- When: The owner deletes the thread, attempts to read, save and clear the draft, then lists drafts.
- Then: Direct operations on the deleted thread return HTTP 404. Read and late save return `CHAT_THREAD_NOT_FOUND`. The deleted thread no longer appears in the list.

## chat-thread-draft-store-009

- Vitest: "sends and drafts > publishes a rich send containing unpaired surrogates"
- Mode: run
- Given: An authenticated owner has an uploaded image and a structured message containing valid Unicode and unpaired surrogates.
- When: The owner sends the rich message with a client event ID and reads that event.
- Then: The send returns HTTP 201. The stored prompt event keeps the image and replaces the unpaired surrogates in its text with replacement characters.

## chat-thread-draft-store-010

- Vitest: "sends and drafts > leaves the saved draft for the client to clear when a message is sent"
- Mode: run
- Given: An authenticated member has a saved draft with text and an attachment.
- When: The member sends a Chat message and reads the draft, then explicitly clears the draft.
- Then: Message acceptance returns HTTP 201 and the saved draft text remains readable. The separate clear returns the draft to empty and removes the thread from the draft list.
