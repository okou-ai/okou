# presentation-template-publish

## presentation-template-publish-001

- Vitest: "presentation template publish > publishes an analysed deck as a ready template"
- Mode: run
- Given: A signed-in member has uploaded a `.pptx` source deck, two PNG page previews, and a template package containing `SKILL.md` and `design-system.md`.
- When: The member calls `POST /api/presentation-templates` with title `Brand system`, then lists, reads the detail, and resolves preview URLs via `POST /api/presentation-templates/preview-urls` repeatedly, including after the clock reaches the first URL's expiry.
- Then: Publishing returns HTTP 200 with the title, `brand-system.pptx` source filename and `pageCount` 2, and a `presentationTemplatesChanged` event is published on the member's user channel. The list has one template with two preview assets equal to the detail's two page URLs, and the cover URL is the first page URL. Repeated resolves return identical assets; after expiry they return the same asset IDs with new URLs and later expiries, which are then reused. The package bundle is stored under a `bundles/v1/<sha256>.tar.gz` key.

## presentation-template-publish-002

- Vitest: "presentation template publish > imports and previews private template files"
- Mode: run
- Given: A signed-in member has uploaded a source deck, two page previews and a valid template package as private chat uploads.
- When: The member publishes the template via `POST /api/presentation-templates` and reads `GET /api/presentation-templates/:templateId`.
- Then: Both requests return HTTP 200 and the detail has two page URLs. The package is downloaded from the private artifacts bucket, and every signed preview URL points to the private artifacts bucket.

## presentation-template-publish-003

- Vitest: "presentation template publish > publishes a legacy PowerPoint source without conversion"
- Mode: run
- Given: A signed-in member has uploaded a legacy `.ppt` source deck (`application/vnd.ms-powerpoint`), two page previews and a valid package.
- When: The member calls `POST /api/presentation-templates` with title `Legacy brand system`.
- Then: The request returns HTTP 200 with the title, source filename `legacy-deck.ppt` and `pageCount` 2.

## presentation-template-publish-004

- Vitest: "presentation template publish > shares a public template with workspace members while keeping management owner-only"
- Mode: run
- Given: A workspace owner has published a private template; another member of the same workspace exists. The workspace realtime notification fails once during a rename.
- When: The owner shares it with `PATCH /api/presentation-templates/:templateId` `visibility: public` and renames it; the member lists, reads, resolves previews, and tries to rename and delete; the owner makes it private again and the member lists, reads and resolves previews again.
- Then: Publishing returns `visibility: private` and `canManage: true`; sharing returns `public` and notifies the workspace channel with `presentationTemplatesChanged`, and the rename still succeeds when the notification fails. The member sees the renamed public template with `canManage: false`, two page URLs and two resolvable `ptp:` preview assets, but rename and delete return HTTP 404. After retraction the member's list is empty, the detail returns 404, and resolving the old preview IDs returns no assets.

## presentation-template-publish-005

- Vitest: "presentation template publish > renames a private template without sharing it and rejects another workspace"
- Mode: run
- Given: An owner has published a private template; the owner also belongs to another workspace.
- When: The owner sends `PATCH /api/presentation-templates/:templateId` with title `  Renamed private brand  `, then tries a rename and share from the other workspace, then reads the template.
- Then: The rename returns HTTP 200 with the trimmed title, an updated `updatedAt` and otherwise unchanged fields, and notifies only the owner's user channel. The other-workspace update returns HTTP 404 with code `NOT_FOUND` and message `Presentation template not found: <id>`. The detail still matches the renamed private template.

## presentation-template-publish-006

- Vitest: "presentation template publish > preserves concurrent field updates and notifies the workspace on retraction"
- Mode: run
- Given: An owner has published a private template named `Brand`.
- When: The owner concurrently sends a title update and a `visibility: public` update, reads it, then concurrently sends two `visibility: private` updates.
- Then: Both concurrent updates return HTTP 200 and the template has both the new title and public visibility with source, page count, cover and creation time unchanged. Both retractions return HTTP 200 with private visibility; exactly two realtime channels are notified, the workspace and the owner's user channel, and the detail stays private with the new title.

## presentation-template-publish-007

- Vitest: "presentation template publish > deletes a template exactly once when two requests race"
- Mode: run
- Given: A member has published a template and shared it publicly with the workspace.
- When: Two `DELETE /api/presentation-templates/:templateId` requests are sent concurrently, then the member lists templates.
- Then: One delete returns HTTP 204 and the other 404. The workspace channel is notified exactly once, and the list is empty.

## presentation-template-publish-008

- Vitest: "presentation template publish > refuses a package that omits its required guidance"
- Mode: run
- Given: A signed-in member has uploaded inputs whose package contains only `SKILL.md`.
- When: The member calls `POST /api/presentation-templates`, then lists templates.
- Then: Publishing returns HTTP 400 with a message mentioning `design-system.md`, and the list is empty.

## presentation-template-publish-009

- Vitest: "presentation template publish > refuses a package path that escapes its root"
- Mode: run
- Given: A signed-in member has uploaded inputs whose package includes a `../escaped.md` entry.
- When: The member calls `POST /api/presentation-templates`.
- Then: The request returns HTTP 400 with a message containing `Unsafe package path`.

## presentation-template-publish-010

- Vitest: "presentation template publish > refuses a package that unpacks past the size cap"
- Mode: run
- Given: A signed-in member has uploaded a small gzip package that decompresses to one byte more than the maximum template package size.
- When: The member calls `POST /api/presentation-templates`, then lists templates.
- Then: Publishing returns HTTP 400 with a message containing `must unpack to`, and the list is empty.

## presentation-template-publish-011

- Vitest: "presentation template publish > refuses uploads that belong to someone else"
- Mode: run
- Given: One member has uploaded a source deck, page previews and package; a different signed-in user in another workspace has their file IDs.
- When: The other user calls `POST /api/presentation-templates` with those file IDs.
- Then: The request returns HTTP 400 with a message containing `Uploaded file not found`.
