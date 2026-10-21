# tapError: Do Not Turn Failures Into Missing Values

`tapError(promise, onError?)` returns the fulfilled value, but converts an
ordinary rejection into `undefined` after awaiting the optional callback.
Cancellation errors propagate; a callback failure also propagates. Despite its
name, it does not merely observe an error: it changes the operation's outcome.

**Do not introduce new `tapError` usage in Platform.** Propagate failures and
express operation state through loadables. Neither a non-HTTP operation nor an
"optional" feature is, by itself, a reason to swallow an error.

See [HTTP handling](../../../.claude/skills/ccstate/references/http.md),
[Platform ccstate](../platform-ccstate.md), and [fallback policy](../../fallback.md).

## Misuse and Correct Alternatives

### Application API failures replaced by local error state

Wrapping `accept(...)`, or a command that eventually calls it, still catches an
API failure. Connector authorization, subscription authorization, banking actions,
receipt downloads, and onboarding checks must not replace that failure with
`undefined`, a local error flag, a replacement toast, or a successful no-op.

```typescript
// Bad: the API failure becomes a fulfilled, empty result.
const started = await tapError(set(startAuthorization$, signal), () => {
  set(status$, "error");
});
if (!started) {
  return;
}

// Good: the command uses apiClient$ + accept with explicit accepted statuses.
// Its rejection propagates to the view's useLoadableSet state.
const started = await set(startAuthorization$, signal);
```

`accept` owns response error handling. Keep that error intact, including the
special authentication and force-upgrade paths. Use `useLoadable` /
`useLoadableSet` for pending, disabled, and success UI, not another business-layer
error handler. An expected status with domain meaning (for example, a missing
resource) belongs in the explicit `accept` status list and a normal domain branch.
A failed onboarding request does not mean "onboarding is unnecessary."

### Nested fallbacks hiding resource failures

Do not turn a failed language-resource request into an absent localization and
then retry the entire initialization in English. Remove both layers of fallback;
let the selected language's initialization fail. Similarly, read an imported file
with `await file.text()` rather than converting a read failure into empty data.

Inspect the callers as well as the immediate wrapper: removing one `tapError`
does not establish fail-fast behavior when another layer still fabricates a
success or fallback value. Missing browser API support can be an explicit
capability branch; an API that exists but rejects is a different outcome.

### Upload failures repaired with duplicate mutable state

Do not swallow an upload error, remove a manually tracked attachment, and show a
replacement toast. Keep each upload promise as the source of truth:

- Render pending and fulfilled uploads from `useLoadable`; omit rejected items.
- Derive the uploading indicator and send-disabled state from pending uploads,
  not from the raw attachment-list length.
- Persist and submit only fulfilled attachments. Rejected uploads must not reach
  outgoing payloads or draft persistence, and an all-failed list must not enable
  an otherwise empty send.

The prepare API, object transfer, and completion API remain one owned operation;
errors propagate rather than becoming optional values. Removing the wrapper
alone is insufficient if the UI or submission logic still treats failed uploads
as pending or sendable.

### Optional preferences wrapping identity and remote reads

A browser-local ranking preference does not need user/organization resolution
and remote workflow fetching in its read or write path. Use `localStorageSignals`
for that preference. If optional bookkeeping needs workflow data after a send,
use already successfully loaded data rather than starting another request and
swallowing its failure. Actual workflow API reads still fail normally.

Do not let a broad "optional preference" boundary disguise missing identity,
programming errors, or a failed remote read as an empty list. Storage policy
belongs to the shared storage primitive, not another `tapError` wrapper.

### Complexity created to support a fallback

Do not preserve speculative image predecoding, preload caches, and prewarming
merely by swallowing `image.decode()` failures. Prefer selecting the requested
image directly when the extra machinery has no required product contract.
When a feature is removed, delete its error wrappers and dedicated tests with it;
do not rebuild its old recovery flow under a different helper.

## Choosing the Error Boundary

1. Trace the entire wrapped operation, including indirect API calls and callers'
   fallbacks. Failure is not the same result as missing data.
2. Prefer direct `await` or a returned promise. Keep work attached to its owner
   signal and let the owning framework boundary observe the rejection.
3. Derive UI from the operation's loadable state rather than duplicated busy,
   failure, and result flags. Do not interpret every non-success state as loading.
4. Preserve real resource cleanup and cancellation ownership. Use the existing
   lifecycle primitives when cleanup is necessary; cleanup must not convert a
   failed operation into success.
5. Preserve explicitly contracted domain recovery, security checks, and per-item
   isolation at their actual owner. Do not mechanically replace `tapError` with
   `settle`, `bestEffort`, a raw catch, a detached task, or a log-and-default wrapper
   to reproduce the same swallowing under another name.

The cleanup in [PR #41845](https://github.com/okou-ai/okou/pull/41845) provides
concrete examples of these alternatives; it is not a blanket endorsement of
fallbacks for non-HTTP failures.

## ESLint and the Existing Exception

`ccstate/no-tap-error` is enabled at error severity in Platform. It rejects value
references to a named `tapError` import (including renamed imports and passing
it as a value), namespace member access or destructuring, and explicit named
re-exports. It is a syntactic import-boundary rule, not inter-module data-flow
analysis: it does not trace arbitrary wrapper functions, export-star chains, or
computed property names. Review still owns those boundaries. There is no autofix;
choosing the right error owner requires understanding the operation.

The helper implementation remains available for the one existing architecture
probe in `computer-use-hosts.ts`. A next-line waiver records **legacy use as of
2026/10/21** and the reason: failure to read optional browser architecture data
currently does not block Desktop downloads. Cancellation still propagates.
This is a grandfathered behavior, not a pattern to copy or proof that the device
is compatible. No file-wide rule override is needed.

Do not add new waivers merely because an operation is non-HTTP or optional.
A future change to this existing exception must also update its consuming views
so a rejected compatibility check is not rendered indefinitely as "checking."
