# slack-artifact-channel-sharing

## slack-artifact-channel-sharing-001

- Vitest: "privately prompts the file owner and shares only with the members present at click time"
- Mode: run
- Given: A workspace admin with an installed Slack workspace owns a private uploaded `report.pdf` (row `file`), with Slack artifact channel sharing and hosted-site email sharing enabled. The channel contains the owner, a connected viewer from another workspace, and a member with an email who leaves before the click; a new member with an email joins before the click.
- When: Slack delivers a signed `link_shared` event for the file link from the owner to `POST /api/webhooks/slack/events`, the owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`, and the same link is later posted again.
- Then: The owner alone receives an ephemeral prompt in the channel with `artifact_share_channel`, `artifact_share_organization` and `artifact_share_public`, and no shares exist before the click. After the click, `GET /api/artifact-sharing/:kind/:id/shares` lists exactly the viewer's and the new member's emails, the viewer can resolve the file reference (HTTP 200) to this file, two emails are sent, and the response-URL callback mentions "2 current channel members" without the departed email. Reposting the link triggers no unfurl or new prompt.

## slack-artifact-channel-sharing-002

- Vitest: "privately prompts the site owner and shares only with the members present at click time"
- Mode: run
- Given: A workspace admin with an installed Slack workspace owns a private hosted site (row `site`), with Slack artifact channel sharing and hosted-site email sharing enabled. The channel contains the owner, a connected viewer from another workspace, and a member with an email who leaves before the click; a new member with an email joins before the click.
- When: Slack delivers a signed `link_shared` event for the site link from the owner to `POST /api/webhooks/slack/events`, the owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`, and the same link is later posted again.
- Then: The owner alone receives an ephemeral prompt in the channel with `artifact_share_channel`, `artifact_share_organization` and `artifact_share_public`, and no shares exist before the click. After the click, `GET /api/artifact-sharing/:kind/:id/shares` lists exactly the viewer's and the new member's emails, two emails are sent, and the response-URL callback mentions "2 current channel members" without the departed email. Reposting the link triggers no unfurl or new prompt.

## slack-artifact-channel-sharing-003

- Vitest: "omits workspace visibility when already workspace-visible but still offers individual grants for external channel members"
- Mode: run
- Given: A Slack-connected workspace admin owns an uploaded file already shared with the organization. The channel has a connected same-workspace member and an external member with an email.
- When: The owner's link is delivered as a `link_shared` event to `POST /api/webhooks/slack/events` and the owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`.
- Then: The prompt offers only `artifact_share_channel` and `artifact_share_public`. After the click there is exactly one individual share, and `POST /api/artifact-shares/status` still reports `organization`.

## slack-artifact-channel-sharing-004

- Vitest: "does not prompt when all channel members already have workspace access"
- Mode: run
- Given: A Slack-connected workspace admin owns an uploaded file already shared with the organization, and the only other channel member is a connected member of the same workspace.
- When: The owner's link is delivered as a `link_shared` event to `POST /api/webhooks/slack/events`.
- Then: No ephemeral prompt is posted.

## slack-artifact-channel-sharing-005

- Vitest: "recognizes existing workspace access by verified email without requiring a Slack account binding"
- Mode: run
- Given: A Slack-connected workspace admin owns an uploaded file already shared with the organization. Another channel member has no Slack account binding but their Slack email matches a verified email of a member of the same workspace.
- When: The owner's link is delivered as a `link_shared` event to `POST /api/webhooks/slack/events`.
- Then: No ephemeral prompt is posted and no individual shares exist.

## slack-artifact-channel-sharing-006

- Vitest: "does not prompt or inspect members for public artifacts"
- Mode: run
- Given: A Slack-connected workspace admin owns a public hosted site, and the channel has an external member with an email.
- When: The owner's site link is delivered as a `link_shared` event to `POST /api/webhooks/slack/events`.
- Then: No ephemeral prompt is posted, channel membership is not read, and Slack is asked to unfurl the link in that channel.

## slack-artifact-channel-sharing-007

- Vitest: "never changes access when a link is posted with the feature disabled"
- Mode: run
- Given: A Slack-connected workspace admin owns a private uploaded file with Slack artifact channel sharing disabled, and the channel has an external member with an email.
- When: The owner's link is delivered as a `link_shared` event to `POST /api/webhooks/slack/events`.
- Then: No ephemeral prompt is posted, channel membership is not read, and no individual shares exist.

## slack-artifact-channel-sharing-008

- Vitest: "does not let a connected non-owner manage another person's artifact"
- Mode: run
- Given: A Slack-connected workspace admin owns a private uploaded file, and a connected Slack user from another workspace is in the channel.
- When: The other user's post of the link is delivered as a `link_shared` event to `POST /api/webhooks/slack/events`.
- Then: No ephemeral prompt is posted and no individual shares exist.

## slack-artifact-channel-sharing-009

- Vitest: "paginates channel membership, including an empty page with a continuation"
- Mode: run
- Given: A Slack-connected workspace admin owns a private uploaded file. Slack's channel member list returns an empty first page with a continuation cursor, then a page with the owner and one member with an email.
- When: The owner's link is delivered to `POST /api/webhooks/slack/events` and the owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`.
- Then: The shares list contains exactly the last-page member's email.

## slack-artifact-channel-sharing-010

- Vitest: "reports missing email separately while sharing with identifiable members"
- Mode: run
- Given: A Slack-connected workspace admin owns a private uploaded file. The channel has one member without an email and one member with an email.
- When: The owner's link is delivered to `POST /api/webhooks/slack/events` and the owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`.
- Then: Exactly one share is created, and the callback text mentions the member without email as `<@id>` and "Could not finish sharing".

## slack-artifact-channel-sharing-011

- Vitest: "does not equate an unavailable member list with an empty channel"
- Mode: run
- Given: A Slack-connected workspace admin owns a private uploaded file and the channel has a member with an email. After the prompt is posted, Slack's channel member list fails.
- When: The owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`.
- Then: No shares are created and the callback text contains "could not be verified".

## slack-artifact-channel-sharing-012

- Vitest: "rejects a stale or mismatched user action"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file; the channel has a member with an email.
- When: The button click is posted to `POST /api/webhooks/slack/interactive` with a different Slack `user` ID (row `user`).
- Then: The interactive response is ephemeral with text containing "expired", no shares are created, and no response-URL callback is sent.

## slack-artifact-channel-sharing-013

- Vitest: "rejects a stale or mismatched team action"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file; the channel has a member with an email.
- When: The button click is posted to `POST /api/webhooks/slack/interactive` with a different Slack `team` ID (row `team`).
- Then: The interactive response is ephemeral with text containing "expired", no shares are created, and no response-URL callback is sent.

## slack-artifact-channel-sharing-014

- Vitest: "rejects a stale or mismatched channel action"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file; the channel has a member with an email.
- When: The button click is posted to `POST /api/webhooks/slack/interactive` with a different `channel` ID (row `channel`).
- Then: The interactive response is ephemeral with text containing "expired", no shares are created, and no response-URL callback is sent.

## slack-artifact-channel-sharing-015

- Vitest: "rejects a stale or mismatched token action"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file; the channel has a member with an email.
- When: The button click is posted to `POST /api/webhooks/slack/interactive` with the action value replaced by `tampered` (row `token`).
- Then: The interactive response is ephemeral with text containing "expired", no shares are created, and no response-URL callback is sent.

## slack-artifact-channel-sharing-016

- Vitest: "rejects a stale or mismatched expired action"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file; the channel has a member with an email. The clock then advances 16 minutes (row `expired`).
- When: The unchanged button click is posted to `POST /api/webhooks/slack/interactive`.
- Then: The interactive response is ephemeral with text containing "expired", no shares are created, and no response-URL callback is sent.

## slack-artifact-channel-sharing-017

- Vitest: "does not duplicate invitations when the same button is clicked again"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file; the channel has one member with an email.
- When: The owner clicks `artifact_share_channel` twice via `POST /api/webhooks/slack/interactive`.
- Then: Exactly one share exists, one email is sent, and the last callback says the members "already have access or an invitation".

## slack-artifact-channel-sharing-018

- Vitest: "shares with more than ten channel members in one action"
- Mode: run
- Given: A Slack-connected workspace admin owns a private file and the channel has 12 members with emails.
- When: The owner's link is delivered to `POST /api/webhooks/slack/events` and the owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`.
- Then: Twelve shares are created and the callback does not mention "limit was reached".

## slack-artifact-channel-sharing-019

- Vitest: "keeps confirmed invitations when the existing hourly recipient limit is reached"
- Mode: run
- Given: A Slack-connected workspace admin owns a private file and the channel has 61 members with emails.
- When: The owner posts the link and clicks `artifact_share_channel`; the clock advances just over an hour and the owner posts the link and clicks again.
- Then: The first click creates 60 shares and its callback contains "sharing limit was reached" and "1 remaining". After the second click there are 61 shares and 61 emails sent in total.

## slack-artifact-channel-sharing-020

- Vitest: "can make a file workspace-visible from the private owner prompt"
- Mode: run
- Given: A Slack-connected workspace admin owns a private uploaded file (row `file`) and the channel has a member with an email.
- When: The owner's link is delivered to `POST /api/webhooks/slack/events` and the owner clicks `artifact_share_organization` via `POST /api/webhooks/slack/interactive`.
- Then: `POST /api/artifact-shares/status` reports audience `organization`, and no unfurl is requested.

## slack-artifact-channel-sharing-021

- Vitest: "can make a site workspace-visible from the private owner prompt"
- Mode: run
- Given: A Slack-connected workspace admin owns a private hosted site (row `site`) and the channel has a member with an email.
- When: The owner's site link is delivered to `POST /api/webhooks/slack/events` and the owner clicks `artifact_share_organization` via `POST /api/webhooks/slack/interactive`.
- Then: `GET /api/host/sites/:siteId/visibility` reports `organization`, and no unfurl is requested.

## slack-artifact-channel-sharing-022

- Vitest: "can make a hosted site public and refresh the original Slack preview"
- Mode: run
- Given: A Slack-connected workspace admin owns a private hosted site and the channel has a member with an email.
- When: The owner's site link is delivered to `POST /api/webhooks/slack/events` and the owner clicks `artifact_share_public` via `POST /api/webhooks/slack/interactive`.
- Then: `GET /api/host/sites/:siteId/visibility` reports `public`, and Slack is asked to unfurl the site URL in the original channel message `1795586400.000001`.

## slack-artifact-channel-sharing-023

- Vitest: "does not repeat private prompts for retries, refreshes, or composer events"
- Mode: run
- Given: A Slack-connected workspace admin owns a private file and the channel has a member with an email.
- When: The owner's link is delivered to `POST /api/webhooks/slack/events` as a Slack retry (`x-slack-retry-num: 1`), as an unfurl refresh, and with source `composer`.
- Then: No ephemeral prompt is posted for any of them.

## slack-artifact-channel-sharing-024

- Vitest: "shares a website through its App artifact reference"
- Mode: run
- Given: A Slack-connected workspace admin owns a private hosted site whose link is its App artifact reference URL, and the channel has one member with an email.
- When: The owner's link is delivered to `POST /api/webhooks/slack/events` and the owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`.
- Then: The shares list contains exactly that member's email.

## slack-artifact-channel-sharing-025

- Vitest: "skips existing email invitations and ignores bots and deleted members"
- Mode: run
- Given: A Slack-connected workspace admin owns a private file already shared by email with one channel member via `POST /api/artifact-sharing/:kind/:id/shares`. The other channel members are a bot and a deleted Slack user.
- When: The owner's link is delivered to `POST /api/webhooks/slack/events`.
- Then: The email share returns HTTP 200. No ephemeral prompt is posted and no further emails are sent.

## slack-artifact-channel-sharing-026

- Vitest: "rechecks disabled before applying an old sharing button"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file, and the feature switch is then turned off (row `disabled`).
- When: The owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`.
- Then: The callback text says the action is "no longer available" or "could not be verified", and no shares exist.

## slack-artifact-channel-sharing-027

- Vitest: "rechecks membership before applying an old sharing button"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file, and the owner's workspace membership then disappears (row `membership`).
- When: The owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`.
- Then: The callback text says the action is "no longer available" or "could not be verified", and no shares exist.

## slack-artifact-channel-sharing-028

- Vitest: "rechecks banned before applying an old sharing button"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file, and the owner's account is then banned (row `banned`).
- When: The owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`.
- Then: The callback text says the action is "no longer available" or "could not be verified", and no shares exist.

## slack-artifact-channel-sharing-029

- Vitest: "rechecks left-channel before applying an old sharing button"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file, and the owner then leaves the channel (row `left-channel`).
- When: The owner clicks `artifact_share_channel` via `POST /api/webhooks/slack/interactive`.
- Then: The callback text says the action is "no longer available" or "could not be verified", and no shares exist.

## slack-artifact-channel-sharing-030

- Vitest: "rejects a forged callback destination"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file; the channel has a member with an email.
- When: The click is posted to `POST /api/webhooks/slack/interactive` with `response_url` `https://example.com/actions/steal`.
- Then: The interactive response is ephemeral and no shares are created.

## slack-artifact-channel-sharing-031

- Vitest: "can make a file public and refresh its original preview"
- Mode: run
- Given: A Slack-connected workspace admin owns a private uploaded file and the channel has a member with an email.
- When: The owner's link is delivered to `POST /api/webhooks/slack/events` and the owner clicks `artifact_share_public` via `POST /api/webhooks/slack/interactive`.
- Then: `POST /api/artifact-shares/status` reports `public`, and Slack is asked to unfurl the file URL in that channel.

## slack-artifact-channel-sharing-032

- Vitest: "an owner can change general visibility when channel membership cannot be read"
- Mode: run
- Given: A Slack-connected workspace admin received a channel-sharing prompt for a private file, and Slack's channel member list then fails.
- When: The owner clicks `artifact_share_public` via `POST /api/webhooks/slack/interactive`.
- Then: `POST /api/artifact-shares/status` reports `public`.
