# Discord integration parity and acceptance

Part of [#36636](https://github.com/okou-ai/okou/issues/36636), with the full
onboarding and conversation-parity implementation in
[#37968](https://github.com/okou-ai/okou/pull/37968).

On 2026-10-08, the owner explicitly superseded the original OAuth-deferred scope.
Discord authorization, server installation and member account linking are now
product functionality, not a protected-preview fixture. The old
`/api/test/discord-state` route, contract and business-row construction helpers
are removed. The original [agreement](https://github.com/okou-ai/okou/issues/36636#issuecomment-5811209334)
and [owner inventory](https://github.com/okou-ai/okou/issues/36636#issuecomment-5811308260)
remain historical records, not the current OAuth boundary.

**Discord integration and Gateway remain disabled by default.** Implementation
and automated verification do not authorize production credentials, command
registration, deployment, activation or a live test guild. No live Slack/Discord
acceptance is established by this guide.

## Product authorization and identity

- A current Okou organization administrator installs one Discord server for that
  organization. One server belongs to one organization. A member connects only
  their own provider-verified Discord account to the installed server.
- Settings distinguish unavailable application configuration, absent server
  installation, installed but personally disconnected, and connected state.
  Admin installation/removal and member connect/disconnect are separate actions.
- Authenticated `discordOauthContract.start` uses
  `POST /api/integrations/discord/oauth/start` with
  `{flow: "install" | "connect", guildId?: string}`. Current Okou user and
  organization come from authentication, never body/query owner IDs. An optional
  guild ID expresses intent; it is not proof of installation or membership.
- Distinct browser-owned proofs and expiring, one-use state correlate authorization
  to both the initiating caller and the actual consent-return browser. Provider callbacks exchange the
  authorization code and verify the application, scopes, user, guild and bot.
  The actual consent-return browser must authenticate as the original Okou
  user/organization and approve with a separate callback-issued secret. Only then
  may the original opener complete with its independent retained proof and commit
  a binding. Callback query indicators never grant connected state.
- Install requests `bot applications.commands identify guilds`; connect requests
  `identify guilds`. Require Discord's **OAuth2 Code Grant** bot setting, and
  register the exact environment-specific callback URI. The token exchange's
  verified guild proves installation; callback `guild_id` is only a consistency
  hint, never a replacement for missing proof.
- Recheck current Okou membership/admin role, feature availability and provider
  presence before binding. Reject cross-organization guild ownership and another
  Okou user's Discord identity. Legitimate repeats are idempotent; concurrent
  claims cannot steal or duplicate a binding. No OAuth access/refresh token is
  persisted, exposed to the Agent, or logged.
- A newly committed connection receives welcome guidance at most once. A
  declined or unavailable DM does not undo the verified connection. Delivery
  uses the same live bot/sender authority boundary as other Discord operations.
- `okou discord connect` opens the authenticated App settings entry at `/works`.
  Sign in, select the intended organization, then use Install or Connect there.
  The CLI does not create a browser-bound attempt in its own HTTP process or
  transfer a bearer token, nonce or state to the browser. A CLI URL is guidance,
  not proof of completed consent.

## Slack baseline and Discord adaptations

Slack's product installation/account linking and public test helpers are the
baseline. Helpers wrap real product interfaces; only external Slack, Discord and
Clerk responses may be mocked. Copying a helper around private state insertion
is not parity.

| Flow                | Discord behavior and deliberate adaptation                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings            | Current configuration, installation and personal connection; real Install/Connect actions; refresh on `discord:changed` and observed authorization completion.                                                                             |
| Identity            | One server per organization and one verified sender per member; current membership is authority. A server member ID is not Okou identity proof.                                                                                            |
| Trigger             | Explicit bot mention in server channels/threads; ordinary bot DMs need no mention. Unmentioned replies, bots, self/webhooks and edits do not start tasks.                                                                                  |
| Thread continuation | Create/reuse native Discord threads. Distinct senders retain user-isolated canonical sessions in the same physical conversation.                                                                                                           |
| Main bot DM         | One continuous canonical main-DM session per connection, not physical DM history. Multiple valid bindings require an explicit sender-owned organization selection; never pick first/recent.                                                |
| Agent/model         | New work uses the organization-default Agent; thread model selection and queued immutable input models remain in the shared Chat/Run pipeline. `/okou switch` describes the workspace Agent; `/okou model` the current conversation model. |
| Continuous input    | Shared ordered canonical inputs and runtime steering, not concatenation/debounce. Queued controls cannot overtake inaccessible predecessors.                                                                                               |
| Results             | Shared canonical completion/error/cancellation pipeline, attribution, notification suppression and live binding/access revalidation. Discord typing replaces Slack's persistent thinking indicator.                                        |
| Context             | Authorized source/parent history, message-based thread starter and older quoted targets; at most 20 messages, 16,000 JSON characters and 2,000 text characters per message.                                                                |
| DM privacy          | Never read physical bot-DM history or referenced DM content into the Agent context. Same-user native referenced sending does not authorize content reads.                                                                                  |
| Native tools        | Channel list, history/replies/send and file upload/download. Decimal snowflakes, known channel IDs or own bot DM; native thread discovery/rich blocks are not Slack-equivalent.                                                            |
| Reply send          | Exact same-channel authorized target; recheck write access after guild target reads. Reference only the first split segment; ordinary writes do not newly require history access.                                                          |
| Files               | Trigger attachments enter canonical owned assets. History retains bounded attachment metadata, not signed CDN URLs or implicit historical downloads. Native downloads reauthorize each attachment and retain the 10 MiB limit.             |
| Web presentation    | Canonical Discord source annotation/message permalink; activity trigger label/icon without inventing an activity permalink field.                                                                                                          |
| Removal             | Personal disconnect, admin uninstall, guild removal and account erasure revoke owned access without revoking the application-wide bot token or another guild.                                                                              |

Discord uses Gateway WebSocket ingestion for ordinary messages and signed HTTP
interactions for commands/components. Preserve heartbeat/resume/reconnect,
ordered durable outbox and event deduplication. Server credentials are
application-wide, not per-guild OAuth tokens. Bot DMs have no authoritative guild
and standard bots cannot join Group DMs; Discord replies are not threads.

Server context/native reads enforce both sender and bot effective access,
including channel overwrites and private-thread membership. Full ordinary-message
history requires the application `MESSAGE_CONTENT` intent. Status explicitly
reports `full`, `mentions_only` or `unavailable`; a mention does not imply full
history permission. Missing optional parent/starter/deleted quote resources are
omitted without reading an unrelated channel. Transient provider failures retain
the owning retry behavior.

Discord messages split at 2,000 characters while preserving Unicode/code fences.
Native attribution is appended once before splitting. Unresolved optional display
labels can be omitted; authorization is never best-effort. Interaction commands
acknowledge within three seconds, then finish privately; long tasks use Bot REST
and do not depend on the 15-minute interaction-token lifetime. Current reply/file
delivery is fire-and-forget after canonical completion, not a promise of durable
provider-delivery reconciliation. See the original acceptance issue for that
separate requirement.

## Configuration and rollout boundary

| Configuration                                                | Purpose                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `FeatureSwitchKey.DiscordIntegration` / `discordIntegration` | Shared server/capability/UI gate; default false. UI visibility never replaces authorization. |
| `DISCORD_APPLICATION_ID`                                     | Expected OAuth/application identity.                                                         |
| `DISCORD_OAUTH_CLIENT_SECRET`                                | Code exchange; server secret only. Absence makes OAuth unavailable.                          |
| `DISCORD_BOT_TOKEN`                                          | Application REST/Gateway authentication, never per-guild/browser/Agent data.                 |
| `DISCORD_PUBLIC_KEY`                                         | Ed25519 interaction verification over timestamp and exact raw body.                          |
| `DISCORD_GATEWAY_SECRET`                                     | Worker-to-API HMAC; separate from Gateway management credentials.                            |
| `DISCORD_MESSAGE_CONTENT_ENABLED`                            | Defaults false; status discloses context availability without granting authority.            |
| `DISCORD_GATEWAY_ENABLED`                                    | Worker startup gate; defaults disabled.                                                      |
| Configured App/API origins                                   | Trusted callback and return destinations; never caller-supplied redirects.                   |

Use owning setup instructions, registered callback URIs and the normal generated
schema migration path. Do not guess provider flags or provision production
secrets. Browser start and authenticated completion must use the actual target
API and retain route-owned proof. Production and preview App/API domains differ;
third-party-cookie assumptions cannot establish browser acceptance.

The existing Gateway endpoint is `POST /api/internal/discord/gateway`, with a
version-1 envelope containing application ID, `MESSAGE_CREATE`/`GUILD_DELETE`,
stable event ID and raw payload. Verify Unix-second timestamp, HMAC-SHA256 over
`${timestamp}.${rawBody}` as UTF-8 without reserializing the body, at most 300
seconds of past/future skew, replay identity and application identity. The
headers are `x-discord-gateway-timestamp` and `x-discord-gateway-signature`.
Retry signatures may change, but event identity remains stable. Success means
durable acceptance or a classified intentional ignore. An unavailable guild
(`unavailable: true`) is not uninstall.

Deploy compatible API/contracts/schema before App/CLI consumers and before any
separately authorized Gateway. Additive schemas do not activate the integration.
The status discriminator is now `onboarding: "oauth"`; the removed private test
endpoint has no compatibility alias. Rollback must retain canonical Discord
readers and stored sources. See [deployment compatibility](deployment-compatibility.md).

### API deployment inputs

The shared `.github/actions/web-api-env` action forwards these settings only to
API deployments, for both preview and production. GitHub inputs come from the
workflow's resolved Variables and Secrets, including its selected environment;
Doppler inputs come from `vm0/dev` for previews and `vm0/prd` for production.

| API setting                       | Configuration source                                 |
| --------------------------------- | ---------------------------------------------------- |
| `DISCORD_APPLICATION_ID`          | GitHub Variable                                      |
| `DISCORD_PUBLIC_KEY`              | GitHub Variable                                      |
| `DISCORD_BOT_TOKEN`               | GitHub Secret                                        |
| `DISCORD_GATEWAY_SECRET`          | GitHub Secret; must match the relay's HMAC secret    |
| `DISCORD_OAUTH_CLIENT_SECRET`     | Doppler secret only; no legacy GitHub OAuth fallback |
| `DISCORD_MESSAGE_CONTENT_ENABLED` | GitHub Variable; `true` or `false`, default `false`  |

The Doppler OAuth client ID must identify the same application as
`DISCORD_APPLICATION_ID`; it is not emitted as a second runtime application-ID
alias. The authenticated OAuth protocol consumes the forwarded secret; forwarding
alone neither registers the callback nor installs a bot or establishes a binding.
Missing settings retain the optional unconfigured state rather than
making disabled Discord a deployment prerequisite. Malformed message-content
flags fail rendering before an environment file is created.

Updating GitHub configuration does not update an already-running API: a
subsequent API deployment must render the new inputs. The signed interaction
PING needs the application ID and public key, while commands also need the bot
token and Gateway HMAC secret. Neither forwarding settings nor validating the
interaction endpoint starts the Gateway or enables `discordIntegration`.
`DISCORD_GATEWAY_ENABLED` and `DISCORD_GATEWAY_CONTROL_SECRET` are relay-only
settings and are not passed to the API or Web. Do not commit credential values.

## Automated construction and coverage

Automated API scenarios establish bindings through real start, provider callback,
authenticated consent-browser approval, opener completion and public status. Mock only external identity/provider
responses. The public helper's returned connection ID comes from product status,
not a private constructor or database read. Cleanup uses personal disconnect and
admin uninstall. Run-scoped scenarios admit work through public Chat/Gateway and
claim a genuine Runner-issued token; never sign a random-Run JWT.

Apply [API testing](testing/api-testing.md#external-behavior-boundary) and
[external behavior](testing/testing-external-behavior.md#cases-without-public-construction)
to every setup phase hidden in a helper. No DB business-row seed, internal
worker/service driver, fabricated historical state or renamed test-only endpoint
is an acceptable substitute. Unsupported historical-only cases are explicitly
recorded in the [retirement ledger](implementation/discord-public-test-lifecycle.md),
not called redundant. The original parity cases and their replacement lifecycle
are tracked in the [parity ledger](implementation/discord-parity-37968-testing.md).

## Separately authorized real-guild acceptance

The checklist below is not executed evidence or permission to deploy/start a bot.

1. Record authorized non-production app/guild and complete revisions, normal
   migrations, registered callback/command versions, intents and bot permissions.
   Establish each real identity through OAuth; no protected-preview seed exists.
2. Install as admin, connect a member and a second sender, and use two independent
   orgs/guilds. Reject wrong owner, cancellation, missing scope, absent bot,
   unbound sender, expired/replayed authorization and changed current membership.
   Verify production and preview browser transports independently.
3. Verify all configuration/installation/connection/context states, welcome once,
   status refresh, visible failures and route-owned lifetime cleanup. Test feature
   off containment while personal disconnect/admin uninstall remain available.
4. Start only the authorized test Gateway. Verify mentions/DMs, heartbeat/ACK,
   outbox/replay/reconnect and two users' isolated canonical histories. Alert on
   `/health` `deadLettered`, persistent `deliveryFailures` and growing
   `oldestPendingAgeMs`; a stuck ordered head can delay all guilds.
5. Exercise help/connect/disconnect/switch/model, organization selection, stale
   components, long tasks, continuous input and queued controls. Verify private
   interaction thinking/update behavior and no duplicate admission under replay.
6. Verify parent/starter/quoted context, content-limited disclosure, attachment-only
   metadata, signed-URL exclusion and absolute bot-DM content isolation. Verify
   native replies, long sends, notification suppression and files/artifacts.
7. Revoke binding/membership or sender/bot channel access during a task; archive/
   lock a thread. No later reply, typing or native operation may escape authority.
   Remove one guild without changing another or revoking the shared bot credential.
8. Stop the test Gateway and remove test bindings/overrides through their owning
   product interfaces. Record cleanup; leave production configuration unchanged.

Record full SHA, environment, exact commands or sanitized live scenario, evidence
URL, result and limits for every acceptance item. Green CI and source review are
not live Slack/Discord acceptance. The original seven slices merged, but their
historic report at `a70fca9bebee64e390e86bac66ac221d41401616` is not current combined
or real-guild acceptance. Track outstanding work on
[#36819](https://github.com/okou-ai/okou/issues/36819), not an assumed completion
from individual implementation merges.
