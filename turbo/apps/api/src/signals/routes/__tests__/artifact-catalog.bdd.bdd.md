# artifact-catalog.bdd

## artifact-catalog.bdd-001

- Vitest: "GET /api/artifacts/catalog > publishes a readable private video catalog and preserves its original chat on reuse"
- Mode: run
- Given: A Pro-entitled member with a Runner group has a Chat run whose CLI token prepared a single-part "private-video.mp4" artifact upload through `POST /api/uploads/prepare` and uploaded the bytes.
- When: The run token completes the upload through `POST /api/uploads/complete`; a second Chat's run completes the same upload ID; the first thread is deleted and the second run completes it again.
- Then: Each catalog-changed realtime publication for the first thread goes to `user:<userId>` with a null payload, and the catalog read at that moment lists "private-video.mp4" with the prepared URL as `videoSourceUrl`; the detail reports the first thread as `sourceChatThreadId`. Reuse keeps the entry in the first thread's catalog and the second thread's catalog stays empty. After the first thread is deleted, the second thread's catalog is still empty, the unfiltered catalog still lists the same entry, and the detail no longer has `sourceChatThreadId`.

## artifact-catalog.bdd-002

- Vitest: "GET /api/artifacts/catalog > withdraws the owned object for a historical public file"
- Mode: run
- Given: A Pro-entitled member's Chat run uploaded "legacy-report.txt", which is listed in the artifact catalog.
- When: The member deletes it through `DELETE /api/artifacts/catalog/:artifactId`.
- Then: The request returns HTTP 200, the stored object for that file is deleted, the catalog is empty, and the thread's artifact list `GET /api/chat-threads/:threadId/artifacts` returns `{ runs: [] }`.

## artifact-catalog.bdd-003

- Vitest: "GET /api/artifacts/catalog > deletes a hosted-site and restores the catalog only for a new publication"
- Mode: run
- Given: A Pro-entitled member has published the same `hosted-site` twice from two Chats, producing one catalog entry linked from the first thread's artifact list.
- When: The member deletes the entry through `DELETE /api/artifacts/catalog/:artifactId`, reads it, lists the site's files through `GET /api/host/sites/:publicSlug/files`, deletes it again, then publishes the site a third time.
- Then: Deletion returns HTTP 200, the catalog and both threads' artifact lists are empty, the detail returns HTTP 404, the files request returns HTTP 409, and the repeated delete returns HTTP 200. The new publication restores the same catalog ID at deployment version 3, the earlier threads' artifact lists stay empty, and files for the old deployment slug still return HTTP 409.

## artifact-catalog.bdd-004

- Vitest: "GET /api/artifacts/catalog > deletes a presentation-html and restores the catalog only for a new publication"
- Mode: run
- Given: A Pro-entitled member has published the same `presentation-html` site twice from two Chats, producing one catalog entry linked from the first thread's artifact list.
- When: The member deletes the entry through `DELETE /api/artifacts/catalog/:artifactId`, reads it, lists the site's files through `GET /api/host/sites/:publicSlug/files`, deletes it again, then publishes the site a third time.
- Then: Deletion returns HTTP 200, the catalog and both threads' artifact lists are empty, the detail returns HTTP 404, the files request returns HTTP 409, and the repeated delete returns HTTP 200. The new publication restores the same catalog ID at deployment version 3, the earlier threads' artifact lists stay empty, and files for the old deployment slug still return HTTP 409.

## artifact-catalog.bdd-005

- Vitest: "GET /api/artifacts/catalog > shares the explicit site title across Chat and Artifacts and retains renames on redeploy"
- Mode: run
- Given: A Pro-entitled member has published a hosted site titled "Quarterly sales report" from a Chat run.
- When: The member renames it through `PATCH /api/host/sites/:publicSlug/title` to " 季度销售报告 ", enables the Artifact Library feature switch, searches the catalog by the site name with and without ascending direction, and redeploys the site from the same Chat with the original title.
- Then: The catalog first shows "Quarterly sales report". The rename returns HTTP 200 with the trimmed title "季度销售报告", which the detail shows with the site URL and slug. The default search by site name returns nothing, while the ascending search matches the entry by its filename. After redeploy the site ID is unchanged and the catalog still has one entry with the renamed title and original `createdAt`; the thread's artifact list has two files with that title for the two deployment URLs.

## artifact-catalog.bdd-006

- Vitest: "GET /api/artifacts/catalog > retains a renamed catalog identity when a hosted site becomes a presentation"
- Mode: run
- Given: A Pro-entitled member has published a hosted site titled "Original site" and renamed it to "保留的报告标题" through `PATCH /api/host/sites/:publicSlug/title`.
- When: The member republishes the same site from the same Chat as a `presentation-html` titled "Incoming deck title".
- Then: The site ID is unchanged, and the catalog has exactly one entry with the original ID, kind `presentation` and title "保留的报告标题"; the detail shows the same site ID and slug with the new deployment URL.

## artifact-catalog.bdd-007

- Vitest: "GET /api/artifacts/catalog > denies other owners site title edits without changing the title"
- Mode: run
- Given: A Pro-entitled member has published a hosted site titled "Original report".
- When: Another member of the same organization and a user from another organization each call `PATCH /api/host/sites/:publicSlug/title` with "Renamed report".
- Then: Both requests return HTTP 404, and the owner's catalog still lists the title "Original report".

## artifact-catalog.bdd-008

- Vitest: "GET /api/artifacts/catalog > lists an uploaded file as one artifact and hides other callers"
- Mode: run
- Given: A Pro-entitled member's Chat run uploaded "quarterly-report.txt" (256 bytes), and an unrelated user uploaded "outsider-report.txt".
- When: The member lists `GET /api/artifacts/catalog` and reads `GET /api/artifacts/catalog/:artifactId`.
- Then: The list has a null `nextCursor` and exactly one `file` artifact titled "quarterly-report.txt" with the upload URL as `sourceUrl` and no thumbnail. The detail is a file with filename "quarterly-report.txt", `text/plain`, size 256, the same URL and no preview image.

## artifact-catalog.bdd-009

- Vitest: "GET /api/artifacts/catalog > lists native PPTX files as presentations while retaining file-backed detail and deletion"
- Mode: run
- Given: A Pro-entitled member's Chat run uploaded "quarterly-review.pptx" and "BOARD-UPDATE.PPTX" as generic binary files and "supporting-notes.pdf".
- When: The member lists the catalog with `kind=presentation` and `kind=file`, reads each presentation's detail, deletes each through `DELETE /api/artifacts/catalog/:artifactId`, and lists both kinds again.
- Then: The presentation filter lists both PPTX titles and the file filter lists only "supporting-notes.pdf". Each presentation's detail is file-backed with its filename and source URL, and each delete returns HTTP 200. Afterwards no presentations remain and the PDF file is still listed.

## artifact-catalog.bdd-010

- Vitest: "GET /api/artifacts/catalog > keeps completed file lists and catalog filters scoped to their owning thread"
- Mode: run
- Given: A Pro-entitled member uploaded "first-thread-report.txt" and "second-thread-report.txt" from two separate Chats; an unrelated Pro-entitled user exists.
- When: The member reads the first thread's artifact list and the catalog filtered by each thread; the outsider reads the first thread's artifact list and its catalog; a same-organization user and a same-user-ID caller in another organization read the first thread's catalog.
- Then: The first thread's artifact list and catalog contain only the first report, and the second thread's catalog contains only the second. The outsider's artifact list request returns HTTP 404 with an API error and its catalog is empty, and both partial-identity callers get `{ artifacts: [], nextCursor: null }`.

## artifact-catalog.bdd-011

- Vitest: "GET /api/artifacts/catalog > keeps a prepared single video in its creating thread across completion retries and thread deletion"
- Mode: run
- Given: A Pro-entitled member's first Chat run prepared a 6 MiB "sharing-demo.mp4" artifact as a single-part upload through `POST /api/uploads/prepare`, and the object is stored.
- When: The first run token completes the upload through `POST /api/uploads/complete`; a second Chat's run completes the same upload; the first thread is deleted and the second run completes it again.
- Then: The first thread's catalog and the unrelated catalog list the video with the prepared URL as both `sourceUrl` and `videoSourceUrl`. After the second completion the first thread still lists the same ID and `createdAt` and the second thread's catalog is empty. After deleting the first thread the catalog still lists the same video, and the second thread's catalog remains empty.

## artifact-catalog.bdd-012

- Vitest: "GET /api/artifacts/catalog > keeps a prepared multipart video in its creating thread across completion retries and thread deletion"
- Mode: run
- Given: A Pro-entitled member's first Chat run prepared a 6 MiB "sharing-demo.mp4" artifact as a multipart upload through `POST /api/uploads/prepare`, storage accepts the two parts, and the object is stored.
- When: The first run token completes the parts through `POST /api/uploads/multipart/complete` and the upload through `POST /api/uploads/complete`; a second Chat's run completes the same upload; the first thread is deleted and the second run completes it again.
- Then: The multipart completion returns HTTP 200. The first thread's catalog and the unrelated catalog list the video with the prepared URL as both `sourceUrl` and `videoSourceUrl`. After the second completion the first thread still lists the same ID and `createdAt` and the second thread's catalog is empty. After deleting the first thread the catalog still lists the same video, and the second thread's catalog remains empty.

## artifact-catalog.bdd-013

- Vitest: "GET /api/artifacts/catalog > catalogues an artifact upload but never a chat attachment"
- Mode: run
- Given: A Pro-entitled member uploads "meeting-notes.png" as a composer attachment without a purpose and "quarterly-summary.html" with purpose `artifact`, completing both through `POST /api/uploads/complete`.
- When: The member lists the catalog, sends a chat message that attaches the PNG (HTTP 201), and lists the catalog again.
- Then: Both before and after the send, the catalog contains only the `file` artifact "quarterly-summary.html".

## artifact-catalog.bdd-014

- Vitest: "GET /api/artifacts/catalog > keeps repeated projections of one file URL as one artifact"
- Mode: run
- Given: A Pro-entitled member's two Chat runs each upload "repeatable-report.txt" with the same file ID.
- When: The member lists `GET /api/artifacts/catalog`.
- Then: The catalog contains exactly one `file` artifact titled "repeatable-report.txt".

## artifact-catalog.bdd-015

- Vitest: "GET /api/artifacts/catalog > lists the source URL for a mp4 video without a poster"
- Mode: run
- Given: A Pro-entitled member's Chat run uploads "source-fallback.mp4" with content type `video/mp4` and no poster.
- When: The run token completes the upload through `POST /api/uploads/complete` and the member lists `GET /api/artifacts/catalog`.
- Then: The catalog contains one `file` artifact titled "source-fallback.mp4" whose `videoSourceUrl` is the completed upload URL and whose thumbnail is null.

## artifact-catalog.bdd-016

- Vitest: "GET /api/artifacts/catalog > lists the source URL for a webm video without a poster"
- Mode: run
- Given: A Pro-entitled member's Chat run uploads "source-fallback.webm" with content type `video/webm` and no poster.
- When: The run token completes the upload through `POST /api/uploads/complete` and the member lists `GET /api/artifacts/catalog`.
- Then: The catalog contains one `file` artifact titled "source-fallback.webm" whose `videoSourceUrl` is the completed upload URL and whose thumbnail is null.

## artifact-catalog.bdd-017

- Vitest: "GET /api/artifacts/catalog > keeps owned files and catalog identity after a rejected attempt to delete the backing Agent"
- Mode: run
- Intent: review
- Given: A Pro-entitled member's Chat run uploaded "retained-report.txt", which is the single catalog artifact; no Agent deletion request is made by the test.
- When: After pending background work finishes, the member re-reads the catalog list and detail and resolves the file through `GET /api/web/file-url`; another user resolves the same file.
- Then: The catalog list and detail are unchanged, the owner's resolved public URL equals the upload URL, and the other user's request returns HTTP 404.

## artifact-catalog.bdd-018

- Vitest: "GET /api/artifacts/catalog > preserves unrelated files after user deletion of an artifact owner"
- Mode: run
- Given: A Pro-entitled member and an unrelated user have each uploaded a report artifact ("account-report.txt" and "unrelated-report.txt"); the member's file resolves and its catalog entry exists.
- When: Clerk sends a signed `user.deleted` webhook for the member to `POST /api/webhooks/clerk`.
- Then: The webhook returns HTTP 200; the unrelated user's file still resolves to its URL and their catalog still lists "unrelated-report.txt".

## artifact-catalog.bdd-019

- Vitest: "GET /api/artifacts/catalog > preserves unrelated files after organization deletion of an artifact owner"
- Mode: run
- Given: A Pro-entitled member and an unrelated user have each uploaded a report artifact ("account-report.txt" and "unrelated-report.txt"); the member's file resolves and its catalog entry exists.
- When: Clerk sends a signed `organization.deleted` webhook for the member's organization to `POST /api/webhooks/clerk`.
- Then: The webhook returns HTTP 200; the unrelated user's file still resolves to its URL and their catalog still lists "unrelated-report.txt".

## artifact-catalog.bdd-020

- Vitest: "GET /api/artifacts/catalog > keeps original thread ownership and current projection across redeploy and thread deletion"
- Mode: run
- Given: A Pro-entitled member published a hosted site from Chat A, creating a catalog entry owned by thread A.
- When: The member redeploys the site from a new Chat B, deletes thread A, then publishes the site again from thread B.
- Then: The redeploy keeps the site ID and slug with a new deployment, and publishes a catalog-changed event for thread A but not B. The catalog has one `hosted-site` entry with the original ID, source thread A and deployment version 2; A's filtered catalog matches it and B's is empty. After deleting A both thread filters are empty, the unfiltered catalog is unchanged and the detail drops `sourceChatThreadId`. The third publication (version 3) keeps one entry with the same ID at version 3, and neither thread filter lists it.

## artifact-catalog.bdd-021

- Vitest: "GET /api/artifacts/catalog > queries and republishes one hosted site across chats and Clerk sessions"
- Mode: run
- Given: A signed-in member prepared a public hosted site through `POST /api/host/deployments/prepare` with a Clerk session, then became a Pro-entitled member with a Runner group.
- When: A first Chat run's token reads the site's deployments through `GET /api/host/sites/:site/deployments` and prepares a second deployment; a second Chat run's token completes the first two deployments and prepares a third, which the member completes; then same-organization and same-user/other-organization callers try deployments, files, completion and preparation.
- Then: The first run sees one deployment; deployments 2 and 3 keep the site ID, slug and URL with versions 2 and 3 and distinct IDs; re-completing the first returns `isActive: false` with `activeDeploymentVersion: 3`. Both the member and the run token see three deployments with the third active, current files at version 3, and version 1 files. The other callers get HTTP 404 for deployments and completion while public files still show the third deployment; the same-organization member's prepare returns HTTP 409 "belongs to another owner". The catalog has one hosted-site entry at version 3.

## artifact-catalog.bdd-022

- Vitest: "GET /api/artifacts/catalog > catalogues a published deck as a presentation"
- Mode: run
- Given: A Pro-entitled member published a site as `presentation-html` from a Chat run.
- When: The member lists `GET /api/artifacts/catalog?kind=presentation`.
- Then: The catalog contains exactly one entry with kind `presentation` and the site name as title.

## artifact-catalog.bdd-023

- Vitest: "GET /api/artifacts/catalog > moves a catalog entry to presentation when a deck redeploys the site"
- Mode: run
- Given: A Pro-entitled member published a site as `hosted-site` and then republished the same site as `presentation-html` from the same Chat.
- When: The member lists `GET /api/artifacts/catalog`.
- Then: The republication keeps the site ID and slug, and the catalog contains exactly one entry with kind `presentation` and the site name as title.

## artifact-catalog.bdd-024

- Vitest: "GET /api/artifacts/catalog > filters by kind without leaking other kinds"
- Mode: run
- Given: A Pro-entitled member has uploaded "notes.txt" and published a hosted site.
- When: The member lists the catalog with `kind` set to `file`, `hosted-site`, `avatar`, `video` and `shared-thread`.
- Then: The file filter returns only `file` kinds, the hosted-site filter returns only the site's title, and the avatar, video and shared-thread filters each return `{ artifacts: [], nextCursor: null }`.

## artifact-catalog.bdd-025

- Vitest: "GET /api/artifacts/catalog > searches artifact titles literally before applying the page limit"
- Mode: run
- Given: A Pro-entitled member has uploaded "Launch-Brief.txt" and "budget.txt".
- When: The member lists the catalog with `keyword=launch&limit=1`, then with `keyword=%`.
- Then: The first search returns exactly the `file` "Launch-Brief.txt" with a null `nextCursor`; the `%` search returns no artifacts and a null cursor.

## artifact-catalog.bdd-026

- Vitest: "GET /api/artifacts/catalog > paginates a thread and kind filtered catalog without repeats or foreign-thread entries"
- Mode: run
- Given: A Pro-entitled member has uploaded "page-one.txt", "page-two.txt" and "page-three.txt" into one Chat and "page-other-thread.txt" into another.
- When: The member pages through `GET /api/artifacts/catalog` with `limit=1`, the first thread's `chatThreadId`, `kind=file` and the returned cursors.
- Then: Each page has at most one artifact, and the collected titles are exactly "page-three.txt", "page-two.txt", "page-one.txt" with no repeats or foreign-thread entries.

## artifact-catalog.bdd-027

- Vitest: "GET /api/artifacts/catalog > keeps a Runner output associated with its owning prompt when the run is interrupted"
- Mode: run
- Given: A Pro-entitled member's Chat run uploaded "workflow-output.txt" through its run token.
- When: The member interrupts the run by sending a control event with `interruptsRunId` (HTTP 201), and the sandbox completes the run with exit code 1.
- Then: The thread events contain the run's `input.prompt` and the `control.interrupt` for that run. The thread's artifact list has exactly that run with "workflow-output.txt", and the thread-filtered and unfiltered catalogs both contain exactly that `file` artifact.

## artifact-catalog.bdd-028

- Vitest: "GET /api/artifacts/catalog > hides an artifact owned by another caller behind a 404"
- Mode: run
- Given: A Pro-entitled member has uploaded "private.txt"; another Pro-entitled user exists.
- When: The other user reads `GET /api/artifacts/catalog/:artifactId` for the member's artifact.
- Then: The request returns HTTP 404 with error code `NOT_FOUND`.

## artifact-catalog.bdd-029

- Vitest: "GET /api/artifacts/catalog > scopes the catalog to one chat thread when chatThreadId is set"
- Mode: run
- Given: A Pro-entitled member has uploaded "first-thread.txt" in one Chat and "second-thread.txt" in another.
- When: The member lists `GET /api/artifacts/catalog?chatThreadId=<first thread>`.
- Then: The result has a null `nextCursor` and contains only the `file` "first-thread.txt".

## artifact-catalog.bdd-030

- Vitest: "shared thread routes > deleting a shared conversation from artifacts revokes its shared link"
- Mode: run
- Given: A Pro-entitled member's completed Chat has a visible prompt, the title model returns "Saved conversation", and the member shared that prompt through `POST /api/chat-threads/:threadId/shared-threads`, producing a `shared-thread` catalog artifact.
- When: The member deletes the artifact through `DELETE /api/artifacts/catalog/:artifactId`, the public reads `GET /api/shared-threads/:id` and `/meta`, and the member deletes the artifact again.
- Then: The delete returns HTTP 200 and the `shared-thread` catalog is empty. The public snapshot and metadata both return HTTP 404, the repeated delete returns HTTP 200, and the source thread still contains the original prompt event.

## artifact-catalog.bdd-031

- Vitest: "shared thread routes > creates immutable, redacted snapshots from selected visible messages"
- Mode: run
- Given: A Pro-entitled member's completed Chat has a prompt and an assistant reply "Here is the **public** launch plan."; another Chat has a private prompt; the title model returns "**Private launch plan**".
- When: The member creates two snapshots through `POST /api/chat-threads/:threadId/shared-threads` with event IDs mixing an unknown ID, the other thread's prompt, a non-shareable event, and duplicated assistant and prompt IDs; the public reads them; the member lists, pages and reads the catalog; then deletes the source thread and Clerk deletes the organization.
- Then: Two title prompts include the prompt and reply but not the other thread. Each snapshot returns HTTP 201, and `GET /api/shared-threads/:id` returns `no-store` with title "Private launch plan" and only the user and assistant messages in order; `/meta` returns that title. The thread's `shared-thread` catalog has two entries whose detail names the source thread, paging by one returns each once, other filters and partial-identity callers see nothing, and direct catalog requests return HTTP 200. After the source thread is deleted and after `organization.deleted`, the snapshot is unchanged; the thread filter is empty while the kind filter and detail (without source) remain.

## artifact-catalog.bdd-032

- Vitest: "shared thread routes > allows API creation while the entry feature switch is disabled"
- Mode: run
- Given: A Pro-entitled member has a Chat run with a visible prompt; the shared-conversation entry feature switch is not enabled for the member, and the title model returns "Private launch plan".
- When: The member creates a snapshot of the prompt through `POST /api/chat-threads/:threadId/shared-threads` and the public reads it.
- Then: Creation returns HTTP 201 and `GET /api/shared-threads/:id` returns HTTP 200 with title "Private launch plan".

## artifact-catalog.bdd-033

- Vitest: "artifact catalog source identity > resolves an owned shared conversation without exposing it to other viewers"
- Mode: run
- Given: A Pro-entitled member has shared a completed Chat's prompt, producing a `shared-thread` catalog entry with the shared thread ID.
- When: The member reads `GET /api/artifacts/catalog/:artifactId` with the shared thread ID and `sourceKind=shared-thread`, and again with the catalog ID; a same-organization user, an unrelated user and an unauthenticated caller make the source-identity request.
- Then: The source-identity read returns HTTP 200 with the catalog ID, kind `shared-thread` and the shared thread, identical to the catalog-ID read. Both other users get HTTP 404 and the unauthenticated caller gets HTTP 401.
