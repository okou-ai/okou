# whatsapp

## whatsapp-001

- Vitest: "WhatsApp through the shared AgentPhone number > guides an unconnected DM into a signed WhatsApp connection for Hello Okou"
- Mode: run
- Given: Row `Hello Okou`. The WhatsApp integration switch is on, the shared AgentPhone number is WhatsApp-enabled, and an unconnected +49 phone number messages it over WhatsApp.
- When: AgentPhone delivers a signed inbound WhatsApp message `Hello Okou` to `POST /api/agentphone/webhook`; a signed-in member opens the signed link from the reply, checks `GET /api/integrations/whatsapp/connect-status`, and connects via `POST /api/integrations/whatsapp/connect`.
- Then: The reply carries a signed `/settings/whatsapp` URL for that phone with `channel: whatsapp`. Connect status is `{kind: "connect"}` and the member is not linked; the connect returns HTTP 200, after which the status is `{kind: "connected", phoneHandle}` while the AgentPhone phone link stays unlinked. The last three provider sends go over WhatsApp to that phone and the last one contains "What would you like to start with?".

## whatsapp-002

- Vitest: "WhatsApp through the shared AgentPhone number > guides an unconnected DM into a signed WhatsApp connection for /connect"
- Mode: run
- Given: Row `/connect`. The WhatsApp integration switch is on, the shared AgentPhone number is WhatsApp-enabled, and an unconnected +49 phone number messages it over WhatsApp.
- When: AgentPhone delivers a signed inbound WhatsApp message `/connect` to `POST /api/agentphone/webhook`; a signed-in member opens the signed link from the reply, checks `GET /api/integrations/whatsapp/connect-status`, and connects via `POST /api/integrations/whatsapp/connect`.
- Then: The reply carries a signed `/settings/whatsapp` URL for that phone with `channel: whatsapp`. Connect status is `{kind: "connect"}` and the member is not linked; the connect returns HTTP 200, after which the status is `{kind: "connected", phoneHandle}` while the AgentPhone phone link stays unlinked. The last three provider sends go over WhatsApp to that phone and the last one contains "What would you like to start with?".

## whatsapp-003

- Vitest: "WhatsApp through the shared AgentPhone number > guides an unconnected DM into a signed WhatsApp connection for /switch"
- Mode: run
- Given: Row `/switch`. The WhatsApp integration switch is on, the shared AgentPhone number is WhatsApp-enabled, and an unconnected +49 phone number messages it over WhatsApp.
- When: AgentPhone delivers a signed inbound WhatsApp message `/switch` to `POST /api/agentphone/webhook`; a signed-in member opens the signed link from the reply, checks `GET /api/integrations/whatsapp/connect-status`, and connects via `POST /api/integrations/whatsapp/connect`.
- Then: The reply carries a signed `/settings/whatsapp` URL for that phone with `channel: whatsapp`. Connect status is `{kind: "connect"}` and the member is not linked; the connect returns HTTP 200, after which the status is `{kind: "connected", phoneHandle}` while the AgentPhone phone link stays unlinked. The last three provider sends go over WhatsApp to that phone and the last one contains "What would you like to start with?".

## whatsapp-004

- Vitest: "WhatsApp through the shared AgentPhone number > identifies the connected workspace and offers recovery without an agent run"
- Mode: run
- Given: A member's workspace "WhatsApp workspace" is connected to a WhatsApp phone through the shared AgentPhone number.
- When: The connected phone sends `/connect` over WhatsApp via `POST /api/agentphone/webhook`.
- Then: The last WhatsApp reply names `workspace "WhatsApp workspace"` and mentions `/switch` and `/disconnect`.

## whatsapp-005

- Vitest: "WhatsApp through the shared AgentPhone number > answers help and disconnect before connection without starting an agent"
- Mode: run
- Given: The WhatsApp integration is enabled and a phone number is not connected to any workspace.
- When: The phone sends `/help`, then `/disconnect`, over WhatsApp via `POST /api/agentphone/webhook`.
- Then: The `/help` reply contains "WhatsApp commands", and the `/disconnect` reply contains "not connected. Send /connect".

## whatsapp-006

- Vitest: "WhatsApp through the shared AgentPhone number > rejects cross-channel and expired signed proofs without connecting"
- Mode: run
- Given: A signed-in member holds a signed WhatsApp connection proof obtained from a `/connect` reply.
- When: The member posts the proof with `channel: "imessage"` to `POST /api/integrations/whatsapp/connect`; then, 11 minutes later, checks `GET /api/integrations/whatsapp/connect-status` and posts the original proof.
- Then: The cross-channel connect returns HTTP 400, the expired status check and connect both return HTTP 400, and `GET /api/integrations/whatsapp/link` shows the member not linked.

## whatsapp-007

- Vitest: "WhatsApp through the shared AgentPhone number > requires explicit number replacement and preserves the old link on a competing claim"
- Mode: run
- Given: A signed-in member is connected to one WhatsApp phone and obtains a signed proof for a second phone; another workspace member also uses that proof.
- When: The member checks connect status and connects without replacement; the other member connects with the proof; the member retries with `replacePhoneHandle`; the other member unlinks; the member retries the replacement; then the new phone sends `/disconnect` and `/connect` over WhatsApp.
- Then: Connect status is `{kind: "phone_mismatch", currentPhoneHandle}` and the plain connect returns HTTP 409. The other member's connect returns HTTP 200, so the member's replacement returns HTTP 409 and the old link is kept. After the other member unlinks (HTTP 204) the replacement returns HTTP 200 and the link shows the new phone. The final `/connect` reply contains `/settings/whatsapp?`.

## whatsapp-008

- Vitest: "WhatsApp through the shared AgentPhone number > sends an owned private artifact as one WhatsApp attachment without publishing its fetch URL"
- Mode: run
- Given: A signed-in member is connected to WhatsApp and has an uploaded private PDF artifact of 1024 bytes; AgentPhone accepts sends without echoing routing details. Another member is connected to a different phone.
- When: The member sends the file with caption "Here is the report" via `POST /api/integrations/whatsapp/files`; the other member tries to send the same file ID.
- Then: The member's send returns HTTP 200 with channel `whatsapp`, the member's phone, the file ID, URL and size, and one message. AgentPhone receives exactly one WhatsApp send from the shared number with the caption and one HTTPS media URL carrying a query string, and the file still has no public URL. The other member's attempt returns HTTP 404 with no provider send.

## whatsapp-009

- Vitest: "WhatsApp through the shared AgentPhone number > preserves the uploaded artifact when file delivery is rejected without retrying"
- Mode: run
- Given: Row `rejected`. A connected member has an uploaded PDF artifact, and AgentPhone rejects message sends with HTTP 422.
- When: The member sends the file via `POST /api/integrations/whatsapp/files`.
- Then: The response is HTTP 400 with `delivery: "failed"` and the file's ID and URL. AgentPhone receives exactly one attempt, and the file still has no public URL.

## whatsapp-010

- Vitest: "WhatsApp through the shared AgentPhone number > preserves the uploaded artifact when file delivery is unknown without retrying"
- Mode: run
- Given: Row `unknown`. A connected member has an uploaded PDF artifact, and the AgentPhone send fails with a network error.
- When: The member sends the file via `POST /api/integrations/whatsapp/files`.
- Then: The response is HTTP 502 with `delivery: "unknown"` and the file's ID and URL. AgentPhone receives exactly one attempt, and the file still has no public URL.

## whatsapp-011

- Vitest: "WhatsApp through the shared AgentPhone number > preserves the uploaded artifact when file delivery is server-error without retrying"
- Mode: run
- Given: Row `server-error`. A connected member has an uploaded PDF artifact, and AgentPhone answers message sends with HTTP 500.
- When: The member sends the file via `POST /api/integrations/whatsapp/files`.
- Then: The response is HTTP 502 with `delivery: "unknown"` and the file's ID and URL. AgentPhone receives exactly one attempt, and the file still has no public URL.

## whatsapp-012

- Vitest: "WhatsApp through the shared AgentPhone number > rejects an audio caption before sending and accepts the same audio without a caption"
- Mode: run
- Given: A connected member has an uploaded `audio/mpeg` artifact.
- When: The member sends it with caption "Listen" via `POST /api/integrations/whatsapp/files`, then sends it again without a caption.
- Then: The captioned send returns HTTP 400 with `delivery: "failed"` and error code `WHATSAPP_AUDIO_CAPTION_UNSUPPORTED`, and nothing reaches AgentPhone. The uncaptioned send returns HTTP 200 and AgentPhone receives a WhatsApp send with an empty body and one media URL.

## whatsapp-013

- Vitest: "WhatsApp through the shared AgentPhone number > verifies WhatsApp independently and disconnects it without changing the phone link"
- Mode: run
- Given: A signed-in member has created a WhatsApp link code via `POST /api/integrations/whatsapp/link-code`.
- When: A phone sends the code over SMS, then over WhatsApp; later the same phone links the AgentPhone phone integration with a phone link code over SMS, and the member unlinks WhatsApp via `DELETE /api/integrations/whatsapp/link`.
- Then: The SMS code leaves WhatsApp unlinked; the WhatsApp code links WhatsApp to that phone and the shared AgentPhone number while the phone integration stays unlinked. After the unlink (HTTP 204) the phone integration remains linked and WhatsApp is unlinked.

## whatsapp-014

- Vitest: "WhatsApp through the shared AgentPhone number > rejects WhatsApp transport proofs on phone connection routes"
- Mode: run
- Given: A signed-in member holds a validly signed proof with `channel: "whatsapp"` for a phone and the AgentPhone agent.
- When: The member submits the proof to the phone routes `GET /api/integrations/agentphone/connect-status` and `POST /api/agentphone/connect`.
- Then: Both return HTTP 400, and neither the phone link nor the WhatsApp link is established.

## whatsapp-015

- Vitest: "WhatsApp through the shared AgentPhone number > disconnect only revokes the WhatsApp link when the same number also has a phone link"
- Mode: run
- Given: Row `disconnect`. A member's phone is connected through WhatsApp and also linked through the AgentPhone phone (SMS) integration.
- When: The phone sends `/disconnect` over WhatsApp via `POST /api/agentphone/webhook`.
- Then: The WhatsApp link is revoked while the phone link stays linked, and the reply goes over WhatsApp from the shared number to that phone.

## whatsapp-016

- Vitest: "WhatsApp through the shared AgentPhone number > switch only revokes the WhatsApp link when the same number also has a phone link"
- Mode: run
- Given: Row `switch`. A member's phone is connected through WhatsApp and also linked through the AgentPhone phone (SMS) integration.
- When: The phone sends `/switch` over WhatsApp via `POST /api/agentphone/webhook`, then reconnects with a new WhatsApp link code.
- Then: The WhatsApp link is revoked while the phone link stays linked; the reply goes over WhatsApp from the shared number to that phone and contains `/settings/whatsapp?` with `channel=whatsapp`. The phone can then reconnect.

## whatsapp-017

- Vitest: "WhatsApp through the shared AgentPhone number > maintains WhatsApp typing and routes run replies through completion (connected)"
- Mode: run
- Given: Row `connected`. A Pro-entitled member with a Runner group and Fable model is connected to WhatsApp; AgentPhone accepts sends without echoing routing details.
- When: The phone sends "Help me plan a meeting" over WhatsApp with recent history that includes an SMS message "Private SMS history"; the dispatched Run sends eight heartbeats four seconds apart to `POST /api/webhooks/run/heartbeat` and a result "Your meeting plan is ready." to `POST /api/webhooks/run/events`, then completes via `POST /api/webhooks/run/complete`; afterwards the Run's Okou token sends an extra message via `POST /api/integrations/whatsapp/message`.
- Then: A typing indicator is sent for the conversation at intake. The Run prompt contains the WhatsApp commands, "# WhatsApp Message Context", "currently running inside: WhatsApp", `okou whatsapp upload-file` and `okou whatsapp message send --help` guidance, sets `OKOU_CURRENT_INTEGRATION=whatsapp`, and omits "Private SMS history". Each heartbeat returns `{ok: true, typingRefreshIntervalSeconds: 4}` and refreshes typing once, the result refreshes it once more, and after completion a heartbeat returns HTTP 404 with no further typing. The final reply goes over WhatsApp from the shared number with body "Your meeting plan is ready." and `reply_to_message_id` equal to the inbound message ID, and the extra message returns HTTP 200.

## whatsapp-018

- Vitest: "WhatsApp through the shared AgentPhone number > maintains WhatsApp typing and routes run replies through completion (typing-recovery)"
- Mode: run
- Given: Row `typing-recovery`. A Pro-entitled member with a Runner group and Fable model is connected to WhatsApp; AgentPhone rejects the first typing request for the conversation with HTTP 503 and then accepts typing.
- When: The phone sends "Help me plan a meeting" over WhatsApp with recent history that includes an SMS message "Private SMS history"; the dispatched Run sends eight heartbeats four seconds apart to `POST /api/webhooks/run/heartbeat` and a result "Your meeting plan is ready." to `POST /api/webhooks/run/events`, then completes via `POST /api/webhooks/run/complete`; afterwards the Run's Okou token sends an extra message via `POST /api/integrations/whatsapp/message`.
- Then: No typing indicator is recorded at intake. The Run prompt contains the WhatsApp commands, "# WhatsApp Message Context", "currently running inside: WhatsApp", `okou whatsapp upload-file` and `okou whatsapp message send --help` guidance, sets `OKOU_CURRENT_INTEGRATION=whatsapp`, and omits "Private SMS history". Each heartbeat returns `{ok: true, typingRefreshIntervalSeconds: 4}` and refreshes typing once, the result refreshes it once more, and after completion a heartbeat returns HTTP 404 with no further typing. The final reply goes over WhatsApp from the shared number with body "Your meeting plan is ready." and `reply_to_message_id` equal to the inbound message ID, and the extra message returns HTTP 200.

## whatsapp-019

- Vitest: "WhatsApp through the shared AgentPhone number > maintains WhatsApp typing and routes run replies through completion (unlink)"
- Mode: run
- Given: Row `unlink`. A Pro-entitled member with a Runner group and Fable model is connected to WhatsApp.
- When: The phone sends "Help me plan a meeting" over WhatsApp with recent history that includes an SMS message "Private SMS history"; the dispatched Run sends eight heartbeats four seconds apart to `POST /api/webhooks/run/heartbeat` and a result "Your meeting plan is ready." to `POST /api/webhooks/run/events`, then the member unlinks WhatsApp via `DELETE /api/integrations/whatsapp/link` (HTTP 204) before the Run completes via `POST /api/webhooks/run/complete`.
- Then: A typing indicator is sent at intake. The Run prompt contains the WhatsApp commands, "# WhatsApp Message Context", "currently running inside: WhatsApp", `okou whatsapp upload-file` and `okou whatsapp message send --help` guidance, sets `OKOU_CURRENT_INTEGRATION=whatsapp`, and omits "Private SMS history". Each heartbeat returns `{ok: true, typingRefreshIntervalSeconds: 4}` and refreshes typing once, the result refreshes it once more, and after completion a heartbeat returns HTTP 404 with no further typing. No message is sent to AgentPhone after the unlink.

## whatsapp-020

- Vitest: "WhatsApp through the shared AgentPhone number > maintains WhatsApp typing and routes run replies through completion (switch)"
- Mode: run
- Given: Row `switch`. A Pro-entitled member with a Runner group and Fable model is connected to WhatsApp.
- When: The phone sends "Help me plan a meeting" over WhatsApp with recent history that includes an SMS message "Private SMS history"; the dispatched Run sends eight heartbeats four seconds apart to `POST /api/webhooks/run/heartbeat` and a result "Your meeting plan is ready." to `POST /api/webhooks/run/events`, then the phone sends `/switch` over WhatsApp before the Run completes via `POST /api/webhooks/run/complete`.
- Then: A typing indicator is sent at intake. The Run prompt contains the WhatsApp commands, "# WhatsApp Message Context", "currently running inside: WhatsApp", `okou whatsapp upload-file` and `okou whatsapp message send --help` guidance, sets `OKOU_CURRENT_INTEGRATION=whatsapp`, and omits "Private SMS history". Each heartbeat returns `{ok: true, typingRefreshIntervalSeconds: 4}` and refreshes typing once, the result refreshes it once more, and after completion a heartbeat returns HTTP 404 with no further typing. No message is sent to AgentPhone after the `/switch` reply.

## whatsapp-021

- Vitest: "WhatsApp through the shared AgentPhone number > maintains WhatsApp typing and routes run replies through completion (window-closed)"
- Mode: run
- Given: Row `window-closed`. A Pro-entitled member with a Runner group and Fable model is connected to WhatsApp, and the Run's Chat is renamed "Meeting plan". Before completion AgentPhone rejects free-form sends with 422 "(#131047) Re-engagement message" and accepts template sends.
- When: The phone sends "Help me plan a meeting" over WhatsApp with recent history that includes an SMS message "Private SMS history"; the dispatched Run sends eight heartbeats four seconds apart to `POST /api/webhooks/run/heartbeat` and a result "Your meeting plan is ready." to `POST /api/webhooks/run/events`, then completes via `POST /api/webhooks/run/complete`, and the completion is delivered a second time.
- Then: A typing indicator is sent at intake. The Run prompt contains the WhatsApp commands, "# WhatsApp Message Context", "currently running inside: WhatsApp", `okou whatsapp upload-file` and `okou whatsapp message send --help` guidance, sets `OKOU_CURRENT_INTEGRATION=whatsapp`, and omits "Private SMS history". Each heartbeat returns `{ok: true, typingRefreshIntervalSeconds: 4}` and refreshes typing once, the result refreshes it once more, and after completion a heartbeat returns HTTP 404 with no further typing. AgentPhone receives exactly two sends; the second is the `okou_task_completed` template (`en_US`, variables "Meeting plan" and the Chat URL) with body 'Your requested Okou task "Meeting plan" is complete. Open <Chat URL> to view the result.' The repeated completion sends nothing more.

## whatsapp-022

- Vitest: "WhatsApp through the shared AgentPhone number > sends long Unicode messages only through WhatsApp using the existing shared number"
- Mode: run
- Given: A signed-in member is connected to WhatsApp; a second member of the platform has no WhatsApp connection.
- When: The member sends a text of 4,100 "😀" characters via `POST /api/integrations/whatsapp/message`; the second member then sends a message through the same route.
- Then: The member's send returns HTTP 200 with channel `whatsapp`, the member's phone, and two messages. AgentPhone receives two WhatsApp sends from the shared number to that phone, each at most 4,096 characters, which join back into the original text. The second member gets HTTP 404 and no further send occurs.

## whatsapp-023

- Vitest: "WhatsApp through the shared AgentPhone number > handles task-completion sends without duplicating uncertain or accepted messages (open)"
- Mode: run
- Given: Row `open`. A Pro-entitled member connected over WhatsApp has a running task in a Chat named "Meeting plan", and AgentPhone accepts every message part.
- When: The Run's Okou token posts "Your completed report. " repeated 300 times with `taskCompleted: true` to `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 200 `{channel: "whatsapp", toNumber, messages: [{id: "normal-part-1"}, {id: "normal-part-2"}]}`. AgentPhone receives two requests whose bodies join to the text followed by "\n\nTriggered by WhatsApp Test".

## whatsapp-024

- Vitest: "WhatsApp through the shared AgentPhone number > handles task-completion sends without duplicating uncertain or accepted messages (closed)"
- Mode: run
- Given: Row `closed`. A Pro-entitled member connected over WhatsApp has a running task in a Chat named "Meeting plan". AgentPhone rejects free-form sends with HTTP 422 error code 131047 and accepts template sends with HTTP 201.
- When: The Run's Okou token posts a long completed-report text with `taskCompleted: true` to `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 200 with `messages: [{id: "task-template"}]` and `template: "okou_task_completed"`. AgentPhone receives two requests; the second is exactly the `okou_task_completed` template (`en_US`, variables "Meeting plan" and the Chat URL) from the shared number with body 'Your requested Okou task "Meeting plan" is complete. Open <Chat URL> to view the result.'

## whatsapp-025

- Vitest: "WhatsApp through the shared AgentPhone number > handles task-completion sends without duplicating uncertain or accepted messages (other-rejection)"
- Mode: run
- Given: Row `other-rejection`. A Pro-entitled member connected over WhatsApp has a running task, and AgentPhone rejects sends with 422 "(#131042) Payment method required".
- When: The Run's Okou token posts a long completed-report text with `taskCompleted: true` to `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 400 with `delivery: "failed"` and no accepted messages, and AgentPhone receives exactly one request.

## whatsapp-026

- Vitest: "WhatsApp through the shared AgentPhone number > handles task-completion sends without duplicating uncertain or accepted messages (lost)"
- Mode: run
- Given: Row `lost`. A Pro-entitled member connected over WhatsApp has a running task, and AgentPhone sends fail with a network error.
- When: The Run's Okou token posts a long completed-report text with `taskCompleted: true` to `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 502 with `delivery: "unknown"` and no accepted messages, and AgentPhone receives exactly one request.

## whatsapp-027

- Vitest: "WhatsApp through the shared AgentPhone number > handles task-completion sends without duplicating uncertain or accepted messages (unconfirmed)"
- Mode: run
- Given: Row `unconfirmed`. A Pro-entitled member connected over WhatsApp has a running task, and AgentPhone answers with HTTP 409 `DELIVERY_UNCONFIRMED`.
- When: The Run's Okou token posts a long completed-report text with `taskCompleted: true` to `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 502 with `delivery: "unknown"` and no accepted messages, and AgentPhone receives exactly one request.

## whatsapp-028

- Vitest: "WhatsApp through the shared AgentPhone number > handles task-completion sends without duplicating uncertain or accepted messages (template-lost)"
- Mode: run
- Given: Row `template-lost`. A Pro-entitled member connected over WhatsApp has a running task; AgentPhone rejects free-form sends with 422 "(#131047) Re-engagement message" and the template send fails with a network error.
- When: The Run's Okou token posts a long completed-report text with `taskCompleted: true` to `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 502 with `delivery: "unknown"` and no accepted messages, and AgentPhone receives exactly two requests.

## whatsapp-029

- Vitest: "WhatsApp through the shared AgentPhone number > handles task-completion sends without duplicating uncertain or accepted messages (template-rejected)"
- Mode: run
- Given: Row `template-rejected`. A Pro-entitled member connected over WhatsApp has a running task; AgentPhone rejects free-form sends with 422 "(#131047) Re-engagement message" and rejects the template with 422 "(#131042) Payment method required".
- When: The Run's Okou token posts a long completed-report text with `taskCompleted: true` to `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 400 with `delivery: "failed"` and no accepted messages, and AgentPhone receives exactly two requests.

## whatsapp-030

- Vitest: "WhatsApp through the shared AgentPhone number > handles task-completion sends without duplicating uncertain or accepted messages (partial-closed)"
- Mode: run
- Given: Row `partial-closed`. A Pro-entitled member connected over WhatsApp has a running task; AgentPhone accepts the first part and rejects the next with 422 "(#131047) Re-engagement message".
- When: The Run's Okou token posts a long completed-report text with `taskCompleted: true` to `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 400 with `delivery: "failed"` and `acceptedMessages: [{id: "accepted-part"}]`, and AgentPhone receives exactly two requests.

## whatsapp-031

- Vitest: "WhatsApp through the shared AgentPhone number > offers billing recovery when a running WhatsApp task runs out of credits"
- Mode: run
- Given: A Pro-entitled member connected over WhatsApp has a running task in the workspace "WhatsApp workspace".
- When: The Run completes via `POST /api/webhooks/run/complete` with exit code 1 and failure reason `insufficient_credits`.
- Then: The last WhatsApp message sent to the phone contains `/?settings=billing`.

## whatsapp-032

- Vitest: "WhatsApp through the shared AgentPhone number > does not describe a failed run as a completed task when the window is closed"
- Mode: run
- Given: A Pro-entitled member connected over WhatsApp has a running task, and AgentPhone rejects every send with 422 "(#131047) Re-engagement message".
- When: The Run completes via `POST /api/webhooks/run/complete` with exit code 1 and error "Could not prepare the meeting plan".
- Then: AgentPhone receives exactly one WhatsApp send to the phone, and it has no `template` field.

## whatsapp-033

- Vitest: "WhatsApp through the shared AgentPhone number > rejects expired and replaced codes while leaving the new code usable"
- Mode: run
- Given: A signed-in member creates two WhatsApp link codes in succession via `POST /api/integrations/whatsapp/link-code`.
- When: A phone sends the first (replaced) code over WhatsApp via `POST /api/agentphone/webhook` and the member reads `GET /api/integrations/whatsapp/link`; the clock advances 10 minutes and 1 ms, the phone sends the second code and the member reads the link again; then the member creates a fresh code, the same phone sends it and the member reads the link.
- Then: Each signed webhook delivery returns HTTP 200. After the replaced code and after the expired code the link status reports `linked` false. After the fresh code it reports `linked: true` with that phone as `phoneHandle`.

## whatsapp-034

- Vitest: "WhatsApp through the shared AgentPhone number > keeps the integration disabled until enabled and the shared number is provisioned for WhatsApp"
- Mode: run
- Given: The WhatsApp integration switch is off for a signed-in member.
- When: The member reads `GET /api/integrations/whatsapp/link`; then the switch is turned on and the member reads the link and creates a link code with the AgentPhone webhook secret missing, and again with the secret present but the shared number not WhatsApp-enabled.
- Then: With the switch off the read returns HTTP 404. Without the webhook secret, the link status reports `configured` false and link-code creation returns HTTP 503. With the number not WhatsApp-enabled, `configured` is again false and link-code creation returns HTTP 503.

## whatsapp-035

- Vitest: "WhatsApp through the shared AgentPhone number > connects and sends to any country when the prefix allowlist is undefined"
- Mode: run
- Given: Row allowlist unset. `WHATSAPP_ALLOWED_COUNTRY_PREFIXES` is unset, and a member connects WhatsApp from a +1 phone number.
- When: The member sends "Your report is ready" via `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 200 and AgentPhone receives exactly one WhatsApp send to that phone with body "Your report is ready".

## whatsapp-036

- Vitest: "WhatsApp through the shared AgentPhone number > connects and sends to any country when the prefix allowlist is "
- Mode: run
- Given: Row allowlist the empty string. `WHATSAPP_ALLOWED_COUNTRY_PREFIXES` is the empty string, and a member connects WhatsApp from a +1 phone number.
- When: The member sends "Your report is ready" via `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 200 and AgentPhone receives exactly one WhatsApp send to that phone with body "Your report is ready".

## whatsapp-037

- Vitest: "WhatsApp through the shared AgentPhone number > connects and sends to any country when the prefix allowlist is \u0020\u0020\u0020"
- Mode: run
- Given: Row allowlist three spaces. `WHATSAPP_ALLOWED_COUNTRY_PREFIXES` is three spaces, and a member connects WhatsApp from a +1 phone number.
- When: The member sends "Your report is ready" via `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 200 and AgentPhone receives exactly one WhatsApp send to that phone with body "Your report is ready".

## whatsapp-038

- Vitest: "WhatsApp through the shared AgentPhone number > applies the configured country prefixes to outbound sends"
- Mode: run
- Given: A member is connected to WhatsApp from a +1 phone number, and afterwards `WHATSAPP_ALLOWED_COUNTRY_PREFIXES` is set to `+49`.
- When: The member sends "Your report is ready" via `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 404 and nothing is sent to AgentPhone.

## whatsapp-039

- Vitest: "WhatsApp through the shared AgentPhone number > returns the same country restriction reply for a WhatsApp connection code without connecting"
- Mode: run
- Given: Row `connection code`. The app URL is `https://app.okou.test`, `WHATSAPP_ALLOWED_COUNTRY_PREFIXES` is " +49, +55, +90 ", and a signed-in member has created a WhatsApp link code.
- When: A +1 phone sends the member's link code over WhatsApp via `POST /api/agentphone/webhook`, the same message ID is redelivered, and then a +49 phone sends the member's link code.
- Then: The +1 phone is not linked, and exactly one WhatsApp reply goes to it: "Okou isn't available on WhatsApp for your phone number's country or region. Please use Okou on the web: https://app.okou.test"; the redelivery sends nothing more. The +49 phone's code links the member to that phone.

## whatsapp-040

- Vitest: "WhatsApp through the shared AgentPhone number > returns the same country restriction reply for a WhatsApp ordinary message without connecting"
- Mode: run
- Given: Row `ordinary message`. The app URL is `https://app.okou.test`, `WHATSAPP_ALLOWED_COUNTRY_PREFIXES` is " +49, +55, +90 ", and a signed-in member has created a WhatsApp link code.
- When: A +1 phone sends "Hello Okou" over WhatsApp via `POST /api/agentphone/webhook`, the same message ID is redelivered, and then a +49 phone sends the member's link code.
- Then: The +1 phone is not linked, and exactly one WhatsApp reply goes to it: "Okou isn't available on WhatsApp for your phone number's country or region. Please use Okou on the web: https://app.okou.test"; the redelivery sends nothing more. The +49 phone's code links the member to that phone.

## whatsapp-041

- Vitest: "WhatsApp through the shared AgentPhone number > returns the same country restriction reply for a WhatsApp command without connecting"
- Mode: run
- Given: Row `command`. The app URL is `https://app.okou.test`, `WHATSAPP_ALLOWED_COUNTRY_PREFIXES` is " +49, +55, +90 ", and a signed-in member has created a WhatsApp link code.
- When: A +1 phone sends `/help` over WhatsApp via `POST /api/agentphone/webhook`, the same message ID is redelivered, and then a +49 phone sends the member's link code.
- Then: The +1 phone is not linked, and exactly one WhatsApp reply goes to it: "Okou isn't available on WhatsApp for your phone number's country or region. Please use Okou on the web: https://app.okou.test"; the redelivery sends nothing more. The +49 phone's code links the member to that phone.

## whatsapp-042

- Vitest: "WhatsApp through the shared AgentPhone number > returns the same country restriction reply for a WhatsApp attachment without connecting"
- Mode: run
- Given: Row `attachment`. The app URL is `https://app.okou.test`, `WHATSAPP_ALLOWED_COUNTRY_PREFIXES` is " +49, +55, +90 ", and a signed-in member has created a WhatsApp link code.
- When: A +1 phone sends an empty body with a photo media URL over WhatsApp via `POST /api/agentphone/webhook`, the same message ID is redelivered, and then a +49 phone sends the member's link code.
- Then: The +1 phone is not linked, and exactly one WhatsApp reply goes to it: "Okou isn't available on WhatsApp for your phone number's country or region. Please use Okou on the web: https://app.okou.test"; the redelivery sends nothing more. The +49 phone's code links the member to that phone.

## whatsapp-043

- Vitest: "WhatsApp through the shared AgentPhone number > does not connect or retry the country restriction reply when delivery is rejected"
- Mode: run
- Given: Row `rejected`. `WHATSAPP_ALLOWED_COUNTRY_PREFIXES` is `+49`, a signed-in member has a WhatsApp link code, and AgentPhone rejects sends with HTTP 422.
- When: The +86 phone `+8613800138000` sends the link code over WhatsApp via `POST /api/agentphone/webhook`, and the same message ID is redelivered.
- Then: AgentPhone receives exactly one WhatsApp send attempt to that phone, and the member stays unlinked.

## whatsapp-044

- Vitest: "WhatsApp through the shared AgentPhone number > does not connect or retry the country restriction reply when delivery is unknown"
- Mode: run
- Given: Row `unknown`. `WHATSAPP_ALLOWED_COUNTRY_PREFIXES` is `+49`, a signed-in member has a WhatsApp link code, and AgentPhone sends fail with a network error.
- When: The +86 phone `+8613800138000` sends the link code over WhatsApp via `POST /api/agentphone/webhook`, and the same message ID is redelivered.
- Then: AgentPhone receives exactly one WhatsApp send attempt to that phone, and the member stays unlinked.

## whatsapp-045

- Vitest: "WhatsApp through the shared AgentPhone number > does not bind or reply to WhatsApp group messages"
- Mode: run
- Given: `WHATSAPP_ALLOWED_COUNTRY_PREFIXES` is " +49, +55, +90 " and a signed-in member has a WhatsApp link code.
- When: The code arrives as WhatsApp group messages from a +1 sender and from a +49 sender via `POST /api/agentphone/webhook`, then as a direct message from a +49 sender.
- Then: After the group messages the member is unlinked and nothing is sent to AgentPhone. The direct message links the member.

## whatsapp-046

- Vitest: "WhatsApp through the shared AgentPhone number > preserves accepted part receipts when the next send has an uncertain outcome (lost)"
- Mode: run
- Given: Row `lost`. A member is connected to WhatsApp; AgentPhone accepts the first message part as "accepted-part" and the next send fails with a network error.
- When: The member sends 4,100 "x" characters via `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 502 with `acceptedMessages: [{id: "accepted-part"}]`, `delivery: "unknown"`, and an error message mentioning "accepted-part". AgentPhone receives exactly two sends.

## whatsapp-047

- Vitest: "WhatsApp through the shared AgentPhone number > preserves accepted part receipts when the next send has an uncertain outcome (server-error)"
- Mode: run
- Given: Row `server-error`. A member is connected to WhatsApp; AgentPhone accepts the first message part as "accepted-part" and answers the next send with HTTP 500.
- When: The member sends 4,100 "x" characters via `POST /api/integrations/whatsapp/message`.
- Then: The response is HTTP 502 with `acceptedMessages: [{id: "accepted-part"}]`, `delivery: "unknown"`, and an error message mentioning "accepted-part". AgentPhone receives exactly two sends.

## whatsapp-048

- Vitest: "WhatsApp through the shared AgentPhone number > returns the provider's service-window failure without retrying or changing transports"
- Mode: run
- Given: A member is connected to WhatsApp, and AgentPhone rejects sends with HTTP 422 `CUSTOMER_SERVICE_WINDOW_CLOSED`.
- When: The member sends "Follow-up" via `POST /api/integrations/whatsapp/message`, then, outside any Run, sends "Done" with `taskCompleted: true`.
- Then: The first send returns HTTP 400 with an error message mentioning the "24-hour service window" after exactly one WhatsApp attempt. The task-completed send returns HTTP 400 with an error mentioning "current run" and makes no further provider request.
