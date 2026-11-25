# chat-thread-queue-pick

## chat-thread-queue-pick-001

- Vitest: "CHAT-02: queued chat thread picks > launches only the FIFO head of a waiting thread and resumes its latest session"
- Mode: run
- Given: A workspace has one running slot. A target thread has a completed native session and an unrelated Run occupies the slot.
- When: The member queues two prompts on the target thread and completes the blocker, then completes the first queued Run.
- Then: Only the first prompt launches when the blocker ends and its dispatch resumes the existing session. The second has no Run then. After the head finishes, the second gets a different Run ID and resumes the head's native session.

## chat-thread-queue-pick-002

- Vitest: "CHAT-02: queued chat thread picks > gives the freed slot to another thread that waited longer than the ending run's thread"
- Mode: run
- Given: One Run occupies the only workspace slot on thread A.
- When: The member queues on thread B before queuing again on A, then completes the original Run and later completes B's Run.
- Then: The first freed slot goes to thread B, with A's input still waiting. The second freed slot launches A's queued input using a different Run ID from the original.

## chat-thread-queue-pick-003

- Vitest: "CHAT-02: queued chat thread picks > gives the slot of a cancelled running run to a waiting thread"
- Mode: run
- Given: One started Run occupies the only workspace slot and another thread is waiting.
- When: The member cancels the active Run and the Sandbox later reports its end.
- Then: Cancel returns HTTP 200 and readback reports cancelled, but the waiting input has no Run until the end callback releases the slot. The waiting thread then launches.

## chat-thread-queue-pick-004

- Vitest: "CHAT-02: queued chat thread picks > launches an automation event appended before a user message first (strict FIFO)"
- Mode: run
- Given: A Team workspace owns a signed webhook automation and one unrelated Run occupies its sole slot.
- When: The member delivers an automation event before sending a user message on that automation thread. The unrelated Run completes, followed by the automation Run.
- Then: Neither input starts while the slot is full. The automation launches first and the later user input stays queued until that Run completes, then gets a distinct Run ID.

## chat-thread-queue-pick-005

- Vitest: "CHAT-02: queued chat thread picks > takes over input sent while the thread's run was running"
- Mode: run
- Given: An authenticated workspace member has a running Run on a thread.
- When: The member sends another input while it is running without steering acknowledgement and reports the current Run's completion.
- Then: The input launches a distinct successor Run once the running Run ends.

## chat-thread-queue-pick-006

- Vitest: "CHAT-02: queued chat thread picks > launches input exactly once when its send overlaps the thread's run failure"
- Mode: run
- Given: An authenticated member has a busy thread with one allowed simultaneous Run.
- When: The member sends a new input while the Sandbox reports failure for the prior Run, without a further wakeup.
- Then: The send returns HTTP 201. The thread history contains exactly one launched event replacing that client ID, and the thread has only the prior and successor Run IDs. The successor dispatch receives the original prompt.

## chat-thread-queue-pick-007

- Vitest: "CHAT-02: queued chat thread picks > leaves a queued automation event for the pick while steering later prompts"
- Mode: run
- Given: A Team member has a Run active on a signed webhook automation's thread.
- When: A signed automation event enters the queue, the member submits a later prompt, and the running Sandbox polls for steering.
- Then: The event feed retains one queued automation input without Run ID. The later send returns HTTP 201 and polling returns the later prompt and client ID.

## chat-thread-queue-pick-008

- Vitest: "CHAT-02: queued chat thread picks > keeps a waiting thread pickable after a concurrency update finds the organization full"
- Mode: run
- Given: A workspace has one occupied slot and two threads waiting in known arrival order.
- When: The member refreshes concurrency entitlement while the workspace is still full, then completes the blocker and later completes the older waiting Run.
- Then: No waiting input starts at refresh. The older input gets the first freed slot and the other remains queued until that Run ends, after which it still launches.

## chat-thread-queue-pick-009

- Vitest: "CHAT-02: queued chat thread picks > keeps the queued model, service tier, and effort after thread and user settings change"
- Mode: run
- Given: A member can use native subscription models, and a Run holds the only workspace slot.
- When: The member queues a prompt with Astra, fast tier and low effort, then edits the thread and account model preferences before the blocker completes.
- Then: The promoted dispatch retains the original prompt, Astra usage attribution, fast and low, while thread metadata reflects Fable, no tier and Astra effort ultra.

## chat-thread-queue-pick-010

- Vitest: "CHAT-02: queued chat thread picks > skips a recalled head and launches a later message on the thread"
- Mode: run
- Given: One active Run occupies the workspace slot and another thread has a queued prompt.
- When: The member recalls that prompt before the blocker finishes and then sends a later prompt to the waiting thread.
- Then: Recall returns HTTP 201. The thread has no Run once the blocker finishes, and later shows exactly the new prompt's Run.
