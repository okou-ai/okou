# project-reference-validation

## project-reference-validation-001

- Vitest: "project reference admission through chat send > admits ordinary chat messages without Project references"
- Mode: run
- Given: A signed-in member entitled to native chat has created a Project and a conversation bound to it.
- When: The member sends a plain chat message with `POST /api/chat/events` in that conversation, containing no Project references, and the Run's execution input is read.
- Then: The Run's prompt is exactly `No project references`, and the execution's system prompt contains `Current Project: "The conversation's Project" (PROJECT_ID=<id>)`.

## project-reference-validation-002

- Vitest: "project reference admission through chat send > preserves multiple, repeated and mixed-case references in ordinary parts and feedback notes"
- Mode: run
- Given: A signed-in member entitled to native chat owns Projects `Research` and `Launch`.
- When: The member sends `POST /api/chat/events` with a structured message containing repeated and upper-case Project mentions in ordinary parts and inside a feedback note.
- Then: The stored `input.prompt` event keeps the exact structured message. The Run prompt renders each mention in order as Markdown links `[name](/projects/<id>)` using the captured names and the IDs' original case, for both the ordinary parts and the feedback note.

## project-reference-validation-003

- Vitest: "project reference admission through chat send > uses the Project name captured before attachment verification"
- Mode: run
- Given: A signed-in member entitled to native chat has a Project named `Research at send`, a conversation bound to it, and an uploaded text attachment. The Project is renamed to `Research during verification` while the attachment is being verified.
- When: The member sends `POST /api/chat/events` mentioning the Project and attaching the file, and the Run's execution input is read.
- Then: The system prompt uses `current name="Research at send"` and `Current Project: "Research at send"`. Reading the Project afterwards shows the new name `Research during verification`.

## project-reference-validation-004

- Vitest: "project reference admission through chat send > stops attachment preparation when rejecting an unavailable Project"
- Mode: run
- Given: A signed-in member entitled to native chat has a conversation. The message references a Project that does not exist and attaches a file whose storage check is slow.
- When: The member sends `POST /api/chat/events` with the missing Project mention and the attachment.
- Then: The request returns HTTP 404 with code `NOT_FOUND`. The attachment's storage prefix is never listed, and no event with the client event ID appears in the conversation.

## project-reference-validation-005

- Vitest: "project reference admission through chat send > uses current Project names and missing references when a queued input launches"
- Mode: run
- Given: The concurrent Run limit is 1. A signed-in member has a conversation bound to Project `Bound before pick` that is busy with a Run, and a queued input mentions `Deleted before pick` and, in a feedback note, `Linked before pick` (upper-cased ID). Before the queued input starts, the bound and linked Projects are renamed and the mentioned Project is deleted.
- When: The busy Run completes, the queued input launches its Run, and the Run's execution input is read.
- Then: The system prompt contains `Current Project: "Bound at pick"`, `current name="Linked at pick"`, and `Mentioned Project "Deleted link" (<id>) is unavailable.`

## project-reference-validation-006

- Vitest: "project reference admission through chat send > rejects a mixed valid/missing batch from ordinary without publishing an input"
- Mode: run
- Given: A signed-in member entitled to native chat owns one Project and has a conversation. The message's ordinary parts mention that Project and a nonexistent Project.
- When: The member sends `POST /api/chat/events`.
- Then: The request returns HTTP 404 with code `NOT_FOUND` and message `Project or conversation not found`, and the conversation's events are unchanged.

## project-reference-validation-007

- Vitest: "project reference admission through chat send > rejects a mixed valid/missing batch from feedback without publishing an input"
- Mode: run
- Given: A signed-in member entitled to native chat owns one Project and has a conversation. A feedback note mentions that Project and a nonexistent Project.
- When: The member sends `POST /api/chat/events`.
- Then: The request returns HTTP 404 with code `NOT_FOUND` and message `Project or conversation not found`, and the conversation's events are unchanged.

## project-reference-validation-008

- Vitest: "project reference admission through chat send > rejects a batch containing a foreign user project without leaking its existence"
- Mode: run
- Given: A signed-in member owns a Project, and another user in the same organization owns a different Project.
- When: The member sends `POST /api/chat/events` mentioning both Projects.
- Then: The request returns HTTP 404 with code `NOT_FOUND` and message `Project or conversation not found`.

## project-reference-validation-009

- Vitest: "project reference admission through chat send > rejects a batch containing a foreign organization project without leaking its existence"
- Mode: run
- Given: A signed-in member owns a Project, and the same user owns a different Project in another organization.
- When: The member sends `POST /api/chat/events` mentioning both Projects.
- Then: The request returns HTTP 404 with code `NOT_FOUND` and message `Project or conversation not found`.

## project-reference-validation-010

- Vitest: "project reference admission through chat send > retains request validation for malformed reference IDs"
- Mode: run
- Given: A signed-in user exists.
- When: The user sends `POST /api/chat/events` with a Project mention whose ID is `not-a-uuid`.
- Then: The request returns HTTP 400.

## project-reference-validation-011

- Vitest: "project reference admission through chat send > does not enqueue references for an already aborted application owner"
- Mode: run
- Given: A signed-in member entitled to native chat owns a Project and a conversation, and the application is already shutting down when the request arrives.
- When: The member sends `POST /api/chat/events` mentioning the Project.
- Then: The response is HTTP 500 with body `{ error: "Internal server error" }`, and the conversation has no events.

## project-reference-validation-012

- Vitest: "project reference admission through chat send > keeps the captured input or rejects admission when a referenced project is deleted concurrently"
- Mode: run
- Given: A signed-in member entitled to native chat owns a Project and a conversation.
- When: The member sends `POST /api/chat/events` mentioning the Project twice while concurrently deleting the Project via `DELETE /api/projects/:id`.
- Then: The deletion returns HTTP 204. If the send returns 201, the stored input keeps the exact structured message; if it returns 404, no input is stored and the error is `NOT_FOUND` with message `Project or conversation not found`. Reading the Project afterwards returns 404.
