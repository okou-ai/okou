# user-template-publish

## user-template-publish-001

- Vitest: "POST /api/user-templates > publishes a compiled reverse run as a private template"
- Mode: run
- Given: A signed-in workspace admin has uploaded, through chat file uploads, a `brand-system.pptx` source, two PNG page images and a presentation guidance package containing `SKILL.md` and `design-system.md`.
- When: The admin calls `POST /api/user-templates` with title "Brand system", kind `presentation`, the source, the two pages and the package.
- Then: The response is HTTP 200 with title "Brand system", kind `presentation`, source filename `brand-system.pptx`, page count 2, visibility `private`, the caller as owner and `canManage: true`. Storage holds a bundle object under `bundles/v1/<sha256>.tar.gz`.

## user-template-publish-002

- Vitest: "POST /api/user-templates > renames a private template and preserves its cover and ownership"
- Mode: run
- Given: A signed-in workspace admin named Mina Okafor has published a private two-page presentation template.
- When: The owner calls `PATCH /api/user-templates/:templateId` with title "Renamed brand", then lists `GET /api/user-templates`.
- Then: The update returns HTTP 200 with the same ID, the new title, visibility `private`, the owner's ID and display name "Mina Okafor", `canManage: true`, unchanged source filename, page count 2, `coverHasMorePages: true`, the original `createdAt`, an `updatedAt` no earlier than before, and a cover URL signing the same stored object. A realtime notification goes to `user:<ownerId>` and not to `org:<orgId>`. The first listed entry matches the updated template.

## user-template-publish-003

- Vitest: "POST /api/user-templates > retracts a shared template and its preview handles from colleagues"
- Mode: run
- Given: A signed-in workspace admin has published a presentation template and shared it with `visibility: "organization"`. A colleague in the same workspace lists templates and obtains the template's two preview asset IDs.
- When: The owner renames it to "Shared edit" via `PATCH /api/user-templates/:templateId`, then sets `visibility: "private"`; the colleague then lists `GET /api/user-templates`, reads `GET /api/user-templates/:templateId` and resolves the preview IDs via `POST /api/user-templates/preview-urls`.
- Then: The colleague initially sees two preview assets. The shared rename notifies `org:<orgId>`. The retraction returns HTTP 200 with title "Shared edit" and visibility `private`, notifies `org:<orgId>` (not `user:<ownerId>`) and publishes `presentationTemplatesChanged`. Afterwards the colleague's list is empty, the detail returns HTTP 404, and preview resolution returns HTTP 200 with no assets.

## user-template-publish-004

- Vitest: "POST /api/user-templates > rejects cross-organization edits without changing the template"
- Mode: run
- Given: A signed-in admin has published a private presentation template. An admin of another workspace exists.
- When: The outsider calls `PATCH /api/user-templates/:templateId` with title "Cross-organization edit"; the owner then reads `GET /api/user-templates/:templateId`.
- Then: The outsider receives HTTP 404 with code `NOT_FOUND` and message "User template not found: <id>". The owner reads HTTP 200 with the template exactly as published.

## user-template-publish-005

- Vitest: "POST /api/user-templates > notifies the readers on both sides of overlapping visibility edits"
- Mode: run
- Given: A signed-in admin has published a private presentation template.
- When: The owner concurrently sends two `PATCH /api/user-templates/:templateId` requests, one with title "Shared edit" and `visibility: "organization"` and one with title "Private edit" and `visibility: "private"`, then reads the template.
- Then: Both edits return HTTP 200; the current title and visibility match one of the edit responses and `updatedAt` is no earlier than either edit. The realtime channels notified are `org:<orgId>` twice when the final state is private, or `org:<orgId>` and `user:<ownerId>` when the final state is shared.

## user-template-publish-006

- Vitest: "POST /api/user-templates > accepts a pdf source, which the import picker already offers"
- Mode: run
- Given: A signed-in admin has uploaded page images, a presentation package and a `brand-system.pdf` source with content type `application/pdf`.
- When: The admin calls `POST /api/user-templates` for a presentation using the PDF as the source.
- Then: The response is HTTP 200 with source filename `brand-system.pdf`.

## user-template-publish-007

- Vitest: "POST /api/user-templates > publishes a document template without page images"
- Mode: run
- Given: A signed-in admin has uploaded a `brand-report.docx` source and a document package containing `SKILL.md` and `reference.docx` (no `design-system.md`).
- When: The admin calls `POST /api/user-templates` with kind `document` and no page images or cover, then lists `GET /api/user-templates` and reads `GET /api/user-templates/:templateId`.
- Then: Publish returns HTTP 200 with kind `document`, source filename `brand-report.docx`, null page count, null cover URL and `coverHasMorePages: false`. The list has one entry with no preview assets. The detail has no page URLs and its source URL signs the stored `.docx` object.

## user-template-publish-008

- Vitest: "POST /api/user-templates > covers a document with its first page without calling it a page"
- Mode: run
- Given: A signed-in admin has uploaded a document source, a document package and a PNG cover image of the first page.
- When: The admin calls `POST /api/user-templates` with kind `document`, the cover and `pageCount: 12`, then reads `GET /api/user-templates/:templateId`.
- Then: Publish returns HTTP 200 with kind `document`, `coverHasMorePages: true`, null page count and a non-null cover URL. The detail has no page URLs and exactly one preview asset.

## user-template-publish-009

- Vitest: "POST /api/user-templates > leaves a one-page document nothing to stack behind its cover"
- Mode: run
- Given: A signed-in admin has uploaded a document source, a document package and a PNG cover image.
- When: The admin calls `POST /api/user-templates` with kind `document`, the cover and `pageCount: 1`.
- Then: The response is HTTP 200 with a non-null cover URL and `coverHasMorePages: false`.

## user-template-publish-010

- Vitest: "POST /api/user-templates > keeps a page count that arrived without a cover from claiming one"
- Mode: run
- Given: A signed-in admin has uploaded a document source and a document package, but no cover image.
- When: The admin calls `POST /api/user-templates` with kind `document` and `pageCount: 12`.
- Then: The response is HTTP 200 with a null cover URL and `coverHasMorePages: false`.

## user-template-publish-011

- Vitest: "POST /api/user-templates > refuses a cover the catalog could not paint"
- Mode: run
- Given: A signed-in admin has uploaded a document source, a document package and a cover image of type `image/webp`.
- When: The admin calls `POST /api/user-templates` with kind `document`, the WebP cover and `pageCount: 12`.
- Then: The response is HTTP 400 and the error message mentions `image/png`.

## user-template-publish-012

- Vitest: "POST /api/user-templates > covers an illustration with its approved examples, not its source"
- Mode: run
- Given: A signed-in admin has uploaded a PNG reference image, two PNG example images (`ref-agenda.png`, `ref-approval.png`) and an illustration package containing `SKILL.md` and an example reference image.
- When: The admin calls `POST /api/user-templates` with kind `illustration`, the reference as source and both examples, then lists templates, resolves the listed preview IDs via `POST /api/user-templates/preview-urls`, and reads `GET /api/user-templates/:templateId`.
- Then: Publish returns HTTP 200 whose cover URL serves the first example's bytes. The list's preview assets serve the first and then the second example, and re-resolving them returns two assets. The detail has no page URLs, two preview assets, and a source URL serving the reference image bytes.

## user-template-publish-013

- Vitest: "POST /api/user-templates > refuses an example the catalog could not paint"
- Mode: run
- Given: A signed-in admin has uploaded a PNG reference image, a GIF example image and an illustration package.
- When: The admin calls `POST /api/user-templates` with kind `illustration` and the GIF as its only example, then lists templates.
- Then: Publish returns HTTP 400 with message "Example 1 must be a image/png", and the template list is empty.

## user-template-publish-014

- Vitest: "POST /api/user-templates > refuses a source the kind it was published as cannot be shown as"
- Mode: run
- Given: A signed-in admin has uploaded a `.docx` source, a PNG example and an illustration package.
- When: The admin calls `POST /api/user-templates` with kind `illustration`, the `.docx` as source and the PNG example.
- Then: The response is HTTP 400 and the error message mentions `illustration`.

## user-template-publish-015

- Vitest: "POST /api/user-templates > takes a document package that carries its skill and nothing else"
- Mode: run
- Given: A signed-in admin has uploaded a `.docx` source and a package containing only `SKILL.md`.
- When: The admin calls `POST /api/user-templates` with kind `document`.
- Then: The response is HTTP 200 with kind `document`.

## user-template-publish-016

- Vitest: "POST /api/user-templates > replaces a template's package without touching anything else"
- Mode: run
- Given: A signed-in admin has published a presentation template and uploaded a rebuilt package with revised `SKILL.md` and `design-system.md`.
- When: The admin calls `PUT /api/user-templates/:templateId/package` with the rebuilt package.
- Then: The response is HTTP 200 with the same ID, title, kind, source filename, page count and visibility as the published template.

## user-template-publish-017

- Vitest: "POST /api/user-templates > returns a conflict if the owner is deleted during bundle publication"
- Mode: run
- Given: A signed-in admin has published a presentation template and uploaded a replacement package. While storage writes the replacement bundle, the owner deletes the template via `DELETE /api/user-templates/:templateId` before the write completes.
- When: The admin calls `PUT /api/user-templates/:templateId/package`, and after it finishes calls it again with the same package.
- Then: The in-flight deletion returns HTTP 204, the replacement returns HTTP 409, and the second replacement returns HTTP 404.

## user-template-publish-018

- Vitest: "POST /api/user-templates > replaces the stored package rather than adding to it"
- Mode: run
- Given: A Pro-entitled member with a configured Runner group and personal model `claude-fable-5-1` has published a presentation template whose package has `SKILL.md`, `design-system.md` and `swatches.md`.
- When: The member sends a chat run selecting the custom template and inspects the run's execution input, cancels it, replaces the package via `PUT /api/user-templates/:templateId/package` with only `SKILL.md` and `design-system.md`, and sends another chat run with the template.
- Then: Each execution's system prompt mentions `okou host screenshot` and `previewImageUrl`, and its first template bundle is a `user-template` bundle for this template. The first run's bundle contains exactly the three original files; after the replacement returns HTTP 200, the next run's bundle contains exactly the two new files. Each run cancellation returns HTTP 200.

## user-template-publish-019

- Vitest: "POST /api/user-templates > applies the row's kind to the replacement, not the caller's"
- Mode: run
- Given: A signed-in admin has published a presentation template and uploaded a document-shaped package (`SKILL.md` and `reference.docx`).
- When: The admin calls `PUT /api/user-templates/:templateId/package` with the document-shaped package.
- Then: The response is HTTP 400 and the error message mentions `design-system.md`.

## user-template-publish-020

- Vitest: "POST /api/user-templates > hides a colleague's template from a package replacement"
- Mode: run
- Given: A signed-in admin has published a presentation template and shared it with the organization. A colleague in the same workspace has uploaded a presentation package.
- When: The colleague calls `PUT /api/user-templates/:templateId/package` with their package.
- Then: The response is HTTP 404 with message "User template not found: <id>".

## user-template-publish-021

- Vitest: "POST /api/user-templates > leaves every change to the owner, not to everyone who can see it"
- Mode: run
- Given: A signed-in admin has published a presentation template and shared it with the organization. A colleague in the same workspace can read it via `GET /api/user-templates/:templateId` (HTTP 200).
- When: The colleague sends `PATCH /api/user-templates/:templateId` with `visibility: "private"`, then with title "Renamed by someone else", then `DELETE /api/user-templates/:templateId`, and reads the template again.
- Then: All three changes return HTTP 404. The final read returns HTTP 200 with the original title and visibility `organization`.

## user-template-publish-022

- Vitest: "POST /api/user-templates > rejects a package that is missing its required guidance"
- Mode: run
- Given: A signed-in admin has uploaded a presentation source, page images and a package containing only `SKILL.md`.
- When: The admin calls `POST /api/user-templates` with kind `presentation`.
- Then: The response is HTTP 400 and the error message mentions `design-system.md`.

## user-template-publish-023

- Vitest: "POST /api/user-templates > keeps a private template out of a colleague's catalog"
- Mode: run
- Given: A signed-in admin has published a private presentation template. A colleague in the same workspace is signed in.
- When: The colleague lists `GET /api/user-templates` and reads `GET /api/user-templates/:templateId`.
- Then: The list is empty and the detail returns HTTP 404.

## user-template-publish-024

- Vitest: "POST /api/user-templates > shows an organization template to a colleague without letting them manage it"
- Mode: run
- Given: A signed-in admin has published a presentation template and shared it with the organization. A colleague in the same workspace is signed in.
- When: The colleague lists `GET /api/user-templates`, then tries `PATCH /api/user-templates/:templateId` with title "Renamed by a colleague" and `DELETE /api/user-templates/:templateId`.
- Then: The list has one entry with the template ID, visibility `organization`, the owner's user ID and `canManage: false`. The rename and delete both return HTTP 404.

## user-template-publish-025

- Vitest: "POST /api/user-templates > names a colleague's template after the person, not the account id"
- Mode: run
- Given: A signed-in admin named Mina Okafor has published and shared a presentation template. A colleague named Sam Reader in the same workspace is signed in, and the user directory returns both profiles.
- When: The colleague lists `GET /api/user-templates` and reads `GET /api/user-templates/:templateId`.
- Then: The listed entry shows the owner's user ID with `ownerDisplayName` "Mina Okafor", and the detail also shows "Mina Okafor".

## user-template-publish-026

- Vitest: "POST /api/user-templates > still lists a template whose owner the provider cannot name"
- Mode: run
- Given: A signed-in admin has published and shared a presentation template. A colleague in the same workspace is signed in, and the user directory rejects profile lookups with a rate-limit error.
- When: The colleague lists `GET /api/user-templates`.
- Then: The list returns HTTP 200 with one entry carrying the template ID, the owner's user ID, `ownerDisplayName: null` and `canManage: false`.
