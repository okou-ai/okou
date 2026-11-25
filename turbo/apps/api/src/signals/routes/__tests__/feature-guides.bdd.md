# feature-guides

## feature-guides-001

- Vitest: "delivers published guides to eligible members"
- Mode: run
- Given: At 2026-10-28, a staff member imported a guide edition via `POST /api/internal/feature-guides` targeted at one member, with three items whose actions are `connect-discord`, `open-artifacts`, and `open-chats` and which carry image media.
- When: The targeted member reads `GET /api/feature-guides/current` before and after the staff member publishes the imported revision via `POST /api/internal/feature-guides/:editionId/publish`.
- Then: Before publication the current edition is `null`. After publication it is the imported edition with its revision ID and exactly the imported content.

## feature-guides-002

- Vitest: "filters bound items by effective switches and leaves empty bindings unrestricted"
- Mode: run
- Given: A published edition targets two members of the same workspace and has five items bound to feature switch `null`, `""`, `singleAgent`, the test (Dummy) switch, and an unknown switch.
- When: The first member reads `GET /api/feature-guides/current`; the peer sets the Dummy switch off, on, and off again via `POST /api/feature-switches`, reading the current guide after each change.
- Then: The first member receives the first four items. The peer receives the first three items while the Dummy switch is off and the first four while it is on; the unknown-switch item is never delivered.

## feature-guides-003

- Vitest: "suppresses an entirely gated edition without revealing a backlog or consuming its receipt"
- Mode: run
- Given: A member is targeted by an older published edition and, one second later, a newer published edition whose every item is bound to the Dummy switch.
- When: With the switch off the member reads `GET /api/feature-guides/current` normally and in a preview deployment with `preview=1`; the member turns the switch on, reads, marks the newer edition seen via `POST /api/feature-guides/:editionId/seen`, then toggles the switch off and on and reads again.
- Then: With the switch off the current edition is `null` (also in preview), so the older edition is not revealed. With the switch on the newer edition is returned with its content. After it is marked seen, reads return `null` with the switch off and on.

## feature-guides-004

- Vitest: "persists seen status per user and edition across workspaces and content revisions"
- Mode: run
- Given: A published edition targets a member, a peer in the same workspace, and the same member in another workspace.
- When: The member reads the current guide, marks it seen with `POST /api/feature-guides/:editionId/seen`, and reads it again in both workspaces; the peer reads it; staff imports a corrected title and publishes the new revision; the member and peer read again.
- Then: The member sees the edition before marking it seen and gets `null` afterwards in both workspaces. The peer still sees it. After the new revision is published the member still gets `null`, while the peer receives the corrected title.

## feature-guides-005

- Vitest: "delivers an organization audience to its members without exposing the audience"
- Mode: run
- Given: A published edition targets two workspaces by organization ID.
- When: A member of the first workspace, another member of that workspace, a member of the second workspace, and a member of an unrelated workspace read `GET /api/feature-guides/current`; the unrelated member also reads with `preview=1` in a preview deployment and marks the edition seen.
- Then: The first member receives exactly `{ id, revisionId, content }` with no audience data, and the other members of targeted workspaces receive the edition. The unrelated member gets `null`, the preview read also returns `null`, and marking the edition seen returns HTTP 404.

## feature-guides-006

- Vitest: "matches targeted users by organization and user together and unions organization targets"
- Mode: run
- Given: A published edition targets one whole workspace by organization ID plus two specific users, each scoped to their own workspace.
- When: A different user in the first target's workspace, and the first target user acting in the second target's workspace, read the current guide and mark it seen; the second target user, a member of the whole-targeted workspace, and the first target user in their own workspace read it; the first target marks it seen, reads it again, and then reads it with `preview=1` in a preview deployment.
- Then: The non-matching user/workspace combinations get `null`, and the seen request returns HTTP 404. The second target, the whole-workspace member, and the first target in the right workspace receive the edition. After marking it seen the first target gets `null`; the preview read returns exactly `{ edition: { id, revisionId, content }, preview: true }`, and a normal read afterwards is still `null`.

## feature-guides-007

- Vitest: "selects the latest eligible edition per audience without resurfacing seen backlogs"
- Mode: run
- Given: A global edition is published, then one second later an edition targeting a first member, then two seconds later an edition targeting a second member's workspace.
- When: The first member reads `GET /api/feature-guides/current`, marks their edition seen, and reads again; the second member reads; an untargeted member reads.
- Then: The first member receives their targeted edition and, after marking it seen, gets `null` rather than the older global edition. The second member receives the workspace-targeted edition, and the untargeted member receives the global edition.

## feature-guides-008

- Vitest: "publishes audience changes only through a new immutable revision and preserves seen receipts"
- Mode: run
- Given: A published edition targets one member. Staff re-imports the identical input, then imports it with the audience changed to the member's whole workspace.
- When: A peer in the workspace reads the current guide; the member marks the published revision seen; staff publishes the changed revision; the member and peer read again.
- Then: The identical import returns the same revision ID and the changed import returns a new one. Before publishing the change the peer gets `null`. After publishing, the member still gets `null` and the peer receives the edition with the new revision ID.

## feature-guides-009

- Vitest: "rejects a null audience instead of broadening delivery"
- Mode: run
- Given: Row `null`: a signed-in staff member prepares a guide import with `audience: null`.
- When: The staff member posts it to `POST /api/internal/feature-guides`.
- Then: The API responds with HTTP 400.

## feature-guides-010

- Vitest: "rejects a unscoped user audience instead of broadening delivery"
- Mode: run
- Given: Row `unscoped user`: a signed-in staff member prepares a guide import whose audience lists a user ID without an organization ID.
- When: The staff member posts it to `POST /api/internal/feature-guides`.
- Then: The API responds with HTTP 400.

## feature-guides-011

- Vitest: "a seen edition does not reveal an older backlog and a new edition can appear"
- Mode: run
- Given: Two editions targeting the same member are published one second apart.
- When: The member reads the current guide, marks the newer edition seen, reads again, and reads after a third targeted edition is published two seconds after the first.
- Then: The member first receives the newer edition, then `null` (the older edition is not revealed), and finally the third edition.

## feature-guides-012

- Vitest: "keeps drafts immutable and publishes only the selected revision"
- Mode: run
- Given: Staff imported an edition targeting one member, re-imported the identical input, and imported a changed revision that binds every item to the Dummy switch.
- When: Staff publishes the original revision, the member reads the current guide, staff publishes with `revisionId: null`, and the member reads again.
- Then: The identical re-import returns exactly the same edition and revision IDs and the changed import returns a different revision ID. The member receives the original revision and content, and after publishing `null` receives `null`.

## feature-guides-013

- Vitest: "respects scheduled and expired publication windows for targeted editions"
- Mode: run
- Given: An edition targeting one member is published with a window starting one second and expiring two seconds after 2026-10-28T00:00:00Z.
- When: The member reads `GET /api/feature-guides/current` at the base time, at the start time, and at the expiry time.
- Then: The reads return `null`, then the edition, then `null`.

## feature-guides-014

- Vitest: "requires hard staff authorization for importing and publishing"
- Mode: run
- Given: A signed-in member of an ordinary (non-staff) workspace.
- When: The member imports a guide via `POST /api/internal/feature-guides` and publishes an unknown edition via `POST /api/internal/feature-guides/:editionId/publish`.
- Then: Both requests return HTTP 403.

## feature-guides-015

- Vitest: "does not mark an unpublished revision as seen"
- Mode: run
- Given: Staff imported a guide edition but never published it, and an ordinary member is signed in.
- When: The member marks the edition revision seen via `POST /api/feature-guides/:editionId/seen`.
- Then: The API responds with HTTP 404.

## feature-guides-016

- Vitest: "requires a session and validates content, audiences and publication windows"
- Mode: run
- Given: An unauthenticated caller, and a signed-in staff member.
- When: The unauthenticated caller reads `GET /api/feature-guides/current`; staff imports guides with an empty audience object, with `startsAt` after `expiresAt`, and with an image item whose URL is `javascript:alert(1)`.
- Then: The unauthenticated read returns HTTP 401 and each invalid import returns HTTP 400.

## feature-guides-017

- Vitest: "rejects guide replay in production deployments"
- Mode: run
- Given: A signed-in member in a production deployment.
- When: The member reads `GET /api/feature-guides/current?preview=1`.
- Then: The API responds with HTTP 403.

## feature-guides-018

- Vitest: "previews the illustrated My Okou guide without publishing or acknowledging an edition"
- Mode: run
- Given: A signed-in member in a preview deployment.
- When: The member reads `GET /api/feature-guides/current?preview=1&edition=single-agent-2026-11-16`, marks the returned revision seen, and repeats the read in a production deployment.
- Then: The preview returns `preview: true` and edition `single-agent-2026-11-16` with three illustrated items: "One Okou. Your subagents, now projects" (an HTTPS character URL and the `projects` scene), "Your instructions are now in Settings" (the `instructions` scene at Settings > Personal > My Okou), and "Your workflows, in one place" (the `workflows` scene). Marking it seen returns HTTP 404, and the production read returns HTTP 403.
