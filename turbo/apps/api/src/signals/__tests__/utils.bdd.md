# utils

## utils-001

- Vitest: "clearAllDetached > drains detached promises scheduled by detached work"
- Mode: run
- Intent: review
- Given: A detached `WaitUntil` task records "outer" and then detaches a nested task that records "inner".
- When: All detached work is cleared.
- Then: Clearing waits for both tasks, so the record is exactly "outer" then "inner".

## utils-002

- Vitest: "clearAllDetached > does not wait for untracked best-effort cleanup"
- Mode: run
- Intent: review
- Given: An untracked best-effort cleanup that never settles and a detached `WaitUntil` task that records "tracked".
- When: All detached work is cleared.
- Then: Clearing completes without waiting for the never-settling cleanup, and only "tracked" is recorded.

## utils-003

- Vitest: "clearAllDetached > preserves the first-error contract after draining every failure"
- Mode: run
- Intent: review
- Given: Two detached `WaitUntil` tasks reject with a first and a second error.
- When: All detached work is cleared, then detached errors are collected.
- Then: Clearing rejects with the first error, and a following error collection returns an empty list because every failure was drained.

## utils-004

- Vitest: "collectAllDetachedErrorsForTest > reports distinct failures including work scheduled while draining"
- Mode: run
- Intent: review
- Given: A detached task schedules a nested detached task, records "outer" and throws an outer error; the nested task records "inner" and throws a nested error.
- When: Detached errors are collected twice.
- Then: The first collection returns exactly the outer and nested errors in that order, the record is "outer" then "inner", and the second collection returns an empty list.

## utils-005

- Vitest: "settleIncludingAbort > infers resolved values from promises and callbacks"
- Mode: run
- Intent: review
- Given: A value `{ id: "winner" }` supplied as a resolved promise, a synchronous callback and an async callback.
- When: Each is settled with `settleIncludingAbort`.
- Then: Each result is successful, typed as `{ id: string }`, with `id` `winner`.

## utils-006

- Vitest: "settleIncludingAbort > unwraps explicit promise-valued callback types"
- Mode: run
- Intent: review
- Given: A callback explicitly typed as returning `Promise<{ id: string }>` that resolves to `{ id: "winner" }`.
- When: It is settled with `settleIncludingAbort`.
- Then: The result is successful, its value is typed as the unwrapped `{ id: string }`, and `id` is `winner`.

## utils-007

- Vitest: "settleIncludingAbort > owns synchronous cancellation errors after irreversible work"
- Mode: run
- Intent: review
- Given: A callback that synchronously throws an `AbortError` "observation failed".
- When: It is settled with `settleIncludingAbort`.
- Then: The call resolves to `{ ok: false, error }` with that same AbortError instead of rejecting.

## utils-008

- Vitest: "settleIncludingAbort > owns asynchronous cancellation from promises and callbacks"
- Mode: run
- Intent: review
- Given: An `AbortError` "observation failed" delivered as a rejected promise and as an async callback rejection.
- When: Each is settled with `settleIncludingAbort`.
- Then: Both calls resolve to `{ ok: false, error }` with that same AbortError.

## utils-009

- Vitest: "joinAll > settles every owned branch before surfacing the first rejection"
- Mode: run
- Intent: review
- Given: Two pending branches are joined with `joinAll`.
- When: The second branch rejects first, then the first branch resolves.
- Then: The join stays unsettled after the rejection until the first branch also settles, and then rejects with the second branch's error.

## utils-010

- Vitest: "joinAllInOrder > settles every owned branch and surfaces errors by dependency order"
- Mode: run
- Intent: review
- Given: Two pending branches are joined with `joinAllInOrder`.
- When: The second branch rejects first, then the first branch rejects.
- Then: After the second rejection the join is still unsettled with only "second" finished; once both settle it rejects with the first branch's error and the finish order is "second", "first".

## utils-011

- Vitest: "joinAllInOrder > settles every owned branch before surfacing cancellation"
- Mode: run
- Intent: review
- Given: Two pending branches are joined with `joinAllInOrder` under an abort signal.
- When: The signal is aborted with an `AbortError` "cancelled", the second branch resolves, and then the first branch resolves.
- Then: The join stays unsettled while the first branch is pending (only "second" finished), then rejects with the abort reason after both settle, with finish order "second", "first".
