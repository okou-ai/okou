# mail

## mail-001

- Vitest: "Outlook mail in chat > returns an actionable 400 for a malformed message ID (ErrorInvalidIdMalformed)"
- Mode: run
- Given: A signed-in member owns a chat thread and a connected Outlook mail account. Microsoft Graph answers the read of the message ID `malformed-id` with HTTP 400 and error code `ErrorInvalidIdMalformed`.
- When: The member calls `POST /api/mail/drafts/link` with provider `outlook`, the thread ID and `outlookMessageId` `malformed-id`, then links the real Outlook draft ID.
- Then: The malformed link responds with HTTP 400, code `BAD_REQUEST` and the message "Invalid Outlook draft ID. Check for a typo or placeholder, then retry with the exact id returned by Microsoft Graph for the draft." without the provider detail. Linking the valid draft ID then responds with HTTP 200.

## mail-002

- Vitest: "Outlook mail in chat > returns an actionable 400 for a malformed message ID (badRequest)"
- Mode: run
- Given: A signed-in member owns a chat thread and a connected Outlook mail account. Microsoft Graph answers the read of the message ID `malformed-id` with HTTP 400, code `badRequest` and inner error code `ErrorInvalidIdMalformed`.
- When: The member calls `POST /api/mail/drafts/link` with provider `outlook`, the thread ID and `outlookMessageId` `malformed-id`, then links the real Outlook draft ID.
- Then: The malformed link responds with HTTP 400, code `BAD_REQUEST` and the message "Invalid Outlook draft ID. Check for a typo or placeholder, then retry with the exact id returned by Microsoft Graph for the draft." without the provider detail. Linking the valid draft ID then responds with HTTP 200.

## mail-003

- Vitest: "Outlook mail in chat > keeps an unrecognized message lookup error as a server failure"
- Mode: run
- Given: A signed-in member owns a chat thread and a connected Outlook mail account. Microsoft Graph answers the message read with HTTP 400 and an unrecognized error code (`private-code@example.com`) whose message says the ID is malformed.
- When: The member links the Outlook draft with `POST /api/mail/drafts/link`.
- Then: The API responds with HTTP 500 instead of an actionable 400.

## mail-004

- Vitest: "Outlook mail in chat > keeps an attachment lookup error as a server failure"
- Mode: run
- Given: A signed-in member owns a chat thread and a connected Outlook mail account. The message read succeeds but Microsoft Graph answers the attachment list with HTTP 400 and code `ErrorInvalidIdMalformed`.
- When: The member links the Outlook draft with `POST /api/mail/drafts/link`.
- Then: The API responds with HTTP 500 instead of an actionable 400.

## mail-005

- Vitest: "Outlook mail in chat > links, refreshes and previews the provider draft with its attachments"
- Mode: run
- Given: A signed-in member owns a chat thread and a connected Outlook mail account. The Outlook draft "Outlook review" has an `In-Reply-To` header, a regular `proposal.pdf` attachment and an inline `logo.png` image with content ID `outlook-logo`.
- When: The member links the draft twice with `POST /api/mail/drafts/link`, the draft subject changes in Outlook to "Revised Outlook proposal", and the member calls `GET /api/mail/drafts/:mailDraftId`, `GET /api/mail/drafts/:mailDraftId/attachments/report` and `GET /api/mail/threads/:threadId/drafts`.
- Then: Both links return HTTP 200 with the same `mailDraftId`. The draft read returns provider `outlook`, the Outlook message ID, the revised subject, status `draft`, `inReplyTo` `<original@example.com>`, the `proposal.pdf` attachment (part `report`) and the inline image `outlook-logo` (part `inline-logo`). The attachment downloads with content type `application/pdf`, and the thread list contains the draft with the revised subject.

## mail-006

- Vitest: "Outlook mail in chat > marks a 202 send successful immediately and prevents duplicate sends"
- Mode: run
- Given: A signed-in member has linked an Outlook draft, and Microsoft Graph accepts the send with HTTP 202.
- When: The member sends `POST /api/mail/drafts/:mailDraftId/send` twice concurrently, reads the draft while Outlook still returns 404 for it, sends again, then reads it after Outlook reports it as sent, and finally calls `DELETE /api/mail/drafts/:mailDraftId`.
- Then: Each concurrent send returns HTTP 200 or 409, one returns status `sent` with a `sentAt`, and Outlook receives exactly one send. The read during propagation returns status `sent`, the extra send returns HTTP 409, the later read returns `sent` with Outlook's `sentDateTime`, and the delete returns HTTP 409. Outlook still receives only one send.

## mail-007

- Vitest: "Outlook mail in chat > preserves an accepted send across an earlier missing provider read"
- Mode: run
- Given: A signed-in member has linked an Outlook draft. An earlier draft read is held at the provider and will return 404 (the message is missing).
- When: The member starts `GET /api/mail/drafts/:mailDraftId`, sends the draft with `POST /api/mail/drafts/:mailDraftId/send` while that read is held, then the held read finishes, and the member reads the draft again after Outlook reports it as sent.
- Then: The send returns HTTP 200 with status `sent`. The earlier read returns HTTP 200 with status `sent` and the same `sentAt`, the confirming read returns `sent`, and Outlook receives exactly one send.

## mail-008

- Vitest: "Outlook mail in chat > preserves an accepted send across an earlier draft provider read"
- Mode: run
- Given: A signed-in member has linked an Outlook draft. An earlier draft read is held at the provider and will return the message still as an unsent draft.
- When: The member starts `GET /api/mail/drafts/:mailDraftId`, sends the draft with `POST /api/mail/drafts/:mailDraftId/send` while that read is held, then the held read finishes, and the member reads the draft again after Outlook reports it as sent.
- Then: The send returns HTTP 200 with status `sent`. The earlier read returns HTTP 200 with status `sent` and the same `sentAt`, the confirming read returns `sent`, and Outlook receives exactly one send.

## mail-009

- Vitest: "Outlook mail in chat > preserves an accepted send across an earlier incomplete-sent provider read"
- Mode: run
- Given: A signed-in member has linked an Outlook draft. An earlier draft read is held at the provider and will return the message as not a draft but without a sent time (incomplete sent state).
- When: The member starts `GET /api/mail/drafts/:mailDraftId`, sends the draft with `POST /api/mail/drafts/:mailDraftId/send` while that read is held, then the held read finishes, and the member reads the draft again after Outlook reports it as sent.
- Then: The send returns HTTP 200 with status `sent`. The earlier read returns HTTP 200 with status `sent` and the same `sentAt`, the confirming read returns `sent`, and Outlook receives exactly one send.

## mail-010

- Vitest: "Outlook mail in chat > preserves an uncertain 408 send without retrying and lets explicit rejections be corrected"
- Mode: run
- Given: A signed-in member has linked an Outlook draft. Microsoft Graph first rejects a send with HTTP 400, then answers the next send with HTTP 408.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send`, reads the draft, sends again, then sends a third time.
- Then: The first send returns HTTP 400 and the draft remains status `draft`. The second send returns HTTP 200 with status `sending`, the third returns HTTP 409, and Outlook received exactly two send requests.

## mail-011

- Vitest: "Outlook mail in chat > preserves an uncertain 503 send without retrying and lets explicit rejections be corrected"
- Mode: run
- Given: A signed-in member has linked an Outlook draft. Microsoft Graph first rejects a send with HTTP 400, then answers the next send with HTTP 503.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send`, reads the draft, sends again, then sends a third time.
- Then: The first send returns HTTP 400 and the draft remains status `draft`. The second send returns HTTP 200 with status `sending`, the third returns HTTP 409, and Outlook received exactly two send requests.

## mail-012

- Vitest: "Outlook mail in chat > preserves an uncertain network-error send without retrying and lets explicit rejections be corrected"
- Mode: run
- Given: A signed-in member has linked an Outlook draft. Microsoft Graph first rejects a send with HTTP 400, then the next send fails with a network error.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send`, reads the draft, sends again, then sends a third time.
- Then: The first send returns HTTP 400 and the draft remains status `draft`. The second send returns HTTP 200 with status `sending`, the third returns HTTP 409, and Outlook received exactly two send requests.

## mail-013

- Vitest: "Outlook mail in chat > requires reconnect for revoked Outlook access"
- Mode: run
- Given: A signed-in member has linked an Outlook draft, and Microsoft Graph then answers message reads with HTTP 401.
- When: The member calls `GET /api/mail/drafts/:mailDraftId`.
- Then: The API responds with HTTP 200 and a mail draft with provider `outlook` and `accessStatus` `reconnect`.

## mail-014

- Vitest: "Outlook mail in chat > preserves the sent copy when the user sends an Outlook draft externally"
- Mode: run
- Given: A signed-in member has linked an Outlook draft, which the user then sends directly in Outlook (it is no longer a draft and has a sent time).
- When: The member calls `DELETE /api/mail/drafts/:mailDraftId` and then `GET /api/mail/drafts/:mailDraftId`.
- Then: The delete returns HTTP 409 and the read returns status `sent`. The Outlook message still exists and the API sent nothing to Outlook.

## mail-015

- Vitest: "Outlook mail in chat > deletes an Outlook draft and keeps its review link unavailable"
- Mode: run
- Given: A signed-in member has linked an Outlook draft.
- When: The member calls `DELETE /api/mail/drafts/:mailDraftId` and then `GET /api/mail/drafts/:mailDraftId`.
- Then: The delete returns HTTP 204, the read returns HTTP 200 with status `deleted`, and the Outlook message is deleted at the provider.

## mail-016

- Vitest: "thread email list > lists linked drafts, then sent emails, and refuses to delete sent mail"
- Mode: run
- Given: A signed-in member has a chat thread, a connected Gmail account with the `gmail.modify` grant, and a linked Gmail draft "Attachment review" from `sender@example.com`.
- When: The member lists `GET /api/mail/threads/:threadId/drafts`, sends the draft with `POST /api/mail/drafts/:mailDraftId/send`, lists again, calls `DELETE /api/mail/drafts/:mailDraftId`, and lists once more.
- Then: The first list contains only the draft with subject "Attachment review", sender `sender@example.com` and status `draft`. The send returns HTTP 200 and the next list shows the same mail with status `sent`. The delete returns HTTP 409 and the final list is unchanged.

## mail-017

- Vitest: "thread email list > keeps sent mail when an earlier deletion finishes after sending"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail holds a draft deletion request and then answers it with 404.
- When: The member starts `DELETE /api/mail/drafts/:mailDraftId`, sends the draft with `POST /api/mail/drafts/:mailDraftId/send` while the deletion is held, then the deletion finishes, and the member lists `GET /api/mail/threads/:threadId/drafts`.
- Then: The send returns HTTP 200 with status `sent`, the earlier deletion returns HTTP 409, and the thread list contains the mail with status `sent`.

## mail-018

- Vitest: "thread email list > omits deleted drafts immediately and keeps their original links unavailable"
- Mode: run
- Given: A signed-in member has a linked Gmail draft.
- When: The member calls `DELETE /api/mail/drafts/:mailDraftId`, lists `GET /api/mail/threads/:threadId/drafts`, and reads `GET /api/mail/drafts/:mailDraftId`.
- Then: The delete returns HTTP 204, the thread list is empty, and the draft read returns HTTP 200 with status `deleted` and `detailAvailable` false.

## mail-019

- Vitest: "thread email list > does not disclose another user's thread"
- Mode: run
- Given: A signed-in member has a chat thread with Gmail connected; another user has their own thread.
- When: The member calls `GET /api/mail/threads/:threadId/drafts` for a random nonexistent thread ID and for the other user's thread ID.
- Then: Both requests return HTTP 404 with code `NOT_FOUND`, and the two error bodies are identical.

## mail-020

- Vitest: "POST /api/mail/drafts/link > rejects a Gmail draft ID with extra text before reading the draft"
- Mode: run
- Given: A signed-in member has a chat thread and a connected Gmail account.
- When: The member calls `POST /api/mail/drafts/link` with `gmailDraftId` `Draft r-test-draft` (extra text before the ID).
- Then: The API responds with HTTP 400, code `BAD_REQUEST` and the message "Invalid Gmail draft ID. Pass only the top-level id returned by Gmail when creating the draft." Gmail receives no draft read.

## mail-021

- Vitest: "POST /api/mail/drafts/link > returns a generic server error when Gmail rejects the draft read"
- Mode: run
- Given: A signed-in member has a chat thread and a connected Gmail account. Gmail answers the draft read with HTTP 400.
- When: The member calls `POST /api/mail/drafts/link` with a well-formed Gmail draft ID.
- Then: The API responds with HTTP 500 and the body `{ "error": "Internal server error" }`. Gmail receives exactly one draft read.

## mail-022

- Vitest: "POST /api/mail/drafts/link > converges simultaneous same-chat links and preserves replay and cross-chat conflict"
- Mode: run
- Given: A signed-in member has a chat thread, a connected Gmail account and an existing Gmail draft. The app URL is `https://app.okou.ai`.
- When: The member sends two simultaneous `POST /api/mail/drafts/link` requests for the same thread and draft, reads `GET /api/mail/drafts/:mailDraftId`, repeats the link, tries to link the same draft to another of their threads, and links the original thread again.
- Then: Both simultaneous links return the same body with `mailDraftUrl` `https://app.okou.ai/mail/drafts/<mailDraftId>`. The read returns the Gmail draft, thread and message IDs, status `draft`, `detailAvailable` true, sender `sender@example.com` and subject "Attachment review". The replay returns the same body, the other-thread link returns HTTP 409 "This Gmail draft is already linked to another chat", and relinking the original thread still returns the original body.

## mail-023

- Vitest: "POST /api/mail/drafts/link > uses the thread-selected Gmail account without probing the default"
- Mode: run
- Given: A signed-in member has a default Gmail account and adds a second Gmail account, which is selected for the chat thread.
- When: The member links a draft with `POST /api/mail/drafts/link`, reads it with `GET /api/mail/drafts/:mailDraftId`, then reads it again after Gmail rejects the selected account's token with HTTP 401.
- Then: The link and first read each read the draft from Gmail with the selected account's token (one read each). After the 401, the read returns HTTP 200 with `reconnectConnectionId` equal to the selected account.

## mail-024

- Vitest: "POST /api/mail/drafts/link > does not fall back from a reconnect-required thread selection"
- Mode: run
- Given: A signed-in member adds a second Gmail account and selects it for the chat thread. Gmail rejects that account's token with HTTP 401.
- When: The member calls `POST /api/mail/drafts/link`, then retries after Gmail access recovers.
- Then: The first link returns HTTP 409 "Reconnect Gmail before continuing" after one draft read, and the selected account is listed as `reconnect-required`. The retry returns HTTP 409 "Connect and allow Gmail in this Chat first" without another Gmail read; the API does not fall back to the default account.

## mail-025

- Vitest: "POST /api/mail/drafts/link > requires Chat allowance before linking a Gmail draft"
- Mode: run
- Given: A signed-in member has a chat thread and a connected Gmail account. Another user of the same organization and the member in another organization also try the link. The member then disables Gmail by default for Chat access.
- When: `POST /api/mail/drafts/link` is called as the other user, as the member in another organization, as the member with Gmail disabled by default, and finally after the member enables Gmail for this thread via a thread override.
- Then: The two foreign callers receive HTTP 404 and the disabled member receives HTTP 409, all without reading Gmail. After the thread override enables Gmail, the link returns HTTP 200 and Gmail receives one draft read.

## mail-026

- Vitest: "POST /api/mail/drafts/link > follows member account eligibility when the Chat owner links a Gmail draft"
- Mode: run
- Given: A signed-in member owns a chat thread and a connected Gmail account, with member connector account access enabled.
- When: The member sets the Gmail account policy to `deny` via `PUT /api/connector-account-access/:connectionId/policy`, calls `POST /api/mail/drafts/link`, then sets the policy to `allow-always` and links again.
- Then: Under `deny` the link returns HTTP 409 "Connect and allow Gmail in this Chat first". After `allow-always` the link returns HTTP 200.

## mail-027

- Vitest: "POST /api/mail/drafts/link > uses a healthy Gmail connection with its provider-granted scope"
- Mode: run
- Given: A signed-in member connected Gmail through OAuth and Google granted the `gmail.modify` scope.
- When: The member reads their default Gmail account and account list, then calls `POST /api/mail/drafts/link`.
- Then: The default account and the single listed account report `oauthScopes` `[gmail.modify]` and `connectionStatus` `connected`. The link returns HTTP 200 and Gmail receives one draft read.

## mail-028

- Vitest: "POST /api/mail/drafts/link > rejects a known-insufficient Gmail grant before provider access"
- Mode: run
- Given: A signed-in member connected Gmail but Google granted no scopes.
- When: The member calls `POST /api/mail/drafts/link` for a Gmail draft.
- Then: The API responds with HTTP 409 "Connect and allow Gmail in this Chat first" and Gmail receives no draft read.

## mail-029

- Vitest: "POST /api/mail/drafts/link > requires reconnect when Gmail reports an insufficient token scope"
- Mode: run
- Given: A signed-in member has a connected Gmail account, and Gmail answers the draft read with HTTP 403 reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT`.
- When: The member calls `POST /api/mail/drafts/link`.
- Then: The API responds with HTTP 409 "Reconnect Gmail before continuing" after one Gmail read, and the default Gmail account becomes `reconnect-required`.

## mail-030

- Vitest: "POST /api/mail/drafts/link > does not require reconnect for an unrelated Gmail permission denial"
- Mode: run
- Given: A signed-in member has a connected Gmail account, and Gmail answers the draft read with HTTP 403 reason `PERMISSION_DENIED` (not a scope problem).
- When: The member calls `POST /api/mail/drafts/link`.
- Then: The request fails with the server error "Failed to read Gmail draft (HTTP 403)" after one Gmail read, and the Gmail account stays `connected`.

## mail-031

- Vitest: "POST /api/mail/drafts/link > reads an existing draft from its pinned Gmail account after changing the Chat selection"
- Mode: run
- Given: A signed-in member linked a Gmail draft through their original Gmail account, pinned that account to the thread, then added a replacement account and made it the default.
- When: The member selects the new default account for the thread and calls `GET /api/mail/drafts/:mailDraftId`.
- Then: The original account is listed as not default. The read returns HTTP 200 with `accessStatus` `ready`, `detailAvailable` true and sender `sender@example.com`, read through the draft's pinned account.

## mail-032

- Vitest: "POST /api/mail/drafts/link > rejects a new draft after the Gmail account is publicly disconnected"
- Mode: run
- Given: A signed-in member linked a Gmail draft, selected their Gmail account for the thread, and then deleted (disconnected) that Gmail account.
- When: The member creates a new thread and calls `POST /api/mail/drafts/link` for it.
- Then: The API responds with HTTP 409 "Connect and allow Gmail in this Chat first".

## mail-033

- Vitest: "POST /api/mail/drafts/link > selects the surviving default when its pinned Gmail account is deleted"
- Mode: run
- Given: A signed-in member linked a Gmail draft, pinned their original Gmail account to the thread, then added a replacement account and made it the default.
- When: The member reads `GET /api/chat-threads/:id/connector-selections`, deletes the pinned Gmail account, reads the selections again, and links a draft with `POST /api/mail/drafts/link`.
- Then: Before deletion the selection points at the pinned account. After deletion it points at the default account for builtin `gmail` with that account as the selected connection, and the link reads Gmail once with the default account's token.

## mail-034

- Vitest: "POST /api/mail/drafts/link > clears the exact thread selection after custom connector disconnect"
- Mode: run
- Given: A signed-in member has a custom connector with a secret value and selects its account for a chat thread.
- When: The member reads `GET /api/chat-threads/:id/connector-selections`, disconnects the custom connector's default account, and reads the selections again.
- Then: The selection first contains the custom account. After the disconnect the response is exactly empty `selections` and `selectedConnections`.

## mail-035

- Vitest: "POST /api/mail/drafts/link > clears the exact thread selection after custom connector delete"
- Mode: run
- Given: A signed-in member has a custom connector with a secret value and selects its account for a chat thread.
- When: The member reads `GET /api/chat-threads/:id/connector-selections`, deletes the custom connector, and reads the selections again.
- Then: The selection first contains the custom account. After the deletion the response is exactly empty `selections` and `selectedConnections`.

## mail-036

- Vitest: "POST /api/mail/drafts/link > links without injecting a duplicate card and sends without rebuilding MIME"
- Mode: run
- Given: A member's chat run is executing with a Runner-issued `OKOU_TOKEN`, Gmail is connected, and a Gmail draft "Attachment review" exists with an HTML body, an inline image and a PDF attachment. The app URL is `https://app.okou.ai`.
- When: Using the run token, the caller links the draft to another thread and then to the run's thread with `POST /api/mail/drafts/link`. The member links again, reads `GET /api/mail/drafts/:mailDraftId`, downloads part `2`, sends with `POST /api/mail/drafts/:mailDraftId/send` twice, and lists the thread events.
- Then: The other-thread link returns HTTP 404 without reading Gmail. The link returns the `https://app.okou.ai/mail/drafts/<id>` URL and the duplicate link returns the same ID and URL. The read returns version 3, provider `gmail`, sender, recipients, subject, text and HTML bodies, the inline image and the PDF attachment. Part `2` downloads the image bytes as `image/png` with an attachment disposition. The first send returns `sent` with the sent message ID after posting only `{ id: draftId }` to Gmail; the second returns HTTP 409 containing "can no longer be sent" and Gmail still has one send. The thread event list after linking and sending is identical to the list before linking.

## mail-037

- Vitest: "POST /api/mail/drafts/link > keeps a rejected Gmail draft available for correction and an explicit later send (status present: false)"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 400, reason `badRequest` and no `status` field.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send`, reads the draft, then sends again after Gmail accepts the corrected draft.
- Then: The first send returns HTTP 400, code `BAD_REQUEST` and the message "Gmail rejected this draft. Open it in Gmail and check its recipients and content before trying again." after one attempt. The draft stays `draft` without a sent message ID and Gmail stays `connected`. The explicit later send returns `sent`, posting `{ id: draftId }` once, and the rejected send is not retried.

## mail-038

- Vitest: "POST /api/mail/drafts/link > keeps a rejected Gmail draft available for correction and an explicit later send (status present: true)"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 400, reason `badRequest` and status `INVALID_ARGUMENT`.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send`, reads the draft, then sends again after Gmail accepts the corrected draft.
- Then: The first send returns HTTP 400, code `BAD_REQUEST` and the message "Gmail rejected this draft. Open it in Gmail and check its recipients and content before trying again." after one attempt. The draft stays `draft` without a sent message ID and Gmail stays `connected`. The explicit later send returns `sent`, posting `{ id: draftId }` once, and the rejected send is not retried.

## mail-039

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for unknown reason"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 400 and an unknown reason (`private@example.com`).
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-040

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for mixed reasons"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 400 and mixed reasons `badRequest` and `backendError`.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-041

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for missing reasons"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 400 and no `errors` reasons.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-042

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for empty reasons"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 400 and an empty `errors` list.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-043

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for structured field violations without a reason"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 400, status `INVALID_ARGUMENT` and structured field violations but no reason.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-044

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for unrecognized domain"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 400, reason `badRequest` in the unrecognized domain `other`.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-045

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for conflicting details"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 400, reason `badRequest` and a conflicting detail reason `OTHER_ERROR`.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-046

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for request parameter defect"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 400, reason `badRequest` located at the request parameter `id`.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-047

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for server failure with badRequest reason"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail fails the send with HTTP 500 and reason `badRequest`.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-048

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for backend failure"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail fails the send with HTTP 503 and reason `backendError`.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-049

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for unrelated permission denial"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 403 and reason `forbidden` (unrelated to token scope).
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-050

- Vitest: "POST /api/mail/drafts/link > preserves a Gmail send failure for rate limit"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail rejects the send with HTTP 429 and reason `userRateLimitExceeded`.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt. The draft stays `draft` without a sent message ID, and Gmail stays `connected`.

## mail-051

- Vitest: "POST /api/mail/drafts/link > preserves an unreadable Gmail send failure for non-JSON body"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail answers the send with HTTP 400 and a non-JSON text body.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt, and the draft stays status `draft`.

## mail-052

- Vitest: "POST /api/mail/drafts/link > preserves an unreadable Gmail send failure for oversized body"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. Gmail answers the send with HTTP 400 and an oversized (over 17 KiB) JSON error body with reason `badRequest`.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt, and the draft stays status `draft`.

## mail-053

- Vitest: "POST /api/mail/drafts/link > preserves an unreadable Gmail send failure for network failure"
- Mode: run
- Given: A signed-in member has a linked Gmail draft. The Gmail send request fails with a network error.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send` and then reads the draft.
- Then: The send responds with HTTP 500 after one Gmail attempt, and the draft stays status `draft`.

## mail-054

- Vitest: "POST /api/mail/drafts/link > requires reconnect when Gmail rejects authorization during send with 401"
- Mode: run
- Given: A signed-in member has a linked Gmail draft, and Gmail rejects the send with HTTP 401.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send`.
- Then: The API responds with HTTP 409 "Reconnect Gmail before continuing", and the default Gmail account becomes `reconnect-required`.

## mail-055

- Vitest: "POST /api/mail/drafts/link > requires reconnect when Gmail rejects authorization during send with 403"
- Mode: run
- Given: A signed-in member has a linked Gmail draft, and Gmail rejects the send with HTTP 403 and reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT`.
- When: The member calls `POST /api/mail/drafts/:mailDraftId/send`.
- Then: The API responds with HTTP 409 "Reconnect Gmail before continuing", and the default Gmail account becomes `reconnect-required`.

## mail-056

- Vitest: "POST /api/mail/drafts/link > refreshes a linked draft whose subject was initially empty"
- Mode: run
- Given: A signed-in member links a Gmail draft that has no subject and an empty body; Gmail then returns the subject "Updated subject" and body "Updated body".
- When: The member calls `POST /api/mail/drafts/link` and then `GET /api/mail/drafts/:mailDraftId`.
- Then: The link reads Gmail once. The read fetches Gmail again (two reads total) and returns subject "Updated subject", body "Updated body" and status `draft`.

## mail-057

- Vitest: "POST /api/mail/drafts/link > serves an inline image stored directly in the Gmail MIME body"
- Mode: run
- Given: A signed-in member has a Gmail draft whose inline image bytes are stored directly in the MIME body rather than as a separate attachment.
- When: The member links the draft and calls `GET /api/mail/drafts/:mailDraftId/attachments/2`.
- Then: The response is HTTP 200 and its bytes equal the inline image bytes.

## mail-058

- Vitest: "POST /api/mail/drafts/link > serves regular attachments stored directly in the Gmail MIME body"
- Mode: run
- Given: A signed-in member has a Gmail draft whose PDF and `decision.txt` attachments are stored directly in the MIME body.
- When: The member links the draft, reads `GET /api/mail/drafts/:mailDraftId`, and downloads parts `1` and `3` from `GET /api/mail/drafts/:mailDraftId/attachments/:partId`.
- Then: The draft lists `report.pdf` (`application/pdf`, size equal to the PDF bytes, part `1`). Part `1` returns the PDF bytes, and part `3` returns the text bytes with content type `application/octet-stream`.

## mail-059

- Vitest: "POST /api/mail/drafts/link > returns cached mail details and requires reconnect after Gmail rejects access"
- Mode: run
- Given: A signed-in member has a linked Gmail draft "Attachment review", and Gmail then rejects the token with HTTP 401.
- When: The member calls `GET /api/mail/drafts/:mailDraftId` twice.
- Then: The first read returns HTTP 200 with `accessStatus` `reconnect`, `detailAvailable` false, status `draft` and the cached subject. The second read also returns `reconnect` without another Gmail draft read.

## mail-060

- Vitest: "POST /api/mail/drafts/link > marks Gmail for reconnect when a refreshed token is rejected"
- Mode: run
- Given: A signed-in member has a linked Gmail draft and reconnects Gmail with an already-expired access token. Google refreshes the token, but Gmail rejects the refreshed token with HTTP 401.
- When: The member calls `GET /api/mail/drafts/:mailDraftId`.
- Then: The read returns HTTP 200 with `accessStatus` `reconnect` and `detailAvailable` false, and the same default Gmail account becomes `reconnect-required`.

## mail-061

- Vitest: "POST /api/mail/drafts/link > restores a draft after its Gmail connector is reconnected"
- Mode: run
- Given: A signed-in member linked a Gmail draft, then disconnected the default Gmail account and connected the same Gmail account again through OAuth.
- When: The member calls `GET /api/mail/drafts/:mailDraftId`.
- Then: The read returns HTTP 200 with `accessStatus` `ready`, `detailAvailable` true, sender `sender@example.com`, status `draft` and subject "Attachment review", reading Gmail again (two reads total).

## mail-062

- Vitest: "POST /api/mail/drafts/link > does not attach an existing draft to a different Gmail account"
- Mode: run
- Given: A signed-in member linked a Gmail draft, then connected a different Gmail account (`replacement@example.com`) and deleted the original account.
- When: The member calls `GET /api/mail/drafts/:mailDraftId`.
- Then: The read returns HTTP 200 with `accessStatus` `reconnect`, `detailAvailable` false, status `draft`, the cached subject and no `reconnectConnectionId`. Gmail is not read again (one read total).

## mail-063

- Vitest: "POST /api/mail/drafts/link > retains the resolved account when a legacy draft needs reconnect"
- Mode: run
- Given: A signed-in member linked a Gmail draft, replaced and deleted the original account, then added a new account with the original address `sender@example.com` as default. Gmail rejects that new account's token with HTTP 401.
- When: The member calls `GET /api/mail/drafts/:mailDraftId` twice.
- Then: Both reads return `accessStatus` `reconnect` with `reconnectConnectionId` equal to the recovered account (different from the original account ID), and the second also keeps the cached subject. The recovered account becomes `reconnect-required`, and Gmail receives only one draft read.

## mail-064

- Vitest: "POST /api/mail/drafts/link > rejects a missing Gmail draft"
- Mode: run
- Given: A signed-in member has a connected Gmail account, and Gmail answers the draft read with 404.
- When: The member calls `POST /api/mail/drafts/link`.
- Then: The API responds with HTTP 404 "Gmail draft not found".

## mail-065

- Vitest: "POST /api/mail/drafts/link > requires reconnect when the Gmail token refresh fails"
- Mode: run
- Given: A signed-in member reconnected Gmail with an already-expired access token, and the Google token refresh fails with a network error.
- When: The member calls `POST /api/mail/drafts/link`.
- Then: The API responds with HTTP 409 "Reconnect Gmail before continuing".

## mail-066

- Vitest: "POST /api/mail/drafts/link > deletes Gmail without removing the linked mail draft"
- Mode: run
- Given: A signed-in member has a linked Gmail draft "Attachment review".
- When: The member calls `DELETE /api/mail/drafts/:mailDraftId` and then `GET /api/mail/drafts/:mailDraftId`.
- Then: The delete returns HTTP 204 and Gmail receives one draft deletion. The read returns the same `mailDraftId` with status `deleted`, `detailAvailable` false and subject "Attachment review".

## mail-067

- Vitest: "POST /api/mail/drafts/link > only removes the link when its chat thread is deleted"
- Mode: run
- Given: A signed-in member has a Gmail draft linked to a chat thread.
- When: The member deletes the chat thread, calls `GET /api/mail/drafts/:mailDraftId`, then links the same Gmail draft to a new thread with `POST /api/mail/drafts/link`.
- Then: Deleting the thread does not delete the Gmail draft. The draft read returns HTTP 404, and the new link returns HTTP 200 with a different `mailDraftId`. Gmail receives no deletion.

## mail-068

- Vitest: "mail refresh publication > persists rotation, preserves explicit zero expiry and reuses the default expiry token"
- Mode: run
- Given: A signed-in member has a linked Gmail draft whose stored access token has expired and refresh token is `original-public-mail-refresh`. Google first refreshes to a token with explicit `expires_in` 0 and a rotated refresh token, then (with the rotated token) returns a token with no expiry and no new refresh token.
- When: The member calls `GET /api/mail/drafts/:mailDraftId` three times.
- Then: The first two reads return `detailAvailable` true, using the rotated refresh token for the second refresh. The default Gmail account then shows `gmail.modify` scopes, `connected` and a `tokenExpiresAt`, and the third read succeeds without calling Google's token endpoint again.

## mail-069

- Vitest: "mail refresh publication > publishes omitted grants with the refreshed credential"
- Mode: run
- Given: A signed-in member has a linked Gmail draft with an expired access token. Google's refresh response omits `scope`.
- When: The member calls `GET /api/mail/drafts/:mailDraftId`, reads the default Gmail account, and reads the draft again.
- Then: The first read returns `detailAvailable` true, the account keeps `oauthScopes` `[gmail.modify]`, and the second read returns `detailAvailable` true.

## mail-070

- Vitest: "mail refresh publication > publishes empty grants with the refreshed credential"
- Mode: run
- Given: A signed-in member has a linked Gmail draft with an expired access token. Google's refresh response has an empty `scope`.
- When: The member calls `GET /api/mail/drafts/:mailDraftId`, reads the default Gmail account, and reads the draft again.
- Then: The first read returns `detailAvailable` true, the account's `oauthScopes` become empty, and the second read returns `detailAvailable` false.

## mail-071

- Vitest: "mail refresh publication > publishes narrower grants with the refreshed credential"
- Mode: run
- Given: A signed-in member has a linked Gmail draft with an expired access token. Google's refresh response grants only `gmail.readonly`.
- When: The member calls `GET /api/mail/drafts/:mailDraftId`, reads the default Gmail account, and reads the draft again.
- Then: The first read returns `detailAvailable` true, the account's `oauthScopes` become `[gmail.readonly]`, and the second read returns `detailAvailable` false.

## mail-072

- Vitest: "mail refresh publication > keeps the public reconnect outcome for invalid_grant"
- Mode: run
- Given: A signed-in member has a linked Gmail draft with an expired access token, and Google's refresh fails with HTTP 400 `invalid_grant`.
- When: The member calls `GET /api/mail/drafts/:mailDraftId` and reads the default Gmail account.
- Then: The read returns `detailAvailable` false and `accessStatus` `reconnect`. The account becomes `reconnect-required` and keeps `oauthScopes` `[gmail.modify]`.

## mail-073

- Vitest: "mail refresh publication > keeps the public reconnect outcome for temporarily_unavailable"
- Mode: run
- Given: A signed-in member has a linked Gmail draft with an expired access token, and Google's refresh fails with HTTP 503 `temporarily_unavailable`.
- When: The member calls `GET /api/mail/drafts/:mailDraftId`, reads the default Gmail account, and reads the draft again after Google refreshes successfully.
- Then: The first read returns `detailAvailable` false and `accessStatus` `reconnect`, while the account stays `connected` with `oauthScopes` `[gmail.modify]`. After recovery the read returns `detailAvailable` true.

## mail-074

- Vitest: "mail refresh publication > suppresses publication after the exact account is deleted during provider refresh"
- Mode: run
- Given: A signed-in member has a linked Gmail draft with an expired access token and a second, sibling Gmail account. The original account is deleted while Google is processing its token refresh.
- When: The member calls `GET /api/mail/drafts/:mailDraftId`, lists their Gmail accounts, selects the sibling for the thread, links the draft again with `POST /api/mail/drafts/link`, and reads the new draft.
- Then: The original card read returns `detailAvailable` false. The deleted account is not listed, and the sibling keeps its scopes, token expiry and `connected` status. The new link returns a different `mailDraftId` whose read returns `detailAvailable` true.

## mail-075

- Vitest: "mail refresh publication > keeps another actor's account and credential isolated from refresh"
- Mode: run
- Given: A signed-in member has a linked Gmail draft with an expired access token. Another user has their own Gmail account and linked draft.
- When: The member reads `GET /api/mail/drafts/:mailDraftId` after Google refreshes the member's token, then the other user reads their own draft.
- Then: The member's read returns `detailAvailable` true, the other user's Gmail account is exactly unchanged, and the other user's read returns `detailAvailable` true.
