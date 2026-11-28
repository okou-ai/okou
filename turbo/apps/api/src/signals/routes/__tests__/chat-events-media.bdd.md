# chat-events-media

## chat-events-media-001

- Vitest: "CHAT-02: run image model through public prompts > keeps a run's image guidance stable and applies member changes to subsequent turns"
- Mode: run
- Given: An entitled workspace member has the built-in default image model, then chooses Flux Pro 1.1 and later Nano Banana 2 in their preferences.
- When: The member sends three successive turns in one thread, updating the preference before the second Run and while that Run is active before sending the third.
- Then: Runner guidance reports GPT Image 2.5 Flare for the first Run, Flux Pro 1.1 for the second including after the later settings edit, and Nano Banana 2 for the third. The instructions disallow per-request model overrides, distinguish separate connector-provider selection, and continue to include the restricted-content section.

## chat-events-media-002

- Vitest: "CHAT-02: run image model through public prompts > uses the member image model when an organization slot releases"
- Mode: run
- Given: An entitled workspace member has selected Flux Pro 1.1 and has one available running slot occupied by another Chat Run.
- When: The member queues another prompt and cancels the blocker.
- Then: The promoted Run's Runner instructions identify Flux Pro 1.1 as the member's selected built-in image model.
