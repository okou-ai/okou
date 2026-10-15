# WeChat connection in Works

This integration lets an authenticated workspace member connect WeChat from
`/works`, scan and confirm a QR code, and chat with their workspace's default
agent through text direct messages. It uses Tencent's iLink bot protocol as
implemented by `@tencent-weixin/openclaw-weixin` 2.4.10 (installer CLI 2.1.4).
It does not run the installer or an OpenClaw process on the API server.

The `wechatIntegration` feature switch and receiver startup are off by default.
This is an initial integration for internal testing, not a claim of Tencent
production certification or a stable third-party API contract.

## Connection and ownership

1. Works creates a five-minute, server-owned QR attempt for the authenticated
   `(orgId, userId)`. The browser receives QR content and an opaque attempt ID.
2. The server polls Tencent. The dialog handles waiting, scanned, verification
   code required, blocked, expired and provider restart states.
3. Confirmation consumes only the current, unexpired attempt and atomically
   binds the verified scanner. A scanner can belong to only one Okou owner.
   Connecting a different scanner requires disconnecting the old binding.
4. A reconnect rotates the credential generation. Old in-flight inputs and
   replies cannot acquire authority from the new generation.
5. Disconnect cancels attempts, deletes the bot and per-message reply
   credentials, and removes the route. Canonical chat events remain available
   in Okou. Member departure and owner deletion also revoke the connection.

Bot tokens, QR polling secrets, reply context tokens and pending provider
batches use the existing KMS-backed stored-secret envelope. The browser, model
prompt, runner environment and public chat projection do not receive them.
Only allowlisted Tencent HTTPS origins can receive provider credentials.

## Receiving after the page closes

`wechat-gateway-worker` owns one Cloudflare Durable Object alarm per connection.
The authenticated `/start` control endpoint schedules receiving; alarms sign
`POST /api/internal/wechat/poll` using HMAC-SHA256. The worker stores only the
connection ID. The API holds provider credentials and performs long polling.

The API saves an encrypted response batch and its next cursor together before
dispatching any messages. A retry drains that batch before fetching more.
Canonical event IDs derive from connection ID, generation and the exact uint64
message ID. Context, canonical input and queue insertion commit together in a
single SQL statement, so replay does not create another input. Each message
must match the verified scanner and bot; group messages are ignored.

Alarms recover after a worker restart. Invalid sessions become
`reconnect_required` and stop polling. Removed bindings, disabled features and
departed members also stop receiving. Reading Works status can restart an
active receiver whose initial `/start` response was lost.

## Context and delivery

The implementation follows Discord's canonical Chat/Run integration:

- One route per binding, shared with the native chat event and queue pipeline.
- Canonical `userMessage` documents, with a WeChat source annotation.
- Current message, scanner/bot/message identities and explicitly untrusted
  quoted text in the prompt. No provider reply token is model-visible.
- Existing agent instructions, model selection, tools and native session
  continuation. New messages arriving during a run use the existing active
  input path, with the same binding and membership validation.
- Canonical output/error/cancellation text returned to the verified sender.
  Delivery checks the original connection generation and live ownership before
  sending, including rechecking revocation between text chunks.

Tencent's inspected bot protocol offers no endpoint to fetch earlier chat
history. Context therefore starts with messages received by this connection;
subsequent turns use Okou's canonical/native session history. This is not access
to the user's contacts, personal chat archive, other conversations or groups.
Attachments are not downloaded in this version; the agent is told that their
content was not read and to request text instead.

Outbound delivery follows Discord's post-commit reply path. It supplies stable
client IDs but does not promise exactly-once delivery or automatically replay
ambiguous network failures. A failed send can leave a canonical reply visible
in Okou but undelivered in WeChat. Durable outbound retries, media support,
typing indicators and general WeChat history/send CLI tools are outside this
initial version.

## Deployment for an internal scan test

1. Deploy the schema migration and API/app changes with the feature disabled.
2. Provision two distinct random secrets of at least 32 characters:
   `WECHAT_GATEWAY_SECRET` (worker-to-API HMAC) and
   `WECHAT_GATEWAY_CONTROL_SECRET` (API-to-worker control authorization).
3. Configure the API with those secrets and `WECHAT_GATEWAY_URL` pointing to the
   receiver origin. Keep the values in the normal secret-management system.
4. The **Deploy WeChat Gateway** workflow reads the matching GitHub environment's
   two secrets, `CF_API_WORKER_DEPLOY_API_TOKEN`, `CF_ACCOUNT_ID`, and the
   `WECHAT_API_ORIGIN` variable (canonical HTTPS API origin). It deploys only
   from main. Choose the test environment first and explicitly enable the
   gateway when API configuration is ready. Startup otherwise stays disabled.
5. Enable `wechatIntegration` only for the internal tester. Open `/works`, click
   WeChat Connect, scan and confirm, then send two text turns. Close Works before
   the second turn to verify background receiving and session continuity.
6. Exercise an expired QR, verification challenge if Tencent requests it,
   reconnect, disconnect during an active run, and member departure. Confirm
   tokens are absent from browser responses and model-visible material.

The receiver requires Cloudflare SQLite Durable Objects. At scale, long polling
creates one outstanding provider/API request per active binding; evaluate
concurrency, provider limits and operating cost before widening rollout.

## Verification

Route tests use PostgreSQL with mocked external Tencent, Clerk, KMS, storage and
runner boundaries. They cover QR lifecycle, owner isolation, exact message IDs,
canonical input/reply handling, session continuation and revocation. UI tests
exercise the Works dialog. Worker tests use real Miniflare/workerd Durable
Objects and verify signed requests. No Tencent account is connected by these
tests. A deployed real-device scan remains the final integration check.

The lossless JSON ID scanner is adapted under Tencent's MIT license; see
[the retained license](licenses/wechat-MIT.txt).
