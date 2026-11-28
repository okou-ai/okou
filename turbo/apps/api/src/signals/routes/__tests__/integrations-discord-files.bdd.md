# integrations-discord-files

## integrations-discord-files-001

- Vitest: "Discord file authorization and input validation > requires authentication for every file endpoint"
- Mode: run
- Given: The caller is not authenticated.
- When: The caller sends `POST /api/integrations/discord/upload-file/init`, `POST /api/integrations/discord/upload-file/materialize`, `POST /api/integrations/discord/upload-file/complete` and `GET /api/integrations/discord/download-file/url` without credentials.
- Then: Every request returns HTTP 401 with error code `UNAUTHORIZED`.

## integrations-discord-files-002

- Vitest: "Discord file authorization and input validation > requires native read or write capability for sandbox requests"
- Mode: run
- Given: A member has launched a Discord-originated Run, and the Run's sandbox token lacks the native Discord read and write capabilities.
- When: The sandbox token calls `POST /api/integrations/discord/upload-file/init` and `GET /api/integrations/discord/download-file/url`.
- Then: Both return HTTP 403; the upload error message mentions `discord:write` and the download error message mentions `discord:read`.

## integrations-discord-files-003

- Vitest: "Discord file authorization and input validation > rejects an unbound caller"
- Mode: run
- Given: A signed-in member's workspace has no Discord binding, although the Discord app is configured and the member is listed as a workspace member.
- When: The member calls `GET /api/integrations/discord/download-file/url` for a channel, message and attachment.
- Then: The response is HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-files-004

- Vitest: "Discord file authorization and input validation > rejects malformed upload metadata: {\"filename\":\"../report.csv\"}"
- Mode: run
- Given: A signed-in member prepares a Discord upload whose filename is `../report.csv`.
- When: The member sends `POST /api/integrations/discord/upload-file/init`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-files-005

- Vitest: "Discord file authorization and input validation > rejects malformed upload metadata: {\"filename\":\"report\\r\\n.csv\"}"
- Mode: run
- Given: A signed-in member prepares a Discord upload whose filename contains a CRLF (`report\r\n.csv`).
- When: The member sends `POST /api/integrations/discord/upload-file/init`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-files-006

- Vitest: "Discord file authorization and input validation > rejects malformed upload metadata: {\"filename\":\"report\\\\private.csv\"}"
- Mode: run
- Given: A signed-in member prepares a Discord upload whose filename contains a backslash (`report\private.csv`).
- When: The member sends `POST /api/integrations/discord/upload-file/init`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-files-007

- Vitest: "Discord file authorization and input validation > rejects malformed upload metadata: {\"filename\":\".\"}"
- Mode: run
- Given: A signed-in member prepares a Discord upload whose filename is `.`.
- When: The member sends `POST /api/integrations/discord/upload-file/init`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-files-008

- Vitest: "Discord file authorization and input validation > rejects malformed upload metadata: {\"length\":10485761}"
- Mode: run
- Given: A signed-in member prepares a Discord upload whose length is one byte over the maximum Discord file size (10,485,761 bytes).
- When: The member sends `POST /api/integrations/discord/upload-file/init`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-files-009

- Vitest: "Discord file authorization and input validation > rejects download identifiers that cannot identify a Discord attachment"
- Mode: run
- Given: A signed-in member is authenticated.
- When: The member calls `GET /api/integrations/discord/download-file/url` with attachment ID `../../credentials`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-files-010

- Vitest: "Discord attachment downloads > resolves fresh attachment metadata with MIME type text/csv"
- Mode: run
- Given: A signed-in admin's workspace is bound to their Discord account in a guild, and Discord returns the source message with the attachment `quarterly report.csv` at a fresh signed URL with content type `text/csv` (row: `text/csv`).
- When: The admin calls `GET /api/integrations/discord/download-file/url` with the channel, message and attachment IDs.
- Then: The response is HTTP 200 with exactly the fresh download URL, filename, content type `text/csv` and size, and header `cache-control: private, no-store`.

## integrations-discord-files-011

- Vitest: "Discord attachment downloads > resolves fresh attachment metadata with MIME type application/octet-stream"
- Mode: run
- Given: A signed-in admin's workspace is bound to their Discord account in a guild, and Discord returns the source message with the attachment `quarterly report.csv` at a fresh signed URL without a content type (row: `application/octet-stream`).
- When: The admin calls `GET /api/integrations/discord/download-file/url` with the channel, message and attachment IDs.
- Then: The response is HTTP 200 with exactly the fresh download URL, filename, content type `application/octet-stream` and size, and header `cache-control: private, no-store`.

## integrations-discord-files-012

- Vitest: "Discord attachment downloads > requires the member to have ATTACH_FILES in addition to readable channel access"
- Mode: run
- Given: A signed-in admin's workspace is bound to their Discord account, and the guild channel's permission overwrite denies ATTACH_FILES to the member's Discord user (row: `member`) while the channel stays readable.
- When: The admin calls `GET /api/integrations/discord/download-file/url` for an attachment in the channel and `POST /api/integrations/discord/upload-file/init` for the same channel.
- Then: The download returns HTTP 200 with the attachment URL and filename; the upload init returns HTTP 404 with `NOT_FOUND`.

## integrations-discord-files-013

- Vitest: "Discord attachment downloads > requires the bot to have ATTACH_FILES in addition to readable channel access"
- Mode: run
- Given: A signed-in admin's workspace is bound to their Discord account, and the guild channel's permission overwrite denies ATTACH_FILES to the bot user (row: `bot`) while the channel stays readable.
- When: The admin calls `GET /api/integrations/discord/download-file/url` for an attachment in the channel and `POST /api/integrations/discord/upload-file/init` for the same channel.
- Then: The download returns HTTP 200 with the attachment URL and filename; the upload init returns HTTP 404 with `NOT_FOUND`.

## integrations-discord-files-014

- Vitest: "Discord attachment downloads > denies own bot DM downloads while allowing outbound file delivery"
- Mode: run
- Given: A signed-in admin's workspace is bound to their Discord account, and the attachment's channel is the bot's DM with the admin's own Discord user (row: `own`); Discord opens that DM for outbound delivery and accepts the file message.
- When: The admin calls `GET /api/integrations/discord/download-file/url` for the DM attachment, then initializes an upload addressed to the user ID, stores the bytes, and calls `POST /api/integrations/discord/upload-file/materialize` and `POST /api/integrations/discord/upload-file/complete`.
- Then: The download returns HTTP 403 with `DISCORD_DM_READ_DENIED`. The upload gets an asset ID, any DM-open request names that recipient, Discord receives the exact file bytes with no allowed mentions, and completion returns HTTP 200 with delivery status `delivered`.

## integrations-discord-files-015

- Vitest: "Discord attachment downloads > denies other bot DM downloads while allowing outbound file delivery"
- Mode: run
- Given: A signed-in admin's workspace is bound to their Discord account, and the attachment's channel is the bot's DM with a different Discord user (row: `other`); Discord opens that DM for outbound delivery and accepts the file message.
- When: The admin calls `GET /api/integrations/discord/download-file/url` for the DM attachment, then initializes an upload addressed to that user ID, stores the bytes, and calls `POST /api/integrations/discord/upload-file/materialize` and `POST /api/integrations/discord/upload-file/complete`.
- Then: The download returns HTTP 404 with `NOT_FOUND`. The upload gets an asset ID, any DM-open request names that recipient, Discord receives the exact file bytes with no allowed mentions, and completion returns HTTP 200 with delivery status `delivered`.

## integrations-discord-files-016

- Vitest: "Canonical Discord file publication and delivery > does not expose another user's asset through materialize or complete"
- Mode: run
- Given: A bound admin has initialized and stored a Discord upload, and another member of the same workspace (row: `user`) is signed in.
- When: The other member calls `POST /api/integrations/discord/upload-file/materialize` and `POST /api/integrations/discord/upload-file/complete` with the admin's asset and operation IDs.
- Then: Both return HTTP 404 with `NOT_FOUND`.

## integrations-discord-files-017

- Vitest: "Canonical Discord file publication and delivery > does not expose another organization's asset through materialize or complete"
- Mode: run
- Given: A bound admin has initialized and stored a Discord upload, and the same user signs in under another workspace (row: `organization`).
- When: The user calls `POST /api/integrations/discord/upload-file/materialize` and `POST /api/integrations/discord/upload-file/complete` with the asset and operation IDs.
- Then: Both return HTTP 404 with `NOT_FOUND`.

## integrations-discord-files-018

- Vitest: "Canonical Discord file publication and delivery > publishes one canonical artifact before delivery and reuses its receipt"
- Mode: run
- Given: A signed-in admin's workspace is bound to Discord, and Discord accepts the file message in the target channel.
- When: The admin sends `POST /api/integrations/discord/upload-file/init`, stores the bytes, calls `POST /api/integrations/discord/upload-file/materialize`, reads `GET /api/artifacts/catalog` and `GET /api/artifacts/catalog/:artifactId`, repeats init with the same body, and calls `POST /api/integrations/discord/upload-file/complete` twice.
- Then: Init signs a storage PUT under `private-artifacts/<assetId>/report.csv` without a checksum binding. Materialize returns the operation, URL and delivery `pending`; the catalog lists exactly one `file` artifact with the asset ID, filename, `text/csv`, size and URL. The repeated init returns the same operation and URL. Both completions return the identical `delivered` receipt with channel, message and attachment IDs and the guild permalink; Discord is sent the bytes exactly once and the catalog is unchanged.

## integrations-discord-files-019

- Vitest: "Canonical Discord file publication and delivery > reuses concurrent upload initialization for one operation"
- Mode: run
- Given: A signed-in admin's workspace is bound to Discord.
- When: The admin sends two concurrent `POST /api/integrations/discord/upload-file/init` requests with the same operation body, then repeats it.
- Then: Both concurrent requests return HTTP 200 with the same asset ID and URL, and the repeat returns the same asset ID.

## integrations-discord-files-020

- Vitest: "Canonical Discord file publication and delivery > keeps exactly one destination when an upload operation races"
- Mode: run
- Given: A signed-in admin's workspace is bound to Discord.
- When: The admin concurrently sends `POST /api/integrations/discord/upload-file/init` for one operation ID with two different captions, then repeats each request.
- Then: One request returns HTTP 200 and the other HTTP 409. Each repeat returns the same status as its first attempt, and the accepted caption's repeat returns the same asset ID.

## integrations-discord-files-021

- Vitest: "Canonical Discord file publication and delivery > preserves the provider across concurrent initialization and replay (discord first)"
- Mode: run
- Given: A signed-in admin is bound to Discord and has a connected Slack installation with a shared channel; the admin's Pro Run is executing, and its Okou run token is used. The Discord init is sent first (row: `discord`).
- When: The run token initializes the operation with `POST /api/integrations/discord/upload-file/init`, then sends the same operation concurrently to the Discord init and to `POST /api/integrations/slack/upload-file/init`, and repeats each.
- Then: The first init returns HTTP 200. Of the concurrent pair, one returns HTTP 200 and the other HTTP 409; each repeat returns the same status, and the accepted provider's repeat returns the same asset ID, operation ID and URL.

## integrations-discord-files-022

- Vitest: "Canonical Discord file publication and delivery > preserves the provider across concurrent initialization and replay (slack first)"
- Mode: run
- Given: A signed-in admin is bound to Discord and has a connected Slack installation with a shared channel; the admin's Pro Run is executing, and its Okou run token is used. The Slack init is sent first (row: `slack`).
- When: The run token initializes the operation with `POST /api/integrations/slack/upload-file/init`, then sends the same operation concurrently to it and to `POST /api/integrations/discord/upload-file/init`, and repeats each.
- Then: The first init returns HTTP 200. Of the concurrent pair, one returns HTTP 200 and the other HTTP 409; each repeat returns the same status, and the accepted provider's repeat returns the same asset ID, operation ID and URL.

## integrations-discord-files-023

- Vitest: "Canonical Discord file publication and delivery > rejects reuse of an operation for a different destination or file"
- Mode: run
- Given: A signed-in admin bound to Discord has initialized and stored an upload for a channel, and another readable channel exists in the same guild.
- When: The admin repeats `POST /api/integrations/discord/upload-file/init` for the same operation with the other channel, with filename `different.csv`, and with the original body.
- Then: The other channel and other filename each return HTTP 409 with `CONFLICT`; the original body returns HTTP 200 with the original asset ID and URL.

## integrations-discord-files-024

- Vitest: "Canonical Discord file publication and delivery > refuses publication when the stored bytes have a different checksum"
- Mode: run
- Given: A signed-in admin bound to Discord has initialized an upload, but the stored bytes differ from the declared SHA-256 checksum.
- When: The admin calls `POST /api/integrations/discord/upload-file/materialize` and then lists `GET /api/artifacts/catalog`.
- Then: Materialize returns HTTP 400 with code `INVALID_FILE` and a message mentioning the checksum, and the catalog is empty.

## integrations-discord-files-025

- Vitest: "Canonical Discord file publication and delivery > does not send a file again after Discord's response is lost"
- Mode: run
- Given: A signed-in admin bound to Discord has initialized, stored and materialized an upload, and Discord receives the file message but the response is lost in a network error.
- When: The admin calls `POST /api/integrations/discord/upload-file/complete` twice and lists `GET /api/artifacts/catalog`.
- Then: The first completion returns HTTP 200 with delivery `failed` and `retryable: false`; the second returns the identical delivery. Discord receives the bytes exactly once, and the catalog still lists one artifact.

## integrations-discord-files-026

- Vitest: "Canonical Discord file publication and delivery > records the receipt when Discord normalizes the attachment filename"
- Mode: run
- Given: A signed-in admin bound to Discord has materialized an upload named `quarterly report.csv`, and Discord stores the attachment as `quarterly_report.csv`.
- When: The admin calls `POST /api/integrations/discord/upload-file/complete`.
- Then: The response is HTTP 200 with delivery exactly `delivered` with the channel, message and attachment IDs and the guild permalink.

## integrations-discord-files-027

- Vitest: "Canonical Discord file publication and delivery > reports a Discord rate limit without sending again on a later completion"
- Mode: run
- Given: A signed-in admin bound to Discord has materialized an upload, and Discord rejects the file message with HTTP 429 rate limit.
- When: The admin calls `POST /api/integrations/discord/upload-file/complete` twice.
- Then: The first completion returns HTTP 200 with delivery exactly `{status: "failed", message: "Discord rejected the file delivery", retryable: false}`; the second returns the same delivery, and Discord receives the file only once.

## integrations-discord-files-028

- Vitest: "Canonical Discord file publication and delivery > pre-claim completion ownership > allows only one external message when completion requests overlap"
- Mode: run
- Given: A signed-in admin bound to Discord has materialized an upload; reading the stored file and the Discord send are both slow, so two completions overlap.
- When: The admin sends `POST /api/integrations/discord/upload-file/complete`, then a second completion for the same operation while the first is still delivering.
- Then: The overlapping completion returns HTTP 200 with delivery `pending`. The first returns HTTP 200 with delivery `delivered` and the Discord message ID; both responses share the asset ID, operation ID and URL, and Discord receives exactly one message.

## integrations-discord-files-029

- Vitest: "Canonical Discord file publication and delivery > does not replay a receipt after its verified connection is removed or replaced"
- Mode: run
- Given: A signed-in admin bound to Discord has delivered a materialized upload to Discord.
- When: The Discord binding is removed and the admin calls `POST /api/integrations/discord/upload-file/complete`; the same Discord account is then bound again with a new connection and the admin completes again.
- Then: The initial completion is `delivered`. Both later completions return HTTP 404 with `NOT_FOUND`, the replacement has a different connection ID, and Discord received the file only once.

## integrations-discord-files-030

- Vitest: "Canonical Discord file publication and delivery > keeps a Run-owned Discord upload visible in its originating chat thread"
- Mode: run
- Given: A Pro admin bound to Discord has an executing chat Run, and the Run's Okou token is used.
- When: The run token initializes and stores a Discord upload, calls `POST /api/integrations/discord/upload-file/materialize`, and the admin lists `GET /api/chat-threads/:threadId/artifacts` for the originating thread.
- Then: Materialize returns HTTP 200, and the thread's artifacts include the Run with exactly that file (asset ID, filename and URL) whose asset reference is a `published-output` with materialization `ready`.

## integrations-discord-files-031

- Vitest: "Canonical Discord file publication and delivery > creates the Discord output thread only when the prepared file is sent"
- Mode: run
- Given: A member is connected to Discord, and a guild-channel message mentioning the bot asks to publish a report; Discord's first thread-creation request is rate limited and later succeeds.
- When: The signed gateway event arrives at `POST /api/internal/discord/gateway`; the admitted Run's token initializes and stores an upload targeting the source message, calls `POST /api/integrations/discord/upload-file/materialize`, and calls `POST /api/integrations/discord/upload-file/complete` twice; the member lists `GET /api/chat-threads/:threadId/artifacts`.
- Then: The gateway event is `accepted` and creates a chat whose prompt event has a Run and a Discord source link to the message. No Discord thread exists after init or materialize (materialize returns delivery `pending`). The first completion returns HTTP 429 and still creates no thread; the second returns HTTP 200 `delivered` to the new thread under the guild channel with the message, attachment and permalink, and Discord receives the exact bytes. The thread's artifacts list the Run's file as a ready `published-output`.
