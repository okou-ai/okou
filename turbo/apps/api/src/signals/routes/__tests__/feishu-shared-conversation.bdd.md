# feishu-shared-conversation

## feishu-shared-conversation-001

- Vitest: "shared Feishu/Lark conversation and queue behavior > reuses one Feishu DM thread for concurrent input and a changed chat destination"
- Mode: run
- Given: A member has linked their Feishu identity to a workspace bot that is ready to start runs.
- When: Feishu sends two encrypted direct-message webhooks concurrently for that member, then sends another message after the Feishu chat destination changes.
- Then: Each webhook returns HTTP 200. Authenticated thread reads show exactly one new thread and readback of that thread includes all three input prompts. The member stays connected.

## feishu-shared-conversation-002

- Vitest: "shared Feishu/Lark conversation and queue behavior > keeps quoted Feishu DM input on the main session and replies in a thread"
- Mode: run
- Given: A connected member already has a Feishu direct-message run with a completed native session and an original message.
- When: Feishu sends an encrypted quoted reply referencing the original message, with no separate thread ID, and a Runner completes the resulting run.
- Then: The Runner receives the main native session as its continuation. Feishu receives the assistant's answer as an in-thread reply to the quoted reply's message ID.

## feishu-shared-conversation-003

- Vitest: "shared Feishu/Lark conversation and queue behavior > with a connected integration actor > forks Feishu DM threads without replacing the main session"
- Mode: run
- Given: A connected Feishu member can run the bot in a DM and a Runner can complete each run with its native session.
- When: The member starts and completes a main DM run, opens and completes a separate Feishu reply thread rooted at the main message, and then sends another main DM message.
- Then: The final main-DM run has Feishu as its source and the Runner receives the original main native session as continuation, despite the completed reply thread.

## feishu-shared-conversation-004

- Vitest: "shared Feishu/Lark conversation and queue behavior > resumes Feishu DM thread sessions and keeps control replies in-thread"
- Mode: run
- Given: A Feishu member connects to the workspace bot and a Runner can complete a new DM reply-thread run with a native session.
- When: The member starts the thread, has the Runner complete it, sends `/help` in the same Feishu thread, and follows up there again.
- Then: The assistant answer and the `Okou Feishu commands` control reply are in-thread replies targeted to the respective incoming messages. The Runner receives the original thread session when the follow-up starts.

## feishu-shared-conversation-005

- Vitest: "shared Feishu/Lark conversation and queue behavior > starts a queued Feishu message when a run slot is released"
- Mode: run
- Given: A connected Feishu member has an organization-wide run limit of two and can send messages into three separate Feishu reply threads.
- When: Feishu delivers three encrypted messages, then an authenticated user releases the first occupied run slot.
- Then: Two runs exist initially and no run for the third prompt appears while capacity is occupied. When the first slot becomes free the third prompt gets a running entry and available Runner execution.

## feishu-shared-conversation-006

- Vitest: "shared Feishu/Lark conversation and queue behavior > terminalizes and delivers a queued Feishu admission failure exactly once"
- Mode: run
- Given: A connected Feishu member has an active run, a second encrypted DM awaiting admission, and a paid plan. The plan ends before the active run completes, and realtime publication fails.
- When: An authenticated Runner completes the first run, and Feishu redelivers the queued message afterwards.
- Then: The queued prompt remains readable without a run ID. Exactly one `input.rejected` supersedes it and exactly one `output.error` reports `insufficient_credits` and `Add credits`. the realtime channel receives a publication attempt and Feishu receives one in-thread reply addressed to the original message with the error event ID as its idempotency key and one reaction removal. No run launches for the queued prompt, and replay adds no event or error reply.

## feishu-shared-conversation-007

- Vitest: "shared Feishu/Lark conversation and queue behavior > persists a queued Feishu admission failure when delivery fails"
- Mode: run
- Given: A connected Feishu member's second encrypted DM is queued behind an active run. Their plan ends and Feishu will reject the outbound credit error reply.
- When: The Runner completes the first run, releasing the queued message for admission.
- Then: Thread readback still shows one `input.rejected` superseding the original and one `output.error`, both `insufficient_credits`. No run starts for the rejected prompt, and the bot attempts the error reply and removes the message reaction once.

## feishu-shared-conversation-008

- Vitest: "shared Feishu/Lark conversation and queue behavior > resumes mentioned group tasks in the same thread session"
- Mode: run
- Given: A connected Feishu member mentions the bot in a group message, and the resulting run completes with a native session.
- When: Feishu delivers an encrypted follow-up in a reply thread rooted at the original group message.
- Then: The follow-up appears as a Feishu-triggered run with the bot mention in its prompt. The Runner receives the original group session as its native continuation.
