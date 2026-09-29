# Release 1 credential and provider-watch boundaries

The six advisory acquisition definitions remain. This work prepares selected write paths; it does not establish that Release 1 is complete for the whole credentials/watch package.

### Implemented

- Forms remote watch preparation, renewal, remote inventory, response pagination and catch-up run outside new local publication transactions. Publication uses the existing watch identity and exact PostgreSQL state revision. Renewal and stop use conditional snapshot predicates. The cron inspects remotely missing watches even when the local expiry is healthy, preserves the cursor during replacement and catches up responses.
- Forms publication handles an outgoing stop deleting a state after the initial read: it prepares a replacement and publishes the original in-memory seed cursor, rather than returning success without a watch or fetching a second newest-response seed.
- Forms watch publication, state renewal/removal and account reprojection commands execute their own SQL. New consumer reads and retry writes are commands with no database argument. Advisory statement builders accept only ordinary values. Shared workflow creation, enable and official reconfiguration ownership remains listed below as implementation work.
- Forms queue admission receives an ordinary source observation and prepared input. `enqueueGoogleFormsWorkflowInput$` owns the local transaction and directly inserts the context, appends through the canonical pure SQL builder, validates source identity, records deduplication, advances the cursor and marks the thread queued. It passes no database or transaction to a helper, callback or another command. Its append-before-source-lock order matches outgoing writers, and source rejection rolls back the entire input. Model selection and message preparation now occur before queue transactions.
- The Forms cursor's existing watch_state_id becomes nullable with ON DELETE SET NULL. R1 repair reattaches detached cursor rows by automation ID and preserves their timestamp. R1 repair publication updates only the watch binding on conflict and never overwrites the existing cursor. Temporary database cursor/source compatibility triggers additionally protect outgoing repair upserts; they are not the accepted terminal design. Explicit disable or source replacement invalidates the old cursor, allowing a subsequent enable to seed a new baseline. No persisted column or coordination table is added.
- DCR registrations are prepared remotely and encrypted before publication. Custom and builtin publication commands own finite SQL, compare the observed registration and return a compatible current winner. New preparation reads own database access. Builtin publication also locks and checks the existing accepted catalog identity, so catalog changes during remote preparation reject stale publication.
- Automatic OAuth callback reads its bound DCR client, decrypts it, exchanges the provider code and encrypts the resulting tokens before local publication. The publication command owns direct SQL, checks the accepted catalog identity and live registration, and atomically replaces the metadata, credentials and binding. Reconnect publication compares the exact account timestamp and `xmin` observed before the provider request; a replacement or deletion rejects stale output. Registration retirement has a separate direct-SQL command for callback failures. The callback entry point now uses command-owned state claim, accepted catalog reads and post-commit wakeup, with no database handle in those command arguments or closures. Catalog decoding receives ordinary payload values, and realtime publication receives ordinary selected rows after SQL has finished. Wakeup completes before the request observes cancellation after a committed publication. The legacy Automatic refresh store remains transaction-aware.
- Automatic start uses a command-owned account snapshot before remote discovery/preparation and a final direct-SQL publication. Public no-auth connections replace metadata and clear credentials atomically; authorization state insertion validates the accepted catalog and unchanged reconnect account. Start no longer passes a transaction to account resolution, state insertion or credential replacement helpers.
- Ordinary builtin credential refresh captures exact stored inputs before provider I/O. Local publication validates owner, principal, method, storage and credential bytes. A lost refresh publication is rejected as connection-changed, including after a stale terminal failure. An updated token bundle cannot prove that the change came from another refresh rather than a replacement authorization. The stale request therefore cannot reuse the replacement token, mutate the new connection or return unpublished provider output.
- Shared firewall builtin and model-provider refresh success/failure writes compare the observed existing metadata timestamp and PostgreSQL `xmin`. A successful publication claims that exact owner row before persisting the credential bundle in the same transaction; a changed or deleted row rejects the result without writing output credentials. These tokens are held only for the in-flight request, with no new persisted state. This is conditional-write preparation, not removal of the shared runtime transaction or provider-I/O boundary.
- Automatic MCP credential resolution retains the exact existing consent binding (`xmin` and its full-precision creation timestamp) and access ciphertext. Both outgoing and R1 reconnect publication replace that binding; token refresh leaves it unchanged. A concurrent expiry request may reuse a sibling refresh only while that same consent binding survives. Comparing only the account metadata timestamp rejects a legitimate sibling refresh, while comparing only changed token ciphertext would wrongly accept replacement authorization. Its refresh publication still claims the exact current account metadata and stored refresh ciphertext before writing output tokens; terminal failure marks only that observed state. Exact DCR registration retirement remains a separate resource-wide invalidation when the provider rejects that client. The legacy Automatic refresh transaction and propagated resolver helper graph still require migration.
- Calendar baseline pagination and credential preparation move before the local decision transaction. Existing credential bytes and state snapshots fence publication. Cleanup after uncertain finalization rereads authoritative ownership and preserves a currently owned channel. Healthy existing watches remain usable while previous-channel cleanup is pending.

- Credential secret/variable authorization predicates are pure SQL builders. Their complete account, owner, auth-method, storage-version and optional revision checks no longer receive a database or transaction from any caller. Calendar watch publication's exact credential predicate is also a pure SQL builder; it receives only the observed account and stored credential bytes.

### Remaining implementation work

- Builtin OAuth callback, Automatic OAuth refresh and its legacy retirement store, ordinary refresh's legacy helper-owned commit path and its nine resolver chains still propagate root database or transaction values. Automatic callback including state claim, catalog preparation and post-commit wakeup has a command-owned boundary. Other builtin/custom callback routes still use the legacy state helper; it remains only for those actual callers.
- Model-provider firewall refresh, settings and account paths have not been migrated to the complete final command-owned conditional protocol. They still execute provider/KMS work through the locked helper graph.
- Gmail lifecycle is unchanged. The user decision about omitting account-global users.stop is still pending; the accepted Forms gap is not authorization for a Gmail behavior change.
- Calendar lifecycle preparation/activation/reconciliation still has helper-owned and propagated transaction paths. Current-channel remote stop remains inside the existing decision boundary.
- Forms workflow-thread creation still accepts a transaction. Its credential/catalog resolver helpers and shared queue model preparation still receive root database handles. Other event sources still use the legacy workflow queue source callback; the Forms admission change does not claim to migrate those sources.

### Forms mixed-version cursor continuity

At baseline 5b458cc9, prepareGoogleFormsWatchesForOwner treats a missing or detached cursor as inexact, calls ensureGoogleFormsWatchForUser with resetAutomationId and no seedCursor, and reaches seedGoogleFormsAutomationCursor. That function fetches newestGoogleFormResponseTime; upsertGoogleFormsCursor then unconditionally replaces lastSeenSubmittedTime on conflict.

The in-memory publication retry fixes the specific uninterrupted new-ensure / outgoing-stop overlap. Cursor detachment alone does not cover a lost request: a pre-R1 repair can still seed newest and overwrite the retained cursor. Checking only a NULL-to-non-NULL binding transition is also insufficient: an R1 repair can reattach the row before a previously started outgoing repair issues its unconditional upsert for the same watch.

Migration 1290 temporarily protects outgoing writers with two triggers:

1. `google_forms_cursor_rebind_preserves_progress` runs before updates that write `watch_state_id`. It preserves the existing `last_seen_submitted_time`, including same-watch upserts. Outgoing and R1 repair can attach the cursor to a replacement resource but cannot advance undelivered progress. The normal response-admission SQL updates only `last_seen_submitted_time` and `updated_at`, so actual delivery can still advance it.
2. `google_forms_cursor_source_lifecycle` invalidates the cursor when the automation's organization, owner, workflow, event kind/type, selected connector, configured connector or form changes. It also invalidates explicit disable: ordinary `enabled=false`, or official `official_intended_enabled=false`. An official temporary reconciliation pause keeps its cursor because its existing intended-enabled field remains true. Subsequent explicit enable creates a new cursor instead of rebinding the old one. Existing explicitly disabled cursors are cleaned during migration.

The functions `preserve_google_forms_cursor_on_rebind` and `invalidate_google_forms_cursor_for_source_change` contain no advisory acquisition, external effect or new stored coordination state. Automation deletion still cascades; connector deletion invalidates the source through its existing SET NULL relationship. Cursor invalidation and response admission both lock the automation before its cursor, while cursor rebinding performs no additional reads.

The terminal schema has no application-defined triggers. These two triggers
must be retired by a follow-up DROP migration after the replacement protocol
covers every supported writer. Their presence is not a permanent exception.

R1 now expresses cursor lifetime in application SQL:

- `publishGoogleFormsWatch$` inserts the prepared baseline only for a missing
  cursor. Its conflict update changes `watch_state_id` and `updated_at` only;
  repair cannot advance delivery progress even without the compatibility trigger.
- `persistDisabledWorkflowAutomation$` is a business-only command. It obtains
  `writeDb$`, updates explicit enabled/intended-enabled state and deletes the
  Forms cursor in one local finite transaction. Reconciliation pause paths do
  not call this command and preserve their cursor.
- `reprojectGoogleFormsAutomationOwnership$` already updates account projection
  and deletes a changed source's cursor inside its own local transaction.
- `persistReconfigurationPatch`, `commitAutomationStructureTransition` and
  `restoreFailedReconfiguration$` now explicitly compare the previous and
  returned source and delete the cursor in the same transaction when the
  connector/form, owner/workflow, event kind/type or intended-enabled state
  changes. The shared predicate accepts ordinary values only. Compensation
  keeps the saved prior cursor for its restored source; same-source official
  pauses retain progress.
- `projectGoogleFormsEnabledEventConfig` still deletes a changed account cursor
  in the enable transaction. That path and the official reconciliation helpers
  still propagate database/transaction handles. Their complete command
  ownership is unfinished R1 work; adding explicit deletes does not complete it.

The removal gate has two distinct parts. First, finish and verify the complete
R1 cursor-writer inventory and the remaining command boundaries, including the
remaining shared create/enable and official reconciliation command ownership.
This is implementation work, not a deployment wait. Second, incompatible pre-R1
repair/source writers must no longer serve or remain in flight, and rollback
targets must contain the new explicit protocol. In particular, the inspected
outgoing repair performs an unconditional `last_seen_submitted_time` overwrite
on conflict after fetching newest response time; deleting migration 1290 now
would restore the previously identified response-loss window. Only after both
parts hold may R2 drop these triggers/functions while R1 and R2 mix. No extra
release wave is inferred from this remaining work.

#### Publication interval and compensation ownership

Create and enable now retain an in-memory observation of the exact automation
row returned by their INSERT/UPDATE: full-precision `updated_at::text` plus
PostgreSQL `xmin`. Repair captures the same observation together with its
retained cursor. Publication locks and checks this observation before writing
watch state or a cursor. An enable/disable/re-enable ABA, even within one
JavaScript timestamp millisecond, rejects the old preparation as superseded.
The user API returns conflict and requires fresh preparation; it never reports
successful creation with a missing cursor.

Create's failed or cancelled watch preparation deletes only its observed
candidate row. Enable compensation is now a command with business arguments,
its own `writeDb$` and direct conditional SQL. It cannot restore a newer enable,
and it deletes a cursor only when it actually restores an explicitly disabled
interval. Official enable finalization and reconfiguration compensation also
compare the observation returned by their owning write. No observation is
persisted as a field or embedded in configuration JSON.

Official structure transitions prepare the remote Forms watch before committing
the desired source. This staging step does not insert a cursor for a source that
is not committed yet. The structure transaction changes the source and binds
its prepared cursor together; its SQL builder accepts only ordinary values.
Existing progress still wins on conflict. Same-source reconfiguration keeps
the prepared baseline as a fallback for a missing cursor instead of stripping
it before publication; a retained cursor is never overwritten.

The new API regressions replace the enabled interval through real disable and
enable requests while the provider's response request is in flight. They cover
both a delayed successful response and a provider failure. They require the
new interval to remain enabled, stale success to return conflict, and dispatch
to start after the new interval's cursor. This is not a runtime test of an
outgoing API binary, nor completion of the remaining legacy command graph.
Shared create/enable/account preparation and official reconciliation still
propagate database handles and need their own command-boundary work. The
compatibility triggers cannot be removed on the strength of this fence alone;
the full writer inventory and supported outgoing/rollback evidence remain
required.

### Validation

The Forms interval fence, compensation, structure publication and two new API regressions pass the full API type-check command, focused ESLint, plain Oxlint and formatting. Behavioral execution remains with the combined PR pipeline. Focused ESLint/Oxlint/format checks pass for the earlier committed source changes. DCR final command publication core types and Calendar core types pass; the integrated PR must validate the latest combined head and schema migration. The command-owned accepted-catalog reader retains the current identity/cache check, exact payload identity query and one bounded retry when activation changes the sole current row. It reuses the same attestation and compatibility validation as legacy readers. The Forms schema snapshot changes only google_forms_automation_cursors; the subsequent custom migration adds the two cursor invariant functions/triggers. API tests cover remote-watch repair/catch-up, pending responses after an already enabled automation rebinds the same watch, DCR concurrent authorizations using a shared published client with usable callbacks, and explicit Forms disable/re-enable behavior. A response retrieval calls the real disable API before returning provider data, then asserts that no automation input was enqueued. Existing API coverage also exercises source account switches, connector deletion/re-add and same-target official reconfiguration. The mixed-version claim additionally relies on the inspected outgoing SQL writing `watch_state_id` in every cursor upsert; the tests do not pretend to execute an outgoing API build. No local Vitest suite or development server was run.

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

Automatic callback security tests also use provider HTTP boundaries. One rejected
DCR token exchange performs a real sibling-account replacement before retirement;
the replacement stays connected. Cross-method exchanges each return a real
`invalid_client`, so both rejected registrations become unusable rather than
assuming the old transaction admitted only one provider request. The internal
account-lock fixture and lock waiter are removed from these cases. A reconnect
token response deletes its account through the API before returning, and the
callback must reject publication without recreating that account. Concurrent
callbacks based on one account revision still allow only one completion receipt.

Automatic post-commit cancellation cases abort the request at the Ably provider
boundary, then read the account, sync the running target and request firewall
authorization through production APIs. They verify both retained OAuth token
use and no-auth credential removal, plus the runtime wakeup payload. The private
SQL COMMIT pause fixture is removed. Non-cancelled start/callback outcomes remain
covered by the ordinary Automatic API suites; these cases no longer duplicate
them. This exercises cancellation during notification, not an artificial pause
inside database COMMIT.

DCR retirement tests retain same-user/other-user delete and default-selection
races. They now start the account API while the real provider token response is
pending, release that external response and assert both request outcomes and
the final account list. They no longer hold database rows or observe lock
waiters. The stale-catalog test retains pre-request and in-flight provider
refresh changes with credential-denial assertions; its duplicate "while auth
waits" internal-lock variant is removed. These were the final callers of the
connector account row-lock fixture, so that fixture is deleted entirely.

### Refresh compatibility and missing protocol

The outgoing Automatic refresh path handles `invalid_grant` by updating
`connectors` by account ID alone. It also persists returned credentials without
comparing the originally observed authorization. R1's exact account/token
publication and failure predicates prevent those stale writes in future R1
writers, but cannot constrain an already executing outgoing request. Removing
the lifecycle/account advisory coordination therefore requires that outgoing
writers are no longer serving or in flight and that supported rollback targets
include these predicates.

That is separate from the unfinished provider-rotation protocol. The current
Automatic resolver still holds its transaction while decrypting, performing the
provider refresh and encrypting output, and passes the transaction to its DCR
store. The ordinary builtin and model-provider graphs also retain propagated
handles. All supported rotating-token callers need a common protocol that
preserves successful credential publication and rejects replacement/revoked
authorization when provider work is moved outside the transaction. CAS after a
provider response alone does not establish the provider-side single-use-token
behavior. This is R1 implementation work, not a condition that deployment drain
can satisfy and not permission for a permanent exception or an extra release.

### Explicit Forms lifecycle writers follow-up

Thread deletion now removes the cursor with the same SQL transaction that disables an ordinary Forms automation; an official automation with preserved enabled intent retains its repair cursor. Membership cleanup uses its own command transaction to disable ordinary automations and delete their Forms cursors. Connector removal deletes cursors whose retained event configuration still identifies that account, after the existing FK clears the projected connector. Publication takes the connector parent row before its automation row to match connector deletion ordering.

The thread-deletion and credential-storage operations still belong to legacy caller-owned transaction graphs. Their cursor lifecycle SQL is explicit, but their handle propagation is implementation work, not an outgoing-writer drain gate. The provider-backed disable/re-enable API regression also exercises deletion of the bound chat thread, and checks the re-created thread for skipped disabled-period responses.
