# shared-thread-artifacts

## shared-thread-artifacts-001

- Vitest: "copies only selected artifacts, rewrites the snapshot, and preserves source messages and permissions"
- Mode: run
- Given: A signed-in Pro member uploaded two private files and sent one Thread message linking the first file twice, followed by a separate message linking the second file. Storage serves the copied objects.
- When: The member shares only the first message with `POST /api/chat-threads/:threadId/shared-threads`, anyone reads `GET /api/shared-threads/:id`, the original file then changes, and the snapshot reference is resolved with `GET /api/artifact-references/:reference`.
- Then: The share returns HTTP 201. The shared message contains two identical new `https://app.okou.ai/artifacts/<10 chars>.pdf` links that differ from the original URL and contain no signature; exactly one copy is made from the selected file and none from the unselected one. The resolved URL points at the copy and returns the original bytes. The source Thread events still contain the original URL and not the snapshot link, `POST /api/artifact-shares/status` for the original file reports `private`, and `GET /api/shared-threads/:id/meta` has `cache-control: no-store`.

## shared-thread-artifacts-002

- Vitest: "snapshots a private file referenced by an uppercase UUID in a historical URL"
- Mode: run
- Given: A signed-in Pro member uploaded a private PDF and sent a Thread message containing only the historical URL `https://api.okou.ai/api/web/file-url?file_id=<UPPERCASE UUID>`.
- When: The member shares that message with `POST /api/chat-threads/:threadId/shared-threads` and reads `GET /api/shared-threads/:id`.
- Then: The share returns HTTP 201 and the shared message content is exactly a new `https://app.okou.ai/artifacts/<10 chars>.pdf` snapshot link.

## shared-thread-artifacts-003

- Vitest: "leaves ordinary relative API paths unchanged"
- Mode: run
- Given: A signed-in Pro member sent a Thread message "The client calls /api/users before rendering."
- When: The member shares that message with `POST /api/chat-threads/:threadId/shared-threads` and reads `GET /api/shared-threads/:id`.
- Then: The share returns HTTP 201, the shared message content is unchanged, and no storage copies are made.

## shared-thread-artifacts-004

- Vitest: "preserves existing snapshot links and qualifies hostless ones when sharing them again"
- Mode: run
- Given: A signed-in Pro member shared a Thread message linking a private PDF, producing an absolute snapshot link. The member then sent a new message containing that absolute snapshot link and its hostless path.
- When: The member shares the new message with `POST /api/chat-threads/:threadId/shared-threads`, reads it, deletes the first share with `DELETE /api/shared-threads/:id`, then reads the second share and resolves the first snapshot reference.
- Then: The second share returns HTTP 201 and its message reads as the absolute snapshot link twice; only one storage copy exists overall and the source Thread still contains the original text. Deleting the first share returns HTTP 204, the second share still reads HTTP 200, and the first snapshot reference resolves HTTP 404.

## shared-thread-artifacts-005

- Vitest: "resolves a public snapshot to copied bytes without exposing its private source or management APIs"
- Mode: run
- Given: A signed-in Pro member shared a Thread message linking a private `report.pdf`, producing a snapshot reference. A signed-in user without an organization is an outsider.
- When: Anonymous and outsider callers use `GET /api/artifact-references/:reference`, `GET /api/artifact-references/:reference/download`, `/files` and `/public`; the owner tries kind-scoped resolves; the private source is then deleted, and finally the owner deletes the share with `DELETE /api/shared-threads/:id`.
- Then: Anonymous resolve returns HTTP 200 with `report.pdf`, `application/pdf`, a signed `/thread-shares/<shareId>/` URL, no preview image and `cache-control: private, no-store`. The outsider's download returns HTTP 200 with kind `file` and the resolved download URL, `/files` returns 404 without files or URL, and `/public` returns the same URL with a PDF preview. The original reference returns 401 on resolve and 404 on public; owner resolves with kind `file`, `html` or `artifact` return 404. After the source is deleted the snapshot still serves the original bytes and the same download; after share deletion the download returns 404 without a URL.

## shared-thread-artifacts-006

- Vitest: "copies an uploaded video with independent bytes and the parent revocation"
- Mode: run
- Given: A signed-in Pro member's Run uploaded a private `video.mp4` with the sandbox Okou token, and the member shared a Thread message linking it.
- When: Anyone resolves the snapshot reference with `GET /api/artifact-references/:reference` and `/public`, downloads the signed URL, the source video changes and is deleted, and the owner deletes the share with `DELETE /api/shared-threads/:id`.
- Then: The video appears in the source Thread's artifacts as `video/mp4`. The snapshot download URL uses the private snapshot credential, `attachment; filename*=UTF-8''video.mp4`, `private, no-store` cache control and the share ID in its path; downloading it returns HTTP 200 with that disposition and the original bytes. The public view has a `video/mp4` preview and the same download URL, keeps serving the original bytes after the source changes or is deleted, and the source reference's public URL is 404. After share deletion both resolve and public return HTTP 404.

## shared-thread-artifacts-007

- Vitest: "does not resolve a snapshot when its parent policy is missing"
- Mode: run
- Given: A signed-in Pro member shared a Thread message linking a private PDF, and the snapshot's parent policy object is missing from hosted storage (row `missing`).
- When: Callers use `GET /api/artifact-references/:reference`, `/public`, `GET /api/artifact-og/metadata`, `GET /api/artifact-og/image` and the owner's `GET /api/artifact-references/:reference/download`.
- Then: Resolve, public and download return HTTP 404 with no URL or preview. OG metadata returns HTTP 200 without an image URL and the OG image returns HTTP 302 with `cache-control: private, no-store`.

## shared-thread-artifacts-008

- Vitest: "does not resolve a snapshot when its parent policy is unavailable"
- Mode: run
- Given: A signed-in Pro member shared a Thread message linking a private PDF, and reading the snapshot's parent policy object fails with a storage error (row `unavailable`).
- When: Callers use `GET /api/artifact-references/:reference`, `/public`, `GET /api/artifact-og/metadata`, `GET /api/artifact-og/image` and the owner's `GET /api/artifact-references/:reference/download`.
- Then: Resolve, public, download, OG metadata and OG image all return HTTP 500 with no URL, preview or image URL; the OG image response has `cache-control: private, no-store`.

## shared-thread-artifacts-009

- Vitest: "short organization share references cannot authorize a recipient to publish a thread snapshot"
- Mode: run
- Given: Another member of the same organization owns a private PDF and shares it with the organization through `PUT /api/artifact-shares`. The recipient sends a Thread message linking the organization share's short URL (row `short`).
- When: The recipient shares that message with `POST /api/chat-threads/:threadId/shared-threads`.
- Then: The organization share returns HTTP 200, the Thread share returns HTTP 400, and the recipient's shared-thread artifact catalog for the Thread is empty.

## shared-thread-artifacts-010

- Vitest: "legacy organization share references cannot authorize a recipient to publish a thread snapshot"
- Mode: run
- Given: Another member of the same organization owns a private PDF and shares it with the organization through `PUT /api/artifact-shares`. The recipient sends a Thread message linking the legacy `https://app.okou.ai/artifacts/<shareId>/report.pdf` reference path (row `legacy`).
- When: The recipient shares that message with `POST /api/chat-threads/:threadId/shared-threads`.
- Then: The organization share returns HTTP 200, the Thread share returns HTTP 400, and the recipient's shared-thread artifact catalog for the Thread is empty.

## shared-thread-artifacts-011

- Vitest: "a partial copy failure leaves no usable share and cleans copied private bytes"
- Mode: run
- Given: A signed-in Pro member sent a Thread message linking two uploaded private files, and the second file's bytes are missing from storage.
- When: The member shares that message with `POST /api/chat-threads/:threadId/shared-threads`.
- Then: The share returns HTTP 400. No `/thread-shares/` objects remain, the shared-thread artifact catalog for the Thread is empty, and the first file's original object still exists.

## shared-thread-artifacts-012

- Vitest: "independent thread snapshots use different short references and revoke separately"
- Mode: run
- Given: A signed-in Pro member sent a Thread message linking a private PDF.
- When: The member shares the same message twice with `POST /api/chat-threads/:threadId/shared-threads`, then deletes the first share with `DELETE /api/shared-threads/:id`.
- Then: Both shares return HTTP 201 with different `https://app.okou.ai/artifacts/<10 chars>.pdf` links. After deletion the first share and its reference (resolve and public) return HTTP 404, while the second share still shows its link and its reference resolves HTTP 200 to a URL containing the second share ID.

## shared-thread-artifacts-013

- Vitest: "share owner deletion revokes a snapshot and preserves the private original"
- Mode: run
- Given: A signed-in Pro member shared a Thread message linking a private PDF. Another member of the same organization exists (row `share`).
- When: The other member tries `DELETE /api/shared-threads/:id`, then the owner deletes it with `DELETE /api/shared-threads/:id`.
- Then: The other member receives HTTP 404 and the share still reads HTTP 200. The owner's delete returns HTTP 204; afterwards the share, its meta, and the snapshot reference (resolve and public) return HTTP 404, no `/thread-shares/` objects remain, and the private original object still exists.

## shared-thread-artifacts-014

- Vitest: "catalog owner deletion revokes a snapshot and preserves the private original"
- Mode: run
- Given: A signed-in Pro member shared a Thread message linking a private PDF. Another member of the same organization exists (row `catalog`).
- When: The other member tries `DELETE /api/shared-threads/:id`, then the owner deletes the shared-thread entry from `GET /api/artifacts/catalog` with `DELETE /api/artifacts/catalog/:artifactId`.
- Then: The other member receives HTTP 404 and the share still reads HTTP 200. The catalog delete returns HTTP 200; afterwards the share, its meta, and the snapshot reference (resolve and public) return HTTP 404, no `/thread-shares/` objects remain, and the private original object still exists.

## shared-thread-artifacts-015

- Vitest: "clerk organization deletion preserves published snapshot access and bytes"
- Mode: run
- Given: A signed-in Pro member shared a Thread message linking a private PDF. Stripe lists no subscriptions and a verified Clerk webhook reports `organization.deleted` for the member's organization (row `organization`).
- When: The Clerk webhook posts to `POST /api/webhooks/clerk`, then anyone reads `GET /api/shared-threads/:id`.
- Then: The webhook returns HTTP 200. The share still returns HTTP 200 with exactly the same body as before, and stored objects are unchanged.

## shared-thread-artifacts-016

- Vitest: "clerk user deletion preserves published snapshot access and bytes"
- Mode: run
- Given: A signed-in Pro member shared a Thread message linking a private PDF. Stripe lists no subscriptions and a verified Clerk webhook reports `user.deleted` for the member (row `user`).
- When: The Clerk webhook posts to `POST /api/webhooks/clerk`, then anyone reads `GET /api/shared-threads/:id`.
- Then: The webhook returns HTTP 200. The share still returns HTTP 200 with exactly the same body as before, and stored objects are unchanged.

## shared-thread-artifacts-017

- Vitest: "publication rechecks current ownership after allocating its durable snapshot"
- Mode: run
- Given: A signed-in Pro member sent a Thread message linking a private PDF, and Clerk now reports no organization memberships for the member.
- When: The member shares that message with `POST /api/chat-threads/:threadId/shared-threads`.
- Then: The share returns HTTP 400, no storage copies are made, and the shared-thread artifact catalog for the Thread is empty.

## shared-thread-artifacts-018

- Vitest: "copies while the title is pending and respects the final action: publish"
- Mode: run
- Given: A signed-in Pro member sent a Thread message linking a private PDF, and the title-generation model is held until released (row `publish`).
- When: The member shares the message with a client-chosen ID via `POST /api/chat-threads/:threadId/shared-threads`; while the title is pending and the file has been copied, the share is read, then the title model returns "Shared report".
- Then: While pending, `GET /api/shared-threads/:id` returns 404 and the shared-thread catalog is empty. After release the share returns HTTP 201 with the chosen ID and reads with title "Shared report".

## shared-thread-artifacts-019

- Vitest: "copies while the title is pending and respects the final action: delete"
- Mode: run
- Given: A signed-in Pro member sent a Thread message linking a private PDF, and the title-generation model is held until released (row `delete`).
- When: The member shares the message with a client-chosen ID via `POST /api/chat-threads/:threadId/shared-threads`; while the title is pending and the file has been copied, the member deletes it with `DELETE /api/shared-threads/:id`, then the title model returns.
- Then: While pending, the share reads 404 and the catalog is empty. The delete returns HTTP 204, the create returns HTTP 400, the share still reads 404, and no `/thread-shares/` objects remain.

## shared-thread-artifacts-020

- Vitest: "copies while the title is pending and respects the final action: owner cancellation"
- Mode: run
- Given: A signed-in Pro member sent a Thread message linking a private PDF, and the title-generation model is held until released (row `owner cancellation`).
- When: The member shares the message with a client-chosen ID via `POST /api/chat-threads/:threadId/shared-threads`; while the title is pending and the file has been copied, the caller aborts the request.
- Then: While pending, the share reads 404 and the catalog is empty. The request rejects with the caller's abort reason and no `/thread-shares/` objects remain.

## shared-thread-artifacts-021

- Vitest: "a losing snapshot creator preserves the ordinary share that won its client ID"
- Mode: run
- Given: A signed-in Pro member has one Thread message linking a private PDF and another ordinary text message "Ordinary conversation remains readable". A snapshot share for the PDF message is paused while writing its policy object under a client-chosen ID.
- When: The member creates an ordinary share of the text message with the same ID via `POST /api/chat-threads/:threadId/shared-threads`, then the paused snapshot share resumes.
- Then: The ordinary share returns HTTP 201 and the paused snapshot share returns HTTP 409. `GET /api/shared-threads/:id` returns HTTP 200 with the ordinary message, and its meta returns HTTP 200.

## shared-thread-artifacts-022

- Vitest: "deletes an unpublished snapshot while copying and never republishes its grant"
- Mode: run
- Given: A signed-in Pro member sent a Thread message linking a private PDF, and the snapshot copy of the file is paused.
- When: The member starts sharing it with a client-chosen ID via `POST /api/chat-threads/:threadId/shared-threads`, deletes that ID with `DELETE /api/shared-threads/:id` while the copy is paused, then the copy resumes.
- Then: During the copy the share and its meta return 404. The delete returns HTTP 204 and the create returns HTTP 400. The share and meta still return 404, the shared-thread catalog is empty, and the owner can still resolve the original private file reference with HTTP 200.

## shared-thread-artifacts-023

- Vitest: "drains an in-flight copy before rolling back another copy's failure"
- Mode: run
- Given: A signed-in Pro member sent a Thread message linking two private files. The first snapshot copy is paused and the second copy fails.
- When: The member shares the message with `POST /api/chat-threads/:threadId/shared-threads`, and the first copy is released after the second fails.
- Then: No storage deletion happens while the first copy is still in flight. The share fails with HTTP 500, no `/thread-shares/` objects remain, and the shared-thread catalog is empty.

## shared-thread-artifacts-024

- Vitest: "shares distinct files and reuses a reference for repeated links"
- Mode: run
- Given: A signed-in Pro member sent a Thread message linking file A, file B and file A again.
- When: The member shares the message with `POST /api/chat-threads/:threadId/shared-threads`, reads it, and resolves each link with `GET /api/artifact-references/:reference`.
- Then: The shared message has three links where the first and third are identical and differ from the second. The two distinct references resolve and download with HTTP 200 to "Original generated PDF" and "Another dependency" respectively.

## shared-thread-artifacts-025

- Vitest: "oG uses the published thread snapshot and revokes its old image URL with the parent share"
- Mode: run
- Given: A signed-in Pro member shared a Thread message linking a private PNG `published.png`.
- When: Anyone reads `GET /api/artifact-og/metadata` and `GET /api/artifact-og/image` (default and `slack` variant) for the snapshot reference after the private source is deleted, then the owner deletes the share with `DELETE /api/shared-threads/:id`.
- Then: Metadata is available with title `published.png` and a scale-down image URL pointing at `/api/artifact-og/image` for the reference. The image returns HTTP 302 to a signed 60-second `/thread-shares/<shareId>/…/published.png` URL with `private, no-store, must-revalidate` cache control, and the slack variant redirects to the same path; the original file reference's metadata is `{ available: false }`. After share deletion metadata is `{ available: false }` and the old image URL redirects HTTP 302 to the brand image with `cache-control: private, no-store`.
