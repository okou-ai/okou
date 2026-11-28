# auxiliary-generation

## auxiliary-generation-001

- Vitest: "auxiliary generation outcomes > titles a contextual Slack request using the native thread conversation"
- Mode: run
- Given: A workspace owner has installed the Okou Slack app. The Slack thread contains a long earlier message ending with "The Atlas invoice export duplicates payment rows." and a mention asking the bot "Please fix this". The title model returns "Fix duplicate payments in Atlas invoice exports" only when the prompt includes that earlier topic.
- When: Slack delivers an `app_mention` event in that thread to the Slack events webhook, and the owner then reads `GET /api/chat-threads/events`.
- Then: The thread events include a `renamed` event titled "Fix duplicate payments in Atlas invoice exports". Exactly one title request is made, and it contains the full earlier Slack message, "You are currently running inside: Slack", and the current request.

## auxiliary-generation-002

- Vitest: "auxiliary generation outcomes > titles the thread from a usable completion"
- Mode: run
- Given: A Pro member with a configured Runner group and personal subscription model exists, and Vertex text generation is configured, and the title model returns "A usable summary".
- When: The member sends the chat prompt "Prepare the launch checklist" with `POST /api/chat/events`; after background work drains, the member reads `GET /api/chat-threads/events`.
- Then: The thread's rename events contain exactly the title "A usable summary".

## auxiliary-generation-003

- Vitest: "auxiliary generation outcomes > keeps a member rename when a held title completion arrives later"
- Mode: run
- Given: A Pro member with a configured Runner group and personal subscription model exists, and Vertex text generation is configured, and the title model's response is held until released.
- When: The member sends the chat prompt with `POST /api/chat/events`; while the title generation is held the member renames the thread to "Member chosen title" via `POST /api/chat-threads/:id/rename` (HTTP 204); the model then returns "Stale generated title" and the member reads `GET /api/chat-threads/events`.
- Then: The thread's rename events contain exactly "Member chosen title".

## auxiliary-generation-004

- Vitest: "auxiliary generation outcomes > leaves the thread untitled after an unavailable provider"
- Mode: run
- Given: A Pro member with a configured Runner group and personal subscription model exists, and Vertex text generation is configured, and the title model responds with HTTP 503 and a private payload.
- When: The member sends the chat prompt "Prepare the launch checklist" with `POST /api/chat/events`; after background work drains, the member reads `GET /api/chat-threads/events`.
- Then: The thread has no rename events, it has a `created` event, and no event contains the provider's private payload.

## auxiliary-generation-005

- Vitest: "auxiliary generation outcomes > leaves the thread untitled after rejected credentials"
- Mode: run
- Given: A Pro member with a configured Runner group and personal subscription model exists, and Vertex text generation is configured, and the title model rejects the credentials with HTTP 401 and a private payload.
- When: The member sends the chat prompt "Prepare the launch checklist" with `POST /api/chat/events`; after background work drains, the member reads `GET /api/chat-threads/events`.
- Then: The thread has no rename events, it has a `created` event, and no event contains the provider's private payload.

## auxiliary-generation-006

- Vitest: "auxiliary generation outcomes > leaves the thread untitled after a response that breaks its contract"
- Mode: run
- Given: A Pro member with a configured Runner group and personal subscription model exists, and Vertex text generation is configured, and the title model returns an HTTP 200 response whose body is a private payload rather than a valid completion.
- When: The member sends the chat prompt "Prepare the launch checklist" with `POST /api/chat/events`; after background work drains, the member reads `GET /api/chat-threads/events`.
- Then: The thread has no rename events, it has a `created` event, and no event contains the provider's private payload.

## auxiliary-generation-007

- Vitest: "auxiliary generation outcomes > leaves the thread untitled after a transport failure"
- Mode: run
- Given: A Pro member with a configured Runner group and personal subscription model exists, and Vertex text generation is configured, and the title model request fails at the network level.
- When: The member sends the chat prompt "Prepare the launch checklist" with `POST /api/chat/events`; after background work drains, the member reads `GET /api/chat-threads/events`.
- Then: The thread has no rename events, it has a `created` event, and no event contains the provider's private payload.

## auxiliary-generation-008

- Vitest: "auxiliary generation outcomes > leaves the thread untitled after an exhausted token budget"
- Mode: run
- Given: A Pro member with a configured Runner group and personal subscription model exists, and Vertex text generation is configured, and the title model stops at its token limit (finish reason `length`) with private content.
- When: The member sends the chat prompt "Prepare the launch checklist" with `POST /api/chat/events`; after background work drains, the member reads `GET /api/chat-threads/events`.
- Then: The thread has no rename events, it has a `created` event, and no event contains the provider's private payload.

## auxiliary-generation-009

- Vitest: "auxiliary generation outcomes > leaves the thread untitled after generated text that interprets to nothi…"
- Mode: run
- Given: A Pro member with a configured Runner group and personal subscription model exists, and Vertex text generation is configured, and the title model returns the text `---`, which interprets to no title.
- When: The member sends the chat prompt "Prepare the launch checklist" with `POST /api/chat/events`; after background work drains, the member reads `GET /api/chat-threads/events`.
- Then: The thread has no rename events, it has a `created` event, and no event contains the provider's private payload.

## auxiliary-generation-010

- Vitest: "auxiliary generation outcomes > leaves the thread untitled and calls no provider when configuration is missing"
- Mode: run
- Given: A Pro member with a configured Runner group and personal subscription model exists, and the Vertex project is not configured.
- When: The member sends the chat prompt "Prepare the launch checklist" with `POST /api/chat/events`; after background work drains, the member reads `GET /api/chat-threads/events`.
- Then: The thread has no rename events and the text-generation endpoint receives no requests.

## auxiliary-generation-011

- Vitest: "auxiliary generation outcomes > finishes a background title that outlives the response within the request lifetime"
- Mode: run
- Given: A Pro member with a configured Runner group and personal subscription model exists, and Vertex text generation is configured, and the title model's response is held until released.
- When: The member sends the chat prompt with `POST /api/chat/events` and reads `GET /api/chat-threads/events` while the title is held and while background work is draining; the title model then returns "Late generated title".
- Then: Both reads during the hold show no rename events and background draining has not finished. After release, draining finishes and the thread's rename events contain exactly "Late generated title".
