# Release 1 credential and provider-watch boundaries

Forms and Calendar lifecycle acquisitions are removed. Other credential/watch coordination remains as described below; these completed paths do not establish that Release 1 is complete for the whole package.

### Implemented

- Forms remote watch preparation, renewal, inventory and response pagination run outside local publication transactions. Publication uses existing watch identity and exact state observations. Reconciliation discovers remotely missing watches and restores delivery; missed triggers during failure and repair are accepted.
- If an outgoing stop deletes a watch after preparation observed it, Forms publication returns conflict. A fresh request or reconciliation may prepare a new watch and newest-response baseline; it does not report successful setup without a usable local watch.
- Forms watch publication, state renewal/removal and account reprojection commands execute their own SQL. New consumer reads and retry writes are commands with no database argument. Advisory statement builders accept only ordinary values. Shared workflow creation, enable and official reconfiguration ownership remains listed below as implementation work.
- Forms queue admission receives an ordinary source observation and prepared input. `enqueueGoogleFormsWorkflowInput$` owns the local transaction and directly inserts the context, appends through the canonical pure SQL builder, validates source identity, records deduplication, advances the cursor and marks the thread queued. It passes no database or transaction to a helper, callback or another command. Its append-before-source-lock order matches outgoing writers, and source rejection rolls back the entire input. Model selection and message preparation now occur before queue transactions.
- Forms keeps the existing non-null cursor/watch foreign key with `ON DELETE CASCADE`. Physical watch deletion may discard the cursor. The unpublished detachment and two cursor-trigger migrations are withdrawn; no Forms schema change or new stored coordination state remains.
- DCR registrations are prepared remotely and encrypted before publication. Custom and builtin publication commands own finite SQL, compare the observed registration and return a compatible current winner. New preparation reads own database access. Builtin publication also locks and checks the existing accepted catalog identity, so catalog changes during remote preparation reject stale publication.
- Automatic OAuth callback reads its bound DCR client, decrypts it, exchanges the provider code and encrypts the resulting tokens before local publication. The publication command owns direct SQL, checks the accepted catalog identity and live registration, and atomically replaces the metadata, credentials and binding. Reconnect publication compares the exact account timestamp and `xmin` observed before the provider request; a replacement or deletion rejects stale output. Registration retirement has a separate direct-SQL command for callback failures. The callback entry point now uses command-owned state claim, accepted catalog reads and post-commit wakeup, with no database handle in those command arguments or closures. Catalog decoding receives ordinary payload values, and realtime publication receives ordinary selected rows after SQL has finished. Wakeup completes before the request observes cancellation after a committed publication. The legacy Automatic refresh store remains transaction-aware.
- Automatic start uses a command-owned account snapshot before remote discovery/preparation and a final direct-SQL publication. Public no-auth connections replace metadata and clear credentials atomically; authorization state insertion validates the accepted catalog and unchanged reconnect account. Start no longer passes a transaction to account resolution, state insertion or credential replacement helpers.
- Ordinary builtin credential refresh captures exact stored inputs before provider I/O. Local publication validates owner, principal, method, storage and credential bytes. A lost refresh publication is rejected as connection-changed, including after a stale terminal failure. An updated token bundle cannot prove that the change came from another refresh rather than a replacement authorization. The stale request therefore cannot reuse the replacement token, mutate the new connection or return unpublished provider output.
- Onboarding recommendation credential collection, provider refresh, authority recheck and job orchestration now use business-input commands. Job claim and result/checkpoint transitions directly own their bounded SQL; provider collection, generation and KMS remain outside transactions. Builtin secret/variable reads pin the original full-precision connection timestamp, and a successful refresh cannot switch to a subsequently replaced authorization during its reload. The API regression deletes the Gmail account through its public endpoint while a provider read is pending and verifies that revoked-source context is discarded. Existing background-job fields are reused unchanged; legacy background-job helpers for other owners remain separate work.
- Home-page Gmail evidence collection, authority rechecks, cached-card filtering and cron refresh now use business-input commands. Their SQL reads and conditional cache writes obtain `writeDb$` locally. Shared scope and permission reads have direct-SQL commands, and event/org predicates are pure SQL builders. Provider, Clerk and generation work stays outside SQL. Gmail collection pins the credential timestamp through every authority recheck, including after refresh, so same-account OAuth replacement discards content collected under the old authorization. Public API tests cover both permission denial and same-account reconnect during the provider response. The route's optional catalog-chip projection is a separate legacy read boundary; other scope/permission callers and legacy predicate signatures still require their own caller migration.
- Shared firewall builtin and model-provider refresh success/failure writes compare the observed existing metadata timestamp and PostgreSQL `xmin`. A successful publication claims that exact owner row before persisting the credential bundle in the same transaction; a changed or deleted row rejects the result without writing output credentials. These tokens are held only for the in-flight request, with no new persisted state. This is conditional-write preparation, not removal of the shared runtime transaction or provider-I/O boundary.
- Automatic MCP credential resolution retains the exact existing consent binding (`xmin` and its full-precision creation timestamp) and access ciphertext. Both outgoing and R1 reconnect publication replace that binding; token refresh leaves it unchanged. A concurrent expiry request may reuse a sibling refresh only while that same consent binding survives. Comparing only the account metadata timestamp rejects a legitimate sibling refresh, while comparing only changed token ciphertext would wrongly accept replacement authorization. Its refresh publication still claims the exact current account metadata and stored refresh ciphertext before writing output tokens; terminal failure marks only that observed state. Exact DCR registration retirement remains a separate resource-wide invalidation when the provider rejects that client. The legacy Automatic refresh transaction and propagated resolver helper graph still require migration.
- Calendar provider pagination, credential preparation and channel registration precede conditional publication in its owning command. The lifecycle advisory key, pending channel and previous-channel recovery protocol are removed. Publication compares the original principal, exact stored credential bytes and observed watch state; cleanup after an uncertain commit rereads current channel ownership. Superseded channels are stopped outside transactions on a best-effort basis, and failed cleanup does not block the current channel. Snapshot writes use at most 250 events per local transaction; pagination and batch iteration remain outside transactions.

- Credential secret/variable authorization predicates are pure SQL builders. Their complete account, owner, auth-method, storage-version and optional revision checks no longer receive a database or transaction from any caller. Calendar watch publication's exact credential predicate is also a pure SQL builder; it receives only the observed account and stored credential bytes.

- Google Drive artifact status and upload now call credential commands using only business inputs. Thread authorization, exact/default account selection, artifact ownership and hosted-deployment reads each obtain their own database in the owning command. The service has no database-handle parameter or captured database passed into a computed. Upload refresh now commits the exact observed credential bundle before retrying Google; previously this caller omitted persistence and used unpublished provider output. The public sync followed by artifact-status regression verifies the committed token remains usable when a subsequent refresh would be refused. Provider HTTP, KMS and R2 work run outside these SQL reads and the shared finite publication transaction. The shared refresh coordinator remains subject to the provider protocol and old-writer limitations below.

- Gmail mail-draft reads, linking, local projection and credential resolution now use business-input commands; no database handle enters or leaves those commands. The link uniqueness conflict is read directly inside its owning insert transaction. Provider operations run directly outside SQL rather than inside a database-aware callback adapter. Gmail authorization failure compares the exact account owner, method and observed full-precision metadata revision before marking reconnect. A late rejected request cannot disconnect an account that was replaced through OAuth while the provider request ran. Refresh publication returns its committed existing timestamp as an in-memory observation, so rejection of the newly published access token can still mark that exact current revision. Public API regressions cover both orders without database gates. These conditional local writes do not establish safe remote single-use token rotation for every provider.

- Ordinary model-provider multi-auth publication now owns the finite secret cleanup, secret upserts and metadata publication in one command transaction. Encryption and realtime remain outside. The selected auth method's declared secret fields bound the write set; unknown fields are rejected before encryption or SQL and cannot overwrite another provider's secret. The existing compatibility key executes directly from a pure SQL statement builder rather than receiving a transaction. Ordinary deletion uses the same direct statement. Model-provider gateway list and post-publication readers also own their SQL with no database arguments. These changes retain the same runtime compatibility acquisitions; moving their SQL definition is not lock removal.

- Single-secret model-provider publication now commits the secret and provider metadata together in one command-owned transaction. It performs only the current provider read and the two bounded upserts; KMS preparation and realtime are outside. An interrupted or rejected metadata write cannot leave a separately committed replacement secret. No advisory acquisition or schema state is added.

- Personal subscription account activation and upsert now execute in business-input commands. Profile lookup and KMS finish before publication. The upsert owns its logical provider row, reads at most eleven connected rows to enforce the existing ten-account cap, and separately reads at most one matching retained identity. It does not scan every retained account into the transaction. Direct account/secret SQL and pure SQL builders commit replacement, live-run retention, the complete bounded secret bundle and model selection together. Existing unique constraints still arbitrate identity and active-account writes; a deadlock with another account writer returns the existing retryable conflict. Exact profile observations compare the current metadata revision and credential ciphertext before adding legacy identity metadata. A public API regression races two real device-auth completions at nine accounts and requires exactly one additional connected account. This scope adds no advisory acquisition or persistent state. Run-retention cleanup still has a separate legacy interface.

- Personal exact-account and all-account disconnection now share business-input preparation and publication commands. Profile/KMS work finishes first. The publication command locks the existing logical provider row, examines at most eleven connected rows to enforce the existing ten-account bound, and directly commits exact profile hydration, live-run retention or deletion, active-sibling selection and unreferenced provider removal. It passes no database handle to a helper and never opens nested per-account transactions. Pure SQL builders receive ordinary values only. Realtime follows commit. Existing user API coverage retains captured-run authority; the account lifecycle test also disconnects two remaining accounts, verifies the empty public list and requires 404 on repeated deletion. A real account conflict now reaches the API as 409 rather than being ignored by the old disconnect-all loop. Terminal-run retained-account cleanup remains separate implementation work.

- Builtin no-secret model-provider settings execute their existing unique-index upsert directly in the owning command. The unused database-taking package operation and export are removed. Existing provider IDs, selected-model behavior and post-commit notification remain unchanged.

- Claude Code and Codex device-session start, load, state changes, completion claim and cancellation now use top-level commands with ordinary business parameters. Each SQL command obtains `writeDb$` and executes its own statement. Provider calls and provider-state encryption remain outside SQL; no transaction or database is captured in the abort listener. The listener dispatches cancellation using only the committed session ID and owner values. Start/complete/import/cancel orchestration no longer passes database handles through command arguments. Existing device-auth API tests cover start, cancellation, exchange, completion, scope authorization and concrete-account import; the provider rotation admission gap is independent of this session bookkeeping.

### Remaining implementation work

- Builtin OAuth callback, Automatic OAuth refresh and its legacy retirement store, ordinary refresh's legacy helper-owned commit path and its remaining resolver chains still propagate root database or transaction values. Automatic callback including state claim, catalog preparation and post-commit wakeup has a command-owned boundary. Other builtin/custom callback routes still use the legacy state helper; it remains only for those actual callers.
- Model-provider firewall refresh has not been migrated to the complete final command-owned conditional protocol; it still executes provider/KMS work through the locked helper graph. Personal account activation/upsert and ordinary multi-auth/single-secret settings now own their SQL. Retained-account cleanup still propagates database handles. They remain implementation work rather than an outgoing-writer gate.
- Gmail now has explicit approval for local disable, stopping renewal and remote natural expiry without account-global `users.stop`. Its remote-stop code is removed. Ensure, renewal and watch reconciliation now use owning commands; missing-thread initialization and shared credential callers remain. Gmail queue source admission now has an owning command, described below. Calendar also has explicit approval for a remote gap and best-effort candidate cleanup; authority and basic deduplication remain required.
- Calendar ordinary lifecycle, activation/reconfiguration, reconciliation, credentials, dispatch reads and queue admission now use business-input commands. Its missing workflow-thread initialization and shared create/official/account projection graphs still forward handles, and are unfinished implementation. The separate builtin credential key remains for the shared account protocol, not for gap-free Calendar delivery. Calendar remote-stop preparation for account deletion and principal replacement is now outside the caller transaction; unrelated credential revocation preparation in the shared graph remains unfinished.
- Forms workflow-thread creation still accepts a transaction. Shared create/official authority preparation and queue model preparation retain legacy database interfaces. Forms account-deletion watch preparation now has its own command outside deletion transactions. The regular Forms watch/configuration/dispatch credential path now uses owning commands. Other event sources still use the legacy workflow queue source callback; this does not claim to migrate those sources.

### Validation

Focused checks cover the changed Forms commands, provider-backed API tests and migration inventory. Combined types and behavior are verified by the parent owner on the integrated PR head. No local Vitest suite or development server is run. Existing DCR API cases verify a common published client and usable callbacks. Calendar and credential cases retain source isolation and replacement-token assertions. Forms tests cover normal notification delivery, retry deduplication, repair followed by usable notifications, explicit disable/re-enable, source selection and late preparation rejection. They do not require replay of a failure window or execute an outgoing API binary.

Repository error handling classifies Codex refresh_token_reused and refresh_token_invalidated as terminal. The inspected code/tests do not prove that submitting a concurrent duplicate refresh invalidates an already successful winner's whole token family. That claim must not be used as a demonstrated impossibility argument.

### Test consolidation

The Calendar source-switch regression now changes account selection through the
public API while the external Google events response is in flight. It still
requires the old source to dispatch no run; the service and route no longer
expose an internal before-admission hook. Forms retry deduplication shares the
normal metadata-delivery setup and asserts one visible automation event after
redelivery, instead of counting provider reads. Remote-watch repair checks that
later notifications work; it no longer asserts automatic failure-window catch-up.
Explicit disable/re-enable remains separate because user stop must suppress events.

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

### Forms lifecycle and command ownership

The accepted behavior permits missed triggers during a failure or watch repair.
It does not permit dispatch through a retired account or reactivation after a
user disable, member departure, thread deletion or credential revocation.

`publishGoogleFormsWatch$` checks the observed automation and current account
before publishing prepared state. `publishGoogleFormsActivation$` keeps an
ordinary automation disabled during provider work, then checks the exact existing
row observation and selected account before enabling it. Both commands obtain
`writeDb$` internally and execute finite SQL directly. Activation retains only
the existing account compatibility key; the second lifecycle try-lock and its
contention protocol are removed. Local watch row/identity constraints protect
publication. A concurrent remote deletion can cause the accepted delivery gap.

The full-precision timestamp and PostgreSQL `xmin` are ordinary in-memory
observations, not new fields. They reject late enable/create results and stale
cleanup. Departure and bound-thread cleanup update even already-disabled
ordinary automations, so preparations started before revocation lose authority.
Verified session membership does not require an eventually populated cache row.
Failure cleanup may remove only its observed candidate; it cannot restore or
delete a newer user choice. Those guards protect authority rather than replay.

`googleFormsAccountProjectionStatement` builds finite SQL from business values.
It locks the owner's automation rows in ID order, directly publishes the actual
selected/default account and removes an incompatible cursor. There is no null
staging projection or account-replacement interval protocol. A missing account
remains unavailable through the existing nullable business relation. Readers
and final queue admission require the exact current source, so an old account's
notification cannot dispatch after selection changes. Reconciliation can seed
its missing cursor from newest and resume later notifications.

`setDefaultGoogleFormsAccount$` commits the owned account's default flags and
source projection in one command-owned transaction. Ordinary enable uses an
owning authority reader, business-only watch commands and an owning post-commit
summary command. SQL builders never receive or execute a database handle.
Post-commit realtime and provider work run outside the transaction.

Forms-to-Forms official reconfiguration uses
`reconcileOfficialGoogleFormsConfiguration$`. Its command checks the accepted
catalog, installed workflow, selected account and exact automation observation,
then writes the new configuration, cursor, existing official identity and
workflow timestamp together. It accepts prepared business values; provider
preparation precedes the transaction. Cursor publication may establish a fresh
baseline. The legacy compensation path no longer saves or restores a Forms
cursor to guarantee replay. Business configuration rollback still rejects stale
ownership; the user did not waive permission or configuration correctness.

Reconciliation inventories remote watches even when local expiry is healthy.
It no longer dispatches synthetic catch-up events on every sweep. A physical
watch deletion cascades its cursor; repair may begin at newest. The old stop/new
ensure race returns conflict if the observed state disappeared, without a
special original-seed recovery loop. An already usable same-source binding may
keep its ordinary cursor, but no no-loss guarantee is made across repair or
mixed API versions.

User API tests retain normal dispatch and duplicate rejection, enabled-state
behavior, explicit stop/re-enable, account switches, connector deletion/re-add,
and superseded preparation after a real nested user operation at a provider HTTP
boundary. Remote repair now verifies subsequent notifications, not recovery of
all responses from the gap. No internal database gate or lock waiter is added.

### Forms migrations and remaining work

On 2026-09-29, PR #37313 is open with `mergedAt: null`. Main `c26098d` and the
latest observed production deployment's `main` tree `c501c3b7` contain neither
of this PR's Forms migrations; their journal ends at 1287. This source/deployment
evidence supports withdrawing these unshipped changes, not changing deployed
history. The prior `1289_google_forms_cursor_detachment` and
`1290_google_forms_cursor_lifecycle` are removed, including both function/trigger
inventory entries. The cursor schema is identical to main.

After integrating main `bf7c3d6`, published migration 1288 is also preserved.
The three Drizzle-generated PR migrations are
`1290_retire_provisional_billing_purge`,
`1291_retire_cloudflare_scope_change_trigger`, and
`1292_retire_billing_attribution_mutation_guard`. Historical migration files
through 1288 remain unchanged. The generated snapshots' structural schema
matches main exactly; only their generated identity chain differs. The final
zero-trigger and no-new-field requirements remain in force, and Forms no longer introduces a trigger removal
gate based on outgoing newest-response repair.

The Forms service has no Db parameter interface. Remaining R1 implementation is
explicit: its missing-thread branch still hands tx to the shared thread initializer,
and shared Forms creation still propagates handles; generic
account deletion, selection and credential callers retain their legacy outer
transaction graphs. Cross-kind official transitions, initial materialization and
other providers' finalization paths still need command ownership migration.
These are implementation gaps, not outgoing-writer drain conditions. The Forms lifecycle advisory key is removed in R1: outgoing stop/reseed can
produce only the now-accepted temporary watch/baseline gap, and neither operation
reactivates an automation. R1 publication and admission still check the current
automation/account source. Renew and stop use single conditional statements,
without a transaction wrapper. Builtin credential coordination is separate: old
refresh publication and invalid-grant handling write by account identity after
provider work without the common stale-authorization predicate. Its removal
requires the credential protocol and outgoing-writer gates, not cursor replay.
Accepted watch tradeoffs do not authorize stale credential publication.

### Forms credential and dispatch command follow-up

Regular Forms configuration, ensure, reconcile and dispatch now call the owning
builtin credential commands. Connection and encrypted input snapshots are read
by commands using `writeDb$`; KMS decryption, provider refresh and output encryption
finish before the publication command opens its local transaction. That command
executes the existing account/input predicates and credential writes directly.
It passes no database or transaction to another function. Pure existing value,
crypto and SQL-condition helpers remain shared with unmigrated provider callers.

The credential behavior is preserved: stale authorization cannot inherit a new
connection's token, failed old refresh cannot mark a replacement as revoked, and
provider output is returned only after its conditional local publication wins.
The old helper interface remains for actual non-migrated callers; the provider
rotation common-protocol obligation is not declared complete by this boundary
change alone.

Forms watch lookup, event history and duplicate reads own their SQL. Dispatch
uses commands with plain source observations instead of passing a database and a
store-capturing run callback through helpers. Fire permission reads retain the
membership, workflow visibility, installed official workflow and agent visibility
checks. Missing-thread initialization still calls the legacy thread transaction
helper, so that specific graph remains unfinished.

Account-deletion watch preparation now uses `prepareGoogleFormsWatchStopForConnector$`
with ordinary owner/account inputs before the deletion transaction. It reads
credentials through the same owning commands and returns only the token and
exact watch identities. The legacy Forms credential resolver is removed.
Best-effort remote cleanup runs only after the account deletion confirms a
committed deletion; a missing account or an uncertain/failed transaction does
not trigger cleanup. Concurrently replaced or unobserved remote candidates may
remain until expiry under the accepted Forms behavior. The generic account
selection, credential deletion and other providers' cleanup transaction graph
still needs its own command-ownership migration.

### Gmail local stop and natural expiry

No production path calls Gmail `users.stop`. Ordinary last-consumer cleanup now
removes only inactive local watch rows and stops renewing them. Account deletion
no longer decrypts or refreshes Gmail credentials to prepare an account-wide
remote stop, and no post-commit stop request can terminate another consumer's
newer watch. The provider may continue sending notifications until expiry.
Local dispatch already checks enabled consumers and current account authority;
inactive notifications cannot start a run.

Local cleanup additionally uses `NOT EXISTS` over current enabled consumers,
so a stale inactive-state read cannot delete the state of a newly enabled
consumer. Other identities sharing the physical mailbox retain their own local
state and may continue renewal. The basic processed-event uniqueness remains.
The obsolete stop-token preparation, sorted scope-stop transaction and remote
stop retry logic are removed. No fields or replacement coordination are added.

API tests remove the remote-stop pause fixture and the old mandatory stop-count
assertions. They verify disable/re-enable and account deletion without `users.stop`,
no credential refresh/history fetch after last-consumer disable, and a second
identity still consuming after the first disables. Source selection, revocation,
message dispatch and retry deduplication remain covered. The normal source test
no longer mutates an internal projection to simulate an old API before asserting
its public result.

Gmail ensure, physical-scope renewal, reconciliation and projection repair now
accept business inputs in commands. Credential reads, KMS, OAuth refresh and
profile requests complete before watch publication. Projection repair owns its
finite SQL transaction and uses ordinary SQL predicates for the selected account.
All route, account deletion, automation enable and official watch adapters call
these commands without forwarding a database or transaction.

One **compatibility boundary**, distinct from the remaining implementation work,
is still required. Outgoing pre-R1 `reconcileGmailPhysicalScope` and connector
cleanup call account-wide `users.stop` while holding the existing mailbox/topic
lifecycle key. If a new writer performs `watch` outside that key while the old
stop is in flight, the old request can arrive last and disable a newly enabled
consumer. Gmail has no watch inventory read to promptly detect that loss. The
accepted Gmail decision does not permit interrupting remaining consumers.

`publishGmailWatch$` therefore temporarily owns the existing lifecycle key,
`watch` HTTP, and direct local publication in the same command transaction.
The healthy-state shortcut also runs under that key: an unlocked earlier read
could otherwise return success just before an outgoing stop deletes the state.
It acquires account/automation row locks only after the HTTP response and checks
current ownership, reconnect state, physical email and enabled/staged authority
before inserting a watch. No handle leaves the command. This is an explicit R1
exception to the final external-I/O rule, not a permanent transaction shape.

**R2 gate:** every API capable of `users.stop` has stopped serving, its in-flight
requests have drained, and the supported rollback target also uses local stop.
Then move `watch` HTTP before the finite publication transaction and delete the
lifecycle key. R1/R2 coexistence is compatible because neither calls `users.stop`.
Credential/account coordination has its own separate writer gates.

Gmail watch and automation reads, processed-event deduplication, resolved-label
publication and history-cursor updates now execute SQL in owning commands. The
resolved-label write is conditional on the observed event configuration, so a
late label lookup cannot overwrite a user's newer configuration. Ordinary and
official configuration preparation, account reads and credential access use
business inputs; ordinary configuration publication owns its short transaction
and reads its summary after commit. The dispatcher no longer passes a database
or a store-capturing start-run callback through event/history helpers.

`enqueueGmailWorkflowInput$` now owns durable source admission and queue SQL;
the transaction-aware `persistCurrentGmailAutomationSource` callback is removed.
It verifies the current account, watch and enabled automation before committing
the queued input. This is independent of the outgoing-stop compatibility gate.

**Still unfinished:** the Gmail missing-thread branch calls
`ensureWorkflowUserAutomationThread(tx, ...)`. Shared credential rotation,
generic account deletion and shared creation also retain their separate legacy
graphs. These are implementation work; they are not covered by the outgoing-stop
gate.
The migrated watch/configuration/dispatch SQL is complete within its stated
scope. API coverage retains shared-mailbox consumption, local disable and
reenable, authorized sources, deduplication and watch-error compensation; old
remote-stop retry assertions now check immediate local removal without
contacting `users.stop`.

### Unresolved one-time refresh consumption

Deleting the exact existing refresh-secret row with `DELETE ... RETURNING` before
an external one-time refresh would elect one caller without adding a field, but
it is not yet a valid complete protocol. All future readers would need to treat
missing refresh input as temporary: the current shared resolver can instead mark
`needsReconnect`, invalidating the in-flight winner. A process crash after that
DELETE commits but before the provider request also permanently discards a still
valid token; the token has no remaining durable copy from which to recover.
That is a new failure window, beyond the existing provider-success/local-commit
window, and is not approved by the watch behavior tradeoffs. An explicit provider
failure could conditionally restore an in-memory token, and an uncertain commit
requires authoritative reread, but neither addresses process loss. Do not
classify shared one-time rotation as complete or merely waiting for old writers
to drain on the strength of this proposal.

### Concrete mixed-writer refresh gap

The command publication predicate does not yet prepare every refresh writer. In
pre-R1 `agent-webhook-firewall-auth.service.ts`, `refreshAccessTokenForSource` holds the
existing connector-state key across provider HTTP, but `markRefreshFailure`
updates the account by identity without the new snapshot predicate. A new
command can refresh outside that key first, then the old writer can use the
still-stored old token, receive `invalid_grant`, and publish terminal reconnect
state. The new successful writer subsequently acquires the key but fails its
publication check. This is unfinished R1 protocol work, not a proven compatible
boundary awaiting deployment alone.

Moving new refresh HTTP under the existing key would protect that particular
old firewall interleaving. It would not cover the entire old graph: the legacy
shared refresh helper already performs HTTP outside the key, and its failure
UPDATE uses an `updatedAt` condition without acquiring the key. Every actual
failure writer must be covered before declaring preparation complete.

For a provider that permits one refresh success and whose rejected token reuse
does not invalidate the successful credential, refusing the failed request
without persisting terminal reconnect state can remove this local loser/winner
window. It must never return another authorization's newly stored token or fall
back to the expired token. Persistent-revocation UI projection and every caller
still need implementation and API verification.

That direction requires provider-specific evidence. For example,
[Auth0 documents token-family revocation on refresh-token reuse](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation):
a local non-mutating failure cannot recover a winner already revoked remotely.
Automatic OAuth supports arbitrary issuers, but this audit did not establish
that a currently connected issuer uses that policy. Conversely, multiple refresh
successes do not by themselves prove that the later result invalidates the earlier
one; [Microsoft explicitly preserves previously used refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens).
Do not generalize either behavior to every adapter, introduce a secret-deletion
claim, or describe the no-new-fields protocol as globally impossible.

### Calendar conditional publication and best-effort cleanup

The final Calendar lifecycle no longer creates an unpublished database channel or
tracks a previous channel until teardown succeeds. A command observes the source,
account and current watch, prepares Google pagination/registration outside SQL,
then publishes one complete channel using existing identities. The account check
includes owner, principal, method, storage version, exact metadata timestamp and
stored credential bytes. After refresh the request keeps its original account
identity and uses only the committed returned revision and token; a later
replacement authorization cannot be adopted by rereading the connector ID.

Only the current channel authenticates notifications. Snapshot batches lock that
channel and contain at most 250 events. The initial cursor is published after
baseline batches; replacement during preparation or batching cannot overwrite a
new channel. Failure during this sequence may require a fresh baseline and may
lose triggers, as explicitly accepted. Existing previous-channel columns are
cleared on publication and are no longer used as a recovery protocol; no schema
field, trigger or migration is added.

Calendar queue admission receives ordinary source and prepared-event values. Its
owning command appends canonical input SQL, validates and protects the current
channel, account owner and enabled automation, then queues the thread. A rejected
source rolls the input back. It passes no database or transaction to another
function. Existing processed-event uniqueness provides basic retry deduplication;
this does not promise exactly-once delivery during a provider failure.

The old Calendar lifecycle writer may still stop a previously observed channel
or replace a cursor during mixed serving. That can create an accepted notification
gap; it is no longer a reason to retain the lifecycle advisory key. The retained
builtin credential acquisition is separate: outgoing account replacement and
revocation writers still mutate shared account credentials without the complete
replacement protocol. Removing that key requires the common credential writer
implementation plus serving, in-flight and rollback compatibility evidence; it
is not merely a Calendar rollout gate.

API regressions retain normal notification delivery, basic deduplication,
source/account isolation, disable during registration and recovery to a usable
replacement. Cleanup failure now verifies that the old channel is rejected and
the new channel dispatches, without requiring a precise number or order of watch,
baseline or stop requests. Focused core types, formatting and changed-file lint
are checked locally; behavior remains subject to the combined PR-head pipeline.
No local Vitest suite or development server is run.

### Provider-specific refresh evidence and unresolved admission

The following first-party evidence was read on 2026-09-29. It describes supported
adapter contracts, not the number or state of production connections. It does
not justify one generic policy for every OAuth issuer.

| Adapter                                                 | Verified provider behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Consequence for this change                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Airtable OAuth, `https://airtable.com/oauth2/v1/token`  | The [API reference](https://airtable.com/developers/web/api/oauth-reference) says a refresh invalidates both previous access and refresh tokens; a recent refresh can return 409. The [official troubleshooting article](https://support.airtable.com/articles/6412360049-troubleshooting-disconnected-oauth-integrations-in-airtable) says OAuth safety violations revoke the integration and access, including reuse after the duplicate-refresh grace period. Neither inspected page gives the duration of that grace period. | This actual supported issuer prevents treating duplicate remote refresh as a harmless local CAS loser. Avoiding duplicate remote consumption still needs a protocol or an explicitly accepted availability tradeoff. It is not an outgoing-writer drain condition.                                                     |
| Calendly OAuth, `https://auth.calendly.com/oauth/token` | The [rotation guide](https://developer.calendly.com/docs/authentication/refresh-token-rotation-guide) explicitly tests `R1 -> R2`, rejection when reusing `R1`, then successful `R2 -> R3`. Reuse returns `invalid_grant`; the enforcement deadline was 2026-08-31.                                                                                                                                                                                                                                                              | A rejected concurrent use must not permanently prevent the successful request from publishing its exact observed credential bundle. The actual Calendly caller remains the firewall refresh graph; a classifier change only in the separate Google/Notion consumer command would not complete that caller's migration. |
| PostHog CIMD OAuth                                      | Our storage-v2 client is the public metadata URL documented in [deployment compatibility](./deployment-compatibility.md#posthog-cimd-oauth). At upstream commit [`d6225edecf52e800edb6ff846bd966ae9ed8f92a`](https://github.com/PostHog/posthog/blob/d6225edecf52e800edb6ff846bd966ae9ed8f92a/posthog/api/oauth/views.py#L870), `OAuthValidator.rotate_refresh_token` returns false for CIMD and DCR clients. Its non-rotating save branch inserts a new access token without revoking siblings.                                 | PostHog's global 120-second reuse-protection configuration applies to rotating clients; it is not evidence that our actual CIMD client revokes a successful sibling. The actual branch must be checked before using provider-wide settings as a blocker.                                                               |
| Box, Stripe Apps, Optimizely CMP                        | [Box](https://developer.box.com/guides/authentication/tokens/refresh), [Stripe Apps](https://docs.stripe.com/stripe-apps/api-authentication/oauth) and [CMP](https://docs.developers.optimizely.com/content-marketing-platform/docs/authentication-1) document single-use rotation. The inspected material does not establish family-wide revocation after duplicate use. Our Stripe adapter uses Marketplace authorization and `/v1/oauth/token`; it is not Stripe Connect.                                                     | Single-use failure/publication handling is necessary. Do not describe whole-family revocation as proven for these adapters from that evidence.                                                                                                                                                                         |

The current firewall provider request has a 30-second default abort timeout;
`FIREWALL_AUTH_REFRESH_TIMEOUT_MS` may override it with any positive integer.
It starts at the provider call, after the existing lock wait. An aborted client
request does not prove that the provider never accepted it or that an already
transmitted request cannot arrive later. A request/runtime deadline therefore
does not prove that Airtable's unspecified reuse grace covers all interleavings.
No production provider request was made to test this behavior.

A concrete problematic order is two callers reading the same usable Airtable
refresh token, one publishing its successful successor, then the other old-token
request arriving after the provider's grace period. Local publication CAS can
reject the second database write but cannot undo remote revocation. Keeping the
old token in otherwise unchanged committed business state does not elect one
remote caller. Holding a SQL transaction across provider HTTP violates the final
short-transaction boundary.

One possible business choice is to atomically consume the existing refresh
credential before HTTP and make only the successful consumer eligible to publish.
It adds no field, but an owner crash before HTTP then loses a still-valid local
credential and may require the user to reconnect. A failed or ambiguous request
cannot safely restore the old token because remote consumption is unknown.
This availability tradeoff has **not been accepted** and is not implemented.
Reinterpreting a timestamp or reconnect flag as a renewable claim would instead
introduce the prohibited coordination protocol. The current Airtable admission
and the remaining firewall command migration are explicit R1 gaps; this evidence
is not approval to retain a permanent lock or add a third release.

### Device authorization cancellation and credential publication

Claude/Codex device-session reads and writes now use commands that acquire
`writeDb$` internally. Provider HTTP and encryption stay outside SQL. Setup
can only advance an existing `initializing` session; late error/expiry writes
cannot replace a terminal status. Cancellation cleanup captures business IDs,
not a database, and stays registered until setup finishes.

The actual single-secret, multi-auth and personal-account publication commands
also conditionally complete the same existing device session in the credential
transaction. Exact organization, acting user, connector, source, `completing`
status and unexpired lifetime are required. If cancellation won, the whole
credential publication rolls back; if publication won, subsequent cancellation
cannot undo or revive that completed consent. Existing status fields are reused;
no claim, lease, coordination field, trigger or external I/O is introduced.

API tests cancel during the provider token HTTP exchange and verify that org
and personal credentials remain absent and the session stays cancelled. A
second test supersedes an in-flight setup through the public start API and
checks that its late result cannot replace the newer authorization. These tests
use neither database gates nor internal lock waiters. This closes device-session
publication only; provider refresh/revocation protocols remain listed separately.

### Gmail queue publication ownership

`enqueueGmailWorkflowInput$` accepts only a prepared input and ordinary source
identity. It obtains `writeDb$`, owns the finite transaction, inserts context and
the canonical event, rechecks mailbox/watch/account identity and the enabled
automation configuration, and publishes queue readiness. A changed source rolls
back the event. The command directly executes SQL; the former transaction-bearing
source callback is removed. Its existing builtin credential key and append-before-
source ordering still match outgoing queue writers. Thread creation and the
shared model-preparation graph are distinct unfinished boundaries.

The usage-hint thread-deletion race was traced through both callers: their
existing `tapError` boundary isolates a missing-thread append after financial
commit while retaining cancellation. No hint retry, parent lock or transaction
was added for that accepted best-effort output.

### Calendar retired-channel verification

Pipeline `36560635172` at `02b3748` exposed a Calendar test that still expected
an inactive old channel to remain locally authenticated after account selection
changed and remote stop failed. The accepted best-effort lifecycle instead
deletes that inactive local identity before attempting remote cleanup; the
notification lookup correctly returns 401. The test now constructs account
switching entirely through public APIs and verifies rejection, no queued Run
from the old source, and a Run bound to the selected account from its notification.
It removes the direct projection-clearing fixture and exact provider-read counts.
Normal notification, repair-to-usable-watch and permission tests remain; no old
channel recovery state, advisory gate or trigger is restored to retain the prior
200-with-zero-dispatch implementation detail.

### Gmail recreated-label publication

The combined `213f0fa` pipeline exposed a normal-delivery regression: label
lookup published a recreated label ID, then queue admission compared the old
configuration and rejected the same event. Label publication now returns the
committed automation snapshot; event matching carries that ordinary value into
queue admission. The conditional update also accepts the identical already
published label config, so another message in the same history response can
continue from the original snapshot. Different user configuration, disabled
state, changed account or missing watch still rejects publication. No database
handle escapes and no new lock, field or recovery mechanism is introduced.

The existing public API regression now supplies two real message identities in
one provider history response. It requires two visible workflow inputs and the
new label identity from the automation API. This preserves normal delivery and
does not impose gap-free watch recovery or provider invocation counts.
