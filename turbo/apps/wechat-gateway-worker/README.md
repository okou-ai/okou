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

## Deploy and operate

1. Deploy the database migration and API before the gateway. The receiver uses
   only the Workflows bootstrap, delivery and expiry endpoints. All `/start`
   requests must include the current binding generation; `/stop` needs only the
   connection ID and remains available while startup is disabled.
2. Provision distinct `WECHAT_GATEWAY_SECRET`, `WECHAT_GATEWAY_CONTROL_SECRET`
   and `WECHAT_RECEIVER_ENCRYPTION_KEY` values of at least 32 characters in the
   matching GitHub environment. Keep the encryption key stable across
   deployments; HMAC/control secret rotation does not rotate stored encryption.
   Replacing it requires draining or re-encrypting pending state first.
3. Run **Deploy WeChat Gateway** from current main, first in test. Set
   `enable_gateway=true` to allow reception. Opening Works or completing a
   verified QR calls authenticated `/start`. Existing receivers retain their
   Durable Object identity and encrypted replay state across deployments.
4. Confirm background reception, failed-delivery replay, reconnect, disconnect,
   owner deletion and provider expiry. Before widening the internal rollout,
   measure CPU, DO active duration, cursor-change frequency and concurrent
   instance startup/recovery in Cloudflare. Local workerd tests are not cloud
   capacity or invoice measurements. Long-polling instances consume concurrency.

The existing DO owns the authoritative polling cursor and pending replay batch.
The API's encrypted SQL batch still owns per-input retry progress and supplies
bootstrap recovery; it must not be deleted as obsolete polling state. Do not
clear DO state or restore an old gateway artifact. API rollback enforces the
[Workflows-only floor](../../../.github/rollback-floors/wechat-workflows-only).
Roll forward to recover. `enable_gateway=false` pauses reception while retaining
DO state; re-enable and call `/start` to resume it.

There is no per-poll success logging. Successful Workflow history retains one
day; failed history retains seven days. The DO contains the durable replay state,
so pruning completed Workflow history does not discard pending deliveries.

## Deployment for an internal scan test

1. Deploy the schema migration and API/app changes with the feature disabled.
2. Provision three distinct random secrets of at least 32 characters:
   `WECHAT_GATEWAY_SECRET` (worker-to-API HMAC),
   `WECHAT_GATEWAY_CONTROL_SECRET` (API-to-worker control authorization), and
   `WECHAT_RECEIVER_ENCRYPTION_KEY` (Durable Object replay encryption).
3. Configure the API with the HMAC/control secrets and `WECHAT_GATEWAY_URL`
   pointing to the receiver origin. The API deployment reads the URL from GitHub variables and
   both credentials from GitHub secrets, matching the gateway deployment below.
   Use a receiver whose `WECHAT_API_ORIGIN` targets that same API environment.
4. The **Deploy WeChat Gateway** workflow reads the matching GitHub environment's
   three secrets, `CF_API_WORKER_DEPLOY_API_TOKEN`, `CF_ACCOUNT_ID`, and the
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
receiver contacts the API only for authorization renewal, message delivery and
provider-session expiry.
