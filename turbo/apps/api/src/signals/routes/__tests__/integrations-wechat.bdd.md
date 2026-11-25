# integrations-wechat

## integrations-wechat-001

- Vitest: "WeChat reply presentation and processing status > links a model failure to the original Web conversation"
- Mode: run
- Given: The web URL is `https://app.okou.ai`. A member with the WeChat integration switch, a Pro entitlement and a personal Claude subscription (model `claude-fable-5-1`) has connected WeChat by QR and received the welcome. A Runner group is available.
- When: The owner's WeChat message "Review this attachment" is delivered through the signed receiver routes `POST /api/internal/wechat/receiver` and `POST /api/internal/wechat/deliver`; the Run completes through `POST /api/webhooks/run/complete` with exit code 1 and failure reason `account_verification_required`; the member then adds and switches to another Claude subscription, and the resulting Run finishes with "The attachment review is complete.".
- Then: The last WeChat text contains "Switch this conversation's model in Okou: https://app.okou.ai/chats/<threadId>" and the thread records `run.failed` for the Run. After the switch a new Run starts with prompt `continue` while WeChat typing is on (status 1). When it finishes, the last WeChat text contains "The attachment review is complete." and typing ends (status 2).

## integrations-wechat-002

- Vitest: "WeChat reply presentation and processing status > offers billing recovery when a running WeChat task runs out of credits"
- Mode: run
- Given: A member with the WeChat switch, Pro entitlement and a personal Claude subscription has connected WeChat by QR. A Runner group is available.
- When: The owner's WeChat message "Finish this task" is delivered through the signed receiver routes, and the Run completes through `POST /api/webhooks/run/complete` with exit code 1 and failure reason `insufficient_credits`.
- Then: The last WeChat text contains "Insufficient credits" and a `/?settings=billing` link.

## integrations-wechat-003

- Vitest: "WeChat reply presentation and processing status > recovers generated failure copy without trusting repeated Runner diagnostics"
- Mode: run
- Given: A member with the WeChat switch, Pro entitlement and a personal Claude subscription has connected WeChat by QR, and a WeChat message has started a Run. The identity provider's membership lookup is temporarily unavailable.
- When: The Runner posts `POST /api/webhooks/run/complete` with exit code 1, failure reason `usage_limit` and a private diagnostic URL; after membership lookups recover it posts the same Run's completion twice with failure reason `future_reason` and error "Run cancelled".
- Then: The first completion returns HTTP 500 and the two retries return HTTP 200. Exactly one new WeChat text is sent, containing "Your Claude subscription has reached its usage limit." and a `?settings=model` link, without the private diagnostic or "Run cancelled".

## integrations-wechat-004

- Vitest: "WeChat reply presentation and processing status > stops a multi-part reply when membership access is revoked after the first part"
- Mode: run
- Given: A member has connected WeChat by QR, and a WeChat message has started a Run. WeChat accepts the first reply part (provider message `first-part`), and right after that send the member's workspace membership disappears.
- When: The Runner posts the result event with 2050 🌿 characters and then `POST /api/webhooks/run/complete`; after membership is restored the member reads `GET /api/integrations/wechat/messages?channelId=…&limit=50`.
- Then: The completion returns HTTP 500 and WeChat receives only the welcome and the first 2000-character part. History shows exactly two sent outbound messages: the first part with provider message ID `first-part` and the welcome containing "You're connected".

## integrations-wechat-005

- Vitest: "WeChat reply presentation and processing status > stops a multi-part reply when feature access is revoked after the first part"
- Mode: run
- Given: A member has connected WeChat by QR, and a WeChat message has started a Run. WeChat accepts the first reply part (provider message `first-part`), and right after that send the member's WeChat integration feature switch is turned off.
- When: The Runner posts the result event with 2050 🌿 characters and then `POST /api/webhooks/run/complete`; after the switch is re-enabled the member reads `GET /api/integrations/wechat/messages?channelId=…&limit=50`.
- Then: The completion returns HTTP 500 and WeChat receives only the welcome and the first 2000-character part. History shows exactly two sent outbound messages: the first part with provider message ID `first-part` and the welcome containing "You're connected".

## integrations-wechat-006

- Vitest: "WeChat reply presentation and processing status > rejects a send when a disconnect happens during credential decryption"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message has started a Run. The credential decryption for the next send is held until released.
- When: The member sends text through `POST /api/integrations/wechat/message`; while its credentials are being decrypted the member disconnects with `DELETE /api/integrations/wechat`.
- Then: The send request responds with HTTP 404 and WeChat has received only the welcome message.

## integrations-wechat-007

- Vitest: "WeChat reply presentation and processing status > rejects a send when a reconnect happens during credential decryption"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message has started a Run. The credential decryption for the next send is held until released.
- When: The member sends text through `POST /api/integrations/wechat/message`; while its credentials are being decrypted the member reconnects through `POST /api/integrations/wechat/connect` and a confirmed `POST /api/integrations/wechat/connect/status`.
- Then: The send request responds with HTTP 404 and WeChat has received only the welcome message.

## integrations-wechat-008

- Vitest: "WeChat reply presentation and processing status > delivers long Unicode replies and keeps typing for queued follow-ups"
- Mode: run
- Given: A member has connected WeChat by QR. A first WeChat message started a Run and a second message arrived while it was active.
- When: The Runner finishes the first Run with 2050 🌿 characters, then the queued follow-up Run finishes with "Follow-up complete".
- Then: WeChat receives the welcome plus reply parts that join exactly to the full text, each at most 2000 characters (three texts in total). Typing is not stopped after the first Run because the follow-up is queued; after the follow-up finishes the last typing status is 2 (stopped).

## integrations-wechat-009

- Vitest: "WeChat reply presentation and processing status > clears typing when a run is failed"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message has started a Run; typing is on (status 1).
- When: The Runner finishes the Run with an empty result and exit code 1.
- Then: The last WeChat typing status is 2 (stopped).

## integrations-wechat-010

- Vitest: "WeChat reply presentation and processing status > clears typing when a run is cancelled"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message has started a Run; typing is on (status 1).
- When: The member cancels the Run through the run cancel endpoint.
- Then: The cancel returns HTTP 200 and the last WeChat typing status is 2 (stopped).

## integrations-wechat-011

- Vitest: "WeChat reply presentation and processing status > still delivers replies when typing has missing ticket"
- Mode: run
- Given: A member has connected WeChat by QR. WeChat's `getconfig` returns no typing ticket.
- When: An owner message "Hello" is delivered through the signed receiver routes and the Run finishes with "Still delivered".
- Then: WeChat receives exactly the welcome and "Still delivered".

## integrations-wechat-012

- Vitest: "WeChat reply presentation and processing status > still delivers replies when typing has config unavailable"
- Mode: run
- Given: A member has connected WeChat by QR. WeChat's `getconfig` responds with HTTP 503.
- When: An owner message "Hello" is delivered through the signed receiver routes and the Run finishes with "Still delivered".
- Then: WeChat receives exactly the welcome and "Still delivered".

## integrations-wechat-013

- Vitest: "WeChat reply presentation and processing status > still delivers replies when typing has typing rejected"
- Mode: run
- Given: A member has connected WeChat by QR. WeChat's `sendtyping` rejects with `ret: -1`.
- When: An owner message "Hello" is delivered through the signed receiver routes and the Run finishes with "Still delivered".
- Then: WeChat receives exactly the welcome and "Still delivered".

## integrations-wechat-014

- Vitest: "WeChat reply presentation and processing status > recovers a reply after a pre-send failure (partial=false)"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message started a Run that posted a 2100-character result. Membership lookups are temporarily unavailable before any reply part is sent.
- When: The Runner posts `POST /api/webhooks/run/complete`, then, after lookups recover, posts the same completion twice more.
- Then: The first completion returns HTTP 500 with no part sent. Both retries return HTTP 200, and WeChat receives exactly two parts that join to the full reply.

## integrations-wechat-015

- Vitest: "WeChat reply presentation and processing status > recovers a reply after a pre-send failure (partial=true)"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message started a Run that posted a 2100-character result. Membership lookups become unavailable right after the first reply part is sent.
- When: The Runner posts `POST /api/webhooks/run/complete`; after lookups recover and 31 seconds pass the receiver gateway bootstraps through the signed `POST /api/internal/wechat/receiver`; the Runner then posts the same completion twice more.
- Then: The first completion returns HTTP 500 after one part. The receiver bootstrap alone resumes delivery so two parts have been sent, the two retries return HTTP 200 without resending, and the parts join exactly to the full reply.

## integrations-wechat-016

- Vitest: "WeChat reply presentation and processing status > does not resend an ambiguous reply on repeated Runner completion"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message started a Run. WeChat's `sendmessage` fails at the network level, so delivery is ambiguous.
- When: The Runner finishes the Run with "Ambiguous reply", then repeats the same result and completion.
- Then: Exactly one send attempt is made in total; the repeated completion does not resend.

## integrations-wechat-017

- Vitest: "WeChat reply presentation and processing status > accepts new input while reply recovery is waiting for WeChat"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message started a Run. The Run finished with "Recovered answer" while membership lookups were unavailable, so the completion returned HTTP 500 and reply delivery is pending recovery.
- When: After lookups recover and 31 seconds pass, a new owner message "A later prompt" is delivered through the signed receiver routes while WeChat holds the recovered reply send open; the member reads `GET /api/integrations/wechat/messages`.
- Then: History contains the inbound message "A later prompt" while the reply send is in flight. WeChat receives exactly one reply, "Recovered answer".

## integrations-wechat-018

- Vitest: "WeChat reply presentation and processing status > serializes overlapping completion delivery attempts after 0 ms"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message started a Run. WeChat holds the first reply send open.
- When: While the Run's completion is delivering "Only one reply", the Runner posts a second completion immediately (0 ms later); after the first delivery finishes it posts another completion.
- Then: The overlapping completion returns HTTP 500 with only one send attempt. The later completion returns HTTP 200 and still only one send attempt is made.

## integrations-wechat-019

- Vitest: "WeChat reply presentation and processing status > serializes overlapping completion delivery attempts after 91000 ms"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message started a Run. WeChat holds the first reply send open.
- When: While the Run's completion is delivering "Only one reply", the clock advances 91 seconds and the Runner posts a second completion; after the first delivery finishes it posts another completion.
- Then: The overlapping completion returns HTTP 500 with only one send attempt. The later completion returns HTTP 200 and still only one send attempt is made.

## integrations-wechat-020

- Vitest: "WeChat reply presentation and processing status > clears typing even when the reply cannot be delivered"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message started a Run; typing is on. WeChat's `sendmessage` responds with HTTP 503.
- When: The Runner finishes the Run with "Done"; 31 seconds later the receiver gateway delivers an empty batch, and the Runner posts another completion.
- Then: WeChat has received only the welcome text and typing ends (status 2). The later completion returns HTTP 200 and the reply is attempted exactly once in total.

## integrations-wechat-021

- Vitest: "WeChat reply presentation and processing status > does not restore typing when a delayed config read outlives completion"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message started a Run. The next WeChat `getconfig` read is held open.
- When: The Runner posts a heartbeat to the run heartbeat webhook, which starts the held config read; the Run then finishes with "Done" before the read is released.
- Then: WeChat receives exactly the welcome and "Done". After completion no typing-on status (1) is sent, and the last typing status is 2.

## integrations-wechat-022

- Vitest: "WeChat reply presentation and processing status > does not send typing after the connection is disconnected during a config read"
- Mode: run
- Given: A member has connected WeChat by QR and a WeChat message started a Run. WeChat's `getconfig` reads are held open.
- When: The Runner posts a heartbeat, which starts a config read; the member disconnects with `DELETE /api/integrations/wechat` before the read is released.
- Then: The disconnect returns HTTP 204 and no further typing status is sent after the read completes.

## integrations-wechat-023

- Vitest: "WeChat QR owner binding > handles verification and publishes only a sanitized connection status"
- Mode: run
- Given: A signed-in member of workspace "WeChat test workspace" has the WeChat integration switch on and the WeChat receiver gateway is configured. Tencent first reports the QR as needing a verification code, then confirms it with a private bot token for scanner `scanner-<userId>`.
- When: The member starts `POST /api/integrations/wechat/connect`, polls `POST /api/integrations/wechat/connect/status` without and then with verify code `123456`, reads `GET /api/integrations/wechat`, and disconnects with `DELETE /api/integrations/wechat`.
- Then: The attempt returns HTTP 200 with QR content `https://weixin.qq.com/test-qr` and never contains the private bot token. The polls report `verification_required` and then `connected`, Tencent sees verify codes `null` then `123456`, and exactly one receiver is started. The status is exactly `{status: active, configured: true, binding: {workspace: {id, name: "WeChat test workspace"}, accountId: "scanner-<userId>"}}`; after the HTTP 204 disconnect the status is `disconnected`.

## integrations-wechat-024

- Vitest: "WeChat QR owner binding > a replacement attempt makes an older QR unable to bind"
- Mode: run
- Given: A signed-in member has the WeChat integration switch on, and Tencent confirms the QR scan.
- When: The member starts two attempts with `POST /api/integrations/wechat/connect`, then polls `POST /api/integrations/wechat/connect/status` for the first and then the second attempt.
- Then: The first attempt's poll reports `expired` and starts no receiver. The second attempt's poll reports `connected`.

## integrations-wechat-025

- Vitest: "WeChat QR owner binding > cancellation prevents late confirmation and does not start a receiver"
- Mode: run
- Given: A signed-in member has the WeChat integration switch on.
- When: The member starts `POST /api/integrations/wechat/connect`, cancels it with `DELETE /api/integrations/wechat/connect`, Tencent then confirms the scan, and the member polls `POST /api/integrations/wechat/connect/status`.
- Then: The cancel returns HTTP 204, the poll reports `expired`, and no receiver is started.

## integrations-wechat-026

- Vitest: "WeChat QR owner binding > another owner cannot poll or cancel the original owner's QR"
- Mode: run
- Given: A member has started a WeChat QR attempt. Another member of the same workspace with the WeChat switch on is signed in.
- When: The other member polls `POST /api/integrations/wechat/connect/status` and cancels with `DELETE /api/integrations/wechat/connect` for the original attempt; the original owner then polls after Tencent confirms.
- Then: The other member's poll reports `expired` and the cancel returns HTTP 204 without affecting the attempt. The original owner's poll reports `connected` and exactly one receiver is started.

## integrations-wechat-027

- Vitest: "WeChat QR owner binding > does not contact WeChat when the feature is disabled"
- Mode: run
- Given: A signed-in member has the WeChat integration switch turned off.
- When: The member calls `POST /api/integrations/wechat/connect`.
- Then: The API responds with HTTP 403.

## integrations-wechat-028

- Vitest: "WeChat QR owner binding > cannot publish a confirmation after cancellation while Tencent is responding"
- Mode: run
- Given: A signed-in member has started a WeChat QR attempt and Tencent confirms it, but the status response is held open.
- When: The member polls `POST /api/integrations/wechat/connect/status`; while Tencent is responding the member cancels with `DELETE /api/integrations/wechat/connect`, then the poll completes, and the member reads `GET /api/integrations/wechat`.
- Then: The cancel returns HTTP 204, the poll returns HTTP 409, no receiver is started, and the status is `disconnected`.

## integrations-wechat-029

- Vitest: "WeChat QR owner binding > does not replace the existing owner when the same scanner connects elsewhere"
- Mode: run
- Given: A first member has connected WeChat with a scanner account. A second member in another workspace has the WeChat switch on and is signed in.
- When: The second member starts `POST /api/integrations/wechat/connect` and Tencent confirms it with the same scanner account; the second member polls `POST /api/integrations/wechat/connect/status` and reads `GET /api/integrations/wechat`.
- Then: The poll returns HTTP 409, no receiver is started for the second member, and the second member's status is `disconnected`.

## integrations-wechat-030

- Vitest: "WeChat QR owner binding > stops authenticated receiver requests for missing bindings and rejects forged requests"
- Mode: run
- Given: The WeChat receiver gateway secret is configured. No WeChat binding exists for a random connection ID.
- When: The gateway posts `POST /api/internal/wechat/receiver` for that connection with a valid HMAC signature, then with a signature of 64 zeros.
- Then: The validly signed request returns HTTP 200 with exactly `{active: false}`. The forged request returns HTTP 401.

## integrations-wechat-031

- Vitest: "receives an owner DM once, resumes its native session and delivers the canonical reply"
- Mode: run
- Given: A member with the WeChat switch, Pro entitlement and personal Claude subscription has connected WeChat by QR. Tencent serves owner messages with uint64 message IDs, quoted text, and later an encrypted `report.csv`, PNG/GIF images and unavailable media; a Runner group is available.
- When: The receiver gateway delivers batches through `POST /api/internal/wechat/receiver` and `POST /api/internal/wechat/deliver` (repeats, a foreign sender, a follow-up, attachments); the Run heartbeats and completes; the agent uses `GET /api/integrations/wechat/channels`, `GET /api/integrations/wechat/messages`, `POST /api/integrations/wechat/message` and `GET /api/integrations/wechat/download-file`; the member finally disconnects with `DELETE /api/integrations/wechat` while a second Run is active.
- Then: Only the welcome (without context token) is sent before the first Run, whose prompt and WeChat system context include the message, quote, channel ID and message ID but not the context or bot token; after the repeat and the foreign sender the thread holds exactly one prompt bound to that Run and one unbound prompt, and the follow-up steers the active Run. The heartbeat returns `{ok: true, typingRefreshIntervalSeconds: 5}`; the reply "I will remember Orchid." is sent with the context token, typing ends, the single channel and paged history (reply, follow-up, first message, welcome) are listed, and unknown channel or cursor return HTTP 404. Message sends are idempotent per operation (identical replay, HTTP 409 for changed text or a concurrent duplicate, HTTP 502 then 409 with an `unknown` message after partial failure); the next Run resumes session `wechat-native-session` in the same thread with the stored CSV as `[Web file] report.csv (text/csv)` and a downloadable attachment, images are imported once, failing media is attempted once, and after disconnect channels are empty, send and history return HTTP 404, no steerable input remains and the completed Run sends nothing.

## integrations-wechat-032

- Vitest: "publishes owner files once across retry, overlapping completion and uncertain delivery"
- Mode: run
- Given: A member has connected WeChat by QR and sent "Please send report.csv". The member's private artifact storage holds the uploaded `report.csv` bytes. WeChat's CDN fails the first three uploads with HTTP 503 and then accepts.
- When: The member calls `POST /api/integrations/wechat/upload-file/init` twice concurrently and once with a changed comment, `POST /api/integrations/wechat/upload-file/materialize`, then `POST /api/integrations/wechat/upload-file/complete` once, twice concurrently and once more; a second operation is completed while WeChat's `sendmessage` fails at the network level, and completed again.
- Then: The concurrent inits return the same asset ID and URL, and the changed init returns HTTP 409. Materialize returns delivery status `pending`. The first complete returns HTTP 503 with a message containing "before sending" after three CDN attempts and no message. The concurrent completes both return HTTP 200, one reports `delivered` with the published URL after five CDN uploads and exactly one message; a repeat returns the same body without sending. The ambiguous operation returns HTTP 200 with delivery `{status: failed, retryable: false}` after one send, and repeating it returns the same body without another send.

## integrations-wechat-033

- Vitest: "native WeChat commands isolate users and workspaces and honor live revocation"
- Mode: run
- Given: A member has connected WeChat by QR. Another user in the same workspace and the same user in another workspace each have the WeChat switch on.
- When: Each other identity calls `GET /api/integrations/wechat/channels`, `GET /api/integrations/wechat/messages` and `POST /api/integrations/wechat/message` for the owner's channel; then the owner reads history after the WeChat switch is turned off, and again after membership is revoked.
- Then: Each other identity sees no channels and gets HTTP 404 for history and send. The owner's history returns HTTP 403 when the switch is off and HTTP 403 when the membership is gone.

## integrations-wechat-034

- Vitest: "WeChat system notices > keeps only reconnect replies after disconnect, deduplicates retries and revokes native access"
- Mode: run
- Given: A member connected WeChat by QR and then disconnected with `DELETE /api/integrations/wechat`. The app URL is `https://app.okou.test`. The scanner keeps sending messages to the bot.
- When: The receiver gateway delivers the owner's message, repeats the disconnect and the same batch, delivers a new message ID, then the member calls the channels, history and send endpoints, reconnects with a new QR, and the old receiver bootstraps again.
- Then: The first delivery reports `{active: true}` and sends one reconnect reply to the scanner with the context token and a `https://app.okou.test/settings/wechat?token=` link, without the incoming text. The repeated disconnect and batch send nothing more; the new message gets a second reply. Channels are empty, history and send return HTTP 404, and no further message is sent. The new QR creates a different connection, the old receiver gets `{active: false}`, and the new channel's history holds only the outbound "You're connected" welcome.

## integrations-wechat-035

- Vitest: "WeChat system notices > ignores unverified messages and never retries an ambiguous reconnect send"
- Mode: run
- Given: A member connected WeChat by QR and then disconnected. WeChat's `sendmessage` responds with HTTP 503.
- When: The receiver gateway delivers a batch with only unverified messages (another scanner, another bot, a group message, an empty context token, a non-user message type), then delivers a valid owner message twice.
- Then: The unverified batch triggers no send attempt. The valid owner message triggers exactly one reconnect send attempt, which is not retried on redelivery.

## integrations-wechat-036

- Vitest: "WeChat system notices > does not send or enqueue a stale batch completed after disconnect"
- Mode: run
- Given: A member has connected WeChat by QR. WeChat holds the next `getupdates` response open.
- When: The receiver gateway starts a fetch; the member disconnects with `DELETE /api/integrations/wechat`; the held batch with an owner message is then delivered, and the gateway later fetches and delivers the same message again.
- Then: The stale batch completed after disconnect sends nothing. The subsequent delivery sends exactly one message.

## integrations-wechat-037

- Vitest: "WeChat system notices > does not create a chat when disconnect completes during the welcome request"
- Mode: run
- Given: A member with the WeChat switch on starts a QR connection. WeChat holds the welcome `sendmessage` open.
- When: The member confirms the QR via `POST /api/integrations/wechat/connect/status`, disconnects with `DELETE /api/integrations/wechat` while the welcome is in flight, and reads `GET /api/integrations/wechat` after the welcome completes.
- Then: The disconnect returns HTTP 204 and the status is `disconnected`.

## integrations-wechat-038

- Vitest: "WeChat system notices > allows a verified scanner to move to a new owner only after disconnect"
- Mode: run
- Given: A first member connected WeChat with a scanner account and then disconnected. A second member in another workspace has the WeChat switch on.
- When: The second member starts `POST /api/integrations/wechat/connect`, Tencent confirms it with the first member's scanner account, and the second member polls `POST /api/integrations/wechat/connect/status`; the first member's old receiver then bootstraps through `POST /api/internal/wechat/receiver`.
- Then: The poll returns HTTP 200 and exactly one receiver starts for the second member, with a connection ID different from the old one. The old receiver bootstrap reports `{active: false}`.

## integrations-wechat-039

- Vitest: "WeChat system notices > preserves the detached receiver when a QR tries to claim another active scanner"
- Mode: run
- Given: A first member has an active WeChat binding for a scanner account. A second member connected a different scanner and then disconnected, leaving a detached receiver.
- When: The second member starts a new QR attempt that Tencent confirms with the first member's active scanner account and polls `POST /api/integrations/wechat/connect/status`; the detached receiver then delivers an empty batch.
- Then: The poll returns HTTP 409. The detached receiver remains running and its delivery reports `{active: true}`.

## integrations-wechat-040

- Vitest: "WeChat system notices > can bind a different scanner after disconnect"
- Mode: run
- Given: A member connected WeChat and then disconnected.
- When: The member starts a new QR attempt that Tencent confirms with a different verified scanner account, polls `POST /api/integrations/wechat/connect/status`, and the old receiver bootstraps through `POST /api/internal/wechat/receiver`.
- Then: The poll returns HTTP 200 and a receiver with a new connection ID starts. The old receiver bootstrap reports `{active: false}`.

## integrations-wechat-041

- Vitest: "WeChat system notices > stops the detached receiver when membership is revoked or Tencent expires the session"
- Mode: run
- Given: A member connected WeChat and then disconnected, leaving a detached receiver. Tencent's `getupdates` reports the session expired (`ret: -14`).
- When: The receiver gateway runs a receive cycle after the WeChat switch is turned off, again after the switch is restored but membership is revoked, again after membership is restored, and once more; the member then reads `GET /api/integrations/wechat`.
- Then: With the switch off and with membership revoked, the cycle reports `{active: false}` without polling Tencent. With access restored, the cycle polls Tencent once, sees the expired session and reports `{active: false}`; the next cycle reports `{active: false}` without polling again. The status is `disconnected`.

## integrations-wechat-042

- Vitest: "WeChat system notices > continues processing the first prompt when the welcome delivery fails and welcomes a new binding once"
- Mode: run
- Given: A member with the WeChat switch, Pro entitlement and a personal Claude subscription is ready to connect. WeChat's first `sendmessage` responds with HTTP 503 and later ones succeed. Tencent serves an owner message "A private incoming message".
- When: The member connects by QR, the receiver gateway delivers the owner's message twice, the member reads `GET /api/integrations/wechat/messages`, disconnects, connects a new binding, and the new receiver delivers the message twice.
- Then: The welcome is attempted once and not retried; the first binding's history lists the inbound message and an outbound welcome with status `unknown`. After reconnecting, exactly one more welcome is sent, and the new binding's history lists the inbound message and the outbound welcome with status `sent`.

## integrations-wechat-043

- Vitest: "WeChat input failure isolation > retains the inbound batch for retry when member dispatch is unavailable"
- Mode: run
- Given: A member has connected WeChat by QR but member dispatch is unavailable (no Run can be started). Tencent serves an owner message.
- When: The receiver gateway bootstraps and delivers the batch through `POST /api/internal/wechat/deliver` twice.
- Then: Both deliveries return a `retryAfterMs`, Tencent is polled only once so the batch is retained, and WeChat receives exactly one message "Oops, something went wrong. Please try again later.".

## integrations-wechat-044

- Vitest: "WeChat input failure isolation > isolates an unavailable attachment and persists bounded retries (recovers=false)"
- Mode: run
- Given: A member with the WeChat switch, Pro entitlement and personal Claude subscription has connected WeChat by QR. Tencent's first batch holds a malformed message, an image message `failed-file` whose CDN download fails with HTTP 503, and a text message `later-text`; later batches repeat `failed-file`, and the image never becomes available.
- When: The receiver gateway delivers the first batch, retries immediately, after 1.1 seconds, after another 2.1 seconds, and once more; the member reads `GET /api/integrations/wechat/messages`.
- Then: The first delivery downloads once and `later-text` appears in history. The immediate retry respects the stored backoff, and the later retries download a second and third time; WeChat receives one "couldn't process this message" notice. Tencent is polled twice in total, `later-text` appears exactly once, and `failed-file` is absent from history.

## integrations-wechat-045

- Vitest: "WeChat input failure isolation > isolates an unavailable attachment and persists bounded retries (recovers=true)"
- Mode: run
- Given: A member with the WeChat switch, Pro entitlement and personal Claude subscription has connected WeChat by QR. Tencent's first batch holds a malformed message, an image message `failed-file` whose CDN download first fails with HTTP 503, and a text message `later-text`; the image becomes available before the second download.
- When: The receiver gateway delivers the first batch, retries immediately, after 1.1 seconds, and once more; the member reads `GET /api/integrations/wechat/messages`.
- Then: The first delivery downloads once and `later-text` appears in history. The immediate retry respects the stored backoff and the retry after 1.1 seconds downloads the image a second time. Tencent is polled twice in total, downloads stay at two, `later-text` appears exactly once, and `failed-file` is present in history.

## integrations-wechat-046

- Vitest: "weChat history keeps time bounds across pages and validates their order"
- Mode: run
- Given: A member has connected WeChat by QR and received owner messages at 00:00 ("Outside before"), 01:00 ("At oldest"), 01:30 ("Inside window") and 02:00 ("At latest") on 2026-10-19 UTC.
- When: The member reads `GET /api/integrations/wechat/messages` with `oldest` 01:00, `latest` 02:00 and `limit=1`, follows `nextBefore`, and then repeats the query with `oldest` and `latest` swapped.
- Then: The first page returns only "Inside window"; the next page returns only "At oldest" with `nextBefore: null`. The swapped bounds return HTTP 400.

## integrations-wechat-047

- Vitest: "WeChat reconnect links > requires confirmation, restores without a new QR, and consumes concurrent and old links"
- Mode: run
- Given: A member connected WeChat, disconnected, and then received a reconnect notice in WeChat whose `/settings/wechat?token=…` link contains no bot token, context token or scanner ID. Tencent would issue a new QR if asked.
- When: The member reads `GET /api/integrations/wechat/reconnect?token=…` and `GET /api/integrations/wechat`, submits two concurrent `POST /api/integrations/wechat/reconnect` requests with the token, reads the status, disconnects again, and retries the same link.
- Then: The link is reported available while the status is `disconnected`. The concurrent reconnects return HTTP 204 and HTTP 409; no new QR is requested, the receiver restarts on the original connection, the status becomes `active`, and a third message (a welcome containing "You're connected" without context token) is sent. After the second disconnect the link is reported unavailable and reconnecting returns HTTP 409.

## integrations-wechat-048

- Vitest: "WeChat reconnect links > rejects a different owner or workspace without exposing the binding"
- Mode: run
- Given: A member connected WeChat, disconnected and received a reconnect link. Another member in another workspace has the WeChat switch on; the original user is also a member of that other workspace.
- When: The other member, and then the original user in the other workspace, each read `GET /api/integrations/wechat/reconnect?token=…` and submit `POST /api/integrations/wechat/reconnect` with the token.
- Then: In both cases the link is reported unavailable and the reconnect returns HTTP 409.

## integrations-wechat-049

- Vitest: "WeChat reconnect links > rejects forged and expired links and accepts a newly issued link"
- Mode: run
- Given: A member connected WeChat, disconnected and received a reconnect link.
- When: The member checks and submits a tampered token through `GET` and `POST /api/integrations/wechat/reconnect`, then the original token after the clock advances 10 minutes; a new owner message then produces a fresh reconnect notice, whose token the member submits.
- Then: The tampered and the expired tokens are reported unavailable and their reconnects return HTTP 409. The newly issued link's reconnect returns HTTP 204.

## integrations-wechat-050

- Vitest: "WeChat reconnect links > rejects revoked access and expired transports"
- Mode: run
- Given: A member connected WeChat, disconnected and received a reconnect link.
- When: With the WeChat switch off the member calls `GET /api/integrations/wechat/reconnect?token=…` and `POST /api/integrations/wechat/reconnect`; with the switch back on, Tencent reports the session expired during a receive cycle and the member checks and submits the link again.
- Then: With the switch off both requests return HTTP 403. After the transport expires the receive cycle reports inactive, the link is reported unavailable, and the reconnect returns HTTP 409.

## integrations-wechat-051

- Vitest: "WeChat reconnect links > discards a disconnected poll response completed after restoration"
- Mode: run
- Given: A member connected WeChat, disconnected and received a reconnect link. Tencent holds the next `getupdates` response, which carries a new owner message.
- When: The receiver gateway starts a fetch for the disconnected transport; the member restores it with `POST /api/integrations/wechat/reconnect`; the held batch is then delivered, and the member reads `GET /api/integrations/wechat/messages`.
- Then: The reconnect returns HTTP 204 and exactly three WeChat messages have been sent. History holds only the outbound welcome containing "You're connected"; the late message from the disconnected poll is discarded.

## integrations-wechat-052

- Vitest: "a restored transport ignores provider backlog and accepts only newly created messages"
- Mode: run
- Given: A member with a Pro entitlement and personal Claude subscription connected WeChat, disconnected, and restored the binding through `POST /api/integrations/wechat/reconnect`. Tencent's backlog holds an owner message created a minute earlier and one without a creation time.
- When: The receiver bootstraps through `POST /api/internal/wechat/receiver` and delivers the backlog, then delivers a freshly created message `fresh-message`; the member reads `GET /api/integrations/wechat/messages` after each.
- Then: The bootstrap session asks to preserve the cursor. After the backlog, history holds only the outbound welcome. After the fresh message, history holds the inbound `fresh-message` and the welcome, and three WeChat messages have been sent in total.

## integrations-wechat-053

- Vitest: "WeChat Workflow receiver > bootstraps a receiver and renews without exposing credentials again"
- Mode: run
- Given: A member with the WeChat switch on has connected WeChat by QR in workspace "WeChat test workspace".
- When: The receiver gateway calls `POST /api/internal/wechat/receiver` with a forged signature, then with a valid HMAC signature, then renews with the returned generation; the member reads `GET /api/integrations/wechat`.
- Then: The forged request returns HTTP 401. The signed bootstrap returns `active: true` with a session holding the bot token and an empty cursor; the renewal returns exactly `{active: true, generation}` without credentials. The status is exactly `{configured: true, status: active, binding: {workspace: {id, name: "WeChat test workspace"}, accountId: "scanner-<userId>"}}`.

## integrations-wechat-054

- Vitest: "WeChat Workflow receiver > deduplicates delivered messages, rejects stale generations and retains reconnect notices"
- Mode: run
- Given: A member with the WeChat switch, Pro entitlement and personal Claude subscription has connected WeChat by QR and the receiver has a current generation. After the first deliveries, the receiver service start endpoint responds with HTTP 503.
- When: The gateway posts the same owner message batch to `POST /api/internal/wechat/deliver` twice; the member disconnects; the gateway redelivers the old batch, bootstraps a detached generation, delivers a new message twice, the member reads history, and the gateway posts `POST /api/internal/wechat/expire` and bootstraps again.
- Then: History holds exactly one inbound message. After disconnect the old-generation delivery returns exactly `{active: true, refresh: true}`. The detached delivery sends exactly one reconnect notice containing `/settings/wechat?token=` and history returns HTTP 404. Expire returns exactly `{active: false}` and a later bootstrap returns `{active: false}`.

## integrations-wechat-055

- Vitest: "WeChat Workflow receiver > stops renewal when workspace membership is revoked"
- Mode: run
- Given: A member has connected WeChat by QR and the receiver has bootstrapped once.
- When: The member's workspace membership is removed and the receiver gateway calls `POST /api/internal/wechat/receiver` again with a valid signature.
- Then: The bootstrap returns HTTP 200 with exactly `{active: false}`.
