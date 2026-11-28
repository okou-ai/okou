# chat-events-subscription-authority

## chat-events-subscription-authority-001

- Vitest: "CHAT-02: run-level model overrides > subscription account preparation > rejects a personal account disconnected while its input is queued"
- Mode: run
- Given: An entitled member has a personal Luna subscription and a Claude Run occupying the only slot.
- When: The member queues a Luna prompt, disconnects its account and frees the slot.
- Then: The input has no Run ID. Exactly one conflict rejection revokes the queued ID and the next sequence, one millisecond later, is a conflict error telling the member to reconnect the unavailable subscription.

## chat-events-subscription-authority-002

- Vitest: "CHAT-02: run-level model overrides > final subscription authority > rejects connected invalid_grant acquired after preparation without refreshing again"
- Mode: run
- Given: A Run has captured a still-connected personal Codex account. The provider responds to forced refresh with HTTP 400 `invalid_grant`.
- When: The Run's authorized firewall client asks for its account and access-token headers with refresh forced.
- Then: The firewall returns HTTP 502 with `reconnect_required`. Only one refresh attempt reaches the provider and thread model credits remain zero.

## chat-events-subscription-authority-003

- Vitest: "CHAT-02: run-level model overrides > final subscription authority > rejects retained terminal refresh acquired after preparation without refreshing again"
- Mode: run
- Given: A Run has captured a personal Codex account before the member disconnected it. The provider returns HTTP 401 with `refresh_token_invalidated` for this retained source.
- When: The Run's authorized firewall client asks for refreshed account and bearer headers.
- Then: The firewall returns HTTP 502 with `reconnect_required`, the provider sees a single refresh attempt, and the thread has zero model credits.

## chat-events-subscription-authority-004

- Vitest: "CHAT-02: run-level model overrides > rejects a prepared subscription when its captured account needs a reconnect"
- Mode: run
- Given: A member starts a fast Luna Run on a connected personal account that will reject a forced refresh with HTTP 401 `refresh_token_invalidated`.
- When: The Run resolves its captured subscription headers and requests forced refresh.
- Then: The firewall returns HTTP 502 with `reconnect_required`, and thread model credits remain zero.

## chat-events-subscription-authority-005

- Vitest: "CHAT-02: run-level model overrides > reuses one subscription gpt-6-luna Pi session across standard, Fast, and standard requests"
- Mode: run
- Given: A member has personal Codex-backed Luna available to Pi.
- When: The member completes successive standard, Fast and standard turns on the same thread, explicitly clearing the tier before the third.
- Then: Each dispatch uses the chosen Luna runtime model. The middle Run resumes the first generation in the same thread session with fast tier, and both standard dispatches omit tier. All completions resolve to the same native session, no history blob is uploaded, and thread model credits stay zero.

## chat-events-subscription-authority-006

- Vitest: "CHAT-02: run-level model overrides > promotes queued and immediate subscription gpt-6-luna Fast from web into the Runner execution"
- Mode: run
- Given: A member is signed into the Web and owns a busy Claude Fable thread plus a personal Luna model route.
- When: The member sends Fast Luna on the busy thread, completes its blocker, and sends another Fast Luna message on a new idle thread.
- Then: Both sends return HTTP 201. Each client event gets a launched replacement whose dispatch uses the Luna runtime model and fast tier. Neither thread incurs model credits.

## chat-events-subscription-authority-007

- Vitest: "CHAT-02: run-level model overrides > promotes queued and immediate subscription gpt-6-luna Fast from agent into the Runner execution"
- Mode: run
- Given: A member owns a busy Claude Fable thread, another active Claude Run with an agent bearer token, and a personal Luna route.
- When: Using the source Run's token, the agent sends Fast Luna on the busy thread, then the blocker completes. The agent also sends Fast Luna on a new idle thread.
- Then: Both bearer-authenticated sends return HTTP 201. Each client event gets a launched replacement, and both dispatches use Luna with fast tier. Neither thread incurs model credits.

## chat-events-subscription-authority-008

- Vitest: "CHAT-02: run-level model overrides > promotes queued and immediate subscription gpt-6-sol Fast from web into the Runner execution"
- Mode: run
- Given: A member is signed into the Web and owns a busy Claude Fable thread plus a personal GPT-6 Sol model route.
- When: The member queues Fast Sol on that thread and completes its blocking Run, then sends Fast Sol on a new idle thread.
- Then: Both sends return HTTP 201. The replacements launch with the GPT-6 Sol runtime model and fast tier, and each thread retains zero model credits.

## chat-events-subscription-authority-009

- Vitest: "CHAT-02: run-level model overrides > promotes queued and immediate subscription gpt-6.1-sol Fast from web into the Runner execution"
- Mode: run
- Given: A member is signed into the Web and owns a busy Claude Fable thread plus a personal GPT-6.1 Sol model route.
- When: The member queues Fast Sol on that thread and completes its blocking Run, then sends Fast Sol on a new idle thread.
- Then: Both sends return HTTP 201. The replacements launch with the GPT-6.1 Sol runtime model and fast tier, and each thread retains zero model credits.
