# chat-events-pi-responses

## chat-events-pi-responses-001

- Vitest: "CHAT-02: model-first routing > reuses one OpenRouter Responses Pi session across standard, fast, and standard turns for gpt-6-luna"
- Mode: run
- Given: An authenticated workspace member has a personal `gpt-6-luna` Responses route through Pi and available Sandbox runners.
- When: The member sends and completes a standard turn, sends and completes a fast turn on the same thread, explicitly clears the thread service tier, then sends and completes a third turn.
- Then: The dispatches use `gpt-6-luna` throughout, omit service tier in the two standard turns and set `fast` on the middle turn. All three completions report the same native session. Later system prompts omit the three turns' text, and the thread shows exactly the three prompt and answer pairs in order with zero model credits and no history blob uploads.

## chat-events-pi-responses-002

- Vitest: "CHAT-02: model-first routing > promotes queued fast gpt-6-luna to a priority Pi Sandbox run"
- Mode: run
- Given: Claude Fable 5.1 occupies a workspace owner's active thread. The member has a personal Pi route for `gpt-6-luna`.
- When: The member submits a fast Luna prompt with a client event ID. The Sandbox completes the blocking Claude Run, then claims and completes the promoted Run.
- Then: The queued send returns HTTP 201 and its replacement event identifies the launched Run. The resulting dispatch specifies Pi, `gpt-6-luna` and service tier `fast`. The public event history contains exactly one copy of the promoted Run's answer.
