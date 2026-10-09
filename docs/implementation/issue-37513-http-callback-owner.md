# Issue #37513: D3 HTTP callback ownership

Related to #37513. Bounded HTTP dispatch and bookkeeping WRITE closure, not
whole-callback or epic completion. Base: `a2678f2d37ccf9d9fdff1f5841e41ca68559f80c`.

## Actual closed chain

The sole HTTP caller remains `dispatchRunCallbacks$`, now calling the private,
stable module-scope `dispatchHttpCallback$` through `set`. Its input contains
only callback/run/status/result/error, feature context and balance facts; the
`DispatchSingleCallbackInput.db` capability and caller field are removed.
The private stable `recordHttpCallbackDelivery$` locally obtains
`set(writeDb$)` and owns all three direct UPDATE shapes. The old handle-taking
`markCallbackAttemptStarted`, `markCallbackDelivered` and `markCallbackFailed`
helpers are deleted; no caller remains. No node/accessor/executor adapter,
escaping closure, mutable argument slot, factory at command time, dynamic
import, re-export, or new public command is introduced.

The unchanged outer callers are completion/recovery (two calls in
`agent-webhook-complete.service.ts`), cancellation (`run-cancel.service.ts`),
Pi (`pi-memory-phase2-worker.service.ts`) and existing workflow execution
(`routes/test-workflow-automation-execution.ts`). The real `writeDb$` command
in `signals/external/db.ts` calls the existing `lib/db` connection provider.

This is the original D3 caller snapshot. [#37440 batch017](issue-37440-batches/batch-017.md)
subsequently removes the test-only workflow callback dispatcher. Its retained
terminal-failure matrix uses real Runner completion/cancellation callbacks;
the production dispatch callers and this D3 ownership implementation remain.

## HTTP protocol and cancellation

Missing URL or encrypted secret still writes failed once and returns failure,
without an attempt. Otherwise decryption precedes attempt persistence. The
existing JSON body, balance-error formatting, `Math.floor(now() / 1000)`
timestamp, HMAC, headers, development tunnel URL rewrite and optional Vercel
bypass header are preserved. Fetch is still POST with the existing body/headers,
settled at the same boundary. Thrown Error messages, Unknown error fallback and
HTTP status/statusText error classification are unchanged.

This slice is **ownership refactoring plus an explicitly authorized cancellation
behavior change**, not full behavioral equivalence. Following Ethan's "keep it
simple for now" direction after discussing possible future Svix adoption, both
commands use the caller-owned final positional `AbortSignal`. HTTP dispatch
checks it after the non-signal-aware decryption and settled fetch awaits. Its
bookkeeping command checks it immediately after each SQL await; sub-command
calls propagate those checks. There is no pre-SQL check, new `fetch.signal`,
key-interface change, or new timeout. The parent's original post-dispatch
observation remains. D1 internal production code is unchanged, and HTTP does
not add a generic skip-checks protocol.

Cancellation observed after decryption prevents attempt persistence and fetch.
Cancellation observed after attempt persistence prevents fetch. Cancellation
observed after a completed HTTP request prevents its result UPDATE, leaving the
callback pending/attempt-started (or its pre-existing failed status) despite the
external request. Existing later redrive can send the same callback again. A
post-result-SQL cancellation can propagate even though that result committed.
Missing URL/secret still executes its single failed UPDATE, but cancellation
observed after that write propagates instead of returning the normal failure.

This remains best-effort with existing recovery, not exactly-once or guaranteed
delivery. Callback ID/HMAC/payload retain the existing protocol; this does not
prove every receiver deduplicates. No outbox, Svix dependency, delivery receipt,
background queue, default swallowed error or fallback protocol is implemented.
Svix is only a future discussion. Existing SQL and decryption/stringification
failures still propagate without new recovery.

## SQL, clocks, decoder and transaction accounting

| Stage     | SET columns               | Ordered bindings                         |
| --------- | ------------------------- | ---------------------------------------- |
| Attempt   | attempts, last_attempt_at | 1, nowDate timestamp, callbackId         |
| Delivered | status, delivered_at      | delivered, nowDate timestamp, callbackId |
| Failed    | status, last_error        | failed, error string, callbackId         |

Every WHERE remains callback-ID-only. Attempts is assignment 1, not increment.
`nowDate()` runs at attempt/delivered writes; failed does not call it. Other
attempt/date/error fields are not cleared. No RETURNING, selected decoder,
schema, payload interpretation or query/index change is introduced.
A normal uncancelled completed HTTP dispatch has two UPDATE round trips;
missing URL/secret has one; decryption failure or abort after decryption has
zero. Abort after the attempt or settled fetch leaves one UPDATE; abort after
the result write leaves two. The three SQL shapes/bindings are unchanged, but
cancellation can now change which writes execute. Attempt/result SQL failures
retain their existing partial boundaries. No production performance claim is
made.

Explicit transactions before/after: zero. Removed: zero; combined: zero;
retained: zero; moved: zero. Each UPDATE retains autocommit atomicity and all
external I/O remains outside SQL transactions. No CAS, lock, retry, timeout or
coordination mechanism is added. Offline Drizzle serialization of the actual
old helper and new owner expressions confirms all three SQL strings and ordered
bindings are identical for a fixed synthetic ID/error/clock. No SQL is executed
by that audit; it is not behavioral test coverage.

## Public evidence and limitations

Existing public cancellation/recovery test remains: one ordinary HTTP callback
receives a provider 503 and repeated cancellation does not redeliver it. This
case now also checks the received Content-Type, timestamp, optional Vercel
bypass, HMAC computed independently with Node crypto, and JSON run/status/payload
at the MSW provider boundary. Assertions run outside the provider handler so
fetch settlement cannot swallow a test assertion failure. Counts and existing
cancellation assertions are retained. No test is removed or weakened.

The case retains its pre-existing callback fixture setup through the test
Telegram route; this PR does not add a production test hook, new fixture writer,
internal node mock, SQL/DB-row/log assertion, or claim that that setup is a
production callback-registration API. Related chat-callback completion/cancel/
recovery, run-lifecycle and workflow scheduler suites remain required on the
new PR head. Old D1 totals are not new-head acceptance.

Missing URL/secret historical rows are not newly exercised public cases. No
legal production API was identified to force this callback dispatch's exact
request-owned AbortSignal at decryption, SQL or fetch settlement. Therefore the
new cancellation interleavings and recovery duplicate-send risk are explicitly
unverified behavior coverage gaps, not proven by the ordinary 503 test. Successful
HTTP and thrown-provider-error branches, development tunnel rewrite and exact
clock timing likewise require their actual available public coverage to be
reported; header/body assertions on the 503 cancellation scenario do not prove
all branches. No internal controls are added to force them.

## Explicit deferred scope and verification

Outer `DispatchRunCallbacksInput.db`, Run/callback READs, undelivered query and
rechecks, Pi maintenance, chat/Feishu/workflow owners and D2 deleted-thread writes
remain unchanged. D2 file overlap is not a dependency or merge-order claim.

Normal formatting/static/lint/types/Knip and configured hooks must succeed;
heavy-check deferral granted to D2 does not apply here. No local Vitest or
local devserver is run. All eight API shards, four required gates and relevant
public suite results must be recorded for the exact new head before stopping
for independent review. A resource/check failure stops commit/push and preserves
the draft; no rule/config waiver, disabled hook, retry, suppression or budget
adjustment is allowed. This slice has no queue/merge, pr-auto, release or deploy
authority.

The initial draft failed ESLint `api/signal-check-await` at the decryption and
settled-fetch awaits and stopped without commit/push. That failure remains a
failure; this revision follows the subsequent explicit behavior-change
instruction rather than disabling or hiding the rule. The resumed revision
passes affected formatting/ESLint, normal API Oxlint including import-cycle and
128-line rules, affected type-aware Oxlint, full API check-types and workspace
Knip. The real executable commit-msg hook accepts the Conventional message;
full pre-commit hooks and exact-head natural CI remain required. No local
Vitest/devserver or D2 heavy-check deferral was used.

The first PR head `4ee4a42a33aec5992d215724e34c12533817beb1` subsequently
failed natural Semgrep run `37206705310`, job `111449292684`: one new blocking
`javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key` finding
from the synthetic literal test key passed to Node `createHmac`. This is a
security CI regression, not evidence of a production credential leak or an
infra flake; the earlier GraphQL HTTP 502 remains an observation failure.
The bounded repair generates a fresh test-owned key with `randomUUID()` and
passes the same value to the existing fixture and independent HMAC assertion.
All provider headers/payload/count/cancellation assertions remain, and no
production owner or scanner rule/config/baseline is modified. The repaired
head requires its own natural CI and independent review; the old run is not
rerun or reclassified as a pass.
