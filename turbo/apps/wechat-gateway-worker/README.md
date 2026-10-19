# WeChat gateway operations

This Worker supports continuous WeChat reception using Cloudflare Workflows.
A Workflow long-polls Tencent directly, waits one second after each completed
poll, and treats its own 40-second receive deadline as an empty round. Each
instance runs six ten-minute steps and then hands off to a fresh instance. A
250-poll cap per step bounds subrequests during bursts; it can rotate earlier.

The existing SQLite Durable Object owns the cursor, encrypted transport copy,
pending batch and receiver lease. Its RPC calls finish before provider/API
network waits. Empty rounds write only when the cursor changes. Batches are
saved atomically with the cursor before delivery, encrypted in bounded chunks
and streamed across RPC so the provider's 2 MB response limit remains usable.
The API retains authorization, reconnect notices, message-ID deduplication,
canonical Chat/Run processing and the KMS-encrypted source credential. Actual
message batches retain per-input retry progress in the existing encrypted SQL
pending field; the DO retains the original replay batch until the API confirms
that every input is admitted or terminal. Failed attachments do not block later
inputs, and malformed provider messages are isolated from valid messages.

At each step boundary the Workflow renews authorization through the API; it
receives credentials only for initial bootstrap or a changed binding generation.
Every real delivery checks live authorization again. Normal completion callbacks
send replies immediately. The interrupted-callback recovery backstop runs on
message delivery and authorization renewal; without incoming messages its scan
cadence is about ten minutes (plus infrastructure retry/recovery delay), rather
than the legacy per-poll cadence. Disconnect and link-based reconnect push the new generation while preserving
the transport cursor; the API keeps the reconnect message-time boundary. Owner
deletion requests authenticated `/stop`, which also works while startup is
disabled. If that request fails, the next authorization renewal stops reception.
A failed step retries with backoff; exhausted retries schedule recovery after
90 seconds. A twelve-minute DO lease recovers interrupted Workflow instances.
Only the current owner may checkpoint, acknowledge or renew state. Workflow
parameters/results contain identifiers and booleans, never credentials/messages.

## Activate Workflows

1. Deploy the additive database migration and API first, keeping
   `enable_workflows=false`. The legacy Worker remains compatible. Verify the
   new API serves all production traffic, then allow the outgoing API's full
   five-minute request limit to drain before activating the new receiver.
2. Provision a distinct random `WECHAT_RECEIVER_ENCRYPTION_KEY` of at least
   32 characters in the matching GitHub environment. Keep it stable across
   deployments; HMAC/control secret rotation does not rotate stored encryption.
   Replacing this key requires draining or re-encrypting pending state first.
3. Run **Deploy WeChat Gateway** with both `enable_gateway=true` and
   `enable_workflows=true`, first in test. Existing alarms migrate receivers;
   opening Works or completing a verified QR also calls authenticated `/start`.
   The deploy creates the environment's Workflow binding in the same Worker.
4. Confirm reception with Works closed, replay after failed delivery, reconnect,
   disconnect, owner deletion and provider expiry. Before widening rollout,
   measure CPU, DO active duration, cursor-change frequency and concurrent
   instance startup/recovery in Cloudflare. Local workerd tests are not cloud
   capacity or invoice measurements. Long-polling instances consume concurrency.

Activation marks each binding `workflow_receiver=true` and fences the legacy API
poll's writes. Its current cursor and any encrypted pending legacy batch transfer
to the DO. The old endpoint and disabled-by-default mode are a deployment bridge:
remove them after all live receivers have migrated and older API/Worker rollback
targets are excluded. Do not roll back to the legacy receiver after transfer or
clear DO state: the freshest cursor/pending batch is now in Cloudflare. Setting
`enable_workflows=false` pauses migrated objects while retaining their state;
roll forward and call `/start` to resume paused objects. The SQL marker prevents
an old poller from silently taking reception back.

Bridge retirement is tracked in [#41268](https://github.com/okou-ai/okou/issues/41268).

There is no per-poll success logging. Successful Workflow history retains one
day; failed history retains seven days. The DO contains the durable replay state,
so pruning completed Workflow history does not discard pending deliveries.

## Deployment for an internal scan test

1. Deploy the schema migration and API/app changes with the feature disabled.
2. Provision two distinct random secrets of at least 32 characters:
   `WECHAT_GATEWAY_SECRET` (worker-to-API HMAC) and
   `WECHAT_GATEWAY_CONTROL_SECRET` (API-to-worker control authorization).
3. Configure the API with those secrets and `WECHAT_GATEWAY_URL` pointing to the
   receiver origin. The API deployment reads the URL from GitHub variables and
   both credentials from GitHub secrets, matching the gateway deployment below.
   Use a receiver whose `WECHAT_API_ORIGIN` targets that same API environment.
4. The **Deploy WeChat Gateway** workflow reads the matching GitHub environment's
   two secrets, `CF_API_WORKER_DEPLOY_API_TOKEN`, `CF_ACCOUNT_ID`, and the
   `WECHAT_API_ORIGIN` variable (canonical HTTPS API origin). It deploys only
   from main. Choose the test environment first and explicitly enable the
   gateway when API configuration is ready. Startup otherwise stays disabled.
5. Enable `wechatIntegration` only for the internal tester. Open `/works`, click
   WeChat Connect, scan and confirm, then send two text turns. Close Works before
   the second turn to verify background receiving and session continuity.
   A verified connection or link-based reconnect gets one immediate welcome;
   a failed or ambiguous welcome must not block the prompt or be retried.
6. Exercise an expired QR, verification challenge if Tencent requests it,
   reconnect, disconnect during an active run, and member departure. Confirm
   tokens are absent from browser responses and model-visible material.
7. Use `okou wechat channel list --json` and `message history --channel-id <id>`
   to check received messages and confirmed replies. Follow `nextBefore` for
   another bounded page. Verify `message send` with the same `--operation-id`
   does not resend confirmed chunks. An unknown delivery requires inspection;
   creating a new operation can duplicate a message that already arrived.
8. Send an image and a file from WeChat, download them with the IDs in history,
   and exercise `okou wechat upload-file` (maximum 10 MiB). Publication must
   finish before delivery. A failed delivery must retain the published file.

History covers this connection's recorded messages, not pre-connection personal
WeChat history, contacts, or groups. Reconnecting an expired session retains recorded history;
disconnecting revokes agent access and deletes the message archive and private
media references while keeping canonical Okou conversation events. The encrypted
transport credential remains only to reply to later direct messages with the
Works connection link; these messages do not start runs or enter chat history.
A new verified QR replaces this detached transport with a fresh binding.
Member/account deletion permanently removes the transport. If Tencent expires
it first, receiving and reconnect notices stop until the user scans again.
Tencent CDN references can expire; ask the sender to resend an unavailable attachment.

The receiver requires a paid Cloudflare Workers plan, SQLite Durable Objects and
Workflows. Each receiving binding has one outstanding Tencent request. The
legacy mode keeps its API request open; Workflows mode contacts the API only for
authorization renewal, message delivery and provider-session expiry.
