# Release 1 credential and provider-watch boundaries

The six advisory acquisition definitions remain. This work prepares selected write paths; it does not establish that Release 1 is complete for the whole credentials/watch package.

### Implemented

- Forms remote watch preparation, renewal, remote inventory, response pagination and catch-up run outside new local publication transactions. Publication uses the existing watch identity and exact PostgreSQL state revision. Renewal and stop use conditional snapshot predicates. The cron inspects remotely missing watches even when the local expiry is healthy, preserves the cursor during replacement and catches up responses.
- Forms publication handles an outgoing stop deleting a state after the initial read: it prepares a replacement and publishes the original in-memory seed cursor, rather than returning success without a watch or fetching a second newest-response seed.
- Forms lifecycle/projection transactions execute their own SQL. New consumer reads and retry writes are commands with no database argument. Advisory statement builders accept only ordinary values.
- The Forms cursor's existing watch_state_id becomes nullable with ON DELETE SET NULL. R1 repair reattaches detached cursor rows by automation ID and preserves their timestamp. Concurrent R1 repair cannot rewind a newer cursor. Explicit user re-enable still seeds a new baseline. No persisted column or coordination table is added.
- DCR registrations are prepared remotely and encrypted before publication. Custom and builtin publication commands own finite SQL, compare the observed registration and return a compatible current winner. New preparation reads own database access. Builtin publication also locks and checks the existing accepted catalog identity, so catalog changes during remote preparation reject stale publication.
- Ordinary builtin credential refresh captures exact stored inputs before provider I/O. Local publication validates owner, principal, method, storage and credential bytes. A lost refresh publication is rejected as connection-changed, including after a stale terminal failure. An updated token bundle cannot prove that the change came from another refresh rather than a replacement authorization. The stale request therefore cannot reuse the replacement token, mutate the new connection or return unpublished provider output.
- Calendar baseline pagination and credential preparation move before the local decision transaction. Existing credential bytes and state snapshots fence publication. Cleanup after uncertain finalization rereads authoritative ownership and preserves a currently owned channel. Healthy existing watches remain usable while previous-channel cleanup is pending.

### Remaining implementation work

- Builtin OAuth callback, Automatic OAuth refresh/retirement, ordinary refresh's legacy helper-owned commit path and its nine resolver chains still propagate root database or transaction values.
- Model-provider firewall refresh, settings and account paths have not been migrated to the complete final command-owned conditional protocol. They still execute provider/KMS work through the locked helper graph.
- Gmail lifecycle is unchanged. The user decision about omitting account-global users.stop is still pending; the accepted Forms gap is not authorization for a Gmail behavior change.
- Calendar lifecycle preparation/activation/reconciliation still has helper-owned and propagated transaction paths. Current-channel remote stop remains inside the existing decision boundary.
- Forms workflow queue admission still propagates a transaction into persistSourceTransition, and its workflow-thread creation helper also accepts a transaction. Credential/catalog resolver helpers still receive database handles.

### Proven Forms mixed-version counterexample

At baseline 5b458cc9, prepareGoogleFormsWatchesForOwner treats a missing or detached cursor as inexact, calls ensureGoogleFormsWatchForUser with resetAutomationId and no seedCursor, and reaches seedGoogleFormsAutomationCursor. That function fetches newestGoogleFormResponseTime; upsertGoogleFormsCursor then unconditionally replaces lastSeenSubmittedTime on conflict.

The in-memory publication retry fixes the specific uninterrupted new-ensure / outgoing-stop overlap. It does not prove crash convergence. If the original request disappears and a pre-R1 repair runs first, the old repair can still seed newest and skip intervening responses. Before cursor detachment, the original cursor row was absent; after detachment, the old repair can overwrite the retained row. Detachment does not introduce this window and allows R1 repair to recover, but cannot make the old repair obey the new protocol. R1 must not be declared fully compatible on the strength of cursor detachment or a future R2 drain alone.

Ordinary FK, unique and CHECK constraints cannot distinguish the old repair's unconditional reset from the old explicit user re-enable's valid reset. No unproved production trigger or schema workaround has been introduced.

### Validation

Focused ESLint/Oxlint/format checks pass for committed source changes. DCR final command publication core types and Calendar core types pass; the integrated PR must validate the latest combined head and schema migration. The Forms schema snapshot changes only google_forms_automation_cursors. API tests cover remote-watch repair/catch-up, DCR concurrent authorizations using a shared published client with usable callbacks, and explicit Forms disable/re-enable behavior. No local Vitest suite or development server was run.

Repository error handling classifies Codex refresh_token_reused and refresh_token_invalidated as terminal. The inspected code/tests do not prove that submitting a concurrent duplicate refresh invalidates an already successful winner's whole token family. That claim must not be used as a demonstrated impossibility argument.

### Test consolidation

The Calendar source-switch regression now changes account selection through the
public API while the external Google events response is in flight. It still
requires the old source to dispatch no run; the service and route no longer
expose an internal before-admission hook. Forms retry deduplication shares the
normal metadata-delivery setup and asserts one visible automation event after
redelivery, instead of counting provider reads. Remote-watch repair with cursor
catch-up and explicit disable/re-enable with a new baseline remain separate
because they require opposite cursor behavior.

The credential replacement case retains the rejected in-flight request and the
connected replacement account. Its follow-up API request must send the stored
replacement token to Google; a successful creation response alone is not the
assertion. The test no longer requires exactly two watch calls and one stop
call. DCR's common published client and both usable OAuth callbacks remain
covered unchanged.
