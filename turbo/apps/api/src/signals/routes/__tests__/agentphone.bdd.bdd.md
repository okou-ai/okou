# agentphone.bdd

## agentphone.bdd-001

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > links a imessage model failure to its original Web conversation"
- Mode: run
- Given: A Pro-entitled member has linked their phone to Okou through the AgentPhone connect prompt, a Runner group is online, and the Web URL is `https://app.okou.ai`; the channel is `imessage`.
- When: The phone sends "review this attachment" through the signed `POST /api/agentphone/webhook`, the Runner receives the dispatched run, and the sandbox completes it through `POST /api/webhooks/run/complete` with exit code 1 and failure reason `account_verification_required`.
- Then: The member's thread lifecycle exposes the newly created integration conversation, whose events contain `run.failed` for that run. The last AgentPhone reply contains "Switch this conversation's model in Okou: https://app.okou.ai/chats/<threadId>" and "Send your previous request again after switching."

## agentphone.bdd-002

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > links a sms model failure to its original Web conversation"
- Mode: run
- Given: A Pro-entitled member has linked their phone to Okou through the AgentPhone connect prompt, a Runner group is online, and the Web URL is `https://app.okou.ai`; the channel is `sms`.
- When: The phone sends "review this attachment" through the signed `POST /api/agentphone/webhook`, the Runner receives the dispatched run, and the sandbox completes it through `POST /api/webhooks/run/complete` with exit code 1 and failure reason `account_verification_required`.
- Then: The member's thread lifecycle exposes the newly created integration conversation, whose events contain `run.failed` for that run. The last AgentPhone reply contains "Switch this conversation's model in Okou: https://app.okou.ai/chats/<threadId>" and "Send your previous request again after switching."

## agentphone.bdd-003

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > adds an iMessage reaction with a run token (group: false)"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the inbound iMessage is a direct message (group: false).
- When: The phone sends "@Okou review this plan" over iMessage through `POST /api/agentphone/webhook`, and the run's CLI token calls `POST /api/integrations/phone/reaction` with that message ID and reaction "🔥".
- Then: The dispatched run's system prompt contains `Message ID: <id>`, the `okou phone reaction <message-id>` command, and "does not require a separate user request". The reaction request returns HTTP 200 with `ok: true`, the message ID, reaction "🔥", channel `imessage` and a `rxn_` reaction ID, and AgentPhone receives exactly one reaction for that message.

## agentphone.bdd-004

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > adds an iMessage reaction with a run token (group: true)"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the inbound iMessage is a group message (group: true).
- When: The phone sends "@Okou review this plan" in an iMessage group through `POST /api/agentphone/webhook`; the run's CLI token calls `POST /api/integrations/phone/reaction` with "🔥", the run completes, and the signed-in member then reacts "like" to Okou's archived group answer.
- Then: The dispatched run's system prompt contains the message ID, the `okou phone reaction <message-id>` command and "does not require a separate user request". The run-token reaction returns HTTP 200 with `ok: true`, reaction "🔥", channel `imessage` and a `rxn_` ID, and AgentPhone receives exactly that reaction. The member's reaction to the bot's answer returns HTTP 200 and AgentPhone receives a "like" reaction for the answer message.

## agentphone.bdd-005

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > lets a recipient add an iMessage reaction to a group message received before connecting"
- Mode: run
- Given: A linked member's phone posts "The launch went well" to an iMessage group whose roster includes a second phone; afterwards a second user links that second phone through the connect prompt.
- When: The second user calls `POST /api/integrations/phone/reaction` with the earlier group message ID and reaction "love".
- Then: The request returns HTTP 200 and AgentPhone receives exactly one "love" reaction for that message.

## agentphone.bdd-006

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > denies iMessage reactions to another account's dm"
- Mode: run
- Given: A linked member sends "/help" as an iMessage direct message (kind: dm); a second user in the same organization links a different phone.
- When: The second user, the original member under a different organization, and an unauthenticated caller each call `POST /api/integrations/phone/reaction` for that message with "like".
- Then: Both signed-in requests return HTTP 404, the unauthenticated request returns HTTP 401, and AgentPhone receives no reaction.

## agentphone.bdd-007

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > denies iMessage reactions to another account's group"
- Mode: run
- Given: A linked member sends "/help" as an iMessage group message (kind: group); a second user in the same organization links a different phone.
- When: The second user, the original member under a different organization, and an unauthenticated caller each call `POST /api/integrations/phone/reaction` for that message with "like".
- Then: Both signed-in requests return HTTP 404, the unauthenticated request returns HTTP 401, and AgentPhone receives no reaction.

## agentphone.bdd-008

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > denies an iMessage reaction for a departed member"
- Mode: run
- Given: A linked member posted an ordinary iMessage group message; scenario "departed member": the AgentPhone conversation roster now lists only the other participant.
- When: The member calls `POST /api/integrations/phone/reaction` for that message with "like".
- Then: The request returns HTTP 404 and AgentPhone receives no reaction.

## agentphone.bdd-009

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > denies an iMessage reaction for a unlinked phone"
- Mode: run
- Given: A linked member posted an ordinary iMessage group message; scenario "unlinked phone": the member has unlinked AgentPhone through `DELETE /api/integrations/agentphone/link` (HTTP 204).
- When: The member calls `POST /api/integrations/phone/reaction` for that message with "like".
- Then: The request returns HTTP 404 and AgentPhone receives no reaction.

## agentphone.bdd-010

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects an iMessage reaction to sms"
- Mode: run
- Given: A linked member sent "/help" over the `sms` channel.
- When: The member calls `POST /api/integrations/phone/reaction` for that message with "like".
- Then: The request returns HTTP 400 with error code `UNSUPPORTED_CHANNEL` and AgentPhone receives no reaction.

## agentphone.bdd-011

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects an iMessage reaction to mms"
- Mode: run
- Given: A linked member sent "/help" over the `mms` channel.
- When: The member calls `POST /api/integrations/phone/reaction` for that message with "like".
- Then: The request returns HTTP 400 with error code `UNSUPPORTED_CHANNEL` and AgentPhone receives no reaction.

## agentphone.bdd-012

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > denies an iMessage reaction when the roster returns 404"
- Mode: run
- Given: A linked member posted an ordinary iMessage group message, and the AgentPhone conversation roster lookup returns HTTP 404.
- When: The member calls `POST /api/integrations/phone/reaction` for that message with "like".
- Then: The request returns HTTP 404 and AgentPhone receives no reaction.

## agentphone.bdd-013

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > denies an iMessage reaction when the roster returns 503"
- Mode: run
- Given: A linked member posted an ordinary iMessage group message, and the AgentPhone conversation roster lookup returns HTTP 503.
- When: The member calls `POST /api/integrations/phone/reaction` for that message with "like".
- Then: The request returns HTTP 502 and AgentPhone receives no reaction.

## agentphone.bdd-014

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns iMessage reaction failures without retrying (400)"
- Mode: run
- Given: A linked member posted an ordinary iMessage group message, and AgentPhone rejects the reaction request with HTTP 400.
- When: The member calls `POST /api/integrations/phone/reaction` for that message with "🔥".
- Then: The request returns HTTP 400 and AgentPhone received exactly one reaction request body `{ reaction: "🔥" }` (no retry).

## agentphone.bdd-015

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns iMessage reaction failures without retrying (404)"
- Mode: run
- Given: A linked member posted an ordinary iMessage group message, and AgentPhone rejects the reaction request with HTTP 404.
- When: The member calls `POST /api/integrations/phone/reaction` for that message with "🔥".
- Then: The request returns HTTP 404 and AgentPhone received exactly one reaction request body `{ reaction: "🔥" }` (no retry).

## agentphone.bdd-016

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns iMessage reaction failures without retrying (503)"
- Mode: run
- Given: A linked member posted an ordinary iMessage group message, and AgentPhone rejects the reaction request with HTTP 503.
- When: The member calls `POST /api/integrations/phone/reaction` for that message with "🔥".
- Then: The request returns HTTP 502 and AgentPhone received exactly one reaction request body `{ reaction: "🔥" }` (no retry).

## agentphone.bdd-017

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns iMessage reaction failures without retrying (network)"
- Mode: run
- Given: A linked member posted an ordinary iMessage group message, and the AgentPhone reaction request fails with a network error.
- When: The member calls `POST /api/integrations/phone/reaction` for that message with "🔥".
- Then: The request returns HTTP 502 with error code `AGENTPHONE_OUTCOME_UNKNOWN`, and AgentPhone received exactly one reaction request (no retry).

## agentphone.bdd-018

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > sends an explicit group message with a run-scoped CLI token and archives it for current members"
- Mode: run
- Given: Two users have each linked a phone; the first member's phone posts "@Okou prepare a group update" to an iMessage group containing both phones, and AgentPhone reports the group as "Project group". The sender's Clerk name is Linghan Hu.
- When: The run's CLI token calls `GET /api/integrations/agentphone/groups?limit=25` and `POST /api/integrations/agentphone/group-message` with the group ID and "The group update is ready"; each member then reads `GET /api/integrations/agentphone/group-history`.
- Then: The run's system prompt contains `Group ID: <groupId>`, `okou imessage message send --to <groupId>`, and the group list and history help commands. The group list contains the group with its conversation ID, name "Project group", agent ID and a `lastMessageAt`. The send returns HTTP 200 with `ok: true` and `toNumber` set to the group ID, and AgentPhone receives "The group update is ready\n\nTriggered by Linghan Hu" for the group. Both members' history (HTTP 200) contains the outbound iMessage with that message ID and body.

## agentphone.bdd-019

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > lets a recipient read history and send with a phone connected later"
- Mode: run
- Given: A linked member's phone posted "Group history from before the member connected" to an iMessage group whose roster includes a second user's phone handle (handle type: phone). The second user issues a link code through `POST /api/integrations/agentphone/link-code` and texts it from that handle.
- When: The second user reads `GET /api/integrations/agentphone/group-history`, sends "Hello from the newly connected member" through `POST /api/integrations/agentphone/group-message`, and reads the history again.
- Then: The first history read returns HTTP 200 with only the earlier inbound message. The send returns HTTP 200 with `ok: true` and `toNumber` set to the group ID, and AgentPhone receives that text for the group. The second read lists the earlier inbound message followed by the new outbound message.

## agentphone.bdd-020

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > lets a recipient read history and send with a email connected later"
- Mode: run
- Given: A linked member's phone posted "Group history from before the member connected" to an iMessage group whose roster includes a second user's email handle (handle type: email). The second user issues a link code through `POST /api/integrations/agentphone/link-code` and texts it from that email handle.
- When: The second user reads `GET /api/integrations/agentphone/group-history`, sends "Hello from the newly connected member" through `POST /api/integrations/agentphone/group-message`, and reads the history again.
- Then: The first history read returns HTTP 200 with only the earlier inbound message. The send returns HTTP 200 with `ok: true` and `toNumber` set to the group ID, and AgentPhone receives that text for the group. The second read lists the earlier inbound message followed by the new outbound message.

## agentphone.bdd-021

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects an explicit group send for a unknown group"
- Mode: run
- Given: A linked member's phone has posted to an iMessage group; scenario "unknown group": the request targets a group ID that was never seen.
- When: The member calls `POST /api/integrations/agentphone/group-message` with "This must not be sent".
- Then: The request returns HTTP 404 with error code `NOT_FOUND` and AgentPhone sends nothing.

## agentphone.bdd-022

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects an explicit group send for a foreign workspace"
- Mode: run
- Given: A linked member's phone has posted to an iMessage group; scenario "foreign workspace": the same user calls from a different organization.
- When: The caller sends "This must not be sent" to the group through `POST /api/integrations/agentphone/group-message`.
- Then: The request returns HTTP 404 with error code `NOT_FOUND` and AgentPhone sends nothing.

## agentphone.bdd-023

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects an explicit group send for a unrelated user"
- Mode: run
- Given: A linked member's phone has posted to an iMessage group; scenario "unrelated user": another user in the same organization has linked a different phone that is not in the group.
- When: The other user sends "This must not be sent" to the group through `POST /api/integrations/agentphone/group-message`.
- Then: The request returns HTTP 404 with error code `NOT_FOUND` and AgentPhone sends nothing.

## agentphone.bdd-024

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects an explicit group send for a unlinked phone"
- Mode: run
- Given: A linked member's phone has posted to an iMessage group; scenario "unlinked phone": the member has unlinked AgentPhone (HTTP 204).
- When: The member sends "This must not be sent" to the group through `POST /api/integrations/agentphone/group-message`.
- Then: The request returns HTTP 404 with error code `NOT_FOUND` and AgentPhone sends nothing.

## agentphone.bdd-025

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects an explicit group send for a departed member"
- Mode: run
- Given: A linked member's phone has posted to an iMessage group; scenario "departed member": AgentPhone's conversation roster now lists only an unrelated phone.
- When: The member sends "This must not be sent" to the group through `POST /api/integrations/agentphone/group-message`.
- Then: The request returns HTTP 404 with error code `NOT_FOUND` and AgentPhone sends nothing.

## agentphone.bdd-026

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects an explicit group send for a foreign agent"
- Mode: run
- Given: A linked member's phone has posted to an iMessage group; scenario "foreign agent": the request names `agentphoneAgentId: "foreign-agent"`.
- When: The member sends "This must not be sent" to the group through `POST /api/integrations/agentphone/group-message`.
- Then: The request returns HTTP 404 with error code `NOT_FOUND` and AgentPhone sends nothing.

## agentphone.bdd-027

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > does not send a group message when roster lookup returns 404"
- Mode: run
- Given: A linked member's phone has posted to an iMessage group, and the AgentPhone conversation roster lookup returns HTTP 404.
- When: The member sends "This must not be sent" through `POST /api/integrations/agentphone/group-message`.
- Then: The request returns HTTP 404 and AgentPhone sends nothing.

## agentphone.bdd-028

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > does not send a group message when roster lookup returns 503"
- Mode: run
- Given: A linked member's phone has posted to an iMessage group, and the AgentPhone conversation roster lookup returns HTTP 503.
- When: The member sends "This must not be sent" through `POST /api/integrations/agentphone/group-message`.
- Then: The request returns HTTP 502 and AgentPhone sends nothing.

## agentphone.bdd-029

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > does not retry an uncertain group message or fall back to a DM"
- Mode: run
- Given: A linked member's phone has posted to an iMessage group, and AgentPhone answers every message send with HTTP 503 "Send outcome unknown".
- When: The member sends "Group update" through `POST /api/integrations/agentphone/group-message`.
- Then: The request returns HTTP 502. AgentPhone received exactly one send attempt with the agent ID, the group ID as `to_number` and body "Group update", and no direct-message fallback was sent.

## agentphone.bdd-030

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > requires authentication for explicit group sends"
- Mode: run
- Given: The caller is unauthenticated.
- When: The caller sends "Group update" to `grp_auth_required` through `POST /api/integrations/agentphone/group-message`.
- Then: The request returns HTTP 401 with error code `UNAUTHORIZED`.

## agentphone.bdd-031

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > sends one contact card after a successful text conversation and ignores repeated callbacks"
- Mode: run
- Given: A linked member has an iMessage conversation whose AgentPhone capabilities allow messages and media; the connect welcome messages carried no media.
- When: The phone asks "hello" through `POST /api/agentphone/webhook` and the run completes with result "Answer: hello"; the sandbox then repeats `POST /api/webhooks/run/complete`, the same inbound message ID is redelivered, and the phone later asks "another question".
- Then: After the first answer AgentPhone receives "Answer: hello" without media followed by one contact card "Save Okou to your contacts so you can find this chat anytime." with an `okou.vcf` media URL to the phone. The repeated completion and redelivered message add no sends. The next answer adds only "Answer: another question", with no second contact card.

## agentphone.bdd-032

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > waits for media permission without interrupting the answer: {\"canSendMessages\":true,\"media\":false}"
- Mode: run
- Given: A linked member has an iMessage conversation; the first AgentPhone capabilities lookup reports `{ canSendMessages: true, media: false }` and later lookups allow media.
- When: The phone asks "first question" and then "next question" through `POST /api/agentphone/webhook`, each run completing with an answer.
- Then: The first answer is sent alone without media. After the second question there are three new sends in total, and the last one carries the `okou.vcf` contact card media URL.

## agentphone.bdd-033

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > waits for media permission without interrupting the answer: {\"canSendMessages\":false,\"media\":true}"
- Mode: run
- Given: A linked member has an iMessage conversation; the first AgentPhone capabilities lookup reports `{ canSendMessages: false, media: true }` and later lookups allow media.
- When: The phone asks "first question" and then "next question" through `POST /api/agentphone/webhook`, each run completing with an answer.
- Then: The first answer is sent alone without media. After the second question there are three new sends in total, and the last one carries the `okou.vcf` contact card media URL.

## agentphone.bdd-034

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > waits for media permission without interrupting the answer: null"
- Mode: run
- Given: A linked member has an iMessage conversation; the first AgentPhone capabilities lookup reports `null` capabilities and later lookups allow media.
- When: The phone asks "first question" and then "next question" through `POST /api/agentphone/webhook`, each run completing with an answer.
- Then: The first answer is sent alone without media. After the second question there are three new sends in total, and the last one carries the `okou.vcf` contact card media URL.

## agentphone.bdd-035

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > defers a restricted contact card until a new text interaction without replaying the answer"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation, and AgentPhone rejects the first media send with HTTP 422 `CONVERSATION_CONTENT_RESTRICTED`.
- When: The phone asks "hello", the run completes, the sandbox repeats `POST /api/webhooks/run/complete`, and the phone then asks "please continue".
- Then: After the first answer only "Answer: hello" is delivered and one card attempt is recorded; the repeated completion adds no attempt. After the next answer there are two card attempts and the deliveries are "Answer: hello", "Answer: please continue", then the `okou.vcf` contact card, without replaying the first answer.

## agentphone.bdd-036

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > does not retry unrelated contact-card validation failures on later messages"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation, and AgentPhone rejects every media send with HTTP 422 `VALIDATION_ERROR`.
- When: The phone asks "first question" and then "second question", each run completing with an answer.
- Then: AgentPhone receives only one contact-card attempt, and the delivered messages are "Answer: first question" and "Answer: second question".

## agentphone.bdd-037

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > reconciles an uncertain card against provider history without resending: accepted"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation; the contact-card send fails with a network error, and AgentPhone's conversation history shows the card as accepted with the same body and media (outcome: accepted).
- When: The phone asks three questions in sequence, each run completing with an answer.
- Then: The provider history is read once after the second question and still once after the third, the contact card is attempted only once, and the three answers are delivered in order.

## agentphone.bdd-038

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > reconciles an uncertain card against provider history without resending: absent"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation; the contact-card send fails with a network error, and AgentPhone's conversation history returns no matching message with `hasMore: true` (outcome: absent).
- When: The phone asks three questions in sequence, each run completing with an answer.
- Then: The provider history is read once after the second question and twice after the third, the contact card is attempted only once (never resent), and the three answers are delivered in order.

## agentphone.bdd-039

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > reconciles an uncertain card against provider history without resending: different-attachment"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation; the contact-card send fails with a network error, and AgentPhone's history shows an outbound message with the same body but a different attachment (outcome: different-attachment).
- When: The phone asks three questions in sequence, each run completing with an answer.
- Then: The provider history is read once after the second question and twice after the third, the contact card is attempted only once (never resent), and the three answers are delivered in order.

## agentphone.bdd-040

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > reconciles an uncertain card against provider history without resending: missing-conversation"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation; the contact-card send fails with a network error, and AgentPhone's conversation history returns HTTP 404 (outcome: missing-conversation).
- When: The phone asks three questions in sequence, each run completing with an answer.
- Then: The provider history is read once after the second question and twice after the third, the contact card is attempted only once (never resent), and the three answers are delivered in order.

## agentphone.bdd-041

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > keeps answers working when the optional media capability lookup fails"
- Mode: run
- Given: A linked member has an iMessage conversation, and the first AgentPhone capabilities lookup fails with HTTP 503 while later lookups allow media.
- When: The phone asks "first question" and then "second question" through `POST /api/agentphone/webhook`, each run completing with an answer.
- Then: The first answer "Answer: first question" is delivered alone, and the last send after the second answer carries one media URL (the contact card).

## agentphone.bdd-042

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > waits for an ordinary text interaction after 12345678"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation; the first message is "12345678".
- When: The phone sends "12345678" and the run answers it, then the phone asks "hello" and that run answers.
- Then: The first answer "Answer: 12345678" is delivered without media, and the last send after "hello" carries one media URL (the contact card).

## agentphone.bdd-043

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > waits for an ordinary text interaction after /unrecognized_command"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation; the first message is "/unrecognized_command".
- When: The phone sends "/unrecognized_command" and the run answers it, then the phone asks "hello" and that run answers.
- Then: The first answer "Answer: /unrecognized_command" is delivered without media, and the last send after "hello" carries one media URL (the contact card).

## agentphone.bdd-044

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > keeps the contact card pending after a failed-run interaction"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation; the first interaction is "failed-run": the phone asks "@Okou hello" and the run completes with exit code 1.
- When: The phone sends the first interaction through `POST /api/agentphone/webhook`, then asks "a normal private question" and that run answers.
- Then: No send after the first interaction carries media, and the last send after the normal question goes to the phone with the `okou.vcf` contact card media URL.

## agentphone.bdd-045

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > keeps the contact card pending after a failed-reply interaction"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation; the first interaction is "failed-reply": the phone asks "@Okou hello" and AgentPhone rejects the next reply send once with HTTP 503.
- When: The phone sends the first interaction through `POST /api/agentphone/webhook` and its run completes, then asks "a normal private question" and that run answers.
- Then: No send after the first interaction carries media, and the last send after the normal question goes to the phone with the `okou.vcf` contact card media URL.

## agentphone.bdd-046

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > keeps the contact card pending after a media-only interaction"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation; the first interaction is "media-only": an empty-bodied message with an attachment whose download returns HTTP 503.
- When: The phone sends the media-only message through `POST /api/agentphone/webhook` and its run completes, then asks "a normal private question" and that run answers.
- Then: No send after the first interaction carries media, and the last send after the normal question goes to the phone with the `okou.vcf` contact card media URL.

## agentphone.bdd-047

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > keeps the contact card pending after a group interaction"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation; the first interaction is "group": "@Okou hello" posted in a separate iMessage group conversation.
- When: The phone sends the group message through `POST /api/agentphone/webhook` and its run completes, then asks "a normal private question" in the private conversation and that run answers.
- Then: No send after the group interaction carries media, and the last send after the private question goes to the phone with the `okou.vcf` contact card media URL.

## agentphone.bdd-048

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > keeps the contact card pending after a help interaction"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation; the first interaction is "help": the phone sends "/help", which dispatches no run.
- When: The phone sends "/help" through `POST /api/agentphone/webhook`, then asks "a normal private question" and that run answers.
- Then: No send after "/help" carries media, and the last send after the normal question goes to the phone with the `okou.vcf` contact card media URL.

## agentphone.bdd-049

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > sends one contact card when completion callbacks arrive concurrently"
- Mode: run
- Given: A linked member has a media-capable iMessage conversation and asked "hello", dispatching one run.
- When: The sandbox sends two concurrent successful `POST /api/webhooks/run/complete` callbacks for that run.
- Then: AgentPhone receives exactly "Task completed successfully." without media followed by one `okou.vcf` contact card.

## agentphone.bdd-050

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > links a direct-message sender with a one-time connection code"
- Mode: run
- Given: A signed-in member has not linked a phone; the AgentPhone provider and webhook are configured.
- When: The member creates a code through `POST /api/integrations/agentphone/link-code`, texts it from an iMessage direct message through `POST /api/agentphone/webhook`, and a different phone later texts the same code over SMS.
- Then: The code is 8 digits and expires more than 9 minutes later. The sender receives the three text-only welcome messages ("Your phone number is now connected to Okou.", the tool-connection hint, "What would you like to start with?"), only the first replying to the code message, all addressed to the phone without a conversation ID. Link status shows the phone as linked. The second sender is told the code is "invalid or expired" and the link status is unchanged.

## agentphone.bdd-051

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > binds one sender and settles one reward when a connection code is consumed concurrently"
- Mode: run
- Given: A signed-in organization member has issued an AgentPhone link code, and two different phones are ready to text it.
- When: Both phones send the code concurrently as iMessage direct messages through `POST /api/agentphone/webhook`; the resulting marketing fact is settled and the member reads `GET /api/billing/usage-pack-credits`.
- Then: Exactly one phone is linked and receives the connected welcome; the other receives only an "invalid or expired" reply. Exactly one `imessage.identity-linked` fact is emitted; after settlement the member has 1000 bonus credits in one `bonus` grant with 1000 remaining, and the link status is unchanged.

## agentphone.bdd-052

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > sends proactive messages and private files to an email-linked iMessage handle"
- Mode: run
- Given: A signed-in member links an email iMessage handle with a one-time code; private artifact storage accepts uploads.
- When: The member sends "proactive hello" through `POST /api/integrations/phone/message`, retries with a foreign `agentphoneAgentId`, uploads "note.txt" through `POST /api/integrations/phone/upload-file/init` and `/complete` with a caption, and downloads it through `GET /api/integrations/phone/download-file`; other callers and a missing stored object are also tried.
- Then: Link status shows the email handle. The message returns HTTP 200 with `toNumber` set to the email and AgentPhone receives "proactive hello"; the foreign agent ID returns 404 `NOT_FOUND` with no send. The upload completes to the email with caption "proactive file", returns the private `/artifacts/<10 chars>.txt` URL and gives AgentPhone a media URL for the private object. The owner's download is a 302 with `private, no-store`, file name, MIME type and size headers pointing at the same object. Another user, another organization, and the owner after the object is gone each get HTTP 404.

## agentphone.bdd-053

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > uses linked inbound identity for proactive text and files without an explicit agent id"
- Mode: run
- Given: A signed-in member links an email iMessage handle with a one-time code and that handle has sent "/help"; private artifact storage accepts uploads.
- When: The member calls `POST /api/integrations/phone/message` with only text "hello from linked identity", then uploads "linked.txt" through `POST /api/integrations/phone/upload-file/init` and `/complete` with only a caption, both without an explicit agent ID.
- Then: The message returns HTTP 200 with `toNumber` set to the email and AgentPhone receives it from the linked agent ID. The upload completes with the email, file name, `text/plain`, size 5 and the private file URL; AgentPhone receives the caption from the linked agent with a media URL for the private object that differs from the private file URL.

## agentphone.bdd-054

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > invalidates a previous connection code when a new one is issued"
- Mode: run
- Given: A signed-in member has issued two AgentPhone link codes in a row.
- When: A phone texts the first code over SMS through `POST /api/agentphone/webhook`, then texts the second code.
- Then: The first code is answered with "invalid or expired" and the link status stays unlinked. The second code produces the three-message connected welcome and the link status shows the phone as linked.

## agentphone.bdd-055

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rewards the Get started iMessage quest once per user"
- Mode: run
- Given: A signed-in organization member (not an admin) is offered the Get started iMessage quest.
- When: The member links a phone with a one-time code over iMessage, unlinks through `DELETE /api/integrations/agentphone/link`, and links another phone with a new code.
- Then: Each link produces the three-message connected welcome. After the first link the Get started rewards-changed realtime event is published.

## agentphone.bdd-056

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects an expired connection code"
- Mode: run
- Given: A signed-in member issued a link code and the clock moves to one millisecond after its expiry.
- When: A phone texts the code over SMS through `POST /api/agentphone/webhook`.
- Then: The sender is told the code is "invalid or expired" and the link status shows the member is not linked.

## agentphone.bdd-057

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > runs an all-digit prompt from an already linked sender"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: The linked phone sends the all-digit text "20260920" over SMS through `POST /api/agentphone/webhook`, and the dispatched run completes successfully.
- Then: The run prompt contains "20260920", and AgentPhone's last reply is "Task completed successfully."

## agentphone.bdd-058

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > runs a prompt from an already linked mixed-case iMessage email sender"
- Mode: run
- Given: A Pro-entitled member with a personal subscription model has linked a lowercase email iMessage handle with a one-time code, and a Runner group is online.
- When: The same email, upper-cased with surrounding spaces, sends "Summarize my meeting notes" over iMessage and the run completes through `POST /api/webhooks/run/complete`.
- Then: The dispatched prompt is exactly "Summarize my meeting notes". AgentPhone replies "Task completed successfully." to the sender as given, threaded to the inbound message, and the link status still shows the original email handle.

## agentphone.bdd-059

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > links an AgentPhone user through the provider connect prompt"
- Mode: run
- Given: A signed-in connector owner is using the public connector environment with the AgentPhone provider and webhook configured.
- When: A phone texts "hi" through `POST /api/agentphone/webhook`, and the owner submits the received signed link to `POST /api/agentphone/connect`.
- Then: The connect welcome reaches the phone, and `GET /api/integrations/agentphone/link` shows the phone as linked.

## agentphone.bdd-060

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > connects an unlinked group phone sender through a private link after @Okou hello"
- Mode: run
- Given: A Pro-entitled member has unlinked their phone; the sender is that phone handle in an iMessage group and the first message is "@Okou hello".
- When: The group message arrives through `POST /api/agentphone/webhook`, the member connects through the private link via `POST /api/agentphone/connect`, and the sender then posts "@Okou help me now" in the group whose run completes.
- Then: AgentPhone first sends the handle a private message with a `/settings/agentphone?` link (not threaded), then replies in the group to the message with "I've sent you a private connection link" without the link. After connecting the status shows the handle linked; the follow-up run prompt is "@Okou help me now" and the group receives "Task completed successfully." threaded to the follow-up.

## agentphone.bdd-061

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > connects an unlinked group email sender through a private link after /connect @Okou"
- Mode: run
- Given: A Pro-entitled member has unlinked their phone; the sender is a new email handle in an iMessage group and the first message is "/connect @Okou".
- When: The group message arrives through `POST /api/agentphone/webhook`, the member connects through the private link via `POST /api/agentphone/connect`, and the sender then posts "@Okou help me now" in the group whose run completes.
- Then: AgentPhone first sends the email handle a private message with a `/settings/agentphone?` link (not threaded), then replies in the group to the message with "I've sent you a private connection link" without the link. After connecting the status shows the email handle linked; the follow-up run prompt is "@Okou help me now" and the group receives "Task completed successfully." threaded to the follow-up.

## agentphone.bdd-062

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > handles a first-contact link restriction when the plain-text greeting is accepted"
- Mode: run
- Given: A Pro-entitled member has unlinked AgentPhone; a new phone posts "@Okou hello" in an iMessage group. AgentPhone rejects the private connection-link message with HTTP 422 `CONVERSATION_CONTENT_RESTRICTED` until the phone replies privately, and accepts the plain-text greeting (greeting: accepted).
- When: The group message arrives through `POST /api/agentphone/webhook`; the phone then replies "hi" privately, the member submits the received link to `POST /api/agentphone/connect`, and the phone posts "@Okou help me now" in the group whose run completes.
- Then: AgentPhone first receives the link attempt and then the unthreaded "Hi, I'm Okou. You can text me like a teammate…" greeting containing "Reply here and I'll send you the link to connect your Okou account."; the group gets a threaded reply asking the user to reply privately, with no link, and the member stays unlinked. After the private "hi", the phone receives the threaded `/settings/agentphone?` link; connecting links the phone, and the group receives "Task completed successfully." threaded to the follow-up.

## agentphone.bdd-063

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > handles a first-contact link restriction when the plain-text greeting is rejected"
- Mode: run
- Given: A Pro-entitled member has unlinked AgentPhone; a new phone posts "@Okou hello" in an iMessage group. AgentPhone rejects the private link with HTTP 422 `CONVERSATION_CONTENT_RESTRICTED` and rejects the plain-text greeting with HTTP 422 `INBOUND_ONLY` (greeting: rejected).
- When: The group message arrives through `POST /api/agentphone/webhook`.
- Then: AgentPhone receives the link attempt and then the unthreaded greeting attempt for the phone. The only delivered message is the group reply threaded to the message: "Please message this number directly to get your connection link.", with no link, and the member stays unlinked.

## agentphone.bdd-064

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > offers direct-message recovery without retrying a private send after quota failure"
- Mode: run
- Given: A Pro-entitled member has unlinked AgentPhone, and AgentPhone rejects every private send to that phone with HTTP 429 `OUTBOUND_LIMIT_REACHED` (failure: quota).
- When: The phone posts "@Okou hello" in an iMessage group through `POST /api/agentphone/webhook`.
- Then: The only delivered message is the group reply threaded to the message: "Please message this number directly to get your connection link.", and exactly one private send was attempted.

## agentphone.bdd-065

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > offers direct-message recovery without retrying a private send after unknown delivery failure"
- Mode: run
- Given: A Pro-entitled member has unlinked AgentPhone, and AgentPhone rejects every private send to that phone with HTTP 503 `INTERNAL_ERROR` (failure: unknown delivery).
- When: The phone posts "@Okou hello" in an iMessage group through `POST /api/agentphone/webhook`.
- Then: The only delivered message is the group reply threaded to the message: "Please message this number directly to get your connection link.", and exactly one private send was attempted.

## agentphone.bdd-066

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > linked iMessage DMs preserve dispatch context"
- Mode: run
- Given: A Pro-entitled member with Okou debug enabled has linked their phone and a Runner group is online (scenario: dispatch context).
- When: The phone sends "summarize my inbox" as an iMessage DM through `POST /api/agentphone/webhook`, the Runner receives the run, and the run completes.
- Then: AgentPhone receives one typing indicator for the conversation. The thread lifecycle shows exactly one created thread whose `input.prompt` for that text carries an `agentphone` source with `sms:<shared number>`. The run prompt is "summarize my inbox", and the system prompt places the "# Current Integration" block (phone messaging, shared number, user handle, agent ID, channel `imessage`, type `dm`, conversation and message IDs) followed by the phone messaging note, ending with the private-artifact note before the built-in image model and restricted content sections.

## agentphone.bdd-067

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > linked iMessage DMs preserve typing and plain-text completion"
- Mode: run
- Given: A Pro-entitled member with Okou debug enabled has linked their phone and a Runner group is online (scenario: typing and plain-text completion).
- When: The phone sends "summarize my inbox" as an iMessage DM; after 4 seconds the sandbox posts an assistant event to `POST /api/webhooks/run/events`, after another 4 seconds posts `POST /api/webhooks/run/heartbeat`, and then completes with a Markdown result.
- Then: The events request returns `{ received: 1, firstSequence: 1, lastSequence: 1 }` and the heartbeat returns `{ ok: true, typingRefreshIntervalSeconds: 4 }`; the typing indicator is sent once, twice and three times for the conversation. The completion reply goes to the phone without a conversation ID, threaded to the inbound message, with the Markdown converted to the expected plain text.

## agentphone.bdd-068

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > admits the Phone input while the first typing request is still pending"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; AgentPhone holds the first typing request open.
- When: The phone sends "Process this while typing is pending" over iMessage through `POST /api/agentphone/webhook`; after the typing request is released the run completes.
- Then: While typing is still pending, the member's new thread already contains the `input.prompt` with that text. The webhook then succeeds and the completion reply goes to the phone.

## agentphone.bdd-069

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > coalesces Phone typing bursts and refreshes at the next four-second heartbeat"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: The phone sends an iMessage; the sandbox posts an assistant event and an immediate heartbeat, then another heartbeat after the clock advances 4 seconds, and completes the run.
- Then: The early heartbeat returns `{ ok: true, typingRefreshIntervalSeconds: 4 }` and only one typing indicator is sent; after the 4-second heartbeat a second typing indicator is sent. The completion reply goes to the phone.

## agentphone.bdd-070

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > recovers a Phone typing server failure on the next progress update"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; AgentPhone's first typing request fails with HTTP 503 (failure: server) and later requests succeed.
- When: The phone sends an iMessage, the sandbox posts `POST /api/webhooks/run/heartbeat`, and the run completes.
- Then: The heartbeat triggers exactly one accepted typing indicator for the conversation, and the completion reply goes to the phone.

## agentphone.bdd-071

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > recovers a Phone typing network failure on the next progress update"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; AgentPhone's first typing request fails with a network error (failure: network) and later requests succeed.
- When: The phone sends an iMessage, the sandbox posts `POST /api/webhooks/run/heartbeat`, and the run completes.
- Then: The heartbeat triggers exactly one accepted typing indicator for the conversation, and the completion reply goes to the phone.

## agentphone.bdd-072

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > recovers a Phone typing timeout failure on the next progress update"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; AgentPhone's first typing request hangs until aborted and then errors (failure: timeout), and later requests succeed.
- When: The phone sends an iMessage, the sandbox posts `POST /api/webhooks/run/heartbeat`, and the run completes.
- Then: The heartbeat triggers exactly one accepted typing indicator for the conversation, and the completion reply goes to the phone.

## agentphone.bdd-073

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > keeps run progress alive when the typing provider fails"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; after the first typing indicator, AgentPhone fails every typing request with HTTP 503.
- When: The phone sends "check my inbox" as an iMessage DM; after the clock advances 4 seconds the sandbox posts `POST /api/webhooks/run/heartbeat`, and the run completes.
- Then: One typing indicator is sent initially. The heartbeat still returns HTTP 200 with `{ ok: true, typingRefreshIntervalSeconds: 4 }`, and the completion reply reaches the phone.

## agentphone.bdd-074

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > reuses the linked iMessage session for follow-up messages"
- Mode: run
- Given: A Pro-entitled member has linked their phone, registered a Web push subscription with VAPID enabled, and a Runner group is online.
- When: The phone sends "start session" as an iMessage DM and its run completes, then sends "follow up" in the same conversation and that run completes.
- Then: Both runs reply "Task completed successfully.". The follow-up run's system prompt contains "# Phone Message Context", `RELATIVE_INDEX`, the first message's `MSG_ID` and a `SENDER: {id: BOT}` entry. The second run's session ID (read through the public run log) equals the first run's, and no Web push notification is sent.

## agentphone.bdd-075

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > keeps one DM thread as its provider conversation changes or disappears"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: The phone sends three messages in turn: iMessage in one conversation, iMessage in a different conversation, and SMS without a conversation; each run completes.
- Then: Each run prompt is the sent text; the iMessage runs' system prompts contain their own `Conversation ID`, and the SMS run's prompt has no `Conversation ID`. All three runs share the same session ID, and the thread lifecycle shows exactly one created thread.

## agentphone.bdd-076

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > publishes one thread for distinct concurrent messages to the same phone root"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: The phone concurrently sends "first concurrent phone task" and "second concurrent phone task" in two different iMessage conversations, and both dispatched runs complete.
- Then: The lifecycle shows exactly one created thread with selected model `claude-fable-5-1` and cloud browser enabled, containing an `input.prompt` for each text. The two runs carry the two prompts, the replies thread to the two inbound message IDs, no dispatch remains unobserved after a Runner heartbeat, and the created-thread events are unchanged.

## agentphone.bdd-077

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > forwards unrecognized slash commands as agent prompts"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: The phone sends "/unrecognized_command" as an iMessage DM through `POST /api/agentphone/webhook`.
- Then: A run is dispatched with prompt "/unrecognized_command".

## agentphone.bdd-078

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > offers personal subscription recovery for ChatGPT (Codex) in iMessage"
- Mode: run
- Given: A Pro-entitled member with native subscription models has linked their phone and prefers model `gpt-6-astra` (label "ChatGPT (Codex)"); a Runner group is online.
- When: The phone sends "Finish my report" over iMessage; the run fails through `POST /api/webhooks/run/complete` with `usage_limit` and a native usage-limit message; after 2 seconds the member switches the recovery subscription to a Codex OAuth token.
- Then: The reply mentions "Your ChatGPT (Codex) subscription", "Wait for your subscription allowance to reset", `?settings=model` and `reply "continue"`, without the native message. After the switch a new run is dispatched with prompt "continue" and a further typing indicator is sent.

## agentphone.bdd-079

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > offers personal subscription recovery for Claude in iMessage"
- Mode: run
- Given: A Pro-entitled member with native subscription models has linked their phone and prefers model `claude-fable-5-1` (label "Claude"); a Runner group is online.
- When: The phone sends "Finish my report" over iMessage; the run fails through `POST /api/webhooks/run/complete` with `usage_limit` and a native usage-limit message; after 2 seconds the member switches the recovery subscription to a Claude Code OAuth token.
- Then: The reply mentions "Your Claude subscription", "Wait for your subscription allowance to reset", `?settings=model` and `reply "continue"`, without the native message. After the switch a new run is dispatched with prompt "continue" and a further typing indicator is sent.

## agentphone.bdd-080

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > replies to failed linked iMessage runs"
- Mode: run
- Given: A Pro-entitled member has linked their phone, registered a Web push subscription with VAPID enabled, and a Runner group is online.
- When: The phone sends "now fail" as an iMessage DM and the run completes with exit code 1 and an error.
- Then: AgentPhone replies "Oops, something went wrong. Please try again later." and no Web push notification is sent.

## agentphone.bdd-081

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > offers billing recovery after a run runs out of credits (imessage, group=false)"
- Mode: run
- Given: A Pro-entitled member in workspace "Finance * Operations" has linked their phone and a Runner group is online; the message is an iMessage DM (channel imessage, group=false).
- When: The phone sends "@Okou finish my report" and the run fails with `insufficient_credits`.
- Then: The reply names workspace "Finance * Operations", mentions "send /switch", "Add credits to continue." and `/?settings=billing`, and has no `billingView=plans`. The phone thread contains a `run.failed` event with content `insufficient_credits`.

## agentphone.bdd-082

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > offers billing recovery after a run runs out of credits (imessage, group=true)"
- Mode: run
- Given: A Pro-entitled member in workspace "Finance * Operations" has linked their phone and a Runner group is online; the message is an iMessage group message (channel imessage, group=true).
- When: The phone sends "@Okou finish my report" in the group and the run fails with `insufficient_credits`.
- Then: The reply does not name the workspace, contains "Add credits to continue." and `/?settings=billing`, and has no `billingView=plans`. The phone thread contains a `run.failed` event with content `insufficient_credits`.

## agentphone.bdd-083

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > offers billing recovery after a run runs out of credits (sms, group=false)"
- Mode: run
- Given: A Pro-entitled member in workspace "Finance * Operations" has linked their phone and a Runner group is online; the message is SMS (channel sms, group=false).
- When: The phone sends "@Okou finish my report" and the run fails with `insufficient_credits`.
- Then: The reply names workspace "Finance * Operations", mentions "send /switch", "Add credits to continue." and `/?settings=billing`, and has no `billingView=plans`. The phone thread contains a `run.failed` event with content `insufficient_credits`.

## agentphone.bdd-084

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > offers billing recovery after a run runs out of credits (mms, group=false)"
- Mode: run
- Given: A Pro-entitled member in workspace "Finance * Operations" has linked their phone and a Runner group is online; the message is MMS (channel mms, group=false).
- When: The phone sends "@Okou finish my report" and the run fails with `insufficient_credits`.
- Then: The reply names workspace "Finance * Operations", mentions "send /switch", "Add credits to continue." and `/?settings=billing`, and has no `billingView=plans`. The phone thread contains a `run.failed` event with content `insufficient_credits`.

## agentphone.bdd-085

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > offers role-aware recovery for a depleted workspace (org:admin, group=false)"
- Mode: run
- Given: A limited-free workspace admin has linked their phone through the connect prompt, and 90 days pass so onboarding and connection rewards expire; the workspace is named "Original Phone Workspace" (role org:admin, group=false).
- When: The phone sends "@Okou help me with this report" as an iMessage DM, then sends "/switch", and another user submits the new connect link to `POST /api/agentphone/connect`.
- Then: The reply names workspace "Original Phone Workspace", says "send /switch", "Upgrade to Pro" and `/?settings=billing&billingView=plans`. "/switch" produces exactly one reply "Your phone has been disconnected" with a new connect URL, and the admin is unlinked. The other user's link status then shows the phone linked while the original admin stays unlinked.

## agentphone.bdd-086

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > offers role-aware recovery for a depleted workspace (org:member, group=false)"
- Mode: run
- Given: A limited-free workspace's ordinary member has linked their phone through the connect prompt, and 90 days pass so onboarding and connection rewards expire; the workspace is named "Original Phone Workspace" (role org:member, group=false).
- When: The phone sends "@Okou help me with this report" as an iMessage DM, then sends "/switch", and another user submits the new connect link to `POST /api/agentphone/connect`.
- Then: The reply names the workspace, says "send /switch" and "Ask a workspace admin", and has no `?settings=billing` link. "/switch" produces exactly one reply "Your phone has been disconnected" with a new connect URL, and the member is unlinked. The other user's link status then shows the phone linked while the original member stays unlinked.

## agentphone.bdd-087

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > offers role-aware recovery for a depleted workspace (org:admin, group=true)"
- Mode: run
- Given: A limited-free workspace admin has linked their phone through the connect prompt, and 90 days pass so onboarding and connection rewards expire; the message is in an iMessage group (role org:admin, group=true).
- When: The phone sends "@Okou help me with this report" in the group, then sends "/switch @Okou" in the same group.
- Then: The reply says "Upgrade to Pro" with `/?settings=billing&billingView=plans`, without the workspace name or "/switch". The group "/switch" reply tells the user to "message this number directly" without a `/settings/agentphone?` link, and the admin remains linked.

## agentphone.bdd-088

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > keeps the phone conversation usable after the provider rejects a completion reply"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; AgentPhone rejects the next message send once with HTTP 422.
- When: The phone sends "first phone request" over iMessage and its run completes through `POST /api/webhooks/run/complete`, the completion callback is repeated, then the phone sends "try the next phone request" and that run completes.
- Then: No reply is delivered for the first run, including after the repeated callback. The next run's prompt is "try the next phone request" and exactly one new reply "Task completed successfully." reaches the phone, threaded to the second message.

## agentphone.bdd-089

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > does not send a phone reply after the user deletes the running thread"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the phone has started a run with "delete this phone conversation".
- When: The member deletes the phone conversation's thread, then the sandbox reports the run failed through `POST /api/webhooks/run/complete`.
- Then: No phone reply is sent, and listing the deleted thread's events returns HTTP 404.

## agentphone.bdd-090

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects unavailable personal DM input without silently billing Auto"
- Mode: run
- Given: A Pro-entitled member with native subscription models has linked their phone, prefers `gpt-6-astra`, and has completed one SMS run on that model; the member then deletes the `codex-oauth-token` personal model provider (HTTP 204).
- When: The phone sends "use the system default" over SMS and the Runner heartbeats.
- Then: The member's model preference reads back as `auto`, no run is dispatched, the phone thread contains an `input.rejected` event with no run ID, and the thread's selected model remains `gpt-6-astra`.

## agentphone.bdd-091

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > keeps the DM service tier captured when its thread was created"
- Mode: run
- Given: A Pro-entitled member with native subscription models has linked their phone and prefers `gpt-6-astra` with the `priority` service tier.
- When: The phone sends an SMS that runs, the member clears the service tier preference, and the phone sends two more SMS messages that run.
- Then: All three runs use `gpt-6-astra` with service tier `fast`, and the later runs stay in the same thread with only one thread created.

## agentphone.bdd-092

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > shares one canonical session across AgentPhone and web messages on the same thread"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: The phone sends "start on my phone" over SMS and the run completes; the member sends "continue from the web" to the same thread through the Web chat send-and-launch API and that run completes; the phone then sends "finish back on my phone" with provider recent history and that run completes.
- Then: The first run's system prompt has the SMS "# Current Integration" block before the phone notes, and the reply "Task completed successfully." reaches the phone. One thread is created and its input carries an `agentphone` source `sms:<shared number>`. The Web run is the dispatched run, sends no phone message, and keeps the same session ID; the final phone run also keeps that session, and only one thread is ever created.

## agentphone.bdd-093

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > queues AgentPhone messages in FIFO order without loss or duplication"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: The phone sends "first queued prompt" over SMS, then "second queued prompt" and "third queued prompt" while the first run is active; the runs are completed one by one.
- Then: The second prompt is queued as a pending input and nothing else is dispatched while the first run is active. After each completion the next run is dispatched in FIFO order with prompts "second queued prompt" then "third queued prompt", all three runs share the same session ID, and no dispatch remains unobserved at the end.

## agentphone.bdd-094

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects a queued AgentPhone input and replies with the failure when launch preparation fails with debug enabled"
- Mode: run
- Given: A Pro-entitled member with Okou debug enabled has linked their phone; one SMS run is active and "fail this queued Okou launch" is queued behind it; the default Runner group is then unconfigured.
- When: The sandbox completes the active run through `POST /api/webhooks/run/complete`.
- Then: Completion fails with "No executor configured: set RUNNER_DEFAULT_GROUP". The phone receives exactly two replies, "Task completed successfully." and "Oops, something went wrong. Please try again later.". `GET /api/logs` lists only the active run as `completed`, and the queued input has no run ID and is revoked by an `input.rejected` event with error `internal_error`.

## agentphone.bdd-095

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > archives group admission-failure replies with the iMessage channel"
- Mode: run
- Given: A Pro-entitled member has linked their phone; an iMessage group run is active and "@Okou fail this queued group launch" is queued behind it; the default Runner group is then unconfigured.
- When: The sandbox completes the active run through `POST /api/webhooks/run/complete`, and the member reads `GET /api/integrations/agentphone/group-history`.
- Then: Completion fails with "No executor configured: set RUNNER_DEFAULT_GROUP". The phone replies include "Task completed successfully." and "Oops, something went wrong. Please try again later.", and the group history contains an outbound iMessage reply containing "Oops, something went wrong".

## agentphone.bdd-096

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects a queued input whose phone link was removed before admission"
- Mode: run
- Given: A Pro-entitled member has linked their phone; an SMS run is active and "reject this input after unlinking" is queued as a pending input without a run; the member then unlinks AgentPhone (HTTP 204).
- When: The sandbox completes the active run through `POST /api/webhooks/run/complete`.
- Then: The thread gains an `input.rejected` event revoking the queued input with error `conflict` and an `output.error` with error `conflict`. No phone reply is sent and no further run is dispatched.

## agentphone.bdd-097

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > deduplicates repeated provider messages and completion callbacks"
- Mode: run
- Given: A Pro-entitled member with Okou debug enabled has linked their phone and a Runner group is online.
- When: AgentPhone delivers the same SMS message ID "process exactly once" twice, the run completes, the completion callback is repeated, and the same message is delivered a third time.
- Then: Exactly one run is dispatched with prompt "process exactly once" and exactly one "Task completed successfully." reply is sent. The repeated completion and third delivery send nothing more and dispatch no new run.

## agentphone.bdd-098

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > deduplicates concurrent sms ingress by provider message and webhook identities"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the channel is SMS.
- When: AgentPhone concurrently delivers the same message ID and webhook ID twice, then replays it with a new webhook ID and with a new message ID; after the run completes the original is delivered again.
- Then: Exactly one run is dispatched with the message text and no other dispatch is pending. After completion exactly one reply is sent and the later redelivery adds no send or dispatch.

## agentphone.bdd-099

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > deduplicates concurrent imessage ingress by provider message and webhook identities"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the channel is an iMessage group.
- When: AgentPhone concurrently delivers the same "@Okou accept this event once" message ID and webhook ID twice, then replays it with a new webhook ID and with a new message ID; after the run completes the original is delivered again.
- Then: Exactly one run is dispatched with the message text and no other dispatch is pending. Group history contains exactly that one inbound message. After completion exactly one reply is sent and the later redelivery adds no send or dispatch.

## agentphone.bdd-100

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > retains a pre-link group message without redispatching provider replays"
- Mode: run
- Given: A phone that is not linked to any Okou user posts "@Okou please connect" in an iMessage group; AgentPhone delivers the same message twice concurrently.
- When: The user then links the phone through the connect prompt, and AgentPhone replays the original message and a copy with a new message ID.
- Then: Before linking exactly two sends occur: an unthreaded private `/settings/agentphone?` link to the phone and a group reply threaded to the message. After linking the replays add no sends, and the group history contains the original inbound message followed by the outbound group reply.

## agentphone.bdd-101

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > imports phone media into canonical storage and preserves its message text"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the MMS attachment URL serves a PNG image.
- When: The phone sends "inspect imported photo" with the image over MMS, the run completes, and the phone sends "inspect the same photo again" with the same media URL.
- Then: The first prompt contains "inspect imported photo" followed by a `[Web file] canonical-photo.png (image/png)` block with a canonical file ID (not the message ID) and no provider URL; the run token can preview the imported bytes. The second prompt references the same file ID, the media is downloaded and uploaded only once, and both inputs list file parts with that file ID.

## agentphone.bdd-102

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > downloads inbound media from https://media.agentphone.test/media-only.png"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the media URL is `https://media.agentphone.test/media-only.png`, which first returns HTTP 503 and later serves the bytes.
- When: The phone sends an empty-bodied MMS with that media; after the media becomes available, the run's CLI token downloads it through `GET /api/integrations/phone/download-file` with the message ID.
- Then: The run prompt contains a `[Phone file]` block, and the download returns HTTP 200 with the body "incoming bytes".

## agentphone.bdd-103

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > downloads inbound media from https://api.agentphone.ai/v1/messages/apmsg_inbound/media"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the media URL is the AgentPhone API media endpoint `https://api.agentphone.ai/v1/messages/apmsg_inbound/media`, which first returns HTTP 503 and later serves the bytes.
- When: The phone sends an empty-bodied MMS with that media; after the media becomes available, the run's CLI token downloads it through `GET /api/integrations/phone/download-file` with the message ID.
- Then: The run prompt contains a `[Phone file]` block, and the download returns HTTP 200 with the body "incoming bytes".

## agentphone.bdd-104

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > renders media prompts"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the MMS media URL has an encoded filename and its download fails with HTTP 503.
- When: The phone sends "what is in this photo" with that media over MMS.
- Then: The run prompt is exactly the text followed by `[Phone file] photo one+final%2zraw.png (image/png)` with the inbound message ID, and the stored input has one file part with a UUID file ID and filename snapshot "photo one+final%2zraw.png".

## agentphone.bdd-105

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > renders provider recent history"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: The phone sends "compare with history" over SMS with provider recent history containing a full entry, a media-only entry and an invalid entry.
- Then: The run's system prompt contains "# Phone Message Context" with `MSG_ID: rh-full`, its content, `CHANNEL: sms` and its `AT` timestamp, plus a `[Phone file]` placeholder for the media-only entry; exactly two `RELATIVE_INDEX` entries appear (the invalid one is dropped).

## agentphone.bdd-106

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > answers help, connect, disconnect, and switch commands over SMS"
- Mode: run
- Given: A Pro-entitled member of workspace "Operations workspace" has linked their phone through the connect prompt and received the connected welcome.
- When: The phone sends "/help", "/connect", "/disconnect", "/disconnect" again, "/switch" and "hello again" over SMS through `POST /api/agentphone/webhook`.
- Then: "/help" lists the connect, help, disconnect and switch commands with the SMS reliability warning. "/connect" says "You are already connected" to workspace "Operations workspace" and mentions /switch and the warning. "/disconnect" disconnects the phone and link status becomes unlinked; a second "/disconnect" returns "Error: This phone number is not connected.". "/switch" offers a `/settings/agentphone?` link with the warning, and the unlinked "hello again" gets "Click the link below to start using Okou." with the link, without "AgentPhone" or the warning.

## agentphone.bdd-107

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > archives an outbound group reply once with the original recipients across concurrent provider-id replays"
- Mode: run
- Given: Three users have linked phones; the AgentPhone roster for an iMessage group lists the sender, the second user twice and an invalid handle, and AgentPhone accepts each send with a provider message ID.
- When: The sender posts "/help @Okou" in the group; later, with a roster of the sender and the third user, AgentPhone replays the same provider ID for two concurrent "/help @Okou" posts; after a second, two more concurrent posts yield a fresh provider ID. Members read `GET /api/integrations/agentphone/group-history`.
- Then: The first reply is archived once as an outbound iMessage with the provider ID, shared number, group ID, no media and the send time, visible to the sender and second user but not the third user or another organization. The replayed provider ID adds nothing, and every request uses the API key, agent ID, group ID, a reply-to ID and a "/help" body. The fresh ID is archived once for the third user and the sender, but not the second user; five provider requests are made in total.

## agentphone.bdd-108

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > passes a group photo and bot reply received before connecting into the recipient's context"
- Mode: run
- Given: A linked owner posts a photo and then "/help @Okou" in an iMessage group whose roster includes a second phone; Okou replies in the group. A second second later the recipient links that phone and becomes a Pro-entitled member with a Runner group.
- When: The recipient reads `GET /api/integrations/agentphone/group-history`, posts "@Okou what is in the photo above?" in the group, and downloads the photo through `GET /api/integrations/phone/download-file`.
- Then: The history contains the photo message with its media URL and Okou's earlier outbound reply. The recipient's run system prompt contains `[Phone file] pre-link-photo.jpg (image/jpeg)` with the photo message ID, and the download returns HTTP 200.

## agentphone.bdd-109

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > uses message-time participants for history and media regardless of when they connect"
- Mode: run
- Given: Two users have linked phones. AgentPhone delivers, over iMessage groups: a message without a roster, a message without a provider timestamp, a message from a not-yet-linked third phone, and a "first group note" with a photo whose roster is the first, second and third phones. A second later the third phone and a newcomer phone are linked, then delayed, replayed and "second group note" (roster: first, third and newcomer) messages arrive.
- When: The members read `GET /api/integrations/agentphone/group-history` (including `query` and `limit=1` with a cursor) and download the photo through `GET /api/integrations/phone/download-file`.
- Then: The roster-less message is visible to its sender; the timestamp-less webhook returns HTTP 500 and stores nothing; the third phone sees its own pre-link message. In the stable group the first user sees first, delayed and second notes, the second user sees first and delayed, the later-linked user sees all three, and the newcomer sees only the second note. The second and later-linked users download the photo with HTTP 200 while the newcomer gets 404. The query "second" returns only the second note, and paging by one returns `hasMore`, a cursor and then the delayed message.

## agentphone.bdd-110

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns 500 and does not dispatch group webhooks without a timestamp"
- Mode: run
- Given: The AgentPhone webhook is configured; iMessage group messages arrive without a provider message timestamp, with an unparseable timestamp ("October 1, 2026"), or with only an unsupported `received_at` alias.
- When: AgentPhone posts each group message to `POST /api/agentphone/webhook` (the first one twice).
- Then: Every request returns HTTP 500; the alias request's body is "iMessage group webhook is missing receivedAt", and no AgentPhone message is sent.

## agentphone.bdd-111

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > acks AgentPhone's documented idless test webhook without processing it"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: AgentPhone posts its documented test webhook (SMS, no message ID, `conversationState.testMode: true`, recent history) to `POST /api/agentphone/webhook`.
- Then: The response is HTTP 200 with body "OK", no run is dispatched after a Runner heartbeat, and no message is sent.

## agentphone.bdd-112

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > processes iMessage webhooks with messageId even when testMode is set"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: AgentPhone posts an iMessage webhook with a message ID and `conversationState.testMode: true` containing "process this identified message", and the run completes.
- Then: The response is HTTP 200 "OK", a run is dispatched with that prompt, and the reply "Task completed successfully." goes to the phone threaded to the message ID.

## agentphone.bdd-113

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns 500 for direct message webhooks without provider message ids"
- Mode: run
- Given: The AgentPhone webhook is configured.
- When: AgentPhone posts direct iMessage and SMS messages without a provider message ID to `POST /api/agentphone/webhook`.
- Then: Each request returns HTTP 500 and no AgentPhone message is sent.

## agentphone.bdd-114

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > acks SMS short-code notifications from 12345 without consuming a connection code or replying"
- Mode: run
- Given: A signed-in member has issued a link code; an SMS notification arrives from the short code "12345".
- When: AgentPhone posts the short-code message containing the code to `POST /api/agentphone/webhook`, then a real phone texts the same code.
- Then: The short-code webhook returns HTTP 200 "OK", the member stays unlinked and nothing is sent. The real phone's code links the member and produces the three-message connected welcome.

## agentphone.bdd-115

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > acks SMS short-code notifications from 123456 without consuming a connection code or replying"
- Mode: run
- Given: A signed-in member has issued a link code; an SMS notification arrives from the short code "123456".
- When: AgentPhone posts the short-code message containing the code to `POST /api/agentphone/webhook`, then a real phone texts the same code.
- Then: The short-code webhook returns HTTP 200 "OK", the member stays unlinked and nothing is sent. The real phone's code links the member and produces the three-message connected welcome.

## agentphone.bdd-116

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns 500 for direct messages with an invalid sender: sms not-a-phone-number"
- Mode: run
- Given: The AgentPhone webhook is configured; a direct SMS arrives from the sender "not-a-phone-number".
- When: AgentPhone posts the message to `POST /api/agentphone/webhook`.
- Then: The request returns HTTP 500 with body "AgentPhone message webhook has an invalid sender".

## agentphone.bdd-117

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns 500 for direct messages with an invalid sender: sms sender12345"
- Mode: run
- Given: The AgentPhone webhook is configured; a direct SMS arrives from the sender "sender12345".
- When: AgentPhone posts the message to `POST /api/agentphone/webhook`.
- Then: The request returns HTTP 500 with body "AgentPhone message webhook has an invalid sender".

## agentphone.bdd-118

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns 500 for direct messages with an invalid sender: sms 15555551212"
- Mode: run
- Given: The AgentPhone webhook is configured; a direct SMS arrives from the sender "15555551212" (no leading plus).
- When: AgentPhone posts the message to `POST /api/agentphone/webhook`.
- Then: The request returns HTTP 500 with body "AgentPhone message webhook has an invalid sender".

## agentphone.bdd-119

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns 500 for direct messages with an invalid sender: imessage 12345"
- Mode: run
- Given: The AgentPhone webhook is configured; a direct iMessage arrives from the short code "12345".
- When: AgentPhone posts the message to `POST /api/agentphone/webhook`.
- Then: The request returns HTTP 500 with body "AgentPhone message webhook has an invalid sender".

## agentphone.bdd-120

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns 500 for direct messages with an invalid sender: mms 12345"
- Mode: run
- Given: The AgentPhone webhook is configured; a direct MMS arrives from the short code "12345".
- When: AgentPhone posts the message to `POST /api/agentphone/webhook`.
- Then: The request returns HTTP 500 with body "AgentPhone message webhook has an invalid sender".

## agentphone.bdd-121

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns 500 for direct messages with an invalid sender: whatsapp 12345"
- Mode: run
- Given: The AgentPhone webhook is configured; a direct WhatsApp message arrives from "12345".
- When: AgentPhone posts the message to `POST /api/agentphone/webhook`.
- Then: The request returns HTTP 500 with body "AgentPhone message webhook has an invalid sender".

## agentphone.bdd-122

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > returns 500 for group webhooks without stable provider identities"
- Mode: run
- Given: The AgentPhone webhook is configured; iMessage group messages arrive missing a message ID, missing a group ID, missing a conversation ID, missing a sender identifier, or with an invalid group ID.
- When: AgentPhone posts each group message to `POST /api/agentphone/webhook`.
- Then: Every request returns HTTP 500 and no AgentPhone message is sent.

## agentphone.bdd-123

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > delivers a group run reply when the provider roster lookup fails"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the phone posts "@Okou summarize this group" in an iMessage group, and AgentPhone's conversation roster lookup then fails with HTTP 503.
- When: The run completes through `POST /api/webhooks/run/complete`, and the member reads `GET /api/integrations/agentphone/group-history`.
- Then: A typing indicator is sent and the run's system prompt contains the group ID. The reply is still sent to the group, but the history contains only the inbound message (the reply is not archived).

## agentphone.bdd-124

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > sends group connect replies when roster lookup fails and never archives them"
- Mode: run
- Given: A linked member is in an iMessage group with an unlinked phone; AgentPhone's roster lookup first fails with HTTP 503 and later returns `null`.
- When: The unlinked phone posts "@Okou please connect this group" and then "@Okou retry the malformed roster response" to `POST /api/agentphone/webhook`; the member reads the group history.
- Then: Each message produces two connect replies (four sends total), and the group history contains only the two inbound messages.

## agentphone.bdd-125

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > rejects group webhooks without a conversation identity before creating a run"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: AgentPhone posts two iMessage group messages that have group IDs but no conversation ID to `POST /api/agentphone/webhook`.
- Then: Each request returns HTTP 500; no run is dispatched, no message is sent, and both groups' history is empty.

## agentphone.bdd-126

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > shares a main thread per iMessage group and forks persistent reply threads"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: In one iMessage group the phone sends a root prompt, a follow-up, a reply to the root, replies to that branch message, its bot answer and the root, a non-reply message, a reply to the first bot answer, and a prompt in another group; each run completes.
- Then: The follow-up and the later non-reply message resume the main session. The first root reply starts a new branch session that later replies to the branch message, branch answer and root resume. Replies to the main bot answer and the other group's message start new sessions distinct from both. Four threads are created with prompts [root, follow-up, return], [branch, three replies], [bot-answer reply] and [other group].

## agentphone.bdd-127

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > anchors iMessage group replies to an ambient message without an existing web thread"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the phone posted an unmentioned message "The launch is scheduled for Friday" in an iMessage group.
- When: The phone replies to that message twice in the group, with "@Okou summarize this plan" and then "@Okou list the risks", and each run completes.
- Then: The first run starts without a resumed session and the second resumes the first run's session, and exactly one thread is created.

## agentphone.bdd-128

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > scopes iMessage reply routing to the linked sender and group conversation"
- Mode: run
- Given: A Pro-entitled owner has linked their phone and completed a mentioned run in an iMessage group; a second Pro-entitled member has linked a different phone.
- When: The second member replies to the owner's root message in the same group, and the owner replies to that root message from a different group conversation; each run completes.
- Then: Neither run resumes a session, and each produces a session different from the owner's original session. The owner has two created threads and the second member has one.

## agentphone.bdd-129

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > handles the iMessage group lifecycle: mentions, stored context, ambient silence, and account-command guards"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the iMessage group conversation ID is long enough that `group:<id>` exceeds 255 characters.
- When: The phone posts "@Okou summarize this thread" with provider recent history, the sandbox sends events and heartbeats, the run completes; then the phone replies to it, posts ambient chatter, sends a private DM, an unlinked participant sends "/disconnect @Okou", and a stranger sends "@Okou hello", "/connect @Okou" and a borrowing mention.
- Then: One group thread is created with the prompt and an `agentphone` source; typing refreshes three times and the heartbeat returns `typingRefreshIntervalSeconds: 4`; provider history is excluded and the reply goes to the group ID threaded to the message. The reply-to run renders stored context with the sender and BOT in a new session. Ambient chatter dispatches nothing and is absent from the DM run. The participant's command is refused with "Only the linked sender" and the member stays linked. The stranger gets a private link plus a link-free group notice, and the borrowing mention dispatches no run and is not recorded in the owner's thread.

## agentphone.bdd-130

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > preserves a mention-only iMessage prompt with the preceding task"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the phone posted "Check the broken article at https://example.com/article" in an iMessage group.
- When: The phone sends a standalone "@okou" with provider-only recent history, then "and schedule it for Monday" with a provider mention object for `okou`, then "I think okou would probably know".
- Then: The "@okou" run's prompt is "@okou" and its system prompt contains the archived article URL but not the provider-only URL. The mention-object message dispatches a run with prompt "and schedule it for Monday". The embedded-name chatter dispatches no run.

## agentphone.bdd-131

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > replies in the group when iMessage drops the at-sign from an opening mention: Okou hi"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the group message is "Okou hi".
- When: The phone posts the message in an iMessage group and the run completes.
- Then: The run prompt is "Okou hi", and the reply "Task completed successfully." goes to the group threaded to the message.

## agentphone.bdd-132

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > replies in the group when iMessage drops the at-sign from an opening mention: \u0020\u0020OKOU，帮我总结"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the group message is " OKOU，帮我总结" (leading spaces, full-width comma).
- When: The phone posts the message in an iMessage group and the run completes.
- Then: The run prompt is the trimmed "OKOU，帮我总结", and the reply "Task completed successfully." goes to the group threaded to the message.

## agentphone.bdd-133

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > replies in the group when iMessage drops the at-sign from an opening mention: Okou"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the group message is just "Okou".
- When: The phone posts the message in an iMessage group and the run completes.
- Then: The run prompt is "Okou", and the reply "Task completed successfully." goes to the group threaded to the message.

## agentphone.bdd-134

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > replies in the group when iMessage drops the at-sign from an opening mention: okou would probably know"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online; the group message is "okou would probably know".
- When: The phone posts the message in an iMessage group and the run completes.
- Then: The run prompt is "okou would probably know", and the reply "Task completed successfully." goes to the group threaded to the message.

## agentphone.bdd-135

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > ignores iMessage group text without an opening address"
- Mode: run
- Given: A Pro-entitled member has linked their phone, a Runner group is online, and an iMessage group thread was established by "Okou establish the group thread".
- When: The phone posts "okou.ai has the answer", "OkouHelper hi" and "I think Okou would probably know" in the group.
- Then: None of the messages dispatches a run and no AgentPhone message is sent.

## agentphone.bdd-136

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > does not send a group reply to one member when the provider group id is missing"
- Mode: run
- Given: A Pro-entitled member has linked their phone and a Runner group is online.
- When: AgentPhone posts "@Okou check this group" as an iMessage group message without a group ID to `POST /api/agentphone/webhook`.
- Then: The request returns HTTP 500, no AgentPhone message is sent, and no run is dispatched.

## agentphone.bdd-137

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > tells a group when the org is at its concurrent run limit and starts it once a slot frees up"
- Mode: run
- Given: The organization concurrent run cap is 1. A Pro-entitled member has linked their phone, and an SMS run occupies the only slot without any wait notice.
- When: The phone posts "Okou wait for an org run slot" in an iMessage group, and later the active run completes.
- Then: The group receives exactly one notice threaded to the message: "The workspace has reached its concurrent run limit; this will start automatically when a slot frees up.". A new group thread is created with the prompt queued, not revoked and without a run, and nothing is dispatched. After the active run completes, a run starts with the waiting prompt, and the notice is never sent again.

## agentphone.bdd-138

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > sends no wait notice when the input joins its thread's running run at the org limit"
- Mode: run
- Given: The organization concurrent run cap is 1, and a Pro-entitled member's SMS run occupies the only slot.
- When: The same phone sends "follow up while the run is working" over SMS.
- Then: No AgentPhone message (no wait notice) is sent.

## agentphone.bdd-139

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > skips completion delivery after the phone link changes through unlink"
- Mode: run
- Given: A Pro-entitled member has linked their phone and has an active iMessage DM run and an active group run; the member then unlinks through `DELETE /api/integrations/agentphone/link` (method: unlink).
- When: The sandbox completes the DM run and then the group run through `POST /api/webhooks/run/complete`.
- Then: Neither completion sends any AgentPhone message.

## agentphone.bdd-140

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > skips completion delivery after the phone link changes through switch"
- Mode: run
- Given: A Pro-entitled member has linked their phone and has an active iMessage DM run and an active group run; the phone then sends "/switch" and receives a `/settings/agentphone?` link (method: switch).
- When: The sandbox completes the DM run and then the group run through `POST /api/webhooks/run/complete`.
- Then: Neither completion sends any AgentPhone message.

## agentphone.bdd-141

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > skips completion delivery after the phone link changes through replace"
- Mode: run
- Given: A Pro-entitled member has linked their phone and has an active iMessage DM run and an active group run; the member then connects a new phone through `POST /api/agentphone/connect` with `replacePhoneHandle` set to the old phone (method: replace).
- When: The sandbox completes the DM run and then the group run through `POST /api/webhooks/run/complete`.
- Then: Neither completion sends any AgentPhone message.

## agentphone.bdd-142

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > uploads phone media with a real run-scoped agent token (group: false)"
- Mode: run
- Given: A Pro-entitled member has linked their phone and started a Web thread run; the run's execution exposes `OKOU_TOKEN` (group: false).
- When: The run token calls `POST /api/integrations/phone/upload-file/init` for "screen shot.png", the object is stored, and `POST /api/integrations/phone/upload-file/complete` with caption "see attached"; it then downloads through `GET /api/integrations/phone/download-file`, and an unauthenticated caller tries the same download.
- Then: Init returns filename `screen_shot.png`, `image/png`, size 123, an upload URL and a private `/artifacts/<10 chars>.png` URL. Complete returns "screen shot.png", `image/png`, size 456 and `toNumber` set to the phone; AgentPhone receives "see attached\n\nTriggered by BDD Runner" with a media URL for the private object. The download is a 302 with `image/png`, file name `screen%20shot.png`, size 456 and the same object; the unauthenticated download returns HTTP 401 with an API error.

## agentphone.bdd-143

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > uploads phone media with a real run-scoped agent token (group: true)"
- Mode: run
- Given: A Pro-entitled member has linked their phone, posted in an iMessage group, and started a Web thread run; the run's execution exposes `OKOU_TOKEN` (group: true).
- When: The run token calls `POST /api/integrations/phone/upload-file/init` for "screen shot.png", the object is stored, and `POST /api/integrations/phone/upload-file/complete` with the group ID and caption "see attached"; the member reads the group history, the token downloads the file, and an unauthenticated caller tries the same download.
- Then: Init returns `screen_shot.png`, `image/png`, size 123 and a private artifact URL. Complete returns "screen shot.png", `image/png`, size 456 and `toNumber` set to the group ID; AgentPhone receives "see attached\n\nTriggered by BDD Runner" for the group with the private object. Group history contains the outbound iMessage with the private file URL. The download is a 302 with the file headers and same object; the unauthenticated download returns HTTP 401.

## agentphone.bdd-144

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > requires current group membership and keeps group uploads scoped to the user, organization, agent, and file owner"
- Mode: run
- Given: A linked owner, a linked group member and a linked outsider exist; the owner's phone posted in an iMessage group with the member, and the owner and outsider each have an uploaded "photo.png".
- When: Callers complete the group upload through `POST /api/integrations/phone/upload-file/complete` while AgentPhone's roster changes: unauthenticated, as the member, as the outsider, from another organization, with an unrelated agent, after the owner left the roster, with roster 404, 503 and network errors, and finally with the owner back in the roster.
- Then: The denials return 401, 404, 404, 404 and 404, the departed owner gets 403, and roster failures return 404, 502 and 502, all without sending. The final upload returns HTTP 200 to the group ID and AgentPhone receives "Group photo" with a media URL; the member's group history contains it, while the outsider's history is empty.

## agentphone.bdd-145

- Vitest: "INT-03: AgentPhone linked-run lifecycle through public APIs > guards startLink against foreign-owner handles and provider network failures"
- Mode: run
- Given: A user has linked a phone through the connect prompt; a rival user signs in.
- When: The rival calls `POST /api/integrations/agentphone/link` for the owner's phone, then for a new phone while AgentPhone message sends fail with a network error.
- Then: The first request returns HTTP 409 with `CONFLICT` and "This phone number is already connected to another Okou account or organization. Disconnect it first.". The second returns HTTP 503 with `PROVIDER_UNAVAILABLE`.
