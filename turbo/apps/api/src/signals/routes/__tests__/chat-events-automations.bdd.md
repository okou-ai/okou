# chat-events-automations

## chat-events-automations-001

- Vitest: "thread-bound Pi Automation execution > rotates a signed event Automation session into Pi and preserves its user conversation"
- Mode: run
- Given: A Team member owns a thread-bound signed webhook automation, completes a first Claude Code turn, and configures personal `gpt-6-luna`.
- When: The member changes the automation thread's model to Luna, posts and retries the same signed event, then sends a user prompt to that thread.
- Then: The event is accepted with duplicate false and replay returns duplicate true. It launches a distinct Run. The automation and user turn each dispatch via Codex-backed Pi on Luna, complete in the public thread and record the thread ID as their native session.

## chat-events-automations-002

- Vitest: "CHAT effort: automation launches > captures automation effort at enqueue and applies edits to later triggers"
- Mode: run
- Given: An authenticated Pro member owns a loop automation on Claude Fable 5.1. Its first Run is active with default reasoning effort max.
- When: The member saves extra effort, launches another automation input, then saves high effort before completing the first Run. They subsequently start a fresh trigger after cancelling the promoted Run.
- Then: The active-thread launch returns HTTP 201 with null immediate Run ID. Promotion creates a different Run with the captured extra effort while thread metadata shows high. A new trigger launches another Run with high effort.

## chat-events-automations-003

- Vitest: "CHAT effort: automation launches > uses route defaults for unsupported effort at automation launch"
- Mode: run
- Given: An authenticated Pro member has a loop automation and personal Claude Fable 5.1 and GPT-6 Sol access.
- When: The member launches it after saving ultracode effort on Fable and after saving high effort on Sol.
- Then: Each trigger returns HTTP 201 with no immediate Run ID and subsequently launches a distinct Run. Fable uses max and Sol uses high, including in the Pi thinking configuration. Metadata preserves the settings the member saved for each model.

## chat-events-automations-004

- Vitest: "thread-bound Pi terminal failures > settles a user-owned automation failed once without Built-in charges"
- Mode: run
- Given: An entitled workspace member runs a loop automation on personal `gpt-6.1-sol` through a Pi Sandbox.
- When: The Sandbox reports failure, then retries the failed completion.
- Then: The thread shows exactly one `run.failed` terminal event for that Run and zero built-in model credits.

## chat-events-automations-005

- Vitest: "thread-bound Pi terminal failures > settles a user-owned automation cancelled once without Built-in charges"
- Mode: run
- Given: An entitled workspace member runs a loop automation on personal `gpt-6.1-sol` through a Pi Sandbox.
- When: The member cancels the Run and the Sandbox delivers a further failure callback.
- Then: The thread shows exactly one `run.cancelled` terminal event for that Run and zero built-in model credits.
