# composer-draft

## composer-draft-001

- Vitest: "GET/PATCH /api/chat-drafts/composer > returns an empty draft when none is saved"
- Mode: run
- Given: An authenticated workspace member has never saved a composer draft.
- When: The member sends `GET /api/chat-drafts/composer`.
- Then: HTTP 200 returns exactly null draft message and null attachments.

## composer-draft-002

- Vitest: "GET/PATCH /api/chat-drafts/composer > stores and clears the current user's composer draft"
- Mode: run
- Given: An authenticated member has a version-1 draft with a file, a voice clip, text and feedback sourced from a conversation event, an artifact and a sent email.
- When: The member saves the draft and attachment, reads it as an ordinary client, both native clients at 0.60.0 and iOS at 0.61.0, then replaces it with text and finally clears it.
- Then: Each save returns HTTP 204. Ordinary and iOS 0.61.0 reads return the original voice-aware document. Both native 0.60.0 reads preserve other parts but project the voice clip as a file with the same ID, name Voice clip 1 and type audio/*. The first ordinary read retains attachment metadata. Later reads return the replacement text with null attachments and finally null for both fields.

## composer-draft-003

- Vitest: "GET/PATCH /api/chat-drafts/composer > rejects attachments without a message and preserves the saved draft"
- Mode: run
- Given: The signed-in member has a saved text draft without attachments.
- When: The member patches the draft with an attachment and a null message, then reads it again.
- Then: The invalid patch returns HTTP 400. HTTP 200 readback returns the original message and null attachments.

## composer-draft-004

- Vitest: "GET/PATCH /api/chat-drafts/composer > converges concurrent first writes without exposing a conflict"
- Mode: run
- Given: The signed-in member has no existing draft.
- When: Two requests concurrently save different first drafts for the member.
- Then: Both writes return HTTP 204. HTTP 200 readback contains one of the exact submitted documents and null attachments.

## composer-draft-005

- Vitest: "GET/PATCH /api/chat-drafts/composer > does not expose another user's draft on the same workspace"
- Mode: run
- Given: Two different signed-in members belong to one workspace, and the first member has saved a draft.
- When: The second member reads and then saves their own draft. Both members read their drafts afterward.
- Then: The second member initially sees null message and attachments. Their write returns HTTP 204 and subsequent reads each show only the corresponding owner’s draft and null attachments.
