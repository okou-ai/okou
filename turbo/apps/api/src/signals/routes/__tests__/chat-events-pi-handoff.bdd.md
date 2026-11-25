# chat-events-pi-handoff

## chat-events-pi-handoff-001

- Vitest: "CHAT-02: model-first routing > passes native input \"/skill:handoff-skill first\u0020 argument\\nsecond line\" unchanged across queued and continued rounds"
- Mode: run
- Given: An authenticated owner has personal Luna on Pi, one occupied workspace slot and a resource archive endpoint that would return HTTP 503. The input starts with a skill command and includes repeated spacing and a newline.
- When: The owner queues this input, completes the Claude Run occupying the slot, and follows up on the promoted thread by appending a second-turn suffix. The Sandbox sends each usage report twice and completes each turn.
- Then: Pi receives the exact prompt text for both turns, the thread ID as its session ID, fresh native continuation first and the prior generation with Chat recovery guidance second. The second system prompt excludes the first answer. Each turn publishes one completed marker and one answer, records the thread as its native session, and leaves thread model tokens at zero. The provider receives no resource download and no history blob upload.

## chat-events-pi-handoff-002

- Vitest: "CHAT-02: model-first routing > passes native input \" \\n\\t/skill:handoff-skill first\u0020 argument\\nsecond line\" unchanged across queued and continued rounds"
- Mode: run
- Given: An authenticated owner has personal Luna on Pi and one occupied slot. The input has leading space, newline and tab before a skill command and preserves repeated spacing and a second line. A resource download would return HTTP 503.
- When: The owner queues the input, completes the blocker, and continues the promoted thread with the exact text plus a suffix. The Sandbox sends identical usage reports twice per turn and completes both.
- Then: Each dispatch preserves the input exactly, uses Pi with the thread ID, and changes from no prior native state to continuation on the previous Run's generation with Chat recovery guidance. The second system prompt omits the first answer. Readback has one completion and one answer per turn, the same native session and zero model tokens. No resource download or history blob upload occurs.

## chat-events-pi-handoff-003

- Vitest: "CHAT-02: model-first routing > passes native input \"/unknown-command first\u0020 argument\\nsecond line\" unchanged across queued and continued rounds"
- Mode: run
- Given: An authenticated owner has personal Luna on Pi and no spare slot. The input begins with an unrecognized slash command and includes repeated spacing and a newline. A resource download would return HTTP 503.
- When: The owner queues the prompt, completes the blocker and continues the resulting thread with the original text followed by a suffix. The Sandbox submits repeated usage and completes both.
- Then: Both dispatches pass the exact prompts to Pi using the thread ID, with a fresh session first and the preceding native generation plus Chat recovery guidance on continuation. The system prompt excludes the earlier answer. The owner reads one completion and one answer per turn, the thread ID as native session and zero model tokens. There are no resource downloads or history blob uploads.

## chat-events-pi-handoff-004

- Vitest: "CHAT-02: model-first routing > passes native input \"/home/user/workspace/report.txt first\u0020 argument\\nsecond line\" unchanged across queued and continued rounds"
- Mode: run
- Given: An authenticated owner has personal Luna on Pi and no spare slot. The input begins with a workspace file path and contains repeated spacing and a newline. A resource download would return HTTP 503.
- When: The owner queues the prompt, frees capacity by completing the blocker and continues the promoted thread with the same input and a suffix. The Sandbox reports usage twice per turn and completes both.
- Then: Pi receives each prompt unchanged, using the canonical thread session. It starts fresh and then continues from the previous Run generation with Chat recovery guidance, without injecting the earlier answer. Each Run exposes one completion and one answer, retains the thread session ID, and contributes no model tokens. The archive provider receives no resource downloads or history blob uploads.

## chat-events-pi-handoff-005

- Vitest: "CHAT-02: model-first routing > claims gpt-6-luna with Sandbox credentials without charging duplicate personal usage"
- Mode: run
- Given: An authenticated workspace member has a connected personal Codex account and uses standard Luna in Pi.
- When: The member sends and claims a Chat Run, the Sandbox sends two concurrent copies of the same usage event, and the member cancels the Run before the Sandbox reports its terminal result.
- Then: Dispatch specifies OpenAI Codex and Luna, without a service tier, and gives the Sandbox a credential placeholder. Both usage callbacks return HTTP 200 with success true, the Run reads back cancelled, and thread usage has zero model tokens and credits.
