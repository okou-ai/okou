# integrations-teams-installation-owner

## integrations-teams-installation-owner-001

- Vitest: "Teams installation read ownership > sends a personal card using the publicly connected installation"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed, and the member has connected their Teams account ("Teams User"). The Teams Bot Framework creates personal conversation `a:personal-<Teams user ID>` and accepts activities.
- When: The member calls `POST /api/integrations/teams/message` with `user` `me`, text "Personal card summary" and an Adaptive Card.
- Then: The response is HTTP 200 with exactly `ok: true`, activity ID `delivered-activity` and the personal conversation ID. Teams receives exactly two requests with the installation's bot token: a non-group conversation creation for the bot "Nova" with the member's Teams user (named "Teams User") in the installation tenant, then a message activity with summary "Personal card summary", the card as an Adaptive Card attachment and the tenant channel data.

## integrations-teams-installation-owner-002

- Vitest: "Teams installation read ownership > uploads public request bytes and delivers a personal attachment"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed, and the member has connected their Teams account. Upload storage accepts the bytes, and Teams creates personal conversation `a:personal-<Teams user ID>` and accepts activities.
- When: The member calls `POST /api/integrations/teams/upload-file/init` with a canonical `notes.txt` (`text/plain`) upload addressed to `user` `me` with text "Uploaded notes", uploads the bytes to the returned URL, then calls `POST /api/integrations/teams/upload-file/complete` with the upload and operation IDs, `user` `me` and the same text.
- Then: Init returns HTTP 200 with filename `notes.txt`, content type `text/plain` and the byte size, and the byte upload returns 200. Completion returns HTTP 200 with exactly the delivered activity ID, conversation ID, filename, mimetype `text/plain`, size and the file URL. Teams receives a personal conversation creation for the member's Teams user and a markdown message "Uploaded notes" followed by a `[notes.txt](<file URL>)` link with a `text/plain` attachment served from private artifact storage, in the installation tenant.

## integrations-teams-installation-owner-003

- Vitest: "Teams installation read ownership > reports the missing installation for a publicly onboarded message sender"
- Mode: run
- Given: A publicly onboarded, signed-in member's organization has no Microsoft Teams installation.
- When: The member calls `POST /api/integrations/teams/message` with `user` `me` and text "No installation".
- Then: The response is HTTP 404 with exactly the error code `NOT_FOUND` and message "No Microsoft Teams installation found for this organization".

## integrations-teams-installation-owner-004

- Vitest: "Teams installation read ownership > reports the missing installation before allocating an upload"
- Mode: run
- Given: A publicly onboarded, signed-in member's organization has no Microsoft Teams installation.
- When: The member calls `POST /api/integrations/teams/upload-file/init` with a canonical 7-byte `missing.txt` upload addressed to `user` `me`.
- Then: The response is HTTP 404 with exactly the error code `NOT_FOUND` and message "No Microsoft Teams installation found for this organization".

## integrations-teams-installation-owner-005

- Vitest: "Teams target command ownership > reports a disconnected personal message recipient while retaining the installation"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed; the member had connected their Teams account but has disconnected it, and the status endpoint reports installed, not connected, for the installation tenant.
- When: The member calls `POST /api/integrations/teams/message` with `user` `me` and text "Disconnected recipient".
- Then: The response is HTTP 404 with exactly the error code `NOT_FOUND` and message "This Teams conversation is unavailable to your connected account and Okou.".

## integrations-teams-installation-owner-006

- Vitest: "Teams target command ownership > rejects an upload addressed to a disconnected personal recipient"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed and the member connected their Teams account. The member initializes a canonical `disconnected.txt` upload addressed to `user` `me` and uploads its bytes, then disconnects their Teams account so the status reports installed but not connected.
- When: The member calls `POST /api/integrations/teams/upload-file/complete` with the upload and operation IDs and `user` `me`.
- Then: The init and byte upload succeed, and the completion returns HTTP 404 with exactly the error code `NOT_FOUND` and message "This Teams conversation is unavailable to your connected account and Okou.".

## integrations-teams-installation-owner-007

- Vitest: "Teams target command ownership > authorizes an explicit Teams user when caller connected=true"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed and the member's Teams account is connected. Teams resolves an explicit Teams user ID in the installation tenant, creates a new conversation and accepts activities.
- When: The member calls `POST /api/integrations/teams/message` with that explicit Teams `user` ID and text "Explicit recipient".
- Then: The response is HTTP 200 with exactly `ok: true`, activity ID `delivered-activity` and the conversation ID. Teams receives two requests with the bot token: a non-group conversation creation for bot "Nova" with the explicit user in the installation tenant, then a markdown message "Explicit recipient" with the tenant channel data.

## integrations-teams-installation-owner-008

- Vitest: "Teams target command ownership > authorizes an explicit Teams user when caller connected=false"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed, but the member has disconnected their Teams account so the status reports installed but not connected.
- When: The member calls `POST /api/integrations/teams/message` with an explicit Teams `user` ID and text "Explicit recipient".
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and no request is sent to Teams.

## integrations-teams-installation-owner-009

- Vitest: "Teams explicit target delivery > authorizes an explicit Teams file recipient when caller connected=true"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed and the member's Teams account is connected. Upload storage accepts bytes, and Teams creates a new conversation with an explicit Teams user and accepts activities.
- When: The member calls `POST /api/integrations/teams/upload-file/init` with a canonical `explicit.txt` upload addressed to that explicit Teams `user` with text "Explicit attachment", uploads the bytes, then calls `POST /api/integrations/teams/upload-file/complete` with the same target and text.
- Then: Init and the byte upload succeed. Completion returns HTTP 200 with exactly the delivered activity ID, conversation ID, filename `explicit.txt`, mimetype `text/plain`, size and file URL. Teams receives two requests with the bot token: a personal conversation creation with the explicit user in the installation tenant, then a markdown message "Explicit attachment" with the `[explicit.txt](<file URL>)` link and a `text/plain` attachment from private artifact storage.

## integrations-teams-installation-owner-010

- Vitest: "Teams explicit target delivery > authorizes an explicit Teams file recipient when caller connected=false"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed, but the member has disconnected their Teams account so the status reports installed but not connected.
- When: The member calls `POST /api/integrations/teams/upload-file/init` with a canonical `explicit.txt` upload addressed to an explicit Teams `user` ID.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and no request is sent to Teams.

## integrations-teams-installation-owner-011

- Vitest: "Teams explicit target delivery > authorizes an explicit Teams reply when caller connected=true"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed and the member's Teams account is connected. Teams accepts replies in an explicit channel conversation.
- When: The member calls `POST /api/integrations/teams/message` with an explicit `conversationId` and `activityId`, text "Explicit reply" and an Adaptive Card.
- Then: The response is HTTP 200 with exactly `ok: true`, activity ID `delivered-activity` and that conversation ID. Teams receives exactly one request with the bot token to reply to that activity, with summary "Explicit reply", `replyToId` set to the activity, the card as an Adaptive Card attachment and the tenant channel data.

## integrations-teams-installation-owner-012

- Vitest: "Teams explicit target delivery > authorizes an explicit Teams reply when caller connected=false"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed, but the member has disconnected their Teams account so the status reports installed but not connected.
- When: The member calls `POST /api/integrations/teams/message` with an explicit `conversationId` and `activityId`, text "Explicit reply" and an Adaptive Card.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and no request is sent to Teams.

## integrations-teams-installation-owner-013

- Vitest: "Teams explicit target delivery > authorizes a Teams reply attachment when caller connected=true"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed and the member's Teams account is connected. Upload storage accepts bytes and Teams accepts replies in an explicit channel conversation.
- When: The member calls `POST /api/integrations/teams/upload-file/init` with a canonical `reply.txt` upload targeting an explicit `conversationId` and `activityId` with text "Reply attachment", uploads the bytes, then calls `POST /api/integrations/teams/upload-file/complete` with the same target and text.
- Then: Init and the byte upload succeed. Completion returns HTTP 200 with exactly the delivered activity ID, conversation ID, filename `reply.txt`, mimetype `text/plain`, size and file URL. Teams receives exactly one reply request to that activity with `replyToId`, a markdown "Reply attachment" message with the `[reply.txt](<file URL>)` link and a `text/plain` attachment from private artifact storage.

## integrations-teams-installation-owner-014

- Vitest: "Teams explicit target delivery > authorizes a Teams reply attachment when caller connected=false"
- Mode: run
- Given: An onboarded, signed-in member's organization has the Microsoft Teams bot installed, but the member has disconnected their Teams account so the status reports installed but not connected.
- When: The member calls `POST /api/integrations/teams/upload-file/init` with a canonical `reply.txt` upload targeting an explicit `conversationId` and `activityId`.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and no request is sent to Teams.
