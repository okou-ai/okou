# workflows

## workflows-001

- Vitest: "workflows > creates private workflows by default and hides them from other org members"
- Mode: run
- Given: A signed-in workspace admin and another member of the same workspace.
- When: The admin creates a Workflow via `POST /api/workflows` with a display name and no visibility, then the admin lists `GET /api/workflows?scope=workspace` and the other member lists `GET /api/workflows`.
- Then: Creation returns HTTP 201 with `visibility: "private"`, the admin as `ownerUserId`, `canManage` true and `canPublish` true. The admin's workspace list includes the Workflow, and the other member's list does not.

## workflows-002

- Vitest: "workflows > runs a workflow slash command with workflow timing attribution"
- Mode: run
- Given: A signed-in workspace admin with Pro entitlement has native subscription models configured, `gpt-6-astra` as preferred model, a Runner group, and a Workflow whose chat Thread was prepared via `POST /api/workflows/:workflowId/chat-thread`.
- When: The admin runs the Workflow twice via `POST /api/workflows/:workflowId/run`, and the Runner heartbeats and receives the first Run.
- Then: The first run returns HTTP 200 with `runId` null on the prepared Thread and launches one Run. The second returns `{ chatThreadId, runId: null }` and stays queued, so the Thread still has only the first Run. The execution uses agent type `codex` with `OPENAI_MODEL` = `gpt-6-astra` and no `ANTHROPIC_MODEL`.

## workflows-003

- Vitest: "workflows > resolves concurrent first workflow runs to one automation thread"
- Mode: run
- Given: A signed-in workspace admin with Pro entitlement, a subscription model and a Runner group owns a Workflow.
- When: The admin sends two concurrent `POST /api/workflows/:workflowId/run` requests.
- Then: Both return HTTP 200 with the same `chatThreadId`, and the Thread launches exactly one Run while the other invocation stays queued.

## workflows-004

- Vitest: "workflows > runs public workflows for members and hides another member's private workflow"
- Mode: run
- Given: A workspace admin with Pro entitlement and Runner group owns a public Workflow and a private Workflow; an onboarded workspace member has a personal subscription model.
- When: The member runs the public Workflow and then the private Workflow via `POST /api/workflows/:workflowId/run`.
- Then: The public Workflow run returns HTTP 200 and launches a Run. The private Workflow run returns HTTP 404 with error code `NOT_FOUND`.

## workflows-005

- Vitest: "workflows > allows the workflow owner to maintain a public workspace workflow"
- Mode: run
- Given: An author created a public Workflow in a workspace and has since been changed to the `org:member` role; that former author is the maintainer.
- When: The maintainer lists `GET /api/workflows`, reads `GET /api/workflows/:workflowId`, updates the instruction via `PATCH /api/workflows/:workflowId`, reads again, deletes it via `DELETE /api/workflows/:workflowId`, and reads once more.
- Then: The list shows the Workflow with `canManage` true; the detail shows the author as owner, `public`, `canManage` true and `canPublish` false. The update returns HTTP 200 and the read shows "# maintained content" with the same owner and visibility. Deletion returns HTTP 204 and the final read returns HTTP 404.

## workflows-006

- Vitest: "workflows > allows the org admin to maintain a public workspace workflow"
- Mode: run
- Given: An author created a public Workflow in a workspace, and a different workspace admin is the maintainer.
- When: The admin lists `GET /api/workflows`, reads `GET /api/workflows/:workflowId`, updates the instruction via `PATCH /api/workflows/:workflowId`, reads again, deletes it via `DELETE /api/workflows/:workflowId`, and reads once more.
- Then: The list shows the Workflow with `canManage` true; the detail shows the author as owner, `public`, `canManage` true and `canPublish` false. The update returns HTTP 200 and the read shows "# maintained content" with the same owner and visibility. Deletion returns HTTP 204 and the final read returns HTTP 404.

## workflows-007

- Vitest: "workflows > allows a public workflow owner to withdraw sharing without gaining publication rights"
- Mode: run
- Given: An author created a public Workflow in a workspace and now holds the `org:member` role; a workspace admin also exists.
- When: The author demotes it via `POST /api/workflows/:workflowId/demote`, tries to republish via `POST /api/workflows/:workflowId/publish`, and the admin reads `GET /api/workflows/:workflowId`.
- Then: Demotion returns HTTP 200 with `visibility: "private"`, the author as owner, `canManage` true and `canPublish` false. Publishing returns HTTP 403, and the admin's read returns HTTP 404.

## workflows-008

- Vitest: "workflows > binds a newly created workflow only to the member’s own chat thread"
- Mode: run
- Given: A signed-in workspace admin owns a chat Thread "Source chat", and a workspace member is a peer in the same workspace.
- When: The admin creates a Workflow with that `chatThreadId` and prepares `POST /api/workflows/:workflowId/chat-thread`; the peer creates a Workflow with the same `chatThreadId` and prepares its chat Thread.
- Then: The admin's creation publishes `chatThreadWorkflowsChanged:<thread>` realtime, and the prepared Thread is the source Thread with a prompt containing the Workflow ID. The peer's prepared Thread is a different Thread and no `chatThreadWorkflowsChanged` publication is sent for the source Thread.

## workflows-009

- Vitest: "workflows > creates a workflow when its chat thread notification fails"
- Mode: run
- Given: A signed-in workspace admin owns a chat Thread, and the realtime service rejects the next publication with "Ably unavailable".
- When: The admin creates a Workflow bound to that Thread via `POST /api/workflows` with `chatThreadId`.
- Then: Creation returns HTTP 201, and the realtime publication `chatThreadWorkflowsChanged:<thread>` was attempted.

## workflows-010

- Vitest: "workflows > protects public workflow slugs while allowing private overrides"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow X and a private Workflow X ("Private Workflow"), and an admin of another workspace owns a public Workflow X.
- When: The admin creates another public Workflow named X via `POST /api/workflows`, then lists `GET /api/workflows`.
- Then: The duplicate returns HTTP 409 whose message contains `/X" already exists in this workspace`. The list shows the public Workflow with `shadowedBy` the private one's ID, name and display name, and the private Workflow with `shadowedBy` null.

## workflows-011

- Vitest: "workflows > lists unshadowed workspace workflows with composer fields"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow X and a private Workflow X with display name "Private Workflow" and description "Private override"; another workspace has its own Workflow.
- When: The admin reads `GET /api/workflows/for-composer`.
- Then: The list contains exactly `{ id, name: X, displayName: "Private Workflow", description: "Private override" }` for the private Workflow and omits both the shadowed public Workflow and the other workspace's Workflow.

## workflows-012

- Vitest: "workflows > rejects same-owner private workflow slugs while allowing other-owner private slugs"
- Mode: run
- Given: A signed-in workspace admin owns a private Workflow X, and another workspace member exists.
- When: The admin creates another private Workflow X, then the other member creates a private Workflow X, both via `POST /api/workflows`.
- Then: The admin's duplicate returns HTTP 409 whose message contains `private workflow named "/X"`. The other member's creation returns HTTP 201 with name X, that member as owner and `private` visibility.

## workflows-013

- Vitest: "workflows > returns one creation and one name conflict for concurrent private workflows"
- Mode: run
- Given: A signed-in workspace admin and visibility `private`.
- When: The admin sends two concurrent `POST /api/workflows` with the same name and `private` visibility, then lists `GET /api/workflows`.
- Then: One request returns HTTP 201 and the other HTTP 409. The list has exactly one Workflow with that name and `private` visibility.

## workflows-014

- Vitest: "workflows > returns one creation and one name conflict for concurrent public workflows"
- Mode: run
- Given: A signed-in workspace admin and visibility `public`.
- When: The admin sends two concurrent `POST /api/workflows` with the same name and `public` visibility, then lists `GET /api/workflows`.
- Then: One request returns HTTP 201 and the other HTTP 409. The list has exactly one Workflow with that name and `public` visibility.

## workflows-015

- Vitest: "workflows > returns one update and one name conflict for concurrent private renames"
- Mode: run
- Given: A signed-in workspace admin owns two `private` Workflows `<name>-first` and `<name>-second` with distinct instructions.
- When: The admin concurrently renames both to `<name>` via `PATCH /api/workflows/:workflowId`, then reads each via `GET /api/workflows/:workflowId`.
- Then: One rename returns HTTP 200 and the other HTTP 409. The renamed Workflow reads with `<name>`, the other keeps its original name, and each keeps its own instruction.

## workflows-016

- Vitest: "workflows > returns one update and one name conflict for concurrent public renames"
- Mode: run
- Given: A signed-in workspace admin owns two `public` Workflows `<name>-first` and `<name>-second` with distinct instructions.
- When: The admin concurrently renames both to `<name>` via `PATCH /api/workflows/:workflowId`, then reads each via `GET /api/workflows/:workflowId`.
- Then: One rename returns HTTP 200 and the other HTTP 409. The renamed Workflow reads with `<name>`, the other keeps its original name, and each keeps its own instruction.

## workflows-017

- Vitest: "workflows > rejects a body edit without its source attachments and supports explicit replacement"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow with instruction "Keep the existing attachments" and attachment `keep.txt`, and its stored attachment archive then becomes unavailable in storage.
- When: The admin copies it via `POST /api/workflows/:workflowId/copy`, edits only the instruction via `PATCH /api/workflows/:workflowId`, and after storage is restored reads it; with storage emptied again the admin sends an update with `files: []` and a new instruction and reads it.
- Then: The copy fails with "Workflow attachment source is unavailable" and the body-only edit fails with "Missing S3 object", with no storage writes. After restoration the Workflow still has the original instruction and `keep.txt` = "retained". The explicit replacement returns HTTP 200 and the detail shows `files: []`.

## workflows-018

- Vitest: "workflows > renames workflow slugs through metadata update and rejects duplicate public slugs"
- Mode: run
- Given: A signed-in workspace admin owns public Workflows `existing` and `rename-source` (display name "Rename Source").
- When: The admin updates `rename-source` via `PATCH /api/workflows/:workflowId` with a new name, display name and description, then tries to rename it to `existing`.
- Then: The first update returns HTTP 200 with the new name, "Renamed Workflow" and the new description. The second returns HTTP 409 whose message contains `/existing" already exists in this workspace`.

## workflows-019

- Vitest: "workflows > rejects renaming a private workflow to another same-owner private slug"
- Mode: run
- Given: A signed-in workspace admin owns two private Workflows, `private-existing` and a source Workflow.
- When: The admin renames the source to `private-existing` via `PATCH /api/workflows/:workflowId`.
- Then: The request returns HTTP 409 whose message contains `private workflow named "/private-existing"`.

## workflows-020

- Vitest: "workflows > rejects publishing a private workflow when the public slug is already taken"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow X and a private Workflow X.
- When: The admin publishes the private one via `POST /api/workflows/:workflowId/publish`.
- Then: The request returns HTTP 409 whose message contains `/X" already exists in this workspace`.

## workflows-021

- Vitest: "workflows > rejects a slow attachment update after its private Workflow is published"
- Mode: run
- Given: A signed-in workspace admin owns a private Workflow with instruction "# original private workflow", and an update adding attachment `late.txt` with a new body is held while its archive uploads.
- When: While the upload is held the admin publishes the Workflow via `POST /api/workflows/:workflowId/publish`; then the upload is released, the admin publishes again and reads `GET /api/workflows/:workflowId`.
- Then: The first publish returns HTTP 200 and the held update returns HTTP 409. Publishing again returns HTTP 200 with `public`, and the Workflow reads as public with the original instruction and no files.

## workflows-022

- Vitest: "workflows > rejects an older private Workflow upload after a newer update publishes"
- Mode: run
- Given: A signed-in workspace admin owns a `private` Workflow with `notes.md` = "original notes", and an older update ("# older Workflow", "older notes") is held while its archive uploads.
- When: The admin sends a newer update via `PATCH /api/workflows/:workflowId` ("# newer Workflow", "newer notes"), then the older upload is released and the admin reads the Workflow.
- Then: The newer update returns HTTP 200 with the new instruction and `notes.md` of size 11. The older update returns HTTP 409 with message "Workflow changed during update; retry the request", and the Workflow reads with "# newer Workflow" and `notes.md` = "newer notes".

## workflows-023

- Vitest: "workflows > rejects an older public Workflow upload after a newer update publishes"
- Mode: run
- Given: A signed-in workspace admin owns a `public` Workflow with `notes.md` = "original notes", and an older update ("# older Workflow", "older notes") is held while its archive uploads.
- When: The admin sends a newer update via `PATCH /api/workflows/:workflowId` ("# newer Workflow", "newer notes"), then the older upload is released and the admin reads the Workflow.
- Then: The newer update returns HTTP 200 with the new instruction and `notes.md` of size 11. The older update returns HTTP 409 with message "Workflow changed during update; retry the request", and the Workflow reads with "# newer Workflow" and `notes.md` = "newer notes".

## workflows-024

- Vitest: "workflows > rejects an older attachment publication after a metadata-only edit at the same clock instant"
- Mode: run
- Given: A signed-in workspace admin owns a Workflow without files, the clock is frozen at one instant, and an update setting display name "Older label" with attachment `notes.md` is held while its archive uploads.
- When: The admin sends a metadata-only update via `PATCH /api/workflows/:workflowId` setting display name "Newer label"; then the older upload is released and the admin reads the Workflow.
- Then: The older update returns HTTP 409. The Workflow reads with display name "Newer label", the original instruction and no file contents.

## workflows-025

- Vitest: "workflows > preserves concurrent Workflow instruction updates"
- Mode: run
- Given: A signed-in workspace admin owns two Workflows with instructions "# first original" and "# second original".
- When: The admin updates both instructions concurrently via `PATCH /api/workflows/:workflowId`, then reads each.
- Then: Both updates return HTTP 200, and the Workflows read "# first updated" and "# second updated" respectively.

## workflows-026

- Vitest: "workflows > makes a deleted Workflow unavailable for reading, editing and publishing"
- Mode: run
- Given: A signed-in workspace admin owns a Workflow with attachment `owned.txt` that reads back with that content.
- When: The admin deletes it via `DELETE /api/workflows/:workflowId`, then reads it, updates its instruction and publishes it.
- Then: Deletion returns HTTP 204. The read returns HTTP 404 with error code `NOT_FOUND`, and the update and `POST /api/workflows/:workflowId/publish` both return HTTP 404.

## workflows-027

- Vitest: "workflows > rejects copying a workflow when the caller already has that private slug in the workspace"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow X and a private Workflow X.
- When: The admin copies the public Workflow via `POST /api/workflows/:workflowId/copy` with an empty body.
- Then: The request returns HTTP 409 whose message contains `private workflow named "/X"`.

## workflows-028

- Vitest: "workflows > publishes one complete private copy when concurrent requests compete for the same slug"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow X with instruction "# Source workflow".
- When: The admin sends two concurrent `POST /api/workflows/:workflowId/copy` requests for it, then lists `GET /api/workflows` and reads the source and the copy.
- Then: One copy returns HTTP 201 and the other HTTP 409 with a message containing `private workflow named "/X"`. The list has exactly one private Workflow, the winning copy named X. Both the source and the copy read with name X, the source instruction and `official` null.

## workflows-029

- Vitest: "workflows > rejects demoting a public workflow when the owner already has that private slug"
- Mode: run
- Given: A signed-in workspace admin owns a private Workflow X and a public Workflow X.
- When: The admin demotes the public Workflow via `POST /api/workflows/:workflowId/demote`.
- Then: The request returns HTTP 409 whose message contains `private workflow named "/X"`.

## workflows-030

- Vitest: "workflows > copies workflows and caller-owned automations through the API"
- Mode: run
- Given: A signed-in Team-tier workspace admin with a subscription model and Runner group owns a public Workflow with a 900-second loop schedule Automation and a `webhook-received` event Automation; the schedule Automation has been run now and completed with a result.
- When: The admin copies the Workflow via `POST /api/workflows/:workflowId/copy`, lists `GET /api/workflows/:workflowId/automations` for the copy, and runs the copied schedule Automation via `POST /api/workflow-automations/:id/run` through to Runner completion.
- Then: The copy returns HTTP 201 with the source name, the admin as owner and a new ID. Its Automations include a schedule Automation owned by the admin with the source's `enabled` state and a `webhook-received` event Automation. Running the copied schedule returns HTTP 201 with `runId` null, launches a Run, and the Run completes as `completed` with a framework session ID.

## workflows-031

- Vitest: "workflows > copies schedule-only workflows without binding a chat thread"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow with a 900-second loop schedule Automation whose `chatThreadId` is null.
- When: The admin copies the Workflow via `POST /api/workflows/:workflowId/copy` and lists the copy's Automations via `GET /api/workflows/:workflowId/automations`.
- Then: The copy returns HTTP 201, and the copy has exactly one Automation, a `schedule` with `chatThreadId` null.

## workflows-032

- Vitest: "workflows > rebinds copied Gmail automations to the target thread default account"
- Mode: run
- Given: A signed-in Team-tier workspace admin owns a public Workflow and has connected two Gmail accounts through OAuth (first is the default, second added). Gmail accepts mailbox watch and stop requests. A `gmail-new-message` event Automation is created and its Thread's Gmail selection is set to the second account via `PUT /api/chat-threads/:id/connector-selections`.
- When: The admin copies the Workflow via `POST /api/workflows/:workflowId/copy`.
- Then: Before copying, Gmail received watch requests with the first token and then the second token. The copy returns HTTP 201 and causes exactly one more Gmail watch, authorized with the first (default) account's token.

## workflows-033

- Vitest: "workflows > rebinds copied Calendar automations to the target thread default account"
- Mode: run
- Given: A signed-in Team-tier workspace admin owns a public Workflow and has connected two Google Calendar accounts through OAuth (first default, second added). Google Calendar accepts event listing, watch and channel stop requests. A `google-calendar-event-created` Automation is created and its Thread's Calendar selection is set to the second account via `PUT /api/chat-threads/:id/connector-selections`.
- When: The admin copies the Workflow via `POST /api/workflows/:workflowId/copy`.
- Then: Before copying, Calendar received watch requests with the first token and then the second token. The copy returns HTTP 201 and causes exactly one more Calendar watch, authorized with the first (default) account's token.

## workflows-034

- Vitest: "workflows > rebinds copied Notion automations before exposing the destination workflow"
- Mode: run
- Given: A signed-in Team-tier workspace admin owns a public Workflow and has connected two Notion accounts (default and selected). Notion returns the parent page "Roadmap" only to the default account's token. A `notion-child-page-created` Automation for that parent page exists and its Thread's Notion selection is set to the selected account.
- When: The admin copies the Workflow via `POST /api/workflows/:workflowId/copy`, lists the copy's and the source's Automations via `GET /api/workflows/:workflowId/automations`, and reads the copy's Thread selections via `GET /api/chat-threads/:id/connector-selections`.
- Then: The copy returns HTTP 201. Its Notion Automation is enabled with `eventConfig.connectorId` equal to the default account and its Thread has no connector selections. The source Automation still uses the selected account's connector ID.

## workflows-035

- Vitest: "workflows > rebinds copied Google Forms automations to the target thread default account"
- Mode: run
- Given: A signed-in Team-tier workspace admin owns a public Workflow and has connected two Google Forms accounts (first default, second added). Google Forms returns a published form, no responses, and accepts watches. A `google-forms-response-submitted` Automation for that form exists and its Thread's Forms selection is set to the second account.
- When: The admin copies the Workflow via `POST /api/workflows/:workflowId/copy` and lists the copy's Automations.
- Then: Before copying, Forms received watches with the first then second token. The copy returns HTTP 201 and causes exactly one more watch with the first account's token, and the copied Automation's `eventConfig.connectorId` is the first (default) account.

## workflows-036

- Vitest: "workflows > reuses current attachment bytes across body edits and file ordering, and never reactivates retired packages"
- Mode: run
- Given: A signed-in workspace admin creates a Workflow with instruction "first body" and attachments `zeta.txt` ("附件") and `alpha.txt`.
- When: The admin edits only the instruction via `PATCH /api/workflows/:workflowId`, then submits the same files in reverse order, then `files: []`, then the original files again, and reads the Workflow.
- Then: Creation writes exactly one `workflow-attachments/` archive containing `alpha.txt` then `zeta.txt`. The body edit returns HTTP 200 with "second body", `fileContents` null and files `alpha.txt` (5 bytes) and `zeta.txt` (6 bytes), and its new `bundles/v1/` package has the new `SKILL.md` body with both files. The reordered submission writes no attachment archive; re-adding after clearing writes one archive under a new key. The final read returns `alpha.txt` and `zeta.txt` contents.

## workflows-037

- Vitest: "workflows > normalizes duplicate attachment paths consistently across order and umask"
- Mode: run
- Given: A signed-in workspace admin creates a Workflow whose files list `duplicate.txt` twice ("first duplicate", then "second duplicate").
- When: The admin reads the Workflow, then under a restrictive 077 process umask resubmits the files in reverse order via `PATCH /api/workflows/:workflowId`, and reads it again.
- Then: The first read returns one `duplicate.txt` with "second duplicate". The resubmission only checks the existing `bundles/v1/` package key, leaves its bytes unchanged and writes nothing, and the second read returns the same file contents as the first.

## workflows-038

- Vitest: "workflows > reads and updates workflow content, audit metadata, and deletion through API responses"
- Mode: run
- Given: A workspace admin creates a public Workflow "Audit Workflow" with `notes.md`; another admin of the same workspace is the updater.
- When: The creator reads `GET /api/workflows/:workflowId`, the updater updates display name, instruction and files via `PATCH /api/workflows/:workflowId` and deletes it via `DELETE /api/workflows/:workflowId`, and the creator reads it again.
- Then: The initial read shows the creator as `createdByUserId`, `updatedByUserId` and owner, with the instruction and string `createdAt`/`updatedAt`. The update returns HTTP 200 with the creator as `createdByUserId`, the updater as `updatedByUserId`, and the new display name and instruction. Deletion returns HTTP 204 and the final read returns HTTP 404 with `NOT_FOUND`.

## workflows-039

- Vitest: "workflow owner profiles > keeps ordinary list, detail and mutation responses independent of profile enrichment"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow, the clock has advanced 16 minutes, and the identity provider's profile lookups fail with "Profiles are offline".
- When: The owner lists `GET /api/workflows`, reads `GET /api/workflows/:workflowId`, and updates the display name via `PATCH /api/workflows/:workflowId`.
- Then: All three return successfully with `ownerUserId` set to the owner, and no identity-provider user or user-list lookup is made.

## workflows-040

- Vitest: "workflow owner profiles > authorizes each profile read including warm-cache private and cross-org misses"
- Mode: run
- Given: A signed-in workspace admin owns a private Workflow, the clock has advanced 16 minutes, and the identity provider returns the owner's profile "Workflow Author" with an image URL.
- When: The owner reads `GET /api/workflows/:workflowId/owner-profile`; then another admin of the same workspace, a user from another workspace, the owner with an unknown Workflow ID, and an unauthenticated caller each request an owner profile.
- Then: The owner gets HTTP 200 with exactly `{ displayName: "Workflow Author", imageUrl: "https://example.com/author.png" }`. The other admin, the other-workspace user and the unknown ID get HTTP 404, the unauthenticated caller gets HTTP 401, and none of these triggers another identity-provider lookup.

## workflows-041

- Vitest: "workflow owner profiles > does not disclose a workflow profile after sharing is withdrawn"
- Mode: run
- Given: A workspace admin owns a public Workflow, a workspace member exists, the clock has advanced 16 minutes, and the identity provider returns the owner's profile.
- When: The member reads `GET /api/workflows/:workflowId/owner-profile`, the owner demotes the Workflow via `POST /api/workflows/:workflowId/demote`, and the member reads the profile again.
- Then: The first read returns HTTP 200 and the demotion HTTP 200. The second read returns HTTP 404 without any identity-provider lookup.

## workflows-042

- Vitest: "workflow owner profiles > reuses positive profiles and refreshes them after fifteen minutes"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow, the clock has advanced 16 minutes, and the identity provider returns the profile "Workflow Author".
- When: The owner reads `GET /api/workflows/:workflowId/owner-profile`; the provider's first name changes to "Updated"; the owner reads again, and again after the clock advances 15 minutes.
- Then: All reads return HTTP 200. The second read still shows "Workflow Author", and the read after 15 minutes shows "Updated Author".

## workflows-043

- Vitest: "workflow owner profiles > bounds missing profiles to sixty seconds and never serves stale identity after authoritative absence"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow, the clock has advanced 16 minutes, and the owner's profile "Workflow Author" has been read once.
- When: After 15 more minutes the identity provider reports the user missing (404) and the owner reads `GET /api/workflows/:workflowId/owner-profile`; the provider then returns the profile again and the owner reads immediately and again after 60 seconds.
- Then: The read after the 404 returns HTTP 200 with `{ displayName: null, imageUrl: null }`. The immediate re-read still has a null display name, and the read 60 seconds later returns "Workflow Author".

## workflows-044

- Vitest: "workflow owner profiles > keeps 429 profile failures retryable"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow, the clock has advanced 16 minutes, and the identity provider's profile lookup fails with HTTP 429.
- When: The owner reads `GET /api/workflows/:workflowId/owner-profile`, then reads again after the provider recovers.
- Then: The first read returns HTTP 429, and the next read returns HTTP 200 with display name "Workflow Author".

## workflows-045

- Vitest: "workflow owner profiles > keeps 503 profile failures retryable"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow, the clock has advanced 16 minutes, and the identity provider's profile lookup fails with HTTP 503.
- When: The owner reads `GET /api/workflows/:workflowId/owner-profile`, then reads again after the provider recovers.
- Then: The first read returns HTTP 503, and the next read returns HTTP 200 with display name "Workflow Author".

## workflows-046

- Vitest: "workflow owner profiles > keeps network profile failures retryable"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow, the clock has advanced 16 minutes, and the identity provider's profile lookup fails with a network error "Connection reset".
- When: The owner reads `GET /api/workflows/:workflowId/owner-profile`, then reads again after the provider recovers.
- Then: The first read returns HTTP 500, and the next read returns HTTP 200 with display name "Workflow Author".

## workflows-047

- Vitest: "workflow owner profiles > coalesces concurrent requests without reading workflow storage"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow, the clock has advanced 16 minutes, and the identity provider's profile lookup is slow.
- When: The owner sends two `GET /api/workflows/:workflowId/owner-profile` requests, the second while the first lookup is in flight, and the provider then answers.
- Then: Both return HTTP 200 with "Workflow Author". The identity provider is called exactly once and Workflow storage is not read.

## workflows-048

- Vitest: "workflow owner profiles > returns a real user's name without inventing a cache email"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow, the clock has advanced 16 minutes, and the identity provider returns the owner's profile with no email addresses.
- When: The owner reads `GET /api/workflows/:workflowId/owner-profile`.
- Then: The read returns HTTP 200 with display name "Workflow Author".

## workflows-049

- Vitest: "workflow owner profile cancellation > retries after cancellation and ignores a late missing result"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow, the clock has advanced 16 minutes, and the identity provider's lookup is slow and will eventually report the user missing.
- When: The client cancels a `GET /api/workflows/:workflowId/owner-profile` request while the lookup is in flight; the late missing result then arrives, the provider returns the profile, and the owner reads again.
- Then: The cancelled request ends with HTTP 500, and the next read returns HTTP 200 with "Workflow Author", ignoring the late missing result.

## workflows-050

- Vitest: "promotes a queued workflow after failure and completes it with a real Runner execution"
- Mode: run
- Given: A signed-in workspace admin with Pro entitlement, a subscription model and a Runner group owns a Workflow; one run has launched and a second `POST /api/workflows/:workflowId/run` is queued with `runId` null.
- When: The Runner receives the first Run and the sandbox reports failure (exit 1) via `POST /api/webhooks/run/complete`; the queued invocation then starts, the Runner receives it, and the sandbox reports success.
- Then: Both completions return HTTP 200, the queued invocation launches a new Run on the same Thread, the first Run reads `failed` and the second `completed`, and the Workflow then deletes with HTTP 204.
