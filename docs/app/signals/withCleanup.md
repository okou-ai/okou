# `withCleanup`: remove duplicate state, preserve real ownership

**Do not introduce new `withCleanup` usages in Platform.**
`ccstate/no-with-cleanup` is an error and points to this guide. Existing usages
are frozen migration inventory, not an approved pattern for new code. Reduce
that inventory by fixing the state and lifetime model, not by renaming the
wrapper or moving its callback into a blanket `try/finally`.

Read [Platform ccstate](../platform-ccstate.md), the
[async lifecycle reference](../../../.claude/skills/ccstate/references/lifecycle.md),
and [request state versus business state](../../react.md#separate-loading-state-from-business-state).
The related [onRejection](onRejection.md) and [tapError](tapError.md) guides define
failure boundaries; cleanup is not another place to implement error recovery.

## What the helper does—and does not do

The [implementation](../../../turbo/apps/platform/src/signals/utils.ts) awaits a
Promise, then awaits its cleanup callback in `finally`, on fulfillment or
rejection, including cancellation.

- It does not cancel the operation, stop a losing race branch, or establish an
  AbortSignal owner.
- Cleanup delays settlement. If it throws or rejects, its error replaces the
  successful result or original failure, including an abort.
- A synchronous throw while evaluating the Promise argument happens before the
  helper runs, so its callback cannot release resources acquired before that
  throw.
- Invalidating a resource is not the same as awaiting its refreshed value.

The helper's name is not evidence that a callback is necessary disposal. Audit
its writes and consumers: many historical callbacks merely repaired a second
copy of request state.

## Anti-patterns and correct alternatives

### Manual loading and error state, even when disguised as an ID or draft

Do not set `busy = true` before a request and clear it afterward. An invitation
ID, saving connector slug, pending-map placeholder, or submit-only audience
"draft" is also duplicate request state if it exists only to show pending UI.
Renaming a boolean does not change its lifetime.

Use `useLoadableSet` in the view invoking a command, or `useLoadable` for an
async computed resource. Keep the actual operation rejecting on failure; observing a Promise
wrapped in `settle`, `tapError`, or another success-producing fallback does not
recover the real error state.

```tsx
// The command returns/awaits the complete save operation, including accept().
const [saveState, save] = useLoadableSet(saveSettings$);
return (
  <Button
    disabled={saveState.state === "loading"}
    onClick={() => detach(save(values, pageSignal), Reason.DomCallback)}
  >
    Save
  </Button>
);
```

Keep typed API requests in `apiClient$` + `accept`, with explicit accepted
statuses and the real owner signal. Let the common boundary handle unexpected
API errors; do not clear loading into a fabricated `error`, show a duplicate
toast, or infer a server outcome from a cancelled response.

For row-specific feedback, let the row view own its action hook. Do not save
command Promises in signals, publish a global progress loadable, or pass action
loadables between views. Repeated cards can submit the same protocol idempotency
key; the server owns deduplication and the persisted result. A hook does not
provide cancellation or resource ownership: keep the appropriate AbortSignal,
session identity, and teardown at the real owner without introducing an action
mutex to model request UI.

### Collapsing a business session into request loading

Separate a short authorization-start request from the longer approval session.
A completed start request can leave a valid session waiting for user input;
treating the entire session's pending Promise as "starting" hides the code or
input form behind a spinner. Likewise, one polling HTTP request is not a new
authorization phase.

Derive request feedback from each actual operation. Preserve protocol facts
such as the device code, pending approval, explicit denial or expiry, attempt
identity, and session owner. Preserve copying/deleting progress and records of
already rescued workflows so retries do not copy twice. Independent unsent
text, selections, annotations, and identity-scoped drafts remain business data.
Do not erase them merely because a request failed.

Keep startup and polling request feedback in the owning view while signals
retain the authorization session and its cancellation boundary. Removing
loading/error mirrors does not justify deleting domain contracts, annotation
facts, idempotent draft recovery, or resource owners.

### Ad-hoc cancellation wrappers and cleanup-driven ownership

Inherit the existing AbortSignal when lifetimes match. For independently
cancellable work, use a stable `resetSignal()` command at the owning scope and
pass the parent signal when the work belongs to that scope. Do not create a new
controller or Promise cancellation wrapper in a feature merely to clear state
when the caller stops waiting.

Await finite operations normally and check `signal.throwIfAborted()` before
subsequent effects where required. A shared computed Promise can outlive one
reader: cancelling that reader must not cancel independently owned shared work.
Native `Promise.race` only selects an outcome; it does not stop losing work.
If losing branches really must stop, their explicit owner must provide that
release path without cancelling shared work owned elsewhere.

Use `setLoop` / `setAbly*Loop$` for owner-scoped background loops and
`waitLoopUntil` / `waitAbly*LoopUntil$` when later work needs completion. A
background starter means started, not subscribed, loaded, or complete. Retain
readiness requirements and retry semantics. Keep `detach` at actual DOM or
background boundaries; neither a loadable nor cleanup makes floating work safe.

[PR #41846](https://github.com/okou-ai/okou/pull/41846) removes
`waitForOperation` and `raceWithCancellation` in favor of direct awaiting and
native races. It deliberately does not introduce a replacement helper or force
an independently owned Promise to settle when its reader cancels.

### Treating invalidation as unconditional end-of-command cleanup

Choose invalidation timing from the mutation contract, not from where the
outer Promise happens to settle:

- If mutation success establishes the change, invalidate immediately after that
  accepted mutation, before unrelated callbacks or navigation that can fail.
  Do not delay all refreshes until an outer workflow succeeds.
- If a mutation can commit despite a lost response or cancellation, reconcile
  authoritative state through the existing owner/notification mechanism. A
  rejected response is not proof of rollback. Preserve any explicitly required
  failure-path reconciliation; do not silently move it to success-only code.
- In a parallel batch, `Promise.all` rejects on the first failure while other
  writes may still run. One finalizer at that point is not an "all writes
  finished" boundary. Define per-write invalidation or a real batch completion
  contract without swallowing the original errors.
- Invalidation alone does not guarantee a fresh read has completed. Await the
  authoritative read separately when subsequent business work needs its value.

The recent connector audit distinguished a successful connect followed by a
failed callback from a connect that never succeeded; it also identified early
`Promise.all` rejection as a refresh-timing hazard. PR #42092 demonstrates the
complementary model: persisted server results and notifications, not a local
callback-failed flag, determine card state.

### Mixing in-flight deduplication, successful caching, and rollback

These are separate responsibilities:

| Responsibility       | Correct lifetime                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Resource ownership   | Keep acquired resources and teardown at their real owner; do not cache action Promises.    |
| Successful cache     | Commit only a successful result, scoped to identity and invalidation generation.           |
| Retry                | Allow a new attempt after failure; do not accidentally retain a rejected entry forever.    |
| Draft or domain data | Commit, reconcile, and release according to its business contract, not request settlement. |

A successful cached resource is different from a command's loading/error state.
Keep action results in the invoking view's hook. Preserve identity checks that
prevent an old operation from mutating a replacement session. Do not retain a
Promise slot or add a command mutex merely to share button feedback.

For pagination, commit the returned page and cursor after success rather than
advancing first and relying on cleanup to restore them. For attachment recovery,
retain successfully established resource facts and make retries idempotent:
PR #42119 specifically preserves annotations, avoids appending/uploading
originals again, and allows failed resource lookups to retry. Do not replace
these semantics with either blanket rollback or permanent failure caching.

## Real disposal still needs a home

No new `withCleanup` does **not** mean no cleanup. Pair acquisition with teardown
at the actual resource owner or existing adapter. Listeners, subscriptions,
object URLs, stream reader locks, database connections, model sessions, audio
contexts, and temporary editors cannot be removed merely because request UI
now uses a loadable.

Before changing a retained disposal path, establish:

1. What is acquired, including partially acquired resources and synchronous
   setup failures?
2. Who owns it before and after successful handoff? For example, a preopened
   OAuth window may need closing before navigation, but belong to the session
   afterward. Do not close a successfully handed-off window unconditionally.
3. Which paths release it: success, failure, cancellation, and replacement?
   Can release safely run more than once, and can an old attempt affect a new one?
4. Must asynchronous disposal finish before the operation settles, and what
   happens if disposal fails while a primary error is already propagating?

Prefer the shared lifecycle or resource adapter instead of repeating release
logic in consumers. A narrowly scoped native `try/finally` may express genuine
acquire/use/release where the local syntax policy permits it; it is not the
default migration or a reason to bypass existing lint policy. It must not
recreate manual loading/error repair, speculative rollback, or a generic
`withCleanup` replacement under another name. If the available owner cannot
express a required lifetime, resolve that architecture explicitly rather than
adding a new waiver.

Sometimes the correct reduction is deleting the obsolete feature and all its
lifetime machinery. [PR #42329](https://github.com/okou-ai/okou/pull/42329)
removes bulk invoice receipt ZIP downloads, including download state, toast and
Blob-URL handling, rather than reimplementing their cleanup. It preserves
individual invoice links; this is feature removal, not evidence that active
resource users can omit disposal.

See [resource lifetimes](../../react.md#pair-acquisition-with-teardown).

## ESLint: frozen legacy inventory, not an exception mechanism

`ccstate/no-with-cleanup` rejects new runtime use. Do not evade it through an
alias, namespace access, re-export, local wrapper, or file-wide disable.
The migration marks an existing reference with this next-line comment:

```ts
// eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
```

The date is the inventory cutoff, **not** a review approval. Do not add new
waivers, copy one onto a new call, expand a legacy call to cover new work, or
move it to another file to preserve the count. New resource-lifetime needs must
use proper ownership without new `withCleanup`. When a legacy reference is
removed, remove its waiver and unused import too. The permitted direction is
reduction only.

Review the design rather than the helper count: preserve cancellation,
protocol idempotency, business progress, successful results, reconciliation timing, and
real disposal. Do not substitute `onRejection`, `settle`, `bestEffort`, raw
catch/finally state repair, or detached work to reproduce the same anti-pattern.
