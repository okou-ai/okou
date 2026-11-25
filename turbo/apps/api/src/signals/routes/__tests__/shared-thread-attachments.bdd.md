# shared-thread-attachments

## shared-thread-attachments-001

- Vitest: "publishes independent public attachment bytes"
- Mode: run
- Given: A signed-in Pro member uploaded a public `dashboard.png` and a public `brief.pdf` and sent a Thread message with both attachments and the text "Build this dashboard".
- When: The member shares that message with `POST /api/chat-threads/:threadId/shared-threads`, anyone reads `GET /api/shared-threads/:id` and downloads each attachment, and the original image upload is then removed.
- Then: The share returns HTTP 201. The shared conversation has one message with content "Build this dashboard" and exactly two attachments, each with filename, content type, byte size and a URL `https://a.okou.io/shared-threads/<shareId>/<uuid>-<filename>` that serves the original bytes. After the original image is removed, its shared copy still serves "original image bytes".

## shared-thread-attachments-002

- Vitest: "sends private attachments and shares independent private snapshots"
- Mode: run
- Given: A signed-in Pro member uploaded a private `private.pdf` and sent a Thread message attaching it twice.
- When: The member shares that message with `POST /api/chat-threads/:threadId/shared-threads`, reads `GET /api/shared-threads/:id`, checks the source with `GET /api/web/file-url`, and the original upload is then removed.
- Then: The share returns HTTP 201 with two attachments that share one `https://app.okou.ai/artifacts/<10 chars>.pdf` URL which resolves to "private bytes". The source file's `publicUrl` stays null, and the snapshot still serves "private bytes" after the original is removed.

## shared-thread-attachments-003

- Vitest: "rejects publication when a private attachment is withdrawn during its snapshot copy"
- Mode: run
- Given: A signed-in Pro member uploaded a private artifact file `withdrawn-attachment.pdf`, sent it as a Thread attachment, and the snapshot copy of it is paused.
- When: The member shares the message with `POST /api/chat-threads/:threadId/shared-threads` and, while the copy is paused, deletes the file with `DELETE /api/artifacts/catalog/:artifactId`.
- Then: The catalog delete returns HTTP 200 and the share returns HTTP 400 with "A selected artifact or hosted dependency is unavailable for sharing". The Thread has no shared-thread catalog entry.

## shared-thread-attachments-004

- Vitest: "shares attachment-only prompts and reuses a copy for repeated references"
- Mode: run
- Given: A signed-in Pro member uploaded a private `reference.png` and sent a Thread message with only that image attached twice.
- When: The member shares the message with `POST /api/chat-threads/:threadId/shared-threads` and reads `GET /api/shared-threads/:id`.
- Then: The share returns HTTP 201. The shared conversation has one message with empty content and two attachments with the same URL.

## shared-thread-attachments-005

- Vitest: "publishes the annotated image without exposing its original"
- Mode: run
- Given: A signed-in Pro member uploaded a private `screen.png` and an annotated `screen.annotated.png`, and sent a Thread message attaching the original with the annotated file and a redaction mark.
- When: The member shares the message with `POST /api/chat-threads/:threadId/shared-threads`, reads `GET /api/shared-threads/:id` and resolves the attachment.
- Then: The share returns HTTP 201 with exactly one attachment: filename `screen.annotated.png`, `image/png`, the annotated byte size, and an `https://app.okou.ai/artifacts/<10 chars>.png` URL that serves "annotated image".

## shared-thread-attachments-006

- Vitest: "rejects sharing on missing source without publishing a partial conversation"
- Mode: run
- Given: A signed-in Pro member sent a Thread message attaching a private `brief.pdf` with the text "Read the brief", and the uploaded file's bytes are then removed from storage (row `missing source`).
- When: The member shares the message with `POST /api/chat-threads/:threadId/shared-threads`.
- Then: The request fails with HTTP 500 and the Thread has no shared-thread catalog entry.

## shared-thread-attachments-007

- Vitest: "rejects sharing on copy failure without publishing a partial conversation"
- Mode: run
- Given: A signed-in Pro member sent a Thread message attaching a private `brief.pdf` with the text "Read the brief", and storage rejects object copies (row `copy failure`).
- When: The member shares the message with `POST /api/chat-threads/:threadId/shared-threads`.
- Then: The request fails with HTTP 500 and the Thread has no shared-thread catalog entry.

## shared-thread-attachments-008

- Vitest: "a visibility-managed share protects copies of private attachments"
- Mode: run
- Given: A signed-in Pro member sent a Thread message attaching a private `confidential.pdf` (row `private`). Another Pro user from a different workspace exists.
- When: The member creates a private share with `POST /api/chat-threads/:threadId/shared-threads/visibility`, the attachment reference is accessed by anonymous, owner and stranger callers, and the owner switches visibility with `PUT /api/shared-threads/:id/visibility` to `public` and back to `private`.
- Then: The create returns HTTP 201. While private, anonymous `GET /api/artifact-references/:reference/public` returns 404, the owner's resolve returns 200 with the attachment bytes and download returns 200, and the stranger's resolve and download return 404. After switching to public (HTTP 200) the public URL serves the bytes; after switching back to private (HTTP 200) the public URL returns 404.

## shared-thread-attachments-009

- Vitest: "a visibility-managed share protects copies of public attachments"
- Mode: run
- Given: A signed-in Pro member sent a Thread message attaching a public `confidential.pdf` (row `public`). Another Pro user from a different workspace exists.
- When: The member creates a private share with `POST /api/chat-threads/:threadId/shared-threads/visibility`, the attachment reference is accessed by anonymous, owner and stranger callers, and the owner switches visibility with `PUT /api/shared-threads/:id/visibility` to `public` and back to `private`.
- Then: The create returns HTTP 201. While private, anonymous `GET /api/artifact-references/:reference/public` returns 404, the owner's resolve returns 200 with the attachment bytes and download returns 200, and the stranger's resolve and download return 404. After switching to public (HTTP 200) the public URL serves the bytes; after switching back to private (HTTP 200) the public URL returns 404.

## shared-thread-attachments-010

- Vitest: "asks for a new share before restricting legacy public attachment copies on https://a.okou.io"
- Mode: run
- Given: The public artifacts base URL is `https://a.okou.io`. A signed-in Pro member sent a Thread message attaching a public `legacy.pdf` and shared it with `POST /api/chat-threads/:threadId/shared-threads`, so the attachment copy lives on that base URL.
- When: The member calls `PUT /api/shared-threads/:id/visibility` with the uppercase share ID for audience `private` and then `organization`, then anyone reads `GET /api/shared-threads/:id`.
- Then: The attachment URL origin is `https://a.okou.io`. Both visibility updates return HTTP 400 with a message containing "Create a new share", and the shared conversation is unchanged.

## shared-thread-attachments-011

- Vitest: "asks for a new share before restricting legacy public attachment copies on https://cdn.okou.io"
- Mode: run
- Given: The public artifacts base URL is `https://cdn.okou.io`. A signed-in Pro member sent a Thread message attaching a public `legacy.pdf` and shared it with `POST /api/chat-threads/:threadId/shared-threads`, so the attachment copy lives on that base URL.
- When: The member calls `PUT /api/shared-threads/:id/visibility` with the uppercase share ID for audience `private` and then `organization`, then anyone reads `GET /api/shared-threads/:id`.
- Then: The attachment URL origin is `https://cdn.okou.io`. Both visibility updates return HTTP 400 with a message containing "Create a new share", and the shared conversation is unchanged.

## shared-thread-attachments-012

- Vitest: "asks for a new share before restricting legacy public attachment copies on https://cdn.vm7.io"
- Mode: run
- Given: The public artifacts base URL is `https://cdn.vm7.io`. A signed-in Pro member sent a Thread message attaching a public `legacy.pdf` and shared it with `POST /api/chat-threads/:threadId/shared-threads`, so the attachment copy lives on that base URL.
- When: The member calls `PUT /api/shared-threads/:id/visibility` with the uppercase share ID for audience `private` and then `organization`, then anyone reads `GET /api/shared-threads/:id`.
- Then: The attachment URL origin is `https://cdn.vm7.io`. Both visibility updates return HTTP 400 with a message containing "Create a new share", and the shared conversation is unchanged.
