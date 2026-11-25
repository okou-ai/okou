# integrations-teams

## integrations-teams-001

- Vitest: "Microsoft Teams integration CLI routes > sends a Teams message through the installed bot"
- Mode: run
- Given: An organization admin ("Ada Lovelace") has the Microsoft Teams bot installed and their Teams account connected, and calls with a run-scoped agent token. The Bot Framework issues a bot token and accepts activities in the connected conversation.
- When: The agent calls `POST /api/integrations/teams/message` with the connected `conversationId`, the thread `activityId` and text "Hello from Teams CLI".
- Then: The response is HTTP 200 with exactly `ok: true`, the delivered activity ID and the conversation ID. Teams receives the activity with the bot framework token: a markdown message "Hello from Teams CLI" followed by "Triggered by <at>Ada Lovelace</at>", a mention entity for the caller's AAD object ID, `replyToId` set to the thread, and the tenant channel data.

## integrations-teams-002

- Vitest: "Microsoft Teams integration CLI routes > denies Teams delivery for a missing member"
- Mode: run
- Given: An organization admin has the Microsoft Teams bot installed and their Teams account connected, and calls with a run-scoped agent token. Teams reports that the caller is not a member of the target conversation (HTTP 404 on the member lookup).
- When: The agent calls `POST /api/integrations/teams/message` with the connected `conversationId` and text "blocked".
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and no activity is sent to Teams.

## integrations-teams-003

- Vitest: "Microsoft Teams integration CLI routes > denies Teams delivery for a different tenant"
- Mode: run
- Given: An organization admin has the Microsoft Teams bot installed and their Teams account connected, and calls with a run-scoped agent token. Teams reports the caller as a conversation member but in a different tenant (`another-tenant`).
- When: The agent calls `POST /api/integrations/teams/message` with the connected `conversationId` and text "blocked".
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and no activity is sent to Teams.

## integrations-teams-004

- Vitest: "Microsoft Teams integration CLI routes > delivers to Teams recipient me: Adaptive Card"
- Mode: run
- Given: An organization admin ("Ada Lovelace") has the Microsoft Teams bot installed and their Teams account connected, and calls with a run-scoped agent token. The recipient is `me`; Teams resolves the caller's Teams user and creates a DM conversation.
- When: The agent calls `POST /api/integrations/teams/message` with `user` `me`, text "Pick a workflow" and a full-width Adaptive Card containing a "Pick a workflow" text block.
- Then: The response is HTTP 200 with exactly `ok: true`, the activity ID and the DM conversation ID. Teams creates a non-group conversation for bot "Nova" with the caller's Teams user named "Ada Lovelace" in the installation tenant, and the activity goes to that DM with summary "Pick a workflow" plus "Triggered by <at>Ada Lovelace</at>". The card attachment keeps the original text block and adds a small, subtle, separated "Triggered by <at>Ada Lovelace</at>" block and an `msteams` mention entity for the caller while keeping the full width.

## integrations-teams-005

- Vitest: "Microsoft Teams integration CLI routes > delivers to Teams recipient 29:other-recipient: Adaptive Card"
- Mode: run
- Given: An organization admin ("Ada Lovelace") has the Microsoft Teams bot installed and their Teams account connected, and calls with a run-scoped agent token. The recipient is Teams user `29:other-recipient`, whom Teams resolves in the installation tenant, and Teams creates a DM conversation.
- When: The agent calls `POST /api/integrations/teams/message` with `user` `29:other-recipient`, text "Pick a workflow" and a full-width Adaptive Card containing a "Pick a workflow" text block.
- Then: The response is HTTP 200 with exactly `ok: true`, the activity ID and the DM conversation ID. Teams creates a non-group conversation for bot "Nova" with member `29:other-recipient` in the installation tenant, and the activity goes to that DM with summary "Pick a workflow" plus "Triggered by <at>Ada Lovelace</at>". The card attachment keeps the original text block and adds a small, subtle, separated "Triggered by" block and an `msteams` mention entity for the caller while keeping the full width.

## integrations-teams-006

- Vitest: "Microsoft Teams integration CLI routes > owns a non-Run v2 conversation upload and preserves its delivered delivery outcome"
- Mode: run
- Given: A signed-in organization admin has the Microsoft Teams bot installed and their Teams account connected. Upload storage accepts bytes and Teams accepts the activity. Row: target `conversation` (the connected channel conversation), outcome `delivered`.
- When: The member calls `POST /api/integrations/teams/upload-file/init` for a canonical v2 `report.txt` upload to the connected conversation with text "Pinned account report", uploads the bytes, calls `POST /api/integrations/teams/upload-file/complete` twice with a replacement conversation and text, re-initializes with the same body and with a changed checksum, and finally completes as another user of the organization.
- Then: Init returns HTTP 200 with the operation ID and `uploadRequired` true. Both completions return HTTP 200 with identical bodies, and Teams receives exactly one activity in the connected conversation containing "Pinned account report" and not "Replacement text". Re-init returns the same upload and operation with `uploadRequired` false, a changed checksum returns 409, and the other user's completion returns 404 without another Teams send.

## integrations-teams-007

- Vitest: "Microsoft Teams integration CLI routes > owns a non-Run v2 direct DM upload and preserves its delivered delivery outcome"
- Mode: run
- Given: A signed-in organization admin has the Microsoft Teams bot installed and their Teams account connected. Upload storage accepts bytes and Teams accepts the activity. Row: target `direct DM` (the existing DM conversation ID), outcome `delivered`.
- When: The member calls `POST /api/integrations/teams/upload-file/init` for a canonical v2 `report.txt` upload to the DM conversation with text "Pinned account report", uploads the bytes, calls `POST /api/integrations/teams/upload-file/complete` twice with a replacement conversation and text, re-initializes with `user` `me` instead of the conversation and once with a changed checksum, and finally completes as another user of the organization.
- Then: Init returns HTTP 200 with the operation ID and `uploadRequired` true. Both completions return HTTP 200 with identical bodies, and Teams receives exactly one activity in the DM conversation containing "Pinned account report" and not "Replacement text". Re-init returns the same upload and operation with `uploadRequired` false, a changed checksum returns 409, and the other user's completion returns 404 without another Teams send.

## integrations-teams-008

- Vitest: "Microsoft Teams integration CLI routes > owns a non-Run v2 me upload and preserves its delivered delivery outcome"
- Mode: run
- Given: A signed-in organization admin has the Microsoft Teams bot installed and their Teams account connected. Upload storage accepts bytes, Teams creates a DM with the caller and accepts the activity. Row: target `me`, outcome `delivered`.
- When: The member calls `POST /api/integrations/teams/upload-file/init` for a canonical v2 `report.txt` upload addressed to `user` `me` with text "Pinned account report", uploads the bytes, calls `POST /api/integrations/teams/upload-file/complete` twice with a replacement conversation and text, re-initializes with the same body and with a changed checksum, and finally completes as another user of the organization.
- Then: Init returns HTTP 200 with the operation ID and `uploadRequired` true. Both completions return HTTP 200 with identical bodies, and Teams receives exactly one activity in the DM conversation containing "Pinned account report" and not "Replacement text". Re-init returns the same upload and operation with `uploadRequired` false, a changed checksum returns 409, and the other user's completion returns 404 without another Teams send.

## integrations-teams-009

- Vitest: "Microsoft Teams integration CLI routes > owns a non-Run v2 29:other-recipient upload and preserves its delivered delivery outcome"
- Mode: run
- Given: A signed-in organization admin has the Microsoft Teams bot installed and their Teams account connected. Upload storage accepts bytes, Teams resolves `29:other-recipient`, creates a DM and accepts the activity. Row: target `29:other-recipient`, outcome `delivered`.
- When: The member calls `POST /api/integrations/teams/upload-file/init` for a canonical v2 `report.txt` upload addressed to `user` `29:other-recipient` with text "Pinned account report", uploads the bytes, calls `POST /api/integrations/teams/upload-file/complete` twice with a replacement conversation and text, re-initializes with the same body and with a changed checksum, and finally completes as another user of the organization.
- Then: Init returns HTTP 200 with the operation ID and `uploadRequired` true. Both completions return HTTP 200 with identical bodies, and Teams receives exactly one activity in the DM conversation containing "Pinned account report" and not "Replacement text". Re-init returns the same upload and operation with `uploadRequired` false, a changed checksum returns 409, and the other user's completion returns 404 without another Teams send.

## integrations-teams-010

- Vitest: "Microsoft Teams integration CLI routes > owns a non-Run v2 conversation upload and preserves its uncertain delivery outcome"
- Mode: run
- Given: A signed-in organization admin has the Microsoft Teams bot installed and their Teams account connected. Upload storage accepts bytes, but the Teams activity send fails with a network error so delivery is uncertain. Row: target `conversation` (the connected channel conversation), outcome `uncertain`.
- When: The member calls `POST /api/integrations/teams/upload-file/init` for a canonical v2 `report.txt` upload to the connected conversation with text "Pinned account report", uploads the bytes, calls `POST /api/integrations/teams/upload-file/complete` twice with a replacement conversation and text, re-initializes with the same body and with a changed checksum, and finally completes as another user of the organization.
- Then: Init returns HTTP 200 with `uploadRequired` true. Both completions return HTTP 409 with identical bodies, and Teams receives exactly one send attempt in the connected conversation containing "Pinned account report" and not "Replacement text". Re-init returns the same upload and operation with `uploadRequired` false, a changed checksum returns 409, and the other user's completion returns 404 without another Teams send.

## integrations-teams-011

- Vitest: "Microsoft Teams integration CLI routes > owns a non-Run v2 direct DM upload and preserves its uncertain delivery outcome"
- Mode: run
- Given: A signed-in organization admin has the Microsoft Teams bot installed and their Teams account connected. Upload storage accepts bytes, but the Teams activity send fails with a network error so delivery is uncertain. Row: target `direct DM` (the existing DM conversation ID), outcome `uncertain`.
- When: The member calls `POST /api/integrations/teams/upload-file/init` for a canonical v2 `report.txt` upload to the DM conversation with text "Pinned account report", uploads the bytes, calls `POST /api/integrations/teams/upload-file/complete` twice with a replacement conversation and text, re-initializes with `user` `me` instead of the conversation and once with a changed checksum, and finally completes as another user of the organization.
- Then: Init returns HTTP 200 with `uploadRequired` true. Both completions return HTTP 409 with identical bodies, and Teams receives exactly one send attempt in the DM conversation containing "Pinned account report" and not "Replacement text". Re-init returns the same upload and operation with `uploadRequired` false, a changed checksum returns 409, and the other user's completion returns 404 without another Teams send.

## integrations-teams-012

- Vitest: "Microsoft Teams integration CLI routes > owns a non-Run v2 me upload and preserves its uncertain delivery outcome"
- Mode: run
- Given: A signed-in organization admin has the Microsoft Teams bot installed and their Teams account connected. Upload storage accepts bytes and Teams creates a DM with the caller, but the activity send fails with a network error so delivery is uncertain. Row: target `me`, outcome `uncertain`.
- When: The member calls `POST /api/integrations/teams/upload-file/init` for a canonical v2 `report.txt` upload addressed to `user` `me` with text "Pinned account report", uploads the bytes, calls `POST /api/integrations/teams/upload-file/complete` twice with a replacement conversation and text, re-initializes with the same body and with a changed checksum, and finally completes as another user of the organization.
- Then: Init returns HTTP 200 with `uploadRequired` true. Both completions return HTTP 409 with identical bodies, and Teams receives exactly one send attempt in the DM conversation containing "Pinned account report" and not "Replacement text". Re-init returns the same upload and operation with `uploadRequired` false, a changed checksum returns 409, and the other user's completion returns 404 without another Teams send.

## integrations-teams-013

- Vitest: "Microsoft Teams integration CLI routes > owns a non-Run v2 29:other-recipient upload and preserves its uncertain delivery outcome"
- Mode: run
- Given: A signed-in organization admin has the Microsoft Teams bot installed and their Teams account connected. Upload storage accepts bytes and Teams resolves `29:other-recipient` and creates a DM, but the activity send fails with a network error so delivery is uncertain. Row: target `29:other-recipient`, outcome `uncertain`.
- When: The member calls `POST /api/integrations/teams/upload-file/init` for a canonical v2 `report.txt` upload addressed to `user` `29:other-recipient` with text "Pinned account report", uploads the bytes, calls `POST /api/integrations/teams/upload-file/complete` twice with a replacement conversation and text, re-initializes with the same body and with a changed checksum, and finally completes as another user of the organization.
- Then: Init returns HTTP 200 with `uploadRequired` true. Both completions return HTTP 409 with identical bodies, and Teams receives exactly one send attempt in the DM conversation containing "Pinned account report" and not "Replacement text". Re-init returns the same upload and operation with `uploadRequired` false, a changed checksum returns 409, and the other user's completion returns 404 without another Teams send.

## integrations-teams-014

- Vitest: "Microsoft Teams integration CLI routes > requires an organization for a non-Run v2 upload"
- Mode: run
- Given: The caller is signed in without an active organization.
- When: The caller calls `POST /api/integrations/teams/upload-file/init` for a canonical v2 12-byte `report.txt` upload to conversation `19:example`.
- Then: The response is HTTP 403.

## integrations-teams-015

- Vitest: "Microsoft Teams integration CLI routes > sends an uploaded file URL as a Teams attachment"
- Mode: run
- Given: A signed-in organization admin has the Microsoft Teams bot installed and their Teams account connected. The member has initialized a canonical v2 1234-byte `report.pdf` upload for the connected conversation and thread with text "Daily report" and uploaded the bytes. Teams accepts activities.
- When: The member calls `POST /api/integrations/teams/upload-file/complete` with the upload and operation IDs, the conversation, thread `activityId`, content type `application/pdf` and text "Daily report", then requests `GET /api/web/file-url?file_id=<upload ID>` in their organization and again with a session in another organization.
- Then: Completion returns HTTP 200 with the activity ID, conversation ID, filename `report.pdf`, mimetype `application/pdf`, size 1234 and the prepared file URL. The file-URL lookup returns 200 with a null `publicUrl` for the owning organization and 404 for the other organization. The Teams activity replies to the thread, its text contains "Daily report" and a `[report.pdf]` link, and it carries an `application/pdf` attachment named `report.pdf` served from private artifact storage.

## integrations-teams-016

- Vitest: "Microsoft Teams integration CLI routes > delivers to Teams recipient me: file"
- Mode: run
- Given: A signed-in organization admin ("Ada Lovelace") has the Microsoft Teams bot installed and their Teams account connected. The member has initialized a canonical v2 1234-byte `report.pdf` upload addressed to `user` `me` and uploaded the bytes. Teams creates a DM with the caller and accepts activities.
- When: The member calls `POST /api/integrations/teams/upload-file/complete` with the upload and operation IDs, `user` `me` and content type `application/pdf`.
- Then: The response is HTTP 200 with the activity ID, the DM conversation ID and filename `report.pdf`. Teams creates a non-group conversation for bot "Nova" with the caller's Teams user named "Ada Lovelace" in the installation tenant, and the DM activity carries an `application/pdf` attachment named `report.pdf` from private artifact storage with no `replyToId`.

## integrations-teams-017

- Vitest: "Microsoft Teams integration CLI routes > delivers to Teams recipient 29:other-recipient: file"
- Mode: run
- Given: A signed-in organization admin has the Microsoft Teams bot installed and their Teams account connected. The member has initialized a canonical v2 1234-byte `report.pdf` upload addressed to `user` `29:other-recipient` and uploaded the bytes. Teams resolves that user, creates a DM and accepts activities.
- When: The member calls `POST /api/integrations/teams/upload-file/complete` with the upload and operation IDs, `user` `29:other-recipient` and content type `application/pdf`.
- Then: The response is HTTP 200 with the activity ID, the DM conversation ID and filename `report.pdf`. Teams creates a non-group conversation for bot "Nova" with member `29:other-recipient` in the installation tenant, and the DM activity carries an `application/pdf` attachment named `report.pdf` from private artifact storage with no `replyToId`.
