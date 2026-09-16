# Pi 0.85.1 pending-tool integration

`AgentSession.continuePendingTools()` is a local additive API, paired with
`Agent.continuePendingTools()` and their declarations. Upstream `continue()`
and both low-level continuation APIs reject a trailing assistant; consuming
queued input is not an equivalent handoff. Keep the version pinned at exactly
0.85.1; the three patches are based on the official npm distribution for that
version, not a replacement copy of the 0.84.1 loop.

The entrypoint validates the current assistant and its unresolved calls, then
claims native Agent ownership before session startup acknowledgement or any
awaited event/tool work. The existing loop handles the pending assistant's
tools without emitting or appending that assistant or its original user again.
It retains argument preparation, hooks, sequential/parallel execution, partial
updates, result metadata, persistence, turn preparation, and the length guard.

The Agent's native abort controller remains active through AgentSession's
post-run retry/compaction/queue handling and awaited terminal extension hooks.
These run within the original lifecycle through the integration callbacks;
`finishRun()` releases it only afterwards. Normal prompt calls retain their
existing post-run path. Optional signals on shared session helpers identify
the pending operation; retry/compaction retain their own explicit abort controls
while also observing that native owner. A fresh explicit prompt obtains a new
signal.

For this entrypoint, extension `agent_settled` handlers are awaited preparation,
called once per owner while both native lifecycles remain busy. They can queue
input or request cancellation through the supported, non-waiting `ctx.abort()`;
they must not wait for their own owner to become idle. New turns caused by that
input retain ordinary turn/message hooks, but do not re-enter settlement
handlers. The public `agent_settled` event is the terminal commit notification.

After preparation, the same owner reconciles cancellation first. Otherwise it
drains accepted input in native steering/follow-up order, including post-run
retry/compaction, and rechecks after every await. An empty queue and un-aborted
signal close admission synchronously with public settlement and owner release.
There is no asynchronous callback after this decision.

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
in #32651 for #32637. Its six JS/declaration hunks are rebased onto 0.85.1's
shared shell factories without replacing upstream context-cwd or spool-prefix
selection. The existing `bash-spool.test.ts` and real child/file fixtures are
preserved unchanged; see `packages/pi-agent-runtime/bash-spool-backpressure.md`.

## 0.85.1 next-response preparation

Retain upstream `lastCompletedTurn`: prepare only before an actual next model
response, including after a pending-tool handoff. The SDK's new pre-response
compaction estimates context after tool results. Its native signal now reaches
auto-compaction, summary authentication checks, the shared
`_runDefaultCompaction` helper, summary retry, and extension preparation. Keep
upstream compaction-failure events and their cancellation outcome consistent.
Do not move preparation back to the end of every completed turn.

The pending owner peeks its native steering/follow-up queues until `message_end`
commits each selected message. This preserves already-polled input if the new
preparation await is cancelled. Cancellation settlement still closes admission
and drains those same queues; there is no new journal or restoration queue.
Upstream's second steering poll remains conditional on an empty first poll, so
one-at-a-time admission does not deliver two messages in one response.

Upstream 0.85.1 also defers context-only custom messages while streaming to
avoid inserting them between tool calls and results. Flush that existing
custom-message queue before and after terminal extension preparation and at
the final settlement boundary. These messages must reach native state, JSONL
and message events before public settlement, without triggering another model
request. The regression covers messages accepted during a tool and an awaited
settlement extension, with successful and cancelled outcomes.

API first-turn preflight still compares a settled checkpoint against the public
pre-prompt compaction semantics and delegates unproven cases to the sandbox.
The API transport issues one response only; next-response compaction belongs
to the sandbox's native continuation. `MemoryPiSession` remains byte-backed.
The restricted Phase 2 system-prompt equality check includes the exact trailing
newline added by 0.85.1; its tools, model, ownership and prompt body are unchanged.

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
newline is deliberate. `session-version-compatibility.test.ts` opens it using
0.85.1, runs only the unresolved call, follows up, and checks the original byte
prefix, session identity, branch entries, and settled memory projection.
The upstream reader repairs only the missing final newline before appending.

A separate official 0.84.1 installation also reads a 0.85.1-written continuation
with a new branch summary and usage-bearing compaction. Old/new readers produce
identical entries, active branch and projected context (18 entries, 16 active
branch entries, 5 context messages). This is representative fixture evidence,
not a production-history replay. Session format remains v3, with no migration
or rewrite of existing records.

The dependency graph introduces upstream `chord@0.85.1`, upgrades the Pi
telemetry/TUI and provider SDK dependencies, and removes the former runtime
client/protocol dependency edges. Okou still imports the root modular SDK;
`./rpc-entry`, the experimental client/harness, model admission, defaults,
provider routes, tiers and billing policy are not changed. Verify the actual
packed CLI, including Photon worker and fallback, after every bundle change.
