# Discord Gateway relay

This independent Cloudflare Worker keeps the outbound Discord Gateway socket,
resumable session and delivery outbox in a SQLite-backed `DiscordGateway`
Durable Object. The canonical API owns identity, access, Chat/Run admission and
responses. The Worker only forwards the versioned raw-event contract to
`POST /api/internal/discord/gateway`.

The relay ships disabled. Merging or deploying this package does not start a
Gateway session. There is no cron, automatic release deployment or automatic
bootstrap. OAuth onboarding and production activation are outside this slice.

## Environments and bindings

| Wrangler environment | Worker name                       | Doppler project/config |
| -------------------- | --------------------------------- | ---------------------- |
| `test`               | `okou-discord-gateway-test`       | `vm0/dev`              |
| `production`         | `okou-discord-gateway-production` | `vm0/prd`              |

Each environment binds `DISCORD_GATEWAY` to its own `DiscordGateway` namespace.
The object identity includes environment, application ID and shard ID. Separate
Discord applications and bot tokens are required for test and production;
sharing an application would also share Discord's session-start budget outside
the namespace. Do not run another relay or local bot with the same application.

| Variable                          | Checked-in value or role                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `DISCORD_GATEWAY_ENABLED`         | `false` in every environment; deployment also forces `false`                             |
| `DISCORD_GATEWAY_ENVIRONMENT`     | `test` or `production`                                                                   |
| `DISCORD_GATEWAY_SHARD_ID`        | `0`                                                                                      |
| `DISCORD_GATEWAY_SHARD_COUNT`     | `1`; multiple shards are rejected until a shared Identify-budget coordinator exists      |
| `DISCORD_GATEWAY_MESSAGE_CONTENT` | `false`; enabling the privileged intent needs Discord application approval/configuration |
| `DISCORD_APPLICATION_ID`          | Exact Discord application snowflake                                                      |
| `DISCORD_BOT_TOKEN`               | Application-level bot credential                                                         |
| `DISCORD_GATEWAY_SECRET`          | At least 32 characters; shared with the canonical API for HMAC-SHA256                    |
| `DISCORD_GATEWAY_CONTROL_SECRET`  | Separate random credential of at least 32 characters for administrative HTTP operations  |
| `DISCORD_API_ORIGIN`              | Explicit HTTPS API origin, without credentials, path, query or trailing slash            |

The five application/origin/secret values are supplied as encrypted Worker
bindings. Never store them in `wrangler.jsonc`, checked-in environment files,
issues or logs. Bot, signing and control credentials must all be distinct.
The API must have the matching application ID and signing secret before any
Gateway activation. The control secret belongs only to this Worker and its
authorized operators. Keep the API's `DISCORD_MESSAGE_CONTENT_ENABLED=false`
aligned with the relay's `DISCORD_GATEWAY_MESSAGE_CONTENT=false`; change both
together only after the Discord application has the necessary intent enabled.

## Supported deployment and secret provisioning

The manual **Deploy Disabled Discord Gateway** workflow is the deployment path.
It only accepts `main`, uses the pinned repository toolchain, respects the
selected GitHub environment, fetches the matching Doppler configuration through
OIDC, and supplies version-scoped secrets using Wrangler's `--secrets-file`.
The private temporary file is removed on success and failure. Credential values
never enter command arguments.

Before an authorized deployment, an operator must configure:

1. The selected GitHub `test` or `production` environment and its protection
   rules; production approval remains separate from a PR merge.
2. `CF_ACCOUNT_ID` and `CF_API_WORKER_DEPLOY_API_TOKEN` with access to the target
   Worker and Durable Objects. These use the existing Cloudflare deployment
   variable/secret names. No token is provisioned by this change.
3. `DOPPLER_SERVICE_IDENTITY_ID` with the selected environment's GitHub OIDC
   subject permitted. Store `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`,
   `DISCORD_GATEWAY_SECRET`, `DISCORD_GATEWAY_CONTROL_SECRET` and
   `DISCORD_API_ORIGIN` in `vm0/dev` or `vm0/prd`. Store the same application ID,
   bot token and HMAC secret in the API's authoritative environment.

After separate authorization, dispatch the disabled test deployment with:

```bash
gh workflow run discord-gateway-deploy.yml --ref main -f environment=test
```

Use `environment=production` only with production deployment authorization.
The workflow does not call `/start` and cannot enable startup. Activation
requires a separately reviewed configuration/operations change after API and
test-guild acceptance; editing a source variable alone does not bypass the
deployment script's forced disabled value.

Cloudflare creates the environment-specific Durable Object namespace with
migration `v1`. Preserve this namespace and its migration history during
rollbacks; deleting or renaming it discards resumable sessions and pending
deliveries. A deployed disabled relay can retain outbox data for later recovery.

## Administrative HTTP contract

All operations require `Authorization: Bearer <DISCORD_GATEWAY_CONTROL_SECRET>`:

| Method | Path      | Operation                                                           |
| ------ | --------- | ------------------------------------------------------------------- |
| `GET`  | `/health` | Read relay health without starting it                               |
| `POST` | `/start`  | Explicit bootstrap; refuses when startup is disabled                |
| `POST` | `/stop`   | Stop the socket and preserve resumable state and pending deliveries |

Use the Worker URL returned by the authorized deployment. Do not put the
control secret into a URL or share health responses publicly. An outbound
Gateway WebSocket does not use Cloudflare's inbound WebSocket hibernation model.

## Recovery and containment

Each dispatch advances the resumable sequence in the same storage transaction
as its outbox entry. Message identities use `MESSAGE_CREATE:<message.id>`;
lifecycle identities use `GUILD_DELETE:<session_id>:<sequence>`. Retries retain
the raw envelope and refresh only the HMAC delivery timestamp/signature. The
API must durably deduplicate those identities and return its versioned receipt.
An unavailable guild event reaches the API unchanged and must be intentionally
ignored there; the relay never interprets it as an uninstall.

Outbox delivery runs separately from Gateway dispatch and heartbeat handling.
Transient delivery/reconnect failures back off to at most 61 seconds;
provider Retry-After can extend that to one hour. A durable alarm recovers
isolate loss within 30 seconds. Pending events survive stop, restart, an invalid
session and fatal configuration errors. A full 1,000-event outbox stops intake
before advancing the next sequence and resumes once delivery makes space.
An event exceeding the 120,000-byte durable-record budget is never queued:
the relay advances the checkpoint past it and stores only a dead-letter
reference (event type, ID and size) in the same transaction, so resuming cannot
replay it and stall delivery. Discord's own resume retention is finite: prolonged outages
or nonresumable sessions cannot recover events Discord no longer retains.

Only events that can start or end work occupy the ordered outbox: DMs, guild
messages whose `mentions` include the bot user reported by READY, and
`GUILD_DELETE`. Other guild chatter only advances the checkpoint. This is a
transport filter; the API still revalidates the mention and sender identity, and
checks the mention before any identity-provider call.

Delivery is strictly ordered, so a failing head-of-queue event delays every
guild. `/health` reports `deliveryFailures` (consecutive failed attempts for the
head event) and `oldestPendingAgeMs` (null when the outbox is empty); activation
monitoring must alert when either keeps rising.

An event the API rejects as malformed (`400`) or too large (`413`) cannot
succeed on retry, so the relay moves it out of the outbox into a dead-letter
record and continues with later events; one member's message never stops
delivery for other guilds. The newest 100 dead-letter records, rejected
envelopes and oversized-event references alike, are retained for diagnosis and
`/health` reports the cumulative `deadLettered` count. Because dead-lettered
events are not replayed, activation monitoring must alert when this
count rises; a systematic contract mismatch would otherwise discard traffic
while the relay still reports `running`.

Fatal Gateway close codes, an application mismatch, an invalid receipt or any
other permanent API rejection (such as `401`, `403` or `404`) require operator
correction and a new authenticated `/start`; they do not erase the outbox.
`/health` exposes the stopped reason, pending, dead-lettered and delivery-failure
counts and the oldest pending age, never
event content, credentials or session IDs. Identify reservations survive process loss,
respect Discord's reported session-start budget and enforce the five-second
single-shard Identify interval. A failed connection may conservatively consume
a reservation even when Identify never reached Discord.

## Verification and rollout limits

From `turbo`, use these scoped checks:

```bash
corepack pnpm --filter @okouai/discord-gateway-worker run build
corepack pnpm --filter @okouai/discord-gateway-worker run check-types
corepack pnpm --filter @okouai/discord-gateway-worker run lint
corepack pnpm exec vitest run --project=@okouai/discord-gateway-worker
```

`build` is a local Wrangler dry run; it does not deploy or create a namespace.
CI builds the relay and runs its worker protocol/storage tests in the existing
required `test-other` job. The deployment script boundary tests verify disabled
startup, environment selection, credential handling and failure cleanup without
contacting Cloudflare or Discord.

A successful dry run or CI run does not validate a live Discord guild, actual
Cloudflare migration, deployed secret availability or Discord application
intents. Those remain explicit prerequisites for authorized live acceptance.
If the API predates the ingress route, leave the Gateway disabled. A later
rollback must retain an API capable of acknowledging the versioned event
contract and a Worker capable of reading its existing durable state.
