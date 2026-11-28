# integrations-email

## integrations-email-001

- Vitest: "email model recovery > links a model failure to the original Web conversation"
- Mode: run
- Given: A Pro-entitled workspace admin's verified login email sent "Requested report" to the Okou inbox, which created an Email conversation and a run claimed by a Runner. The Web URL is `https://app.okou.ai`.
- When: The run's sandbox reports completion through the agent-complete webhook with exit code 1, error "Claude verification required" and failure reason `account_verification_required`; the admin then switches to a recovery model subscription and the Runner claims its next execution.
- Then: The completion returns HTTP 200. The last outgoing email contains "Switch this conversation's model in Okou: https://app.okou.ai/chats/<thread id>" for the original conversation, whose events include `run.failed` for the run. After the subscription switch a new run (different ID) is delivered with prompt "continue" and a system prompt containing "Requested report".

## integrations-email-002

- Vitest: "email-native signup > creates the account and workspace only after consent, then resumes the original request once"
- Mode: run
- Given: An unknown sender (no Okou account, not blocklisted) emailed "Please compare these options after signup" to the Okou inbox and received a signup invitation containing a standalone `CONFIRM` line, the terms-of-use link and a unique `okou+confirm-<32 hex>@okou.io` reply address; no account exists yet.
- When: The sender replies to the issued address with a body starting with "cOnFiRm" plus a quoted "> CONFIRM" (first while the new workspace is still initializing, then after the organization-created webhook), sends the same reply again, and sends a plain `CONFIRM` reply; a Runner then claims the run and the run completes with result "Your first email request is complete".
- Then: The first delivery fails with "Email workspace initialization is pending". After initialization the identity provider creates exactly one user with the sender's address, a legal-acceptance time and signup metadata containing the confirmation message ID and terms URL, and exactly one organization. Onboarding is complete, proactive suggestions report `enabled: true` with `unavailableReason` "missing-timezone", exactly one conversation with one prompt exists, and the executed prompt contains the original request but not the CONFIRM line. `GET /api/integrations/email/link` lists the sender's email. The final reply email goes to the sender with reply-to `okou@okou.io` and text "Your first email request is complete".

## integrations-email-003

- Vitest: "email-native signup > refuses a Clerk-blocked sender matching domain before confirming or creating an account"
- Mode: run
- Given: An unknown sender's domain is on the identity provider's blocklist as `*@<domain>`.
- When: The sender emails the Okou inbox (signed Resend webhook to `POST /api/email/inbound`).
- Then: Exactly one reply is sent to the sender saying it "did not pass our security checks", without any CONFIRM text. No user and no organization is created.

## integrations-email-004

- Vitest: "email-native signup > refuses a Clerk-blocked sender matching uppercase-address before confirming or creating an account"
- Mode: run
- Given: An unknown sender's address is on the identity provider's blocklist in uppercase.
- When: The sender emails the Okou inbox (signed Resend webhook to `POST /api/email/inbound`).
- Then: Exactly one reply is sent to the sender saying it "did not pass our security checks", without any CONFIRM text. No user and no organization is created.

## integrations-email-005

- Vitest: "email-native signup > refuses email-native signup for a disposable address"
- Mode: run
- Given: A verified user with a disposable `@mailinator.com` address belongs to two workspaces, and that address is not yet bound to email.
- When: The sender emails the Okou inbox.
- Then: Exactly one reply is sent to the sender saying it "did not pass our security checks". No user is created, no conversation is created, and `GET /api/integrations/email/link` still reports the sender's email.

## integrations-email-006

- Vitest: "email-native signup > does not register when the reply only contains or quotes CONFIRM: > CONFIRM"
- Mode: run
- Given: An unknown sender has a pending signup invitation with a unique confirmation reply address.
- When: The sender replies to that address with only the quoted text "> CONFIRM".
- Then: No user is created and only the single original invitation containing a CONFIRM line has been sent.

## integrations-email-007

- Vitest: "email-native signup > does not register when the reply only contains or quotes CONFIRM: Please CONFIRM this account"
- Mode: run
- Given: An unknown sender has a pending signup invitation with a unique confirmation reply address.
- When: The sender replies to that address with "Please CONFIRM this account".
- Then: No user is created and only the single original invitation containing a CONFIRM line has been sent.

## integrations-email-008

- Vitest: "email-native signup > rejects another mailbox's confirmation reply address without creating or running anything"
- Mode: run
- Given: An unknown sender has a pending signup invitation, and a different existing verified user knows its confirmation reply address.
- When: The other user sends `CONFIRM` to that confirmation address.
- Then: The last reply says the confirmation is "invalid or expired", no user is created, and the other user has no new conversation.

## integrations-email-009

- Vitest: "email-native signup > rejects expired consent and does not create an account"
- Mode: run
- Given: An unknown sender has a pending signup invitation.
- When: The clock advances 25 hours and the sender then replies `CONFIRM` to the issued confirmation address.
- Then: The last reply says the confirmation is "invalid or expired" and no user is created.

## integrations-email-010

- Vitest: "email-native signup > rejects an unissued confirmation reply address without creating an account"
- Mode: run
- Given: An unknown sender has a pending signup invitation.
- When: The sender replies `CONFIRM` to a well-formed but never-issued `okou+confirm-<hex>@okou.io` address.
- Then: The last reply says the confirmation is "invalid or expired" and no user is created.

## integrations-email-011

- Vitest: "email-native signup > requires the issued reply address even when CONFIRM references the original request"
- Mode: run
- Given: An unknown sender has a pending signup invitation.
- When: The sender sends `CONFIRM` to the normal Okou inbox with `In-Reply-To` referencing the original request instead of the issued confirmation address.
- Then: No user is created, and the sent emails are exactly two signup invitations containing a CONFIRM line.

## integrations-email-012

- Vitest: "email-native signup > does not accuse a sender when the Clerk precheck is unavailable, and recovers on redelivery"
- Mode: run
- Given: An unknown sender emails the Okou inbox, and the identity provider's blocklist check fails once with an HTTP 403 authorization error.
- When: The inbound email webhook is delivered, fails, and is redelivered.
- Then: The first delivery surfaces the provider error, no email is sent and no user is created. On redelivery exactly one signup invitation containing a CONFIRM line is sent.

## integrations-email-013

- Vitest: "email-native signup > bounds unconfirmed signup messages from one sender"
- Mode: run
- Given: An unknown, non-blocklisted sender has no account.
- When: The sender emails the Okou inbox four times with different requests.
- Then: Exactly three signup invitations containing a CONFIRM line are sent and no user is created.

## integrations-email-014

- Vitest: "email-native signup > preserves Clerk's authoritative rejection after a successful precheck"
- Mode: run
- Given: An unknown sender has a pending signup invitation, but the identity provider rejects user creation with HTTP 403 `not_allowed_access`.
- When: The sender replies `CONFIRM` to the issued confirmation address.
- Then: The last reply says the request "did not pass our security checks" and no organization is created.

## integrations-email-015

- Vitest: "Email integration > starts with the received email when gmail is unavailable and enriches active input"
- Mode: run
- Given: A Pro-entitled workspace admin has connected two Gmail mailboxes: their login address and a private mailbox whose chat access policy is set to deny; Gmail context reads are allowed. Gmail message search responds with HTTP 503, and the title model titles content containing "Original message content" as "Review customer discussion".
- When: The admin emails "Fwd: Customer discussion" with forwarded "Original message content" and an `In-Reply-To` parent; the Runner claims the run; a follow-up reply arrives while the run is active with Gmail now returning the exact message and one earlier thread message; then, after the input is steered and Gmail reads are denied, another follow-up arrives.
- Then: The conversation is renamed "Review customer discussion" from exactly one title request containing the original content and the subject. The run prompt contains the received content with no mailbox request; the system prompt contains the subject, the RFC Message-ID, exact-match lookup guidance, `GMAIL_TOKEN`, the `In-Reply-To` and `References` headers, and exactly one "Connected mailbox for this Run" entry for the login mailbox; the environment holds `GMAIL_TOKEN` and the firewall allows Gmail for that mailbox. The active follow-up input contains its text, provider body, `LOOKUP_STATUS: found`, provider message and conversation IDs, and one history item at relative index -1 from "Reviewer <reviewer@example.com>" with its date, in Integration Note, Email Message, Email Thread, Chat Thread order. After the read denial the next input reports `LOOKUP_STATUS: permission-required` and Gmail is not called.

## integrations-email-016

- Vitest: "Email integration > starts with the received email when outlook-mail is unavailable and enriches active input"
- Mode: run
- Given: A Pro-entitled workspace admin has connected two Outlook mailboxes: their login address and a private mailbox whose chat access policy is set to deny. Outlook message search responds with HTTP 503, and the title model titles content containing "Original message content" as "Review customer discussion".
- When: The admin emails "Fwd: Customer discussion" with forwarded "Original message content" and an `In-Reply-To` parent; the Runner claims the run; then a follow-up reply arrives while the run is active with Outlook now returning the exact message and one earlier thread message.
- Then: The conversation is renamed "Review customer discussion" from exactly one title request containing the original content and the subject. The run prompt contains the received content with no mailbox request; the system prompt contains the subject, the RFC Message-ID, exact-match guidance, `OUTLOOK_MAIL_TOKEN`, the `X-Okou-Connector-Intent: outlook-mail` and `Prefer: IdType="ImmutableId"` guidance, `In-Reply-To` and `References`, and exactly one "Connected mailbox for this Run" entry for the login mailbox; the environment holds `OUTLOOK_MAIL_TOKEN` and the firewall allows Outlook for that mailbox. The active follow-up input contains its text, provider body, `LOOKUP_STATUS: found`, provider message and conversation IDs, and one history item at relative index -1 from "Reviewer <reviewer@example.com>" with its date, in Integration Note, Email Message, Email Thread, Chat Thread order.

## integrations-email-017

- Vitest: "Email integration > adds chronological gmail history to active input without repeating quoted bodies, current messages or unrelated mail"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Gmail mailbox with context reads allowed and an active Email run. The Gmail thread contains an older and a newer message, a duplicate of the newer one, a message whose body is already quoted in the reply, a second copy of the current message, a later reply, a message from another conversation and a draft.
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: The thread context has exactly three items: index -3 from "Application team <applications@example.com>" with the older body and `BODY_ALREADY_INCLUDED: false`, index -2 with `BODY_ALREADY_INCLUDED: true`, and index -1 from "Marketplace reviewer <reviewer@example.com>" with the newer body and `BODY_ALREADY_INCLUDED: false`, each with its provider message ID. The prompt reports `HISTORY_MESSAGE_COUNT: 3` and `HISTORY_TRUNCATED: false`, the history omits the quoted text, and the prompt contains no second copy, later reply, other-conversation mail or draft.

## integrations-email-018

- Vitest: "Email integration > adds chronological outlook-mail history to active input without repeating quoted bodies, current messages or unrelated mail"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Outlook mailbox and has an active Email run. The Outlook conversation contains an older and a newer message, a duplicate of the newer one, a message whose body is already quoted in the reply, a second copy of the current message, a later reply, a message from another conversation and a draft.
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: The thread context has exactly three items: index -3 from "Application team <applications@example.com>" with the older body and `BODY_ALREADY_INCLUDED: false`, index -2 with `BODY_ALREADY_INCLUDED: true`, and index -1 from "Marketplace reviewer <reviewer@example.com>" with the newer body and `BODY_ALREADY_INCLUDED: false`, each with its provider message ID. The prompt reports `HISTORY_MESSAGE_COUNT: 3` and `HISTORY_TRUNCATED: false`, the history omits the quoted text, and the prompt contains no second copy, later reply, other-conversation mail or draft.

## integrations-email-019

- Vitest: "Email integration > bounds gmail history and explicitly reports omitted messages and body truncation"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Gmail mailbox with context reads allowed and an active Email run. The Gmail thread has 25 earlier messages, each with a body of about 9000 characters.
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: The prompt reports `HISTORY_STATUS: found`, `HISTORY_TRUNCATED: true` and `HISTORY_MESSAGE_COUNT: 20`. Exactly 20 items are loaded, from index -20 (the sixth message) to -1, the last marked `BODY_TRUNCATED: true` with an 8000-character body, and all bodies total at most 40,000 characters.

## integrations-email-020

- Vitest: "Email integration > bounds outlook-mail history and explicitly reports omitted messages and body truncation"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Outlook mailbox and has an active Email run. The Outlook conversation has 25 earlier messages, each with a body of about 9000 characters.
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: The prompt reports `HISTORY_STATUS: found`, `HISTORY_TRUNCATED: true` and `HISTORY_MESSAGE_COUNT: 20`. Exactly 20 items are loaded, from index -20 (the sixth message) to -1, the last marked `BODY_TRUNCATED: true` with an 8000-character body, and all bodies total at most 40,000 characters.

## integrations-email-021

- Vitest: "Email integration > retains the exact message and reports denied thread history without reading it"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Gmail mailbox with message reads allowed but `threads.read` denied, and has an active Email run. Gmail returns the exact reply message "Exact message retained".
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: The input contains "Exact message retained" and `HISTORY_STATUS: permission-required`, and the Gmail thread history is never requested.

## integrations-email-022

- Vitest: "Email integration > retains the exact message when the history response has status 404 or invalid data"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Gmail mailbox with context reads allowed and an active Email run. Gmail returns the exact reply message, but the thread-history request responds with HTTP 404.
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: The input contains "Current message survives history failure" and `HISTORY_STATUS: not-found`.

## integrations-email-023

- Vitest: "Email integration > retains the exact message when the history response has status 503 or invalid data"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Gmail mailbox with context reads allowed and an active Email run. Gmail returns the exact reply message, but the thread-history request responds with HTTP 503.
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: The input contains "Current message survives history failure" and `HISTORY_STATUS: provider-unavailable`.

## integrations-email-024

- Vitest: "Email integration > retains the exact message when the history response has status 200 or invalid data"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Gmail mailbox with context reads allowed and an active Email run. Gmail returns the exact reply message, but the thread-history request returns HTTP 200 with an invalid error-shaped body.
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: The input contains "Current message survives history failure" and `HISTORY_STATUS: provider-unavailable`.

## integrations-email-025

- Vitest: "Email integration > marks active Outlook history incomplete when the provider has another page"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Outlook mailbox and has an active Email run. Outlook returns the exact reply message, and the conversation-history query returns no messages but an `@odata.nextLink`.
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: The input reports `HISTORY_STATUS: found`, `HISTORY_TRUNCATED: true` and `HISTORY_MESSAGE_COUNT: 0`.

## integrations-email-026

- Vitest: "Email integration > retains the exact message when thread history exceeds the lookup deadline"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Gmail mailbox with context reads allowed and an active Email run. Gmail returns the exact reply message, but the thread-history request hangs until it is cancelled.
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: The input contains "Current message survives a slow history provider" and `HISTORY_STATUS: lookup-timed-out`.

## integrations-email-027

- Vitest: "Email integration > retains the received email when gmail has no exact RFC Message-ID match"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Gmail mailbox and has an active Email run. Gmail's RFC Message-ID search returns no match for the reply.
- When: The admin's reply "Only the received forward is available" arrives while the run is active and the active input is read.
- Then: The input contains "Only the received forward is available" and `LOOKUP_STATUS: not-found`.

## integrations-email-028

- Vitest: "Email integration > retains the received email when outlook-mail has no exact RFC Message-ID match"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Outlook mailbox and has an active Email run. Outlook's Message-ID search returns no match for the reply.
- When: The admin's reply "Only the received forward is available" arrives while the run is active and the active input is read.
- Then: The input contains "Only the received forward is available" and `LOOKUP_STATUS: not-found`.

## integrations-email-029

- Vitest: "Email integration > refreshes rejected Gmail credentials before fetching and appending the exact message"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Gmail mailbox with context reads allowed and an active Email run. Gmail rejects the stored access token with HTTP 401 and accepts only a token obtained through a `refresh_token` grant.
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: Google receives a `refresh_token` grant, and the input contains the exact message body "Body read after OAuth refresh".

## integrations-email-030

- Vitest: "Email integration > retains the received email when the mailbox provider is unavailable"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Outlook mailbox and has an active Email run; Outlook message lookups respond with HTTP 503.
- When: The admin's reply "Continue from this received message" arrives while the run is active and the active input is read.
- Then: The input contains "Continue from this received message" and `LOOKUP_STATUS: provider-unavailable`.

## integrations-email-031

- Vitest: "Email integration > retains the received email when the mailbox response stream terminates"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Outlook mailbox and has an active Email run; Outlook message lookups start a JSON response and then the stream terminates with an error.
- When: The admin's reply "Continue despite the interrupted mailbox response" arrives while the run is active and the active input is read.
- Then: The input contains "Continue despite the interrupted mailbox response" and `LOOKUP_STATUS: provider-unavailable`.

## integrations-email-032

- Vitest: "Email integration > does not append a provider message with a different RFC Message-ID"
- Mode: run
- Given: A Pro-entitled workspace admin has connected their login Gmail mailbox with context reads allowed and an active Email run. Gmail's search returns a message whose details carry a different Message-ID (`<another@example.test>`) and body "Unrelated private body".
- When: The admin's reply arrives while the run is active and the active input is read.
- Then: The input reports `LOOKUP_STATUS: not-found` and does not contain "Unrelated private body".

## integrations-email-033

- Vitest: "Email integration > provides Email system context and privately delivers an attachment once in the original conversation"
- Mode: run
- Given: A Pro-entitled workspace admin emailed "Requested report" from their login address, and a Runner claimed the resulting run with its run token. Storage reports the run's private artifact file as 20 MiB.
- When: The test inspects the run, reads the conversation's rows with the run token, prepares and completes a private artifact upload, calls `POST /api/integrations/email/upload-file/complete` once with a browser session, eight times concurrently with the run token and text "Your requested report", once more as a replay, and once with a different text.
- Then: The run has `OKOU_CURRENT_INTEGRATION` "email", a chat thread ID, and a system prompt naming Email, the verified sender, the Message ID, the subject, `okou email upload-file`, "# This Chat Thread" and the `okou chat messages --thread-id <id>` command; the rows include an `input.prompt` with `contextType` "email". The session call returns HTTP 403. All run-token calls return HTTP 200 with the same operation ID, and the replay returns the upload ID, the sender's email, `report.txt`, 20 MiB size, the file URL and delivery `accepted`. Exactly one email with an attachment is sent to the sender, with the caption, `In-Reply-To` the original message, `Message-ID` `<operationId@okou.io>` and a signed `report.txt` text attachment. The different-caption call returns HTTP 409, and the file has no public URL.

## integrations-email-034

- Vitest: "Email integration > resumes the same file across successive Runs in its original Email conversation"
- Mode: run
- Given: A Pro-entitled workspace admin's Email run has already delivered a private file through `POST /api/integrations/email/upload-file/complete`, and the run completed with result "File ready".
- When: The admin replies to the delivery's Message-ID with "Please inspect that file delivery", a Runner claims the new run, and the new run token completes the same upload again.
- Then: The new run has a different ID, `OKOU_CURRENT_INTEGRATION` "email", the same chat thread ID as the first delivery, a system prompt with the `okou chat messages` command for that thread and the follow-up Message-ID. The resumed delivery returns HTTP 200 with the same operation ID and chat thread ID and status `accepted`, and only one email with an attachment has been sent in total.

## integrations-email-035

- Vitest: "Email integration > does not deliver a private file owned by another account"
- Mode: run
- Given: A Pro-entitled workspace admin's Email run has a run token, and a user from another workspace has uploaded a private file.
- When: The run calls `POST /api/integrations/email/upload-file/complete` with the outsider's upload ID.
- Then: The response is HTTP 404 and no email is sent.

## integrations-email-036

- Vitest: "Email integration > replays the identical attachment and provider idempotency key after a transient rejection"
- Mode: run
- Given: A Pro-entitled workspace admin's Email run has a private file ready. Resend rejects the first send with `rate_limit_exceeded` and accepts later sends with ID `resend-file-accepted`.
- When: The run calls `POST /api/integrations/email/upload-file/complete`, the clock advances 60 seconds, and it calls the same endpoint twice more.
- Then: Every call returns the same operation ID, and the final response's delivery is exactly `{ status: "accepted", providerId: "resend-file-accepted" }`. Resend receives exactly two send attempts with identical payloads (including the idempotency key), and the second attempt carries the signed `report.txt` attachment.

## integrations-email-037

- Vitest: "Email integration > checks the stored object's actual size before attaching it"
- Mode: run
- Given: A Pro-entitled workspace admin's Email run has a private file whose stored object is one byte larger than the maximum Email attachment size.
- When: The run calls `POST /api/integrations/email/upload-file/complete` for that file.
- Then: The response is HTTP 400 and no email is sent.

## integrations-email-038

- Vitest: "Email integration > rejects Email attachment delivery after its mailbox disconnects"
- Mode: run
- Given: A Pro-entitled workspace admin bound an additional email address by connection code, and a run started from that address has a private file ready.
- When: The admin unlinks the address with `DELETE /api/integrations/email/link`, then the run calls `POST /api/integrations/email/upload-file/complete`.
- Then: The unlink returns HTTP 204, the upload completion returns HTTP 403, and no attachment is emailed.

## integrations-email-039

- Vitest: "Email integration > does not infer an email recipient for a Web-originated run"
- Mode: run
- Given: A Pro-entitled workspace admin launched a run from the Web chat with prompt "A web request".
- When: The run's token calls `POST /api/integrations/email/upload-file/complete` with an upload ID.
- Then: The response is HTTP 403 and no email is sent.

## integrations-email-040

- Vitest: "Email integration > imports an email attachment privately from https://resend-attachments.s3.amazonaws.com without forwarding the Resend credential"
- Mode: run
- Given: A Pro-entitled workspace admin emails the Okou inbox with attachment `comparison.txt`. Resend's attachment API (called with the Resend API key) returns a download URL on `https://resend-attachments.s3.amazonaws.com`, which serves "A private comparison" as `text/plain`.
- When: The inbound email webhook is delivered, the admin reads the new conversation's events and resolves the attachment's file URL, and a user from another workspace requests the same file URL.
- Then: The download request carries no authorization header, and storage receives the body "A private comparison" with content type `text/plain`. The conversation's `input.prompt` has a file part with filename `comparison.txt` and content type `text/plain`. The resolved file has no public URL and a URL different from the Resend download URL. The outsider's file URL request returns HTTP 404.

## integrations-email-041

- Vitest: "Email integration > imports an email attachment privately from https://cdn.resend.app without forwarding the Resend credential"
- Mode: run
- Given: A Pro-entitled workspace admin emails the Okou inbox with attachment `comparison.txt`. Resend's attachment API (called with the Resend API key) returns a download URL on `https://cdn.resend.app`, which serves "A private comparison" as `text/plain`.
- When: The inbound email webhook is delivered, the admin reads the new conversation's events and resolves the attachment's file URL, and a user from another workspace requests the same file URL.
- Then: The download request carries no authorization header, and storage receives the body "A private comparison" with content type `text/plain`. The conversation's `input.prompt` has a file part with filename `comparison.txt` and content type `text/plain`. The resolved file has no public URL and a URL different from the Resend download URL. The outsider's file URL request returns HTTP 404.

## integrations-email-042

- Vitest: "Email integration > rejects untrusted attachment download host untrusted.example while preserving the email text"
- Mode: run
- Given: A Pro-entitled workspace admin emails the Okou inbox with attachment `untrusted.txt`, and Resend's attachment API returns a download URL on host `untrusted.example`.
- When: The inbound email webhook is delivered and the admin reads the new conversation's events.
- Then: The `input.prompt` still contains a file part with filename `untrusted.txt` and a text part containing "Please compare these options". The untrusted host is never requested.

## integrations-email-043

- Vitest: "Email integration > rejects untrusted attachment download host cdn.resend.app.evil.example while preserving the email text"
- Mode: run
- Given: A Pro-entitled workspace admin emails the Okou inbox with attachment `untrusted.txt`, and Resend's attachment API returns a download URL on host `cdn.resend.app.evil.example`.
- When: The inbound email webhook is delivered and the admin reads the new conversation's events.
- Then: The `input.prompt` still contains a file part with filename `untrusted.txt` and a text part containing "Please compare these options". The untrusted host is never requested.

## integrations-email-044

- Vitest: "Email integration > keeps email chats readable through both installed-iOS event endpoints"
- Mode: run
- Given: A Pro-entitled workspace admin has an Email conversation created by an inbound email.
- When: The admin requests `GET /api/chat-threads/:threadId/event-rows` and `POST /api/chat/events/catch-up` with iOS client headers (version 99.0.0), then requests event rows without client headers.
- Then: Both iOS responses return HTTP 200 with an `input.prompt` row whose `contextType` is "web" and no row with `contextType` "email". The request without client headers includes a row with `contextType` "email".

## integrations-email-045

- Vitest: "Email integration > revokes pending reply delivery when its sender disconnects"
- Mode: run
- Given: A Pro-entitled workspace admin bound an additional address by emailing a connection code from it, and an email from that address started a run claimed by a Runner.
- When: The admin unlinks the address via `DELETE /api/integrations/email/link`, then the run reports the result "Reply after disconnect" and completes successfully.
- Then: The unlink returns HTTP 204 and no email with text "Reply after disconnect" is sent.

## integrations-email-046

- Vitest: "Email integration > does not join another sender's chat through copied reference headers"
- Mode: run
- Given: Two Pro-entitled admins in different workspaces each email the Okou inbox; the second admin's email copies the first email's Message-ID in `In-Reply-To`.
- When: Both inbound emails are delivered and the second admin requests the first admin's conversation events.
- Then: Each admin has exactly one conversation and the conversations differ. The second admin's request for the first conversation's events returns HTTP 404.

## integrations-email-047

- Vitest: "Email integration > automatically connects the login email, respects unlinking, and allows explicit reconnection"
- Mode: run
- Given: A Pro-entitled workspace admin with a verified login email is signed in.
- When: The admin reads `GET /api/integrations/email/link`, unlinks the login email with `DELETE /api/integrations/email/link`, emails the inbox, reconnects it with `POST /api/integrations/email/link`, emails again, and tries to connect `someone-else@example.com`.
- Then: The link list initially contains only the login email. The unlink returns HTTP 204 and the list becomes empty; the email then creates no conversation and the list stays empty. Reconnecting returns HTTP 200 and lists the login email again, and the next email creates one conversation. Connecting someone else's address returns HTTP 403.

## integrations-email-048

- Vitest: "Email integration > rejects a forged login sender without starting a task or replying"
- Mode: run
- Given: A Pro-entitled workspace admin's login address is spoofed in an email whose DMARC result is `fail`.
- When: The inbound email webhook is delivered.
- Then: No conversation is created and no email is sent.

## integrations-email-049

- Vitest: "Email integration > accepts aligned DKIM for a DMARC monitoring policy but rejects SPF-only gray authentication"
- Mode: run
- Given: A Pro-entitled workspace admin with a verified login email emails the Okou inbox twice: first with SPF pass but DKIM and DMARC "gray", then with DKIM pass but SPF and DMARC "gray".
- When: Both inbound email webhooks are delivered and the admin reads `GET /api/integrations/email/link`.
- Then: The SPF-only email creates no conversation; the DKIM-aligned email creates exactly one conversation. The link list is exactly the login email.

## integrations-email-050

- Vitest: "Email integration > auto-connects registered senders, separates independent emails, keeps replies in their original chat, and deduplicates webhook retries"
- Mode: run
- Given: A Pro-entitled workspace admin with a verified login email and a configured Runner.
- When: The admin emails "First independent request" (subject "Same subject"); the same webhook is delivered twice more and another delivery reuses the same Message-ID. The Runner claims the run, which reports "Here is the comparison" and completes. Resend then sends a signed `email.sent` webhook mapping the reply to the rewritten Message-ID `<provider-rewritten-message@amazonses.com>`; the admin replies to that rewritten ID and sends a second independent email with the same subject.
- Then: The link list is exactly the login email and only one conversation exists after the duplicates. The run prompt contains the request and the system prompt says it is running inside Email. The reply email goes to the admin with `In-Reply-To` the first Message-ID and a `Message-ID` header. Afterwards there are exactly two conversations, and the original conversation has exactly two non-revoked prompts.

## integrations-email-051

- Vitest: "Email integration > preserves workspace-selection links for existing accounts and resumes the original request only once"
- Mode: run
- Given: A verified user with an `@vm0.ai` address belongs to two workspaces and has no email binding. Their email "Please handle this after signup" receives a workspace-selection invitation containing a signed `https://app.okou.ai/settings/email?...` link.
- When: A different signed-in user calls `POST /api/integrations/email/connect` with the link's message, expiry and signature; the workspace is initialized; the sender calls the endpoint with a forged all-zero signature, then twice with the valid values; a Runner claims the run, which reports "Your original request is complete" and completes.
- Then: The invitation goes to the sender. The other user's call returns HTTP 403, the forged signature returns HTTP 400, and both valid calls return HTTP 200. Onboarding is complete, exactly one new conversation with one non-revoked prompt exists, and the link list is exactly the sender. The run prompt contains the original request, and exactly one reply "Your original request is complete" is sent to the sender.

## integrations-email-052

- Vitest: "Email workspace binding > reports the current run's code-verified sender, workspace and available workspaces"
- Mode: run
- Given: A Pro-entitled workspace admin bound an additional address by connection code; an email from that address started a run claimed by a Runner. The user belongs to "Email workspace" (current) and "Other workspace".
- When: The run calls `GET /api/integrations/email/session` with its run token.
- Then: The response is HTTP 200 with exactly the code-verified sender address, the current workspace, and both workspaces in order. The run's system prompt mentions `okou email status --json`, `okou email switch --workspace-id <id>` and `okou email logout`.

## integrations-email-053

- Vitest: "Email workspace binding > switches workspaces, confirms by email and starts a fresh conversation for old reply references"
- Mode: run
- Given: A Pro-entitled workspace admin's login-email run is active; the same user also belongs to a Pro-entitled "Target workspace".
- When: The run calls `POST /api/integrations/email/session/workspace` with the target workspace ID, then calls `DELETE /api/integrations/email/session`; the original email is redelivered and a reply referencing the original Message-ID arrives.
- Then: The switch returns HTTP 200 with exactly the email address and the target workspace, and a confirmation email containing `connected to workspace "Target workspace"` is sent. The original workspace's link list becomes empty and the logout returns HTTP 403. In the target workspace the link list contains the email; the redelivered original creates no conversation, while the reply creates one new conversation different from the original. The original workspace still has exactly one conversation.

## integrations-email-054

- Vitest: "Email workspace binding > preserves the binding when switching to a workspace outside the user's membership"
- Mode: run
- Given: A Pro-entitled workspace admin's login-email run is active.
- When: The run calls `POST /api/integrations/email/session/workspace` with a workspace ID the user does not belong to, then reads `GET /api/integrations/email/session`.
- Then: The switch returns HTTP 403, the binding still points to the original workspace, and no email is sent.

## integrations-email-055

- Vitest: "Email workspace binding > logs out the login sender until explicit reconnection and rejects the stale run afterward"
- Mode: run
- Given: A Pro-entitled workspace admin's login-email run is active in one Email conversation.
- When: The run calls `DELETE /api/integrations/email/session`; a new email arrives; the run reads `GET /api/integrations/email/session`; the admin reconnects via `POST /api/integrations/email/link`; the original email is redelivered; the stale run calls logout again; and another new email arrives.
- Then: The logout returns HTTP 200 with exactly the email address and sends an email saying it is "disconnected from Okou Email"; the link list becomes empty. The new email while logged out creates no conversation and the list stays empty; the session read returns HTTP 403. Reconnecting returns HTTP 200 and lists the email; the redelivered original creates no conversation. The stale run's logout returns HTTP 403, and the next new email creates a second conversation.

## integrations-email-056

- Vitest: "Email workspace binding > logs out only the current code-verified sender"
- Mode: run
- Given: A Pro-entitled workspace admin bound an additional address by connection code, and a run started from that address is active.
- When: The run calls `DELETE /api/integrations/email/session`.
- Then: The response is HTTP 200 and the link list contains only the login email.

## integrations-email-057

- Vitest: "Email workspace binding > keeps an OAuth mailbox logged out while its connector stays connected"
- Mode: run
- Given: A Pro-entitled workspace admin bound an additional address by connection code, connected the same address as a Gmail mailbox, and a run started from that address is active.
- When: The run calls `DELETE /api/integrations/email/session`, and then an email from that address arrives.
- Then: The logout returns HTTP 200. The link list contains only the login email, the new email creates no additional conversation (one in total), and the Gmail connector still lists the mailbox connection for that address.

## integrations-email-058

- Vitest: "Email workspace binding > does not use an account's binding for a Web run or a browser session"
- Mode: run
- Given: A Pro-entitled workspace admin has their login email linked and launched a Web chat run.
- When: The Web run's token calls `GET /api/integrations/email/session`, and the browser session calls `DELETE /api/integrations/email/session`.
- Then: Both requests return HTTP 403 and the link list still contains the login email.

## integrations-email-059

- Vitest: "Email multi-account connections > preserves an email's disconnection when it becomes the login email"
- Mode: run
- Given: A Pro-entitled workspace admin has their login email linked and binds a second address by emailing a connection code from it.
- When: The admin unlinks the second address via `DELETE /api/integrations/email/link`; the identity provider then reports that second address as the user's primary email; an email "Analyze my report" arrives from it; finally the admin unlinks the original login email.
- Then: The second-address unlink returns HTTP 204 and, after it becomes the primary email, the link list still contains only the original login email. The email from it creates no conversation and the list is unchanged. Unlinking the original login email returns HTTP 204 and the list becomes empty.

## integrations-email-060

- Vitest: "Email multi-account connections > allows reconnecting the login email to another workspace after unlinking"
- Mode: run
- Given: A user's verified login email is automatically linked in their first workspace; the same user and email also belong to a second workspace.
- When: In the second workspace the user calls `POST /api/integrations/email/link` for the login email; in the first workspace they unlink it via `DELETE /api/integrations/email/link`; in the second workspace they create a connection code with `POST /api/integrations/email/link-code` and email it from the login address.
- Then: The second workspace's list starts empty and the connect returns HTTP 409. The unlink in the first workspace returns HTTP 204 and the second workspace's list is still empty. After the emailed code, the second workspace lists the login email and the first workspace's list is empty.

## integrations-email-061

- Vitest: "Email multi-account connections > processes an ordinary message with a numeric subject as a task"
- Mode: run
- Given: A Pro-entitled workspace admin with a linked login email.
- When: The admin emails "Analyze this report" with the numeric subject "20261110".
- Then: Exactly one conversation is created.

## integrations-email-062

- Vitest: "Email multi-account connections > binds multiple non-login email addresses to one owner without starting tasks for connection codes"
- Mode: run
- Given: A Pro-entitled workspace admin with a linked login email creates 8-digit connection codes via `POST /api/integrations/email/link-code`.
- When: A first non-login address sends the code to an `okou+confirm-...` address, then sends the code as the subject with an empty body; a second address sends a fresh code followed by "Sent from my phone"; then each address sends an ordinary request.
- Then: The code sent to the confirmation address does not link anything (only the login email is listed). After the subject-code and body-code emails both addresses are listed and no conversation is created. The two ordinary requests create exactly two conversations.

## integrations-email-063

- Vitest: "Email multi-account connections > deduplicates verification webhook retries and cannot reuse a code for another sender"
- Mode: run
- Given: A signed-in workspace admin creates a connection code with `POST /api/integrations/email/link-code`.
- When: The code email from a new address is delivered twice, a different address sends the same code, the admin unlinks the first address via `DELETE /api/integrations/email/link`, and the original code email is delivered again.
- Then: The link list is exactly the login email and the first address, and exactly one "Email connected." confirmation is sent. The unlink returns HTTP 204, and the redelivered code email does not relink the address (only the login email remains).

## integrations-email-064

- Vitest: "Email multi-account connections > rejects another workspace with a reply and allows moving only after disconnect and a fresh proof"
- Mode: run
- Given: A first workspace user linked an external address by emailing a connection code. A second user in another workspace creates their own code.
- When: The address emails the second user's code; the first user unlinks the address and the first code email is redelivered; the second user creates a fresh code and the address emails it.
- Then: After the second user's first code, the second user's list is only their login email and the address receives a reply that it is "already connected to another account or workspace", while the first user's list holds the first user's email and the address. The unlink returns HTTP 204 and the redelivered first code does not relink it. After the fresh code, the second user's list holds their email and the address, and the first user's list holds only the first user's email.

## integrations-email-065

- Vitest: "Email multi-account connections > rejects expired verification without creating a connection"
- Mode: run
- Given: A signed-in workspace admin created a connection code 11 minutes ago.
- When: A new address emails that code with passing authentication.
- Then: The link list remains only the admin's login email.

## integrations-email-066

- Vitest: "Email multi-account connections > rejects forged verification without creating a connection"
- Mode: run
- Given: A signed-in workspace admin created a fresh connection code.
- When: A new address emails that code with a failing DMARC result.
- Then: The link list remains only the admin's login email.

## integrations-email-067

- Vitest: "Email multi-account connections > consumes one code atomically when two authenticated senders race"
- Mode: run
- Given: A signed-in workspace admin created a connection code.
- When: Two different authenticated addresses email the same code concurrently.
- Then: The link list contains the admin's login email and exactly one other address (two entries).

## integrations-email-068

- Vitest: "Email multi-account connections > delivers private attachments to a code-verified address outside the login account"
- Mode: run
- Given: A Pro-entitled workspace admin bound an external address by connection code, and a run started from that address has a 1 KiB private file.
- When: The run calls `POST /api/integrations/email/upload-file/complete` with text "Your report".
- Then: The run's system prompt names the external address as the verified sender. The response is HTTP 200 with `emailAddress` equal to the external address, and an email with text "Your report" and attachments is sent to that address.

## integrations-email-069

- Vitest: "Email multi-account connections > routes first-contact email from an existing gmail account using its workspace switch"
- Mode: run
- Given: A Pro-entitled workspace admin connected an external address as a Gmail mailbox while the Email integration switch was off, then the switch was turned on. The address has no Okou account, and Gmail finds the exact incoming message.
- When: The address emails "Use my connected workspace" and the webhook is delivered twice; a Runner claims the run.
- Then: Exactly one conversation is created. The run prompt contains "Use my connected workspace", the system prompt names the address as the verified sender, and the run's chat thread ID is that conversation.

## integrations-email-070

- Vitest: "Email multi-account connections > routes first-contact email from an existing outlook-mail account using its workspace switch"
- Mode: run
- Given: A Pro-entitled workspace admin connected an external address as an Outlook mailbox while the Email integration switch was off, then the switch was turned on. The address has no Okou account, and Outlook finds the exact incoming message.
- When: The address emails "Use my connected workspace" and the webhook is delivered twice; a Runner claims the run.
- Then: Exactly one conversation is created. The run prompt contains "Use my connected workspace", the system prompt names the address as the verified sender, and the run's chat thread ID is that conversation.

## integrations-email-071

- Vitest: "Email multi-account connections > does not route an existing mailbox when its workspace switch is disabled"
- Mode: run
- Given: A Pro-entitled workspace admin connected an external address as a Gmail mailbox, and the Email integration switch is off.
- When: The address emails the Okou inbox.
- Then: No conversation is created and no email is sent.

## integrations-email-072

- Vitest: "Email multi-account connections > does not route an existing mailbox for a banned account"
- Mode: run
- Given: A Pro-entitled workspace admin connected an external address as a Gmail mailbox with the Email integration switch on, but the identity provider reports the account as banned.
- When: The address emails the Okou inbox.
- Then: No conversation is created and no email is sent.

## integrations-email-073

- Vitest: "Email multi-account connections > does not choose a workspace when an unbound mailbox belongs to multiple workspaces"
- Mode: run
- Given: Two Pro-entitled admins in different workspaces have each connected the same external address as a Gmail mailbox while the Email integration switch was off, then turned it on.
- When: The address emails the Okou inbox.
- Then: Neither workspace gets a conversation and no email is sent.

## integrations-email-074

- Vitest: "Email multi-account connections > automatically adds gmail accounts (existing: false) and preserves individual deletion"
- Mode: run
- Given: A signed-in workspace admin connects Gmail mailboxes for their login email and a second address.
- When: The admin reads `GET /api/integrations/email/link`, deletes the login Gmail connector account, unlinks the second address via `DELETE /api/integrations/email/link`, and the second address then emails the inbox.
- Then: The link list includes both addresses with `emailSources` mapping both to "gmail". After deleting the connector account both addresses remain listed. The unlink returns HTTP 204, the email does not relink it, `emailSources` becomes empty, and the list contains only the login email.

## integrations-email-075

- Vitest: "Email multi-account connections > automatically adds outlook-mail accounts (existing: false) and preserves individual deletion"
- Mode: run
- Given: A signed-in workspace admin connects Outlook mailboxes for their login email and a second address.
- When: The admin reads `GET /api/integrations/email/link`, deletes the login Outlook connector account, unlinks the second address via `DELETE /api/integrations/email/link`, and the second address then emails the inbox.
- Then: The link list includes both addresses with `emailSources` mapping both to "outlook". After deleting the connector account both addresses remain listed. The unlink returns HTTP 204, the email does not relink it, `emailSources` becomes empty, and the list contains only the login email.

## integrations-email-076

- Vitest: "Email multi-account connections > automatically adds gmail accounts (existing: true) and preserves individual deletion"
- Mode: run
- Given: A signed-in workspace admin connected Gmail mailboxes for their login email and a second address while the Email integration switch was off, then turned it on.
- When: The admin reads `GET /api/integrations/email/link`, deletes the login Gmail connector account, unlinks the second address via `DELETE /api/integrations/email/link`, and the second address then emails the inbox.
- Then: The link list includes both addresses with `emailSources` mapping both to "gmail". After deleting the connector account both addresses remain listed. The unlink returns HTTP 204, the email does not relink it, `emailSources` becomes empty, and the list contains only the login email.

## integrations-email-077

- Vitest: "Email multi-account connections > automatically adds outlook-mail accounts (existing: true) and preserves individual deletion"
- Mode: run
- Given: A signed-in workspace admin connected Outlook mailboxes for their login email and a second address while the Email integration switch was off, then turned it on.
- When: The admin reads `GET /api/integrations/email/link`, deletes the login Outlook connector account, unlinks the second address via `DELETE /api/integrations/email/link`, and the second address then emails the inbox.
- Then: The link list includes both addresses with `emailSources` mapping both to "outlook". After deleting the connector account both addresses remain listed. The unlink returns HTTP 204, the email does not relink it, `emailSources` becomes empty, and the list contains only the login email.
