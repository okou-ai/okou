# Discord integration parity and acceptance

Part of [#36636](https://github.com/okou-ai/okou/issues/36636). This guide records
the required Slack parity, Discord adaptations, and acceptance evidence. The
[shared agreement](https://github.com/okou-ai/okou/issues/36636#issuecomment-5811209334)
and [owner inventory](https://github.com/okou-ai/okou/issues/36636#issuecomment-5811308260)
define the implementation boundaries.

The feature and Gateway remain disabled by default. OAuth authorization,
consent, token exchange, production credentials, and production activation are
outside this implementation. A merged slice or an interface announcement does
not prove combined behavior. Real Discord acceptance requires an authorized
test application, bot, and guild; none is claimed in this guide.

## Slack baseline and parity matrix

The Slack baseline was inspected on 2026-09-24 at main commit
`f9087f092b79d12b87632b32d6091f3121abdf14`. Relevant implementation references:

- [Settings and account state](../turbo/apps/platform/src/views/okou-page/works-page.tsx),
  [reactive status](../turbo/apps/platform/src/signals/okou-page/slack.ts), and
  [status/disconnect API](../turbo/apps/api/src/signals/routes/integrations-slack.ts).
- [Verified account connection](../turbo/apps/api/src/signals/services/slack-connect.service.ts)
  and [events, commands, and selection](../turbo/apps/api/src/signals/services/slack-webhooks.service.ts).
- [Canonical route creation](../turbo/apps/api/src/signals/services/slack-chat-ingress.service.ts),
  [DM session key](../turbo/apps/api/src/lib/integration-dm-session.ts),
  [durable ingress processor](../turbo/apps/api/src/signals/services/canonical-slack-ingress-processor.service.ts),
  and [context rendering](../turbo/apps/api/src/lib/slack-webhook-context.ts).
- [Final delivery](../turbo/apps/api/src/signals/services/internal-slack-chat-run-callback.service.ts),
  [native shared-access reads](../turbo/apps/api/src/signals/routes/integrations-slack-read.ts),
  and [Slack CLI](../turbo/apps/cli/src/commands/slack).

The Discord column is the acceptance contract, not a claim that the row is
delivered. Owners must link implementation, current-HEAD review, CI, and any
live acceptance in the evidence ledger below.

| Flow                          | Current Slack behavior                                                                                                                                                                                                                                                                                                                                                                                                                                              | Required Discord behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Owners                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings                      | `/works` distinguishes installation, current-user connection, and admin/member actions; status changes refresh through `slack:changed`.                                                                                                                                                                                                                                                                                                                             | Gate the entry and status fetch; distinguish configuration, guild installation, user binding, and admin/member state; refresh on `discord:changed`. Show deferred onboarding without a nonfunctional OAuth Connect button.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | [A](https://github.com/okou-ai/okou/issues/36640), [F](https://github.com/okou-ai/okou/issues/36645)                                                                                                       |
| Identity                      | A workspace is associated with one Okou org; individual Slack accounts connect to Okou users.                                                                                                                                                                                                                                                                                                                                                                       | One guild maps to one org. A verified Discord sender binding and current Okou membership are required. Guild membership or a supplied ID is not identity proof.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [A](https://github.com/okou-ai/okou/issues/36640)                                                                                                                                                          |
| Start a task                  | `app_mention` and ordinary bot DMs enter the agent path; ordinary channel messages and unmentioned replies do not. Bot-authored and unsupported message updates are excluded.                                                                                                                                                                                                                                                                                       | Require an explicit mention in guild channels and threads; accept ordinary bot DMs directly. Ignore bot/self/webhook messages and edits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [C](https://github.com/okou-ai/okou/issues/36642), [D](https://github.com/okou-ai/okou/issues/36643)                                                                                                       |
| Guild thread continuity       | Existing physical-thread routes retain their agent/model; different users have different canonical ownership within the same external thread.                                                                                                                                                                                                                                                                                                                       | Create/reuse a native Discord thread where supported. Route ownership is `(connectionId, channelId, sessionKey, userId)` and preserves the original agent/model. A reply reference alone does not create a thread.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | [A](https://github.com/okou-ai/okou/issues/36640), [B](https://github.com/okou-ai/okou/issues/36641), [C](https://github.com/okou-ai/okou/issues/36642)                                                    |
| Continuous bot DM             | Main-DM routing uses `integrationDmSessionKey` with agent/model/service-tier boundaries.                                                                                                                                                                                                                                                                                                                                                                            | Reuse that session key under connection/org/channel/user. Resolve a unique valid binding directly; multiple valid bindings require the sender's explicit saved org choice through settings or interactions. Never choose the first or most recently used guild.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [A](https://github.com/okou-ai/okou/issues/36640), [C](https://github.com/okou-ai/okou/issues/36642), [E](https://github.com/okou-ai/okou/issues/36644), [F](https://github.com/okou-ai/okou/issues/36645) |
| Commands                      | `/okou help`, `connect`, `disconnect`, `switch`, and `model` provide connection guidance and permitted preferences.                                                                                                                                                                                                                                                                                                                                                 | Preserve those semantics through signed interactions and Discord-native private responses/components; `connect` explains deferred onboarding. An org selector resolves ambiguous DMs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [E](https://github.com/okou-ai/okou/issues/36644)                                                                                                                                                          |
| Integration prompt guidance   | Slack-triggered runs receive an integration note (`integration-note-prompt.service.ts`): only the final reply reaches the originating thread, Slack commands are for other channels or explicit extra messages, `okou slack download-file`/`upload-file` handle Slack files, canonical `[Web file]` blocks use `okou web download-file`, `SLACK_TOKEN` is never used directly, and a private-artifact final-reply line is added when private artifacts are enabled. | Discord-triggered runs need an equivalent note: the canonical callback delivers the final reply, `okou discord message send` is only for other channels or extra messages, files on the triggering message arrive as `[Web file]` blocks, `okou discord download-file`/`upload-file` handle other Discord attachments and file delivery, the bot token is never exposed, and the private-artifact line matches Slack. The acceptance report found this missing (N4); [#36831](https://github.com/okou-ai/okou/pull/36831) added it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [B](https://github.com/okou-ai/okou/issues/36641), [G](https://github.com/okou-ai/okou/issues/36646)                                                                                                       |
| Welcome guidance              | When an account connects and the private in-channel confirmation cannot be posted, the bot DMs the confirmation with a welcome (bot identity, workspace agent, how to use). Otherwise the welcome DM is sent the first time the connected user opens the Messages tab. `dmWelcomeSent` sends it once per connection.                                                                                                                                                | OAuth onboarding is deferred, so there is no connect moment and no welcome DM. Until onboarding exists, `/okou help` and the private `connect` response carry the guidance. A once-per-connection welcome is required when onboarding ships; it is a recorded gap, not delivered behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Unowned until OAuth onboarding is scheduled; PMO tracks it on [#36636](https://github.com/okou-ai/okou/issues/36636).                                                                                      |
| Agent/model choice            | Org default and per-user agent preferences respect accessible agents; the model picker uses shared policy and availability.                                                                                                                                                                                                                                                                                                                                         | Use the same preferences and policy. Revalidate picker submissions, sender identity, current binding, and accessible options; do not replace an existing guild thread's agent/model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | [A](https://github.com/okou-ai/okou/issues/36640), [E](https://github.com/okou-ai/okou/issues/36644)                                                                                                       |
| Canonical execution           | Ingress persists canonical Chat input/assets and drains the shared queue; Run routing, billing, history, and callbacks remain shared.                                                                                                                                                                                                                                                                                                                               | Use the same Chat/Run pipeline, permissions, queues, billing, and web history. Durable acceptance and replay must not produce duplicate runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [C](https://github.com/okou-ai/okou/issues/36642), [D](https://github.com/okou-ai/okou/issues/36643)                                                                                                       |
| Results and status            | Canonical callbacks deliver terminal content with agent/model presentation and suppress delivery after binding revocation.                                                                                                                                                                                                                                                                                                                                          | Deliver final/error/cancelled/admission-failure outcomes, attribution, and processing status through the bot. Recheck live binding, membership, feature availability, and destination access at delivery time. Processing status is the bot typing indicator: sent on admission and queued-input launch, then refreshed every 8 s through the Runner heartbeat typing cadence while the run is active. Each refresh rechecks the route, feature and binding; typing reuses the destination permission reads for up to 45 s so an active run costs one typing request per refresh, while delivery always rechecks in full. Any rate limit typing sees pauses all typing for `retry_after`; failures never affect admission or delivery. _Platform difference:_ Slack's thread status is persistent and cleared explicitly, while Discord typing expires after about 10 s and cannot be cleared, so refreshes stop once the run is terminal and the bot reply clears the indicator. No reaction or status message is used. | [B](https://github.com/okou-ai/okou/issues/36641), [C](https://github.com/okou-ai/okou/issues/36642)                                                                                                       |
| Context                       | Bounded channel/thread context renders sender names, mentions, and files alongside the triggering message.                                                                                                                                                                                                                                                                                                                                                          | Preserve bounded context and sender attribution. Enforce user-and-bot access and disclose limited context when ordinary message content is unavailable. Bot DMs read no DM history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [B](https://github.com/okou-ai/okou/issues/36641), [C](https://github.com/okou-ai/okou/issues/36642), [F](https://github.com/okou-ai/okou/issues/36645)                                                    |
| Native messages               | CLI channel listing, history, replies, and sending use the shared user/bot access boundary for reads.                                                                                                                                                                                                                                                                                                                                                               | Provide `okou discord channel list`, `message history`, `message replies`, and `message send`; enforce channel overwrites and private-thread membership. Send only to the sender's own bot DM; never read bot DM content.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | [B](https://github.com/okou-ai/okou/issues/36641)                                                                                                                                                          |
| Files and artifacts           | Inbound files become canonical inputs; upload/download and output delivery retain canonical ownership.                                                                                                                                                                                                                                                                                                                                                              | Safely import expiring attachments, enforce file limits and MIME rules, preserve private artifact ownership, and deduplicate partial retries. Provide native upload/download with stable user-facing references.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [C](https://github.com/okou-ai/okou/issues/36642), [G](https://github.com/okou-ai/okou/issues/36646)                                                                                                       |
| Web source presentation       | Canonical Slack messages retain a source annotation and message permalink when available.                                                                                                                                                                                                                                                                                                                                                                           | Render the canonical source-message permalink in history with an accessible Discord label/icon. Activity headers display the Discord trigger-source label/icon; the activity contract has no source-message permalink. Consume C's shared discriminators.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | [C](https://github.com/okou-ai/okou/issues/36642), [F](https://github.com/okou-ai/okou/issues/36645)                                                                                                       |
| Disconnect, removal, deletion | Personal disconnect removes access; org-admin removal removes the installation and its connections.                                                                                                                                                                                                                                                                                                                                                                 | Keep personal disconnect and admin guild removal distinct. Revoke routes/preferences and delivery authority, preserve other guilds, and cover member removal, account export/deletion, and owned descendants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [A](https://github.com/okou-ai/okou/issues/36640), [C](https://github.com/okou-ai/okou/issues/36642), [F](https://github.com/okou-ai/okou/issues/36645)                                                    |

## Published settings and source contracts

A's [exact settings contract](https://github.com/okou-ai/okou/issues/36640#issuecomment-5811445351)
exports `integrationsDiscordContract`, `discordOrgStatusSchema`,
`discordContextModeSchema`, `DiscordOrgStatus`, `DiscordContextMode`, and
`IntegrationsDiscordContract` from
`@okouai/api-contracts/contracts/integrations-discord`.

| Method           | Request                                                                                | Success and authority                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getStatus`      | `GET /api/integrations/discord`                                                        | `200` with the current org/caller's status; `401`, `403`, and `404` are contract errors.                                                                                                                                                      |
| `disconnect`     | `DELETE /api/integrations/discord`, optional `action=disconnect` or `action=uninstall` | `200 {ok:true}`. Omitted action disconnects the caller; uninstall is admin-only for this guild. Both stay available while the feature switch is off so data can be removed after a rollback. `401`, `403`, and `404` remain visible failures. |
| `setDmSelection` | `PUT /api/integrations/discord/dm-selection`, strict body `{connectionId: UUID}`       | `200 {ok:true}`. The server resolves the caller and verified Discord sender; the payload supplies no user/guild identity proof. `401`, `403`, and `404` remain visible failures.                                                              |

The required status fields are:

- Boolean `isAvailable`, `isInstalled`, `isConnected`, and `isAdmin`.
- Nullable string `guildId`, `guildName`, `discordUserId`, `defaultAgentId`, and
  `defaultAgentName`.
- `contextMode: "full" | "mentions_only" | "unavailable"` and
  `onboarding: "oauth_deferred"`. Settings disclose the server-provided context
  mode and deferred onboarding rather than infer availability from installation.
- `dmSelectionConnectionId: UUID | null` and
  `dmBindings: {connectionId: UUID, guildId: string, guildName: string | null}[]`.
  Choices contain only the current Okou caller's valid bindings for the current
  Discord sender. F exposes explicit DM choice in settings; an absent saved
  choice must not select the first or most recent guild.

C's [published source contract and targeted verification](https://github.com/okou-ai/okou/issues/36642#issuecomment-5811506561)
own the `discord` discriminator. Canonical user-message source parts retain
`{type: "source", kind: "discord", href?: string}` for history; the optional
`href` is the original Discord message permalink. Activity headers consume the
`TriggerSource` value `discord` for their label/icon. They have no source-message
permalink field, so this guide does not require an invented activity link.

Computer Use authorization follows the existing canonical `source: "chat"`
path when the Run has a canonical `chatThreadId`; F does not add a separate
Discord authorization source. See C's
[authorization clarification](https://github.com/okou-ai/okou/issues/36645#issuecomment-5811508333).

## Discord platform differences

1. **Gateway transport.** Ordinary messages arrive through an outbound Gateway
   WebSocket. HTTP interactions handle slash commands and components but do not
   replace message ingestion. The Worker/Durable Object owns heartbeat, resume,
   reconnect, Identify budgets, and a durable outbox; the finite-lived API
   function owns authoritative identity, admission, and business logic.
2. **Application-wide bot credential.** The bot token is shared by the Discord
   application; guild rows contain bindings rather than copied bot tokens.
   Removing one guild must not revoke the credential for other guilds. A bot DM
   contains no authoritative guild choice, so ambiguous org routing needs an
   explicit sender-owned selection.
3. **Replies and threads.** A reply references a message; a thread is a separate
   Discord conversation with permissions and archive/lock state. Sending into
   an archived thread reopens it, so only a moderator lock stops delivery
   (unless both the sender and the bot hold `MANAGE_THREADS`). Task routing
   must use the actual channel/thread identity. Bot DMs have no Slack-style
   subthreads; standard bots cannot join Group DMs. Those are platform limits,
   not a reason to share DM ownership across users or orgs.
4. **Message content.** Ordinary guild context depends on the applicable
   `MESSAGE_CONTENT` intent configuration and approval. Limited-context mode
   must say what is unavailable and must not claim full Slack parity. Content
   availability never grants identity or channel access.
5. **Access evaluation.** Guild roles alone are insufficient: effective channel
   overwrites and private-thread membership apply to both sender and bot. Access
   can change while a task runs; a successful admission is not continuing
   permission to read or deliver.
6. **Interaction lifetime.** Discord requires an initial interaction response
   within three seconds, and interaction tokens expire after fifteen minutes.
   Acknowledge commands promptly and use durable bot-authenticated result
   delivery for long tasks.
7. **Presentation and provider limits.** Discord-native private replies,
   buttons/selects/modals, typing/status, and Markdown replace Slack App Home
   and Block Kit. Message/file limits, mention suppression, expiring attachment
   URLs, and rate limits require deliberate splitting, import, and retry. A
   truncated result or a silently missing attachment is not parity. Attachment
   CDN URLs are signed bearer links, so native history returns attachment
   metadata only and `okou discord download-file` re-authorizes each fetch.
   Forum and media channels hold posts as threads with no channel history, so
   `channel list` omits them; a post is read by its thread ID.
   When a reply part's delivery cannot be confirmed, it is not resent (that
   could duplicate it); the remaining parts are still sent, followed by a notice
   linking to the full reply in Okou.
8. **Admission notices.** Slack answers an unconnected sender with an ephemeral
   `not_connected` notice. Discord has no ephemeral messages outside
   interactions, so a mention from an unconnected guild member gets no reply: a
   public reply would expose that member's connection state to the channel,
   and an unsolicited bot DM to someone who only mentioned the bot can be
   blocked by privacy settings or read as spam. `/okou connect` gives the same
   guidance privately. A bot DM from an unconnected sender gets setup guidance,
   and a DM from a sender with several connections and no saved choice gets
   `/okou org` guidance, each about once an hour. The bot's own earlier notice
   among the DM's latest 50 messages is the rate-limit record, and a shared
   enforced nonce collapses concurrent notices, so Okou stores nothing about
   unconnected senders. That read is internal and compares only the bot's own
   notices; no DM content reaches a run. A sender whose connection exists but no longer
   verifies (for example, while the feature is off for that org) gets no notice.

OAuth deferral and disabled rollout are project scope limits, not unavoidable
Discord differences. The Gateway owner's initial single-shard scope is likewise
an implementation limit: its
[published contract](https://github.com/okou-ai/okou/issues/36643#issuecomment-5811353867)
rejects applications requiring multiple shards until an application-wide
Identify coordinator exists. Discord's recommended shard count alone does not
stop the relay; its sharding-required close (`4011`) does.

Provider references: [Gateway](https://docs.discord.com/developers/events/gateway),
[interactions](https://docs.discord.com/developers/interactions/receiving-and-responding),
[threads](https://docs.discord.com/developers/topics/threads), and
[permissions](https://docs.discord.com/developers/topics/permissions).

## Configuration and rollout boundary

These names come from the shared agreement and A's
[published configuration contract](https://github.com/okou-ai/okou/issues/36640#issuecomment-5811445351).
The owning implementation and its validated setup instructions are authoritative;
do not substitute guessed CLI flags, raw database inserts, or a public
arbitrary-ID binding endpoint.

| Configuration                                                          | Owner and purpose                                                | Required boundary                                                                                                                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FeatureSwitchKey.DiscordIntegration` / `_discordIntegration`          | A: common API/capability/UI gate.                                | Default false; no production allowlist activation. Frontend visibility does not replace the server gate.                                                                   |
| `DISCORD_APPLICATION_ID`                                               | A: expected application identity; D/E use the same application.  | Validate incoming application identity; do not accept transport-supplied Okou org/user IDs.                                                                                |
| `DISCORD_BOT_TOKEN`                                                    | A: application-level REST credential; D: Gateway authentication. | Keep in supported secret configuration, never per-guild data or browser responses.                                                                                         |
| `DISCORD_PUBLIC_KEY`                                                   | A/E: Ed25519 interaction verification.                           | Verify timestamp and exact raw request body before processing interactions.                                                                                                |
| `DISCORD_GATEWAY_SECRET`                                               | A/C/D: Worker-to-API HMAC.                                       | Verify timestamp, signature, replay window, and application ID at the API.                                                                                                 |
| `DISCORD_MESSAGE_CONTENT_ENABLED`                                      | A: app-level ordinary-message context availability.              | Defaults to `false`. Report `full`, `mentions_only`, or `unavailable` through status; this setting never authorizes bindings or conversation access.                       |
| `DISCORD_GATEWAY_ENABLED`                                              | D: live Gateway startup switch.                                  | Default disabled, including deployment wiring; code merge is not permission to start a bot.                                                                                |
| Gateway API URL and management configuration                           | D: relay deployment and control.                                 | Use the published Worker configuration/secret path for the selected test environment. D's announced `DISCORD_GATEWAY_CONTROL_SECRET` is separate from the API HMAC secret. |
| Verified guild/user fixtures                                           | A: protected development/test bindings.                          | Only an authorized non-production fixture path may establish test bindings; the sender cannot self-assert another user's identity.                                         |
| Message-content intents, channel permissions, and command registration | B/D/E: provider configuration.                                   | Record actual test-app permissions and intent availability. Use E's registration tooling only in an authorized test application; do not register production commands.      |

`getDiscordAppConfig()` is available only when the application ID, bot token,
public key, and Gateway secret are all configured. A validates the application
ID as 17–20 decimal digits, the Ed25519 public key as 32-byte hex, and the
Gateway secret as at least 32 characters. The shared feature gate reads actual
DB overrides independently of configuration and verified identity checks.

The agreed Gateway endpoint is `POST /api/internal/discord/gateway`, with a
version-1 envelope containing `applicationId`, `eventType` (`MESSAGE_CREATE` or
`GUILD_DELETE`), stable `eventId`, and raw Discord event `payload`. Its
`x-discord-gateway-timestamp` is Unix seconds;
`x-discord-gateway-signature` is hex HMAC-SHA256 over
`${timestamp}.${rawBody}` as UTF-8, without reserializing the body. The contract
allows at most 300 seconds of past or future timestamp skew. Retry signatures
may change, but event identity must remain stable. Success means durable
acceptance or an explicitly classified intentional ignore. An unavailable guild (`GUILD_DELETE` with
`unavailable: true`) is not an uninstall.

Before a separately authorized test rollout, use compatible A-G revisions,
apply A's schema through the repository's normal migration path, and deploy the
API/contracts before directing the Gateway at them. Check independently
deployed App, API, CLI, and Worker versions. Do not start a mixed-version test
whose API cannot parse Discord sources or whose provider imports remain
unresolved. Turning off a feature does not remove already persisted source
values; any rollback after a test must retain the readers needed for its data.

## Fixture acceptance

Fixture tests exercise the actual service/UI boundaries with controlled
provider responses. They do not demonstrate that a live Discord bot is
configured, installed, or reachable.

A has [published the protected fixture interface](https://github.com/okou-ai/okou/issues/36640#issuecomment-5811564566).
The actual provider revision must be available before running these steps;
the interface announcement alone is not execution evidence.

- `@okouai/api-contracts/contracts/test-discord-state` exports
  `testDiscordStateContract.post` and `.delete`.
- `POST /api/test/discord-state` requires an authenticated admin. Its body is
  `{guildId, guildName, botUserId, discordUserId}`. Use synthetic snowflakes for
  the three ID fields and a synthetic guild name. The response is
  `200 {connectionId}`. The server binds only the
  authenticated user's current org/user; callers cannot supply Okou identity
  fields. Conflicting ownership returns `409` instead of rebinding.
- Optional `history: {chatThreadId, channelId, messageId, messageText}` seeds
  deletion/export descendants, including a failed admission-notice delivery,
  for an already-created owned canonical Chat thread. Use C's real ingress entrypoint for admission tests.
- `DELETE /api/test/discord-state?guildId=...` uses the same admin context and
  deletes only that org's named guild.
- Production returns `404`. Development is allowed; protected previews also
  require `isPreviewEndpointAllowed`. This fixture does not bypass runtime
  feature gating or turn supplied IDs into a production onboarding flow.
- A's `signals/routes/__tests__/helpers/discord.ts` exports
  `configureDiscordApp`, `uniqueDiscordSnowflake`, `mockDiscordMemberships`,
  `seedDiscordFixture`, and `deleteDiscordFixture`. The seed helper calls the
  guarded HTTP route and returns the actor, IDs, and connection ID. Mock current
  Clerk membership at its external boundary; cached session roles are not
  binding authority. Configure all four app settings with synthetic values and
  enable `_discordIntegration` only for the fixture cohort through the existing
  feature-switch API.

1. Record the full checkout SHA, compatible provider PRs, and test environment.
   Use A's guarded fixture setup above once its actual provider revision is
   integrated. Verify production rejection, admin enforcement, conflicting
   identity rejection, and scoped cleanup. Keep setup execution pending until
   that revision is available; do not substitute raw database inserts.
2. Create two test orgs/guilds, an admin and member, a second connected sender in
   one shared thread, an unbound sender, and one sender with valid bindings to
   both orgs. Include revoked membership, inaccessible agents/models, and stale
   selections. Keep fixtures isolated from production identities.
3. With the feature off, verify the settings entry and status subscription are
   absent and server/native operations are denied, except that personal
   disconnect and admin uninstall still remove existing data. With only the fixture cohort
   enabled, exercise unconfigured, uninstalled, installed/unconnected, and
   connected settings for admin/member roles. Exercise each exact `contextMode`
   (`full`, `mentions_only`, and `unavailable`) with `onboarding: "oauth_deferred"`.
   Confirm deferred onboarding guidance and limited-context disclosure. No action
   should imply that OAuth or ID-based self-binding is available.
4. Exercise personal disconnect, admin removal, failed actions, and a
   `discord:changed` event while `/works` is mounted. Verify state refresh,
   visible errors, lifetime cleanup, and continued isolation of the other org.
   The settings DM-choice control must contain only the authenticated sender's
   valid bindings, submit only `{connectionId}`, and reflect the saved choice
   after refresh. Verify that no first/recent choice is applied automatically
   when multiple valid bindings have no saved selection. Hold a selection PUT
   pending while status refreshes, including a failed refresh followed by retry;
   another choice must stay disabled until that PUT settles.
5. Submit signed Gateway/interaction fixtures for mention, unmentioned reply,
   bot DM, bot/self/webhook message, and edit. Reject wrong signatures,
   application IDs, expired timestamps, mismatched component senders, and
   cross-org selections before admission. Verify PING and timely interaction
   acknowledgement without waiting for provider work.
6. Assert one canonical admission/run under duplicate event delivery, lost API
   response, Worker restart/RESUME, reconnect, queued input, stale-ingress
   recovery, and partial delivery failure. Confirm two users in one native
   thread receive separate canonical ownership. Agent/model changes preserve
   existing guild routes and create the expected main-DM session boundary.
7. Exercise both user and bot denial, channel overwrites, private-thread
   membership, archive/lock changes, and revocation between admission and final
   delivery. Cover final, error, cancellation, and admission-failure paths. No
   terminal callback or retry may escape revoked authority.
8. Exercise bounded context with and without message content, native
   read/send/replies pagination, rate limits, long-result splitting, mention
   suppression, incoming files, expiring attachment refresh, byte/MIME rejection,
   output artifacts, and partial-upload retry. Keep canonical ownership and
   stable delivery references intact.
9. Render canonical history from C's real Discord source part. Verify the
   label/icon and keyboard-accessible source-message link; missing permalinks
   must not create broken or fabricated destinations. Verify the Discord
   trigger-source label/icon in activity headers without inventing a permalink
   field there. Check that Slack and other source presentations remain intact.
10. Run scoped formatting, lint, types, and meaningful focused behavior tests;
    rely on PR CI for broad coverage. Record exact commands/results and limits.
    This task does not authorize a local dev server or full local Vitest,
    `pnpm test`, or full turbo test runs.

## Authorized real-guild acceptance

The owner inventory records test-guild selection and secure configuration as
pending. The following steps are acceptance criteria, not executed evidence or
permission to activate production.

1. Record the authorized test app/guild, non-production deployment revisions,
   the protected fixture procedure, registered command version, intents, and
   bot permissions. Keep tokens and private identity details out of the public
   evidence. Use the provider owners' published setup commands; do not guess
   their inputs or provision production secrets.
2. Start only the authorized test Gateway. Verify heartbeat/ACK health and
   durable outbox acceptance. Before starting it, configure an alert on any
   increase of the relay's `/health` `deadLettered` count: events rejected by
   the API (`400`/`413`) or exceeding the relay's 120,000-byte record budget are
   set aside rather than replayed, so a contract mismatch would otherwise
   discard traffic while the relay still reports `running`. Also alert when
   `deliveryFailures` stays above zero or `oldestPendingAgeMs` keeps growing:
   delivery is ordered, so a stuck head event delays every guild. Confirm
   ordinary guild messages are not relayed and do not start
   tasks, an explicit mention does, and a mentioned thread continuation uses
   the same native thread and canonical owner.
3. Invoke the same thread as the second connected user and verify separate
   canonical histories/credentials. Exercise bot DMs with one valid binding,
   then multiple bindings: require explicit org choice and preserve it. A
   recent message in another guild must not change the DM choice.
4. Use help/connect/disconnect/switch/model and the org picker. Verify private
   guidance, accessible-option filtering, stale component rejection, sticky
   guild routes, and the expected DM session boundaries. Connect must state the
   OAuth limitation honestly.
   Interactions use a callback-ACK design: after Ed25519 verification, and
   before any database or Clerk work, the API posts the interaction callback
   (a deferred private response, type 5 with flags 64, for slash commands; a
   deferred update, type 6, for component clicks so the result replaces the
   picker in place), then answers the webhook with `202` and no body. The
   interaction finishes by editing that response in the background. A second
   ACK for the same interaction (Discord error 40060) returns `202` without
   applying changes. When the callback times out or fails with a server error,
   its outcome is uncertain: the API applies no change, returns `202`, and
   replaces any loading state after Discord's 3-second window. Verify each
   command shows the private "thinking" state within three seconds and then the
   final private response, that a picker selection updates in place, and that
   replaying a signed request changes nothing.
5. Send a file and a task producing a long result and an output artifact. Verify
   input/output ownership, complete content, native upload/download, usable
   references, and Discord source-message links in web history. Verify the
   Discord trigger-source label/icon in activity headers. Repeat context checks
   under the actual message-content configuration; record any restricted mode
   visibly.
6. Test a task longer than the interaction-token lifetime, queued input, forced
   relay reconnect/replay, duplicate delivery, and a recoverable provider error.
   Correlate the external event, durable ingress, canonical Chat/Run, and result
   message to demonstrate no duplicate execution or avoidable duplicate reply.
7. During an active task, revoke the binding or membership, remove bot/user
   channel access, and archive/lock a thread in separate cases. Verify safe
   terminal handling. Remove one guild and confirm another configured guild
   still functions; distinguish temporary guild unavailability from removal.
   With app configuration removed, accepted ingress stays retryable without
   consuming attempts or sending a notice, and is admitted once it returns.
8. Stop the test Gateway, remove temporary fixtures and test-only overrides using
   their owning cleanup paths, and record cleanup. Leave production flags,
   credentials, command registration, and activation unchanged.

Screenshots/browser checks need an authorized browser environment. Mock renders,
passing CI, and provider interface announcements cannot replace live evidence.

## Operations and evidence ledger

When investigating an incident, correlate application/environment/shard, stable
Discord event ID, ingress/route, canonical thread/run, and delivery identity.
Distinguish relay acceptance from API durable acceptance, run completion, and
provider delivery. Check access revocation, disabled gates, and missing
configuration before replaying anything. Preserve the outbox through reconnect
and nonresumable sessions; retry delivery without starting a new task. Never
log bot tokens, interaction tokens, HMAC secrets, or raw private content as
diagnostic evidence.

For each completed acceptance item, record date, full SHA, environment, exact
test/check or sanitized live scenario, result, evidence URL, and remaining
limits. A provider announcement establishes an interface expectation only.
Reconcile these rows against the child issues when integration acceptance is
performed; the dated snapshot below is not a live project-status feed.

| Area                                        | Evidence as of 2026-09-25                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Remaining acceptance                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack baseline                              | Source inspection at `f9087f092b79d12b87632b32d6091f3121abdf14`; references above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Source inspection only; no Slack live regression is claimed.                                                                                             |
| A: identity, schema, gate, status, fixtures | [Merged PR #36665](https://github.com/okou-ai/okou/pull/36665) (`fdeb98f05f1ef4d51eb44dfed1f4bd4244fe74be`). F's 13 settings UI tests pass on main `7e6034cebc78a7ae296aaf0bd387ffac760c7f48`; the [user-channel invalidation](https://github.com/okou-ai/okou/pull/36657#issuecomment-5812538474) was verified in source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Lifecycle/deletion and live fixture acceptance remain required.                                                                                          |
| B: REST, shared access, native messages     | [Merged PR #36661](https://github.com/okou-ai/okou/pull/36661) (`dafe827d3ddc4fe391776c35e49a36022d4397c6`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Permission/context/native-tool live evidence must be linked.                                                                                             |
| C: canonical ingress and delivery           | [Merged PR #36685](https://github.com/okou-ai/okou/pull/36685) (`99ddcab5538b064d842ad523f50579f3d14ebe1e`); [landed interface receipt](https://github.com/okou-ai/okou/issues/36645#issuecomment-5820217891). F's 3 source UI tests pass on main `7e6034cebc78a7ae296aaf0bd387ffac760c7f48`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Durable admission/recovery/delivery and live acceptance remain unverified here.                                                                          |
| D: Gateway relay                            | [Merged PR #36660](https://github.com/okou-ai/okou/pull/36660) (`ed449226621bba038c4b92462bbd663293904987`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Authorized test deployment, `deadLettered`/`deliveryFailures`/`oldestPendingAgeMs` alerting, and live relay replay/reconnect acceptance remain required. |
| E: commands/components                      | [Merged PR #36659](https://github.com/okou-ai/okou/pull/36659) (`af9be5c5d0a04d2425c5187f7d7717ff2dbbf897`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Signed interaction and preference evidence must be linked; no registration execution is claimed.                                                         |
| F: settings/source presentation/guide       | [Merged PR #36657](https://github.com/okou-ai/okou/pull/36657) (`c33f8af753c4846d0991f2c27aa13005bcb95c33`). Both focused UI suites, Platform production/test types, and scoped lint passed on main `7e6034cebc78a7ae296aaf0bd387ffac760c7f48`. Acceptance fixes: [#36834](https://github.com/okou-ai/okou/pull/36834) (Known #4, merged `e5654719bdf62df55a00c7e648e98249f8b93d12`), [#36836](https://github.com/okou-ai/okou/pull/36836) (N16, merged `a280ae9fb07ee62ac6d1757fc20bf5e2762b2d9d`), and this guide refresh (N17).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Authorized browser evidence remains required. Fixture tests are not live-guild acceptance.                                                               |
| G: files/artifact delivery                  | [Merged PR #36663](https://github.com/okou-ai/okou/pull/36663) (`64383f45a6c6bb261113b359b280d49dc4d41890`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | File limits, import/access/partial-retry evidence, and live file acceptance must be linked.                                                              |
| Combined-main acceptance fixes              | [Independent report](https://github.com/okou-ai/okou/issues/36819#issuecomment-5826110446) at `a70fca9bebee64e390e86bac66ac221d41401616`. Merged: [#36824](https://github.com/okou-ai/okou/pull/36824) (Known #2, `a70fca9bebee64e390e86bac66ac221d41401616`), [#36828](https://github.com/okou-ai/okou/pull/36828) (Known #1, `e1786774efd4dadfdf0dcc18e226efb5d5828d64`), [#36831](https://github.com/okou-ai/okou/pull/36831) (N4, `cb5da5ff10f4024d6e2f20119d5f7d643b07128f`), [#36833](https://github.com/okou-ai/okou/pull/36833) (Known #5, `5adae15586d18cab55e400095d5df70ad3e03ddd`), [#36837](https://github.com/okou-ai/okou/pull/36837) (N8, `9797460fa5241f6ecb3d92a5169b173a91a3fe68`), [#36839](https://github.com/okou-ai/okou/pull/36839) (N1, `c72e30eb8ea0c979476833d1b2281a3d49818bd4`), [#36840](https://github.com/okou-ai/okou/pull/36840) (N9–N11, `96a1761315c530f3cc89adfcd2822363280679f4`), [#36835](https://github.com/okou-ai/okou/pull/36835) (N2, `16d67c9cecb50d547b621dd489695faabe423ae7`), [#36838](https://github.com/okou-ai/okou/pull/36838) (N14, `99de0fd34ef26557f4f70a6846d3fba41fcf9cdd`), and the F fixes above. Open when this row was written: [#36841](https://github.com/okou-ai/okou/pull/36841) (N15). | Track each fix PR to its merge on [#36819](https://github.com/okou-ai/okou/issues/36819); this row is a snapshot, not a live status feed.                |
| Combined main and real guild                | [PMO acceptance state](https://github.com/okou-ai/okou/issues/36636#issuecomment-5811308260).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Not established by any individual slice. PMO retains the parent issue until combined and authorized real-guild acceptance are evidenced.                 |
