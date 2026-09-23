# Pi 0.87.1 pending-tool integration

`AgentSession.continuePendingTools()` is a local additive API, paired with
`Agent.continuePendingTools()` and their declarations. Upstream `continue()`
and both low-level continuation APIs reject a trailing assistant; consuming
queued input is not an equivalent handoff. Keep the version pinned at exactly
0.87.1; the three patches are based on the official npm distribution for that
version.

## 0.87.1 rebase and model admission

Pi 0.87.1 adds native catalog entries for Claude Opus 5.5, GPT 6 Sol and GPT 6
Luna. The core patch retains unresolved-tool continuation while preserving
0.87's `prepareRequest` and `finishTurn` boundaries. A resumed assistant skips
both request preparation and streaming, then runs the pending tools through the
ordinary turn-finish decision. The coding-agent patch retains its queued
follow-up notification; the upstream queue gained `peek()` but still needs the
local `remove()` used by the patched Agent settlement path. The pi-ai patch
applies unchanged in behavior to the 0.87.1 package.

The 0.87 release also introduced `context_edit` session entries and made the
SessionManager's projected context authoritative. An older reader can parse
these JSONL records but does not apply their context edits, so a rollback may
restore abandoned model attempts to provider context. Release and rollback
must follow [deployment compatibility](../../docs/deployment-compatibility.md);
the tests below do not prove a production rollback is safe.

The entrypoint validates the current assistant and its unresolved calls, then
claims native Agent ownership before session startup acknowledgement or any
awaited event/tool work. The existing loop handles the pending assistant's
tools without emitting or appending that assistant or its original user again.
It retains argument preparation, hooks, sequential/parallel execution, partial
updates, result metadata, persistence, turn preparation, and the length guard.

## Cancellation convergence on 0.86.1

Through 0.85.1 this integration threaded an explicit signal through the shared
session helpers, because upstream had no cancellation of its own between the
post-run steps. 0.86.1 added that mechanism natively: `_agentRunAbortRequested`
with `_finishCancelledRetry()`, a signal-bearing
`_getSummarizationRequestAuth(model, signal)`, and a `_runAutoCompaction` that
owns an `AbortController` and calls `signal.throwIfAborted()` around auth, the
`session_before_compact` extension, `_runDefaultCompaction` and the pre-persist
boundary.

Those upstream paths and this integration are driven by the same cancellation
entry point. `this.agent.abort()` has exactly two call sites in
`agent-session.js` — `abort()` and `dispose()` — and each aborts the retry,
auto-compaction and branch-summary controllers in the same synchronous block
that aborts the native Agent. The signal this integration used is the native
Agent run signal, so the previous per-helper threading duplicated a guarantee
upstream now provides.

The signal-passthrough hunks were therefore **deleted rather than stacked**:
`_handlePostAgentRun`, `_checkCompaction`, `_runAutoCompaction`,
`_prepareRetry`, `_compactBeforeNextAssistantResponse` and the combined
`AbortSignal.any` wiring all keep their upstream signatures. Five hunks remain
in `agent-session.js`: the `continuePendingTools()` entrypoint, the
`_queueSteer` / `_queueFollowUp` admission order, and `waitForIdle()`. The
entrypoint resets `_agentRunAbortRequested` on start, matching
`_runAgentPrompt`, and calls `_finishCancelledRetry()` at settlement instead of
carrying a second signal.

Restore per-helper threading only with evidence that a cancellation entry point
exists which does not abort those controllers together. A version bump alone is
not that evidence; re-read both `agent.abort()` call sites first.

For this entrypoint, extension `agent_settled` handlers are awaited preparation,
called once per owner while both native lifecycles remain busy. They can queue
input or request cancellation through the supported, non-waiting `ctx.abort()`;
they must not wait for their own owner to become idle. New turns caused by that
input retain ordinary turn/message hooks, but do not re-enter settlement
handlers. The public `agent_settled` event is the terminal commit notification.

After preparation, the same owner reconciles cancellation first. Otherwise it
drains accepted input in native steering/follow-up order, including post-run
retry/compaction, and rechecks after every await. An empty queue and an
unrequested abort close admission synchronously with public settlement and owner
release. There is no asynchronous callback after this decision.

When cancellation wins, native queue admission closes before awaited message
callbacks. Accepted input is drained once into native message events and JSONL,
without a new turn, tool, HTTP request, retry or compaction. The final assistant
outcome is aborted before the sole public settlement. If a provider already
emitted an aborted assistant, retain that fact instead of appending a duplicate;
subsequently accepted input can follow it in history. A fresh prompt sees those
messages as persisted context, never as a revived pending queue. Input arriving
after admission closes receives the existing RPC error response, before queue
display state changes. Guest therefore retains its existing failed-delivery
path; successful acknowledgements never rely on a future prompt or process.

Cancellation gates surround awaited context conversion, auth, turn preparation,
and prepared-tool entry. Started tools and event callbacks are joined even if
a sibling fails. Interrupted/unstarted calls retain upstream history handling;
there is no second result journal, replay engine, or checkpoint format.

Cancellation is cooperative: completed external effects are not rolled back,
and a tool that ignores cancellation can delay settlement. Guest's existing
10-second RPC abort acknowledgement deadline and child termination/reaping
remain authoritative; this patch changes neither the protocol nor that bound.

`pending-tool-cancellation.test.ts` uses real sessions/files, MSW and barriers in
owned child tests. `rpc-cancellation.test.ts` drives the official stdin/stdout
host with a separate kill deadline, including delayed settlement extensions.
Its normalized aborted terminal fixture is also consumed by Guest's public
CLI settlement integration test. Existing memory, route, handoff-mode and
history-validation tests cover the surrounding contracts.

When editing the integration, change the matching compiled JS and `.d.ts`
patch hunks together, regenerate the pnpm patch hashes, and verify a frozen
install plus the runtime/CLI type, build and focused test checks. Preserve the
independent photon and provider account-binding patches.

The coding-agent patch also retains the Bash spool backpressure repair merged
in #32651 for #32637, rebased onto 0.86.1's shared shell factories without
replacing upstream context-cwd or spool-prefix selection. 0.86.1 changed the
surrounding exit semantics: a signal-killed shell now reports `128 + signal`
instead of a bare code, and upstream itself raises when `exitCode` is `null`
(upstream #9577), so this patch keeps upstream's wording there and no longer
carries its own workaround for that case. The existing `bash-spool.test.ts` and
real child/file fixtures are preserved unchanged; see
`packages/pi-agent-runtime/bash-spool-backpressure.md`.

## 0.86.1 tool-loadout declaration

0.86.1 moved the system prompt and tool loadout into the transcript. The agent
loop calls `declareToolChanges([...prepared, ...pending])` before each request
and inserts a `system` message carrying `toolsAdded` / `toolsRemoved`.

`runAgentLoopPendingTools()` must skip that injection block entirely. A
pending-tool continuation resolves the previous assistant's calls and issues no
model request in that pass, so declaring a tool change there would append a
`system` entry that no request ever consumed.

## 0.86.1 next-response preparation

Retain upstream `lastCompletedTurn`: prepare only before an actual next model
response, including after a pending-tool handoff. The SDK's pre-response
compaction estimates context after tool results, and 0.86.1 owns its own
cancellation across auto-compaction, summary authentication, the shared
`_runDefaultCompaction` helper, summary retry and extension preparation. Keep
upstream compaction-failure events and their cancellation outcome consistent.
Do not move preparation back to the end of every completed turn.

The pending owner peeks its native steering/follow-up queues until `message_end`
commits each selected message. This preserves already-polled input if the new
preparation await is cancelled. Cancellation settlement still closes admission
and drains those same queues; there is no new journal or restoration queue.
Upstream's second steering poll remains conditional on an empty first poll, so
one-at-a-time admission does not deliver two messages in one response.

Upstream defers context-only custom messages while streaming to avoid inserting
them between tool calls and results. Flush that existing custom-message queue
before and after terminal extension preparation and at the final settlement
boundary. These messages must reach native state, JSONL and message events
before public settlement, without triggering another model request. The
regression covers messages accepted during a tool and an awaited settlement
extension, with successful and cancelled outcomes.

API first-turn preflight still compares a settled checkpoint against the public
pre-prompt compaction semantics and delegates unproven cases to the sandbox.
The API transport issues one response only; next-response compaction belongs
to the sandbox's native continuation. `MemoryPiSession` remains byte-backed.
The restricted Phase 2 system-prompt equality check is re-pinned to 0.86.1's
rendering — named sections joined by a blank line, with the working directory
as a `<cwd>` block — and still recomputes its digest from the rendered prompt
rather than a hardcoded value. Its tools, model, ownership and prompt body are
unchanged.

## Provider-declared queue expiry

For #34461, the pi-ai patch shares one exact-message predicate between
`isRetryableProviderError` and `isRetryableAssistantError`. Both reject the
observed 900-second queue-expiry failure before generic timeout/5xx matching
or retry hints. Error objects, messages, ordinary backoff and retry settings
remain unchanged. The same native assistant predicate owns summary retries.
`provider-queue-timeout.test.ts` exercises real HTTP and stream failures,
native session settlement, an earlier transient, completed tools, cancellation
and independent accepted input. The shared provider-failure fixture protects
diagnostic precedence in TypeScript and Rust.

0.86.1 changed the label these errors carry: the prefix is the provider id
(`deepseek API error (503):`) rather than a fixed `OpenAI API error`. The
predicate's prefix strip is therefore provider-agnostic. A prefix list limited
to OpenAI and Anthropic silently stops matching on every other provider, and
both retry owners then keep retrying an expired queue; the regression covers
that case directly.

The same patch carries the structured retry classification merged for #35819
(`OKOU_RETRYABLE_MODEL_REQUEST_REASONS` / `isOkouRetryableModelRequest`),
ported from the 0.85.1 patch during this upgrade.

Remove these hunks and their helper together only when the pinned upstream SDK
implements the same terminal behavior at both retry owners and these boundary
tests pass against it. A version bump alone is insufficient. Regenerate the
patch and pnpm hash using `pnpm patch` / `pnpm patch-commit`; retain the other
independent integration hunks.

## Session compatibility

`src/test/fixtures/pi-0.84.1-session.jsonl` in `pi-agent-runtime` was generated
with official npm `pi-coding-agent@0.84.1` and `pi-ai@0.84.1`. It contains session
v3, model/thinking entries, an abandoned branch, a branch summary, a compaction
boundary, and one resolved plus one unresolved tool call. Its missing trailing
newline is deliberate. `session-version-compatibility.test.ts` opens it using the
pinned runtime, runs only the unresolved call, follows up, and checks the original
byte prefix, session identity, branch entries, and settled memory projection.
The upstream reader repairs only the missing final newline before appending.

Session format remains v3 across this upgrade, with no migration or rewrite of
existing records. A separate official 0.85.1 installation reads a 0.86.1-written
continuation with identical session id, entries and active branch. The projected
context is not identical in shape: 0.86.1 records the transcript `system` entry,
and a 0.85.1 reader projects it into `buildSessionContext().messages` while its
own LLM boundary discards it. Rolling back to 0.85.1 is therefore readable but
semantically lossy for the prompt and tool loadout, which the runtime rebuilds
per run anyway. This is representative fixture evidence, not a production-history
replay.

The dependency graph upgrades the Pi telemetry/TUI and provider SDK
dependencies: `@smithy/node-http-handler` to 4.12.1 — matched by
`pi-agent-runtime`'s own pin because `PiBedrockHttpHandler` extends it —
`@aws-sdk/client-bedrock-runtime` to 3.1127.0, `@google/genai` to 2.21.0,
`@anthropic-ai/sdk` to 0.124.0, `undici` to 8.10.2 and `chalk` to 6.0.0.
`engines.node` is unchanged. Okou still imports the root modular SDK;
`./rpc-entry`, the experimental client/harness, model admission, defaults,
provider routes, tiers and billing policy are not changed. Verify the actual
packed CLI, including Photon worker and fallback, after every bundle change.

## Behaviour pinned off at this version

0.86.1 turns on three behaviours by default that this upgrade deliberately does
not adopt, so that the version bump carries no wire or cost change of its own:

- Codex strict JSON-schema tools. The `openai-codex-responses` gate is
  `model.compat?.supportsStrictMode ?? true` and the Codex catalog never sets
  the field, so `resolvePiAgentModel` pins it to `false` for that dialect.
  `anthropic-messages`, `bedrock-converse-stream` and `openai-responses` all
  default to `false` upstream and need no pin.
- Prompt cache warming, whose unset mode resolves to `streaming`. It is pinned
  off through `setCacheWarmingMode("off")`, which is the effective setter;
  writing `settings` directly does not work because the mode getter reads
  `globalSettings`, and the setter does not persist to disk, so a disk-backed
  settings path keeps its project configuration.

Mid-conversation system messages are the exception and are allowed through:
0.86.1's Codex catalog sets `supportsMidConvoSystemMessages` and
`resolvePiAgentModel` copies `source.compat` wholesale. Suppressing it would
require a compat-copy exception and would construct a combination upstream does
not test.
