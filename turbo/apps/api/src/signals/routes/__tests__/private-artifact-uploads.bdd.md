# private-artifact-uploads

## private-artifact-uploads-001

- Vitest: "private artifact uploads > cancels private completion during storage verification and permits a fresh replay"
- Mode: run
- Given: A signed-in workspace member has prepared an `artifact`-purpose upload for `report.html` and the private bytes are stored. Storage verification of the object is slow.
- When: The member sends `POST /api/uploads/complete` and the request is cancelled while storage verification is in progress; the member lists `GET /api/artifacts/catalog`, then replays the completion.
- Then: The cancelled completion ends with an abort error and the catalog stays empty. The replayed completion returns HTTP 200 and the catalog then contains one `file` artifact titled `report.html`.

## private-artifact-uploads-002

- Vitest: "private artifact uploads > keeps one downloadable catalog artifact after concurrent completion and replay"
- Mode: run
- Given: A signed-in workspace member has prepared an `artifact`-purpose upload for a 13-byte `report.html` and the private bytes are stored.
- When: The member sends two concurrent `POST /api/uploads/complete` requests, lists the catalog, replays the completion, lists again, reads `GET /api/artifacts/catalog/:artifactId`, and requests `GET /api/web/file-url`.
- Then: Both completions return HTTP 200 with the same file ID, URL and size 13. The catalog contains exactly one `file` artifact, and after replay it is still the same artifact with the same creation time. The detail shows the file's ID, URL and size, and the file URL returns an HTTPS download URL.

## private-artifact-uploads-003

- Vitest: "private artifact uploads > publishes only verified private bytes after a missing storage response and replay"
- Mode: run
- Given: A signed-in workspace member has prepared an `artifact`-purpose upload, and private storage reports the object as not found.
- When: The member sends `POST /api/uploads/complete`, lists the catalog, then retries after the bytes are stored.
- Then: The first completion returns HTTP 404 and the catalog stays empty. The retried completion returns HTTP 200 and the catalog contains one `file` artifact titled `report.html`.

## private-artifact-uploads-004

- Vitest: "private artifact uploads > publishes only verified private bytes after a unknown-size storage response and replay"
- Mode: run
- Given: A signed-in workspace member has prepared an `artifact`-purpose upload, and private storage returns object metadata without a size.
- When: The member sends `POST /api/uploads/complete`, lists the catalog, then retries after the bytes are stored.
- Then: The first completion returns HTTP 500 and the catalog stays empty. The retried completion returns HTTP 200 and the catalog contains one `file` artifact titled `report.html`.

## private-artifact-uploads-005

- Vitest: "private artifact uploads > keeps a guarded upload private through completion"
- Mode: run
- Given: A signed-in workspace member uses the guarded private upload flow.
- When: The member calls `POST /api/uploads/prepare/private`, uploads bytes to the returned upload URL, sends `POST /api/uploads/complete`, and requests `GET /api/web/file-url`.
- Then: Preparation returns a stable `/artifacts/<10 chars>.html` URL, completion returns the same URL, and the file URL response has `publicUrl` null.

## private-artifact-uploads-006

- Vitest: "private artifact uploads > keeps organization-less public uploads readable"
- Mode: run
- Given: A signed-in user without an organization prepares an ordinary upload.
- When: The user calls `POST /api/uploads/prepare`, uploads the bytes, completes with `POST /api/uploads/complete`, and requests `GET /api/web/file-url`.
- Then: All requests succeed and the file URL response's `publicUrl` equals the URL returned at preparation.

## private-artifact-uploads-007

- Vitest: "private artifact uploads > previews private bytes uploaded by an older composer without a complete request"
- Mode: run
- Given: A signed-in workspace member prepared an upload and stored the private bytes but never called the complete endpoint, as an older composer does.
- When: The member resolves the stable reference with `GET /api/artifact-references/:reference`.
- Then: The request returns HTTP 200 with a signed URL that was signed for the private artifacts bucket.

## private-artifact-uploads-008

- Vitest: "private artifact uploads > makes attachments and outputs private by default"
- Mode: run
- Given: A signed-in workspace member prepares uploads.
- When: The member calls `POST /api/uploads/prepare` for a PNG attachment and for an `artifact`-purpose HTML file sent from the app origin.
- Then: Both return HTTP 200 with stable private `/artifacts/<10 chars>` URLs ending in `.png` and `.html` respectively.

## private-artifact-uploads-009

- Vitest: "private artifact uploads > returns stable owner references and signed private download URLs"
- Mode: run
- Given: A signed-in workspace member prepares a `report.html` upload from the app origin and the bytes are stored privately.
- When: The member completes it, requests `GET /api/web/file-url` at a fixed time, resolves `GET /api/artifact-references/:reference`, requests the file URL again, and again close to expiry.
- Then: Preparation returns an upload URL signed for 172,800 seconds for `private-artifacts/<id>/report.html` in the private bucket, and completion returns exactly id, URL, filename, content type and size 13. The file URL returns a signed URL with null `publicUrl` and `previewImageUrl`, an expiry two days after the second-rounded time, and `cache-control: private, no-store`, signed with a private immutable cache header. The reference resolves to the same URL; a repeat request keeps the cached URL and expiry with a new download URL, and near expiry it returns a fresh URL with a new two-day expiry.

## private-artifact-uploads-010

- Vitest: "private artifact uploads > enforces owner and organization for complete and multipart operations"
- Mode: run
- Given: A signed-in member has prepared and completed a private upload; other callers are a different user in the same organization, the same user in another organization, the same user without an organization, and an unauthenticated caller.
- When: Each other caller requests `GET /api/web/file-url`, `POST /api/uploads/complete`, `POST /api/uploads/multipart/complete` and `POST /api/uploads/multipart/abort` for that file.
- Then: The owner's file URL has `publicUrl` null and completion returns the prepared URL. The other user and other organization get HTTP 404 (code `NOT_FOUND`) for the file URL and 404 for complete, multipart complete and multipart abort. The organization-less session gets 404 for the file URL and the unauthenticated caller gets 401.

## private-artifact-uploads-011

- Vitest: "private artifact uploads > does not consult public storage when a private object is missing"
- Mode: run
- Given: A signed-in member has prepared a private upload and private storage reports the object as missing.
- When: The member requests `GET /api/web/file-url` for the file.
- Then: The request returns HTTP 404 with code `NOT_FOUND`, and only the private object is checked; no other storage request is made.

## private-artifact-uploads-012

- Vitest: "private artifact uploads > keeps private multipart completion unavailable for NoSuchUpload without publishing it"
- Mode: run
- Given: A signed-in member has prepared a multipart `artifact`-purpose upload, and listing its parts fails with a `NoSuchUpload` storage error (HTTP 404).
- When: The member sends `POST /api/uploads/multipart/complete` and then lists the catalog.
- Then: Completion returns HTTP 404 and the catalog is empty.

## private-artifact-uploads-013

- Vitest: "private artifact uploads > keeps private multipart completion unavailable for ProviderNotFound without publishing it"
- Mode: run
- Given: A signed-in member has prepared a multipart `artifact`-purpose upload, and listing its parts fails with a `ProviderNotFound` storage error (HTTP 404).
- When: The member sends `POST /api/uploads/multipart/complete` and then lists the catalog.
- Then: Completion returns HTTP 404 and the catalog is empty.

## private-artifact-uploads-014

- Vitest: "private artifact uploads > keeps private multipart completion unavailable for ServiceUnavailable without publishing it"
- Mode: run
- Given: A signed-in member has prepared a multipart `artifact`-purpose upload, and listing its parts fails with a `ServiceUnavailable` storage error (HTTP 503).
- When: The member sends `POST /api/uploads/multipart/complete` and then lists the catalog.
- Then: Completion returns HTTP 500 and the catalog is empty.

## private-artifact-uploads-015

- Vitest: "private artifact uploads > complete multipart uploads in their recorded bucket"
- Mode: run
- Given: A signed-in member prepares a 6 MiB multipart upload, which storage creates in the private artifacts bucket.
- When: The member sends `POST /api/uploads/multipart/complete` with both parts.
- Then: Preparation returns upload ID `upload-1` with parts 1 and 2. Completion returns HTTP 200 with the prepared URL, every storage operation targets `private-artifacts/<id>/report.html` in the private bucket, and exactly one multipart complete is performed.

## private-artifact-uploads-016

- Vitest: "private artifact uploads > abort multipart uploads in their recorded bucket"
- Mode: run
- Given: A signed-in member prepares a 6 MiB multipart upload, which storage creates in the private artifacts bucket.
- When: The member sends `POST /api/uploads/multipart/abort`.
- Then: Preparation returns upload ID `upload-1` with parts 1 and 2. Abort returns HTTP 200 with the file ID, every storage operation targets `private-artifacts/<id>/report.html` in the private bucket, and exactly one multipart abort is performed.

## private-artifact-uploads-017

- Vitest: "private artifact uploads > fails visibly when private storage credentials are absent"
- Mode: run
- Given: A signed-in member prepares an upload while the private artifact storage access key is not configured.
- When: The member calls `POST /api/uploads/prepare`.
- Then: The request returns HTTP 500 and the body contains no `url`.
