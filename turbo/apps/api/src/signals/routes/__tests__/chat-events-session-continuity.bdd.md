# chat-events-session-continuity

## chat-events-session-continuity-001

- Vitest: "CHAT-02: run-level model overrides > reuses Codex sessions across account switches with the newly captured account"
- Mode: run
- Given: A signed-in entitled member connects two personal Codex subscription accounts A and B through the Codex device-auth start and complete flow, with account A active, and prefers `gpt-6-astra`.
- When: The member sends a first chat message with model `gpt-6-astra` via `POST /api/chat/events`, activates account B, resolves the first Run's firewall auth, completes the first Run as `codex` via `POST /api/webhooks/run/complete`, then sends a second and third message to the same thread, completing the second Run in between.
- Then: The first Run's execution binds `CHATGPT_ACCESS_TOKEN` to account A and its firewall auth resolves `ChatGPT-Account-ID` to `chat-codex-account-a`. The second Run resumes native session `bdd-cli-<first run>`, binds account B, and its firewall auth resolves `chat-codex-account-b` with a different Authorization header. The third Run resumes `bdd-cli-<second run>` and still binds account B.

## chat-events-session-continuity-002

- Vitest: "CHAT-02: run-level model overrides > resumes Claude Code with the current model selection"
- Mode: run
- Given: A signed-in entitled member has a personal Claude Code OAuth token, prefers `claude-opus-5-5`, and has a thread whose first Run with `claude-opus-5-5` completed.
- When: The member clears the thread model selection and then sets it to `claude-sonnet-5-5` via `POST /api/chat-threads/:id/model-selection`, and sends a follow-up message to the thread via `POST /api/chat/events`.
- Then: The second Run's Runner execution resumes native session `bdd-cli-<first run>` with generation Run set to the first Run and a recovery prompt containing `okou chat messages --output-dir /tmp/okou-chat-history`, and its environment sets `ANTHROPIC_MODEL` to `claude-sonnet-5-5`.

## chat-events-session-continuity-003

- Vitest: "CHAT-02: run-level model overrides > keeps the Pi session across subscription and Auto model switches"
- Mode: run
- Given: A signed-in entitled member has a personal Codex subscription connected and prefers `gpt-6-luna`.
- When: The member sends a first message with model `gpt-6-luna`, completes it as `pi` with the thread ID as session, clears the thread model selection (Auto) and sends a second message, completes it, then sends a third message with model `gpt-6-luna`.
- Then: The first execution uses `pi` with provider `openai-codex`/`gpt-6-luna` and an empty native continuation. The second uses `pi` with provider `openrouter`, resumes the thread-ID session with generation Run set to the first Run, and includes the chat-history recovery prompt. The third uses `openai-codex`/`gpt-6-luna` and resumes the same session with generation Run set to the second Run.

## chat-events-session-continuity-004

- Vitest: "CHAT-02: run-level model overrides > retains the newer claude-code producer after delayed initialization and repeated completion"
- Mode: run
- Given: A signed-in entitled member uses the native `claude-fable-5-1` route (row `claude-code`). A first Run posted an init event with session S1 and completed with S1.
- When: A second Run in the same thread posts an init event with a new session S2 and completes with S2; afterwards the first Run posts a delayed init event (sequence 1) for S1 and a repeated completion to `POST /api/webhooks/run/complete`, and the member sends a third message.
- Then: The second Run resumes S1 from the first Run, the first Run reads back as `completed`, and the third Run resumes S2 with generation Run set to the second Run.

## chat-events-session-continuity-005

- Vitest: "CHAT-02: run-level model overrides > retains the newer pi producer after delayed initialization and repeated completion"
- Mode: run
- Given: A signed-in entitled member has a personal Codex subscription with `gpt-6-luna` on the `pi` framework (row `pi`), and the session ID is the thread ID. A first Run posted an init event and completed.
- When: A second Run in the same thread posts an init event and completes; afterwards the first Run posts a delayed init event (sequence 1) and a repeated completion to `POST /api/webhooks/run/complete`, and the member sends a third message.
- Then: The second Run resumes the thread session from the first Run, the first Run reads back as `completed`, and the third Run resumes the session with generation Run set to the second Run.

## chat-events-session-continuity-006

- Vitest: "CHAT-02: run-level model overrides > saves a released Run's recovery outputs without replacing a newer native binding"
- Mode: run
- Given: A signed-in entitled member on the native `claude-fable-5-1` route has a first Run that failed with "Runner fallback", followed by a second Run in the same thread that completed with native session S2.
- When: The first Run's sandbox posts late run outputs (claude-code, a new session ID, `native_only`) twice to `POST /api/webhooks/run/complete`, and the member sends a third message to the thread.
- Then: Both posts return HTTP 200, the first Run stays `failed` with a framework session ID and storage outputs in its result, and the repeated post leaves the result unchanged. The third Run resumes S2 with generation Run set to the second Run.

## chat-events-session-continuity-007

- Vitest: "CHAT-02: run-level model overrides > keeps the first native context fresh when initialization arrives after a failed Run released its slot"
- Mode: run
- Given: A signed-in entitled member on the native `claude-fable-5-1` route has a first Run that failed before native initialization (row "failed").
- When: The failed Run's sandbox posts a late init event with a new session to `POST /api/webhooks/run/events` (HTTP 200), and the member sends a second message to the thread.
- Then: The second Run starts with no native session and no generation Run, and includes the recovery prompt `okou chat messages --output-dir /tmp/okou-chat-history`.

## chat-events-session-continuity-008

- Vitest: "CHAT-02: run-level model overrides > keeps the first native context fresh when initialization arrives after a cancelled Run released its slot"
- Mode: run
- Given: A signed-in entitled member on the native `claude-fable-5-1` route has a first Run that was cancelled before native initialization (row "cancelled").
- When: The cancelled Run's sandbox posts a late init event with a new session to `POST /api/webhooks/run/events` (HTTP 200), and the member sends a second message to the thread.
- Then: The second Run starts with no native session and no generation Run, and includes the recovery prompt `okou chat messages --output-dir /tmp/okou-chat-history`.

## chat-events-session-continuity-009

- Vitest: "CHAT-02: run-level model overrides > captures claude-code initialization during cancellation recovery before releasing the slot"
- Mode: run
- Given: A signed-in entitled member on the native `claude-fable-5-1` route (row `claude-code`) cancels a first Run while it executes.
- When: The cancelled Run's sandbox posts an init event with a new session, then reports exit code 1 "Run cancelled" without completion metadata, and the member sends a second message to the thread.
- Then: The first Run reads back as `cancelled`, and the second Run resumes the session from the init event with generation Run set to the first Run.

## chat-events-session-continuity-010

- Vitest: "CHAT-02: run-level model overrides > captures pi initialization during cancellation recovery before releasing the slot"
- Mode: run
- Given: A signed-in entitled member has a personal Codex subscription with `gpt-6-luna` on `pi` (row `pi`) and cancels a first Run while it executes.
- When: The cancelled Run's sandbox posts an init event with the thread ID as session, then reports exit code 1 "Run cancelled" without completion metadata, and the member sends a second message to the thread.
- Then: The first Run reads back as `cancelled`, and the second Run resumes the thread-ID session with generation Run set to the first Run.

## chat-events-session-continuity-011

- Vitest: "CHAT-02: run-level model overrides > preserves the claude-code binding when initialization, completion and cancellation overlap"
- Mode: run
- Given: A signed-in entitled member on the native `claude-fable-5-1` route (row `claude-code`) has a running first Run.
- When: The sandbox's init event, the sandbox's successful completion with the same session, and the member's cancel request (accepted with HTTP 200 or 400) are sent concurrently, then the member sends a second message to the thread.
- Then: The first Run settles as `completed` or `cancelled`, and the second Run resumes the initialized session with generation Run set to the first Run.

## chat-events-session-continuity-012

- Vitest: "CHAT-02: run-level model overrides > preserves the pi binding when initialization, completion and cancellation overlap"
- Mode: run
- Given: A signed-in entitled member has a personal Codex subscription with `gpt-6-luna` on `pi` (row `pi`) and a running first Run; the session ID is the thread ID.
- When: The sandbox's init event, the sandbox's successful completion with the same session, and the member's cancel request (accepted with HTTP 200 or 400) are sent concurrently, then the member sends a second message to the thread.
- Then: The first Run settles as `completed` or `cancelled`, and the second Run resumes the thread-ID session with generation Run set to the first Run.

## chat-events-session-continuity-013

- Vitest: "CHAT-02: run-level model overrides > resumes the thread's latest session when a waiting input is picked"
- Mode: run
- Given: The concurrent Run limit cap is 2. A signed-in entitled member on the native `claude-fable-5-1` route has a thread whose first Run completed, and two other Runs occupy both organization slots.
- When: The member sends a follow-up message to the thread via `POST /api/chat/events`, which waits for capacity, and then one blocker Run is cancelled.
- Then: The waiting input launches a Run that reads back as `running` and resumes native session `bdd-cli-<first run>`.

## chat-events-session-continuity-014

- Vitest: "CHAT-02: run-level model overrides > uses the previous Run's resource and recovers native context across claude-fable-5-1 -> gpt-6-astra -> claude-fable-5-1"
- Mode: run
- Given: A signed-in entitled member has native Claude and Codex subscriptions and prefers `claude-fable-5-1` (row from `claude-fable-5-1`/`claude-code` to `gpt-6-astra`/`codex`). The first Run's Runner stops admitting work and a second single-slot Runner registers.
- When: The member sends a first message with `claude-fable-5-1`, a second with `gpt-6-astra`, both completed, then both Runners report a held sandbox for `thread:<threadId>` from their Runs and the member sends a third message with `claude-fable-5-1`.
- Then: The first Run uses `claude-code` and completes with a framework session. The second uses `codex` with `OPENAI_MODEL` `gpt-6-astra`, no native session, the chat-history recovery prompt, runs on the second Runner and completes with framework `codex`. The third is dispatched to the second Runner with reuse key `thread:<threadId>`, uses `claude-code` with no native session and the recovery prompt, and the thread shows both earlier prompts.

## chat-events-session-continuity-015

- Vitest: "CHAT-02: run-level model overrides > uses the previous Run's resource and recovers native context across gpt-6-astra -> claude-fable-5-1 -> gpt-6-astra"
- Mode: run
- Given: A signed-in entitled member has native Claude and Codex subscriptions and prefers `gpt-6-astra` (row from `gpt-6-astra`/`codex` to `claude-fable-5-1`/`claude-code`). The first Run's Runner stops admitting work and a second single-slot Runner registers.
- When: The member sends a first message with `gpt-6-astra`, a second with `claude-fable-5-1`, both completed, then both Runners report a held sandbox for `thread:<threadId>` from their Runs and the member sends a third message with `gpt-6-astra`.
- Then: The first Run uses `codex` and completes with a framework session. The second uses `claude-code` with `ANTHROPIC_MODEL` `claude-fable-5-1`, no native session, the chat-history recovery prompt, runs on the second Runner and completes with framework `claude-code`. The third is dispatched to the second Runner with reuse key `thread:<threadId>`, uses `codex` with no native session and the recovery prompt, and the thread shows both earlier prompts.

## chat-events-session-continuity-016

- Vitest: "CHAT-02: run-level model overrides > requires Chat recovery after a Framework switch"
- Mode: run
- Given: A signed-in entitled member has native Claude and Codex subscriptions and a thread whose first `claude-fable-5-1` Run completed with two narration events and a final answer that appear in the thread.
- When: The member sets the thread model selection to `gpt-6-astra` via `POST /api/chat-threads/:id/model-selection` and sends a follow-up message.
- Then: The second Run starts with no native session and no generation Run, includes the recovery prompt `okou chat messages --output-dir /tmp/okou-chat-history`, and its platform environment sets `OKOU_CHAT_THREAD_ID` to the thread ID.

## chat-events-session-continuity-017

- Vitest: "CHAT-02: run-level model overrides > recovers durable Chat after an executed attempt was failed before initialization"
- Mode: run
- Given: A signed-in entitled member on the native `claude-fable-5-1` route sends a first message whose execution has an empty native continuation, and the Run fails before native initialization (row "failed").
- When: The member sends "retry with the same model" to the thread with model `claude-fable-5-1`.
- Then: The second Run's appended system prompt contains `# Incomplete Rounds Context` and `User: <first prompt>`, it uses the same CLI agent type as the first, and it starts with no native session and no generation Run but with the chat-history recovery prompt.

## chat-events-session-continuity-018

- Vitest: "CHAT-02: run-level model overrides > recovers durable Chat after an executed attempt was cancelled before initialization"
- Mode: run
- Given: A signed-in entitled member on the native `claude-fable-5-1` route sends a first message whose execution has an empty native continuation, and the member cancels the Run before native initialization (row "cancelled").
- When: The member sends "retry with the same model" to the thread with model `claude-fable-5-1`.
- Then: The second Run's appended system prompt contains `# Incomplete Rounds Context` and `User: <first prompt>`, it uses the same CLI agent type as the first, and it starts with no native session and no generation Run but with the chat-history recovery prompt.

## chat-events-session-continuity-019

- Vitest: "CHAT-02: run-level model overrides > keeps durable Chat and native identity independent of a history archive"
- Mode: run
- Given: A signed-in entitled member on the native `claude-fable-5-1` route has a running first Run.
- When: The sandbox reports completion with invalid session IDs `../foreign-session` and a 256-character ID, then posts an assistant answer event and completes with session `discarded-cli-<run>`; the member then sends a follow-up message and the second Run completes.
- Then: Each invalid completion returns HTTP 400 and the Run stays `running`; the valid completion makes it `completed`. The second Run's prompt is exactly the follow-up text, it resumes the first Run's public framework session with generation Run set to the first Run, and after completion its framework session is `bdd-cli-<second run>`.

## chat-events-session-continuity-020

- Vitest: "CHAT-02: run-level model overrides > resumes a sticky model through personal credential replacement and reconnect"
- Mode: run
- Given: A signed-in entitled member on the native `claude-fable-5-1` route has a thread whose first `claude-fable-5-1` Run completed, and the thread list events show a `created` event with selected model `claude-fable-5-1`.
- When: The member replaces the personal Claude Code OAuth token and sends a second message; then deletes the personal Claude Code provider (HTTP 204), reconnects a personal subscription for `claude-fable-5-1`, and sends a third and a fourth message, completing each Run.
- Then: The second Run uses the personal `CLAUDE_CODE_OAUTH_TOKEN` placeholder, `ANTHROPIC_MODEL` `claude-fable-5-1`, and resumes `bdd-cli-<first run>`; the third uses the placeholder, `claude-code`, and resumes `bdd-cli-<second run>`; the fourth resumes `bdd-cli-<third run>`. Completed Runs report their own `bdd-cli-<run>` sessions, and no `model_selection_updated` event to `claude-fable-5-1` appears for the thread.

## chat-events-session-continuity-021

- Vitest: "CHAT-02: run-level model overrides > rejects an explicit disconnected personal model instead of capturing Auto"
- Mode: run
- Given: A signed-in entitled member prefers `claude-fable-5-1` and has no personal subscription connected for `gpt-6-luna`.
- When: The member sends `POST /api/chat/events` with model `gpt-6-luna`.
- Then: The send returns HTTP 201, the thread events contain an `input.rejected` event and no event with a Run ID, and the thread metadata keeps selected model `gpt-6-luna`.
