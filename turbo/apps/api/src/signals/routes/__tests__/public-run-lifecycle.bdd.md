# public-run-lifecycle

## public-run-lifecycle-001

- Vitest: "fixture lifecycle: drains accepted work and rejects late admission"
- Mode: run
- Intent: review
- Given: A test fixture lifecycle has preparation, teardown and restoration steps, and accepted work that is still waiting to finish.
- When: Finish is requested while the work is pending, and new work is submitted after finish has started.
- Then: The accepted work completes with 42, the late work is rejected with `Fixture teardown already started`, and finish succeeds. Steps run in order prepare, work, teardown, restore, and repeated finish calls return the same promise.

## public-run-lifecycle-002

- Vitest: "fixture lifecycle: rejects owned-work and teardown reentry without deadlock"
- Mode: run
- Intent: review
- Given: A test fixture lifecycle whose owned work and teardown callback each try to finish the same fixture.
- When: The owned work calls finish from inside itself, then the fixture is finished and its teardown calls finish again.
- Then: Both reentrant finish attempts fail with `Cannot finish a fixture from its owned work or callbacks` without deadlocking, and later finish calls return the original finish promise.

## public-run-lifecycle-003

- Vitest: "fixture lifecycle: caches the complete failed finish and original error"
- Mode: run
- Intent: review
- Given: A test fixture lifecycle whose teardown throws an abort error.
- When: Finish is called twice immediately and once more after it settles.
- Then: All calls share the same failed result carrying the original abort error, and teardown and restore each run once in that order.

## public-run-lifecycle-004

- Vitest: "fixture lifecycle: strict cleanup lists real Runs but skips finalization after failure"
- Mode: run
- Intent: review
- Given: A strict public Run fixture for a new onboarded user whose pre-Run cleanup step throws.
- When: The user completes onboarding through `POST` on the onboarding completion route inside the fixture, then the fixture is finished twice, and the user's Run logs are listed.
- Then: Onboarding succeeds; finish fails with the original error and the repeat returns the same promise and result. The recorded steps are restore, restore, beforeRuns, baseline, with no finalization, and the user's Run log list is empty.

## public-run-lifecycle-005

- Vitest: "fixture lifecycle: preserves ordered preparation cleanup and restoration errors"
- Mode: run
- Intent: review
- Given: A strict public Run fixture for an onboarded user where the first environment restoration fails, the pre-Run cleanup throws an aggregate error, and baseline restoration throws.
- When: The user completes onboarding inside the fixture and the fixture is finished twice.
- Then: Finish fails with an AggregateError whose errors are exactly the preparation, cleanup and restoration errors in that order, and the repeat returns the same error. Only the baseline restoration is recorded, environment restoration runs twice, and finish returns the same promise.

## public-run-lifecycle-006

- Vitest: "fixture lifecycle: failed baseline capture retains identities and skips cleanup"
- Mode: run
- Intent: review
- Given: A strict public Run fixture for an onboarded user whose baseline capture throws.
- When: The user completes onboarding inside the fixture and the fixture is finished.
- Then: Onboarding succeeds, finish fails with the original baseline error, and no cleanup steps run.

## public-run-lifecycle-007

- Vitest: "fixture lifecycle: finalizes a real empty workspace once and restores its baseline"
- Mode: run
- Intent: review
- Given: A strict public Run fixture for an onboarded user with no Runs; the default Runner group is changed after setup. Finalization deletes the organization while Clerk and Stripe report no other members, subscriptions or invoices.
- When: The fixture is finished twice.
- Then: The cleanup receipt is empty and organization deletion returns `Organization deleted`. Finish succeeds with the same result both times and the same promise; steps run restore, restore, finalize, baseline, and the changed Runner group setting is left as set.

## public-run-lifecycle-008

- Vitest: "fixture lifecycle: default manual cleanup remains void and idempotent"
- Mode: run
- Intent: review
- Given: A default public Run owner for an onboarded user with a post-Run cleanup step.
- When: Manual cleanup is called twice.
- Then: Both cleanups succeed with no value and the post-Run step runs exactly once, including after the test finishes.

## public-run-lifecycle-009

- Vitest: "fixture lifecycle: default manual failure remains eligible for automatic cleanup"
- Mode: run
- Intent: review
- Given: A default public Run owner for an onboarded user whose pre-Run cleanup fails the first time.
- When: Manual cleanup is called, then cleanup is allowed to succeed.
- Then: Manual cleanup fails with the original error after one pass, and automatic cleanup at test end runs a second pass.

## public-run-lifecycle-010

- Vitest: "fixture lifecycle: strict guards preserve the single automatic cleanup owner"
- Mode: run
- Intent: review
- Given: Strict public Run fixture options for a user.
- When: A strict fixture is created with continuation enabled, and again with a legacy post-Run step; then a strict owner is created, manual cleanup is attempted, and the user is onboarded.
- Then: Both creations throw `Strict Run cleanup forbids afterRuns and continuation`. Manual cleanup fails with `Strict Run cleanup is owned by fixture finalization` and records nothing, and at test end the automatic cleanup records restore, restore, finalize, baseline.
