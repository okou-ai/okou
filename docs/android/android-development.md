# Android Development

Build native features around explicit domain contracts, identity, and lifecycle
owners. Setup, dependency pins, commands and distribution instructions belong
in the component [README](../../android/README.md).

## Ownership

| Owner                             | Responsibility                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Kotlin state holders              | Immutable feature state, pure derivation and semantic actions                                          |
| ViewModels and Flow               | Screen state retention, observable data and explicitly scoped work                                     |
| App workspace/draft/screen owners | Identity, semantic actions, retained work and native lifetime composition                              |
| Data services                     | Canonical API transport, confirmed synchronization, durable cache, uploads and authorization protocols |
| Domain values/projections         | Structured message meaning, event replay and pure business decisions                                   |
| Compose/native controls           | Rendering, keyboard/IME, selection, focus, scrolling, accessibility and presentation                   |

Keep Android UI types out of pure Kotlin state/domain owners. A ViewModel is appropriate when its
navigation lifetime matches the work; it is not automatically an authenticated
workspace owner. Replace identity-scoped owners on account/workspace changes
and reject late publication from retired scopes. Token renewal alone does not
change durable identity. Temporary UI detachment, configuration changes and
process death are distinct events. Persist meaningful drafts/cursors through
the owning data contract; in-memory UI state is not durable storage.

Observe authorization changes as well as identity. SDK client snapshots can
change memberships, roles or permissions without changing user/session/workspace
IDs. Revalidate those changes and fence pending token/API work against the
captured authorization snapshot. Exclude incidental token timestamps from the
snapshot key so routine renewal does not discard an authorized presentation.

## State and Async Work

Follow [CCState principles on Android](android-ccstate.md) for single-source,
derivation, action and ownership rules. Keep mutable state private and expose
read-only StateFlow/Flow or Compose State with ordinary semantic methods.
Use native primitives before introducing a custom framework. Pure helpers and
API/storage services remain ordinary typed interfaces.

Each async operation has a trigger, owner, completion/error path and teardown.
Use structured coroutine scopes and cooperative Job cancellation. StateFlow is
thread-safe, but complete domain transitions still need a coherent immutable
snapshot or explicit serialization. Keep UI-only APIs on their required thread;
make blocking data operations main-safe with injected dispatchers. Collect
screen flows using collectAsStateWithLifecycle and choose upstream sharing by
the work's actual lifetime.

Await finite work. A row disappearing closes its UI subscription, not another
consumer's shared request. Retain business operations at their actual owner;
view scopes do not grant ownership of Send or authorization. Cancellation is
not remote rollback, and transport failure is not proof that a write failed.
Use stable operation/event identity and authoritative readback where required.

## First Display And API Loading

API requests must not block the first native screen from opening. Render the
native root/navigation and an appropriate destination while responses are still
pending. Do not await bootstrap, session, configuration or catalog requests before
setting root content, or keep the splash screen visible until they complete.

Start requests under their actual asynchronous owners independently of rendering;
they may run concurrently with the first frame. Keep request preparation and
decoding main-safe. Moving a request off-main is insufficient if the UI still
waits for its result before rendering. Do not introduce an artificial delay before
starting requests to satisfy this rule.

Show truthful destination-local loading, error and retry states, or a native
identity-checking screen when the destination is not yet known. Initial display
does not establish usable data, freshness or authorized access. Protected content
and actions still require their actual identity, permission and initialization
prerequisites; cached content and late results remain scoped to the correct owner.

Apply [first-display verification](android-testing.md#first-display-with-pending-api-requests)
when introducing the corresponding API consumers. A standalone benchmark target
or numerical startup budget is not a prerequisite for applying this contract.

## Native Presentation

Use Kotlin and Compose for application UI and native APIs for OS interactions.
External OAuth should retain its own system-browser/session and server-receipt
verification contract. Do not render provider credentials or first-party
application flows as an unowned embedded website.

Use Web semantic color roles through generated Android resources. Shared brand
assets and licensed Geist fonts retain their source artwork and licenses;
Android controls own dp/sp, touch targets, scaling, back navigation and focus.
Do not copy iOS point sizes, Apple materials or Swift UI APIs as Android rules.
The shared primary role can be a pale fill. Use a readable foreground role for
text-only actions and state indicators instead of assuming that fill contrasts
with its surrounding surface; verify contrast against the actual surface.

Use string resources for product copy and preserve user text verbatim. Keep
IME composition, selection, undo and cursor state with the editing owner.
The feature owner receives semantic text/document edits; rendering must not create
new business owners or imperatively start duplicate requests. Maintain accessibility
names, font scaling, contrast and system inset/keyboard handling.

Retain editable text together with its native selection/composition value at
the presentation owner. A business preview or submission is a separate immutable
snapshot; do not synchronize two continuously editable strings with an effect.
Navigation/configuration retention does not establish durable process restoration.

Keep device-local preferences with one process-owned store and explicit
presentation read/write/retry states. Observe disk asynchronously without making
unrelated content wait for it. A completed write and the UI's observation of
that value can arrive separately; preserve pending intent until confirmation
instead of accepting a newer action against an obsolete value. IO failure must
not masquerade as a saved preference, and cancellation retains its native meaning.

Resolve an explicit app appearance from the correct generated day/night
resources, independently of the phone's mode. Keep the Activity context and its
owners intact; a configuration-specific Resources instance is sufficient for
token lookup. Native system-bar presentation follows the resolved app mode.

### Saved Instance State

`rememberSaveable`, `rememberSerializable`, `SavedStateHandle` and registered
saved-state providers share the Activity's Bundle. Supported types do not imply
bounded size. Keep only restoration metadata, such as IDs, flags, selection and
scroll positions, there. Documents and pending business operations retain their
own private persistent owner; a Bundle budget must not become a document limit.

First-party saveable APIs belong in
[`SavedUiState.kt`](../../android/app/src/main/kotlin/ai/okou/android/state/SavedUiState.kt).
Use its native metadata/editor adapters and explicit collection retention policy.
The source audit rejects direct saved-state API imports, aliases, wildcard imports,
qualified references and provider registration outside that boundary. This is an
architectural source boundary, not a general Kotlin data-flow or third-party SDK audit.
Framework controls such as lazy lists can also contribute saved state indirectly.

Journal-backed editors save native selection only and wait for the body to load
before consuming that selection. Keep text, IME and selection with the native
editing value while the data owner receives semantic text edits. Bound both the
size of a saved value and the number of retained presentation targets.

Measure the complete app-owned Activity state after the superclass save returns;
ComponentActivity writes Jetpack providers after the ordinary lifecycle callback.
The platform post-save callback requires API 29, while this app supports API 24.
The shared budget is checked on every Debug save, including CI. An excess fails
with byte counts only; it must never clear the Bundle, truncate input or spill
arbitrary Parcel bytes to disk. Release does not add a second serialization pass.

The Binder buffer is shared with other process transactions, so an Activity
budget is headroom and a regression check, not a guarantee for every IPC. Follow
the [official Bundle guidance](https://developer.android.com/guide/components/activities/parcelables-and-bundles)
and verify the actual save boundary through the
[Android testing guide](android-testing.md).

## Service and Release Boundaries

### Local Storage

Use Android's storage owners and choose the location by data lifetime. Structured
server-confirmed chat data uses Room/SQLite, with Web's snapshot, event replay,
cursor and consistency rules as its semantic reference. Keep one lazy database
owner per application process; run IO off Main and commit related records in a
transaction. Store snapshots as per-entity rows so tail appends do not rewrite an
entire archive. Use the AndroidX bundled SQLite driver to avoid CursorWindow's
per-row limit. Native response decoding must not add data-size/count limits that
reject legitimate canonical data Web can read; use streaming and cursor progress
checks. Export Room schemas through its Gradle plugin. A disposable-cache rebuild
policy must never cover user-authored drafts
or other data that cannot be recovered from the server.

Resolve paths through Context, never hard-code device paths. Keep offline cache
databases in app-private `noBackupFilesDir` and disposable download/upload staging
in `cacheDir`; neither requires storage permissions. Durable unsent input needs
its own private persistent owner and explicit migration/recovery rules. Credentials
belong to the authentication SDK/Keystore, and device preferences to DataStore.
Canonical member preferences remain server-owned. User-selected imports/exports
use the Storage Access Framework or MediaStore as appropriate, and sharing uses
content URIs with scoped grants rather than exposing private file paths.

Scope protected content by API origin, account and workspace; revalidate current
authorization before restoring it. Keep optimistic mutations and transient stream
deltas outside confirmed tables. Storage failures must remain observable without
discarding already confirmed live content. Closing a workspace cancels its work
and retires its storage lease; physical database/file cleanup must not block Main.
Tests must close/checkpoint SQLite before copying or restoring its files.

### Public Android Entry Points

An exported component can be launched by another application. The desktop
launcher must be public, so export alone is an audit signal, not proof of an
authorization defect. Keep private activities, aliases, services, receivers and
providers explicitly unexported. Review external Intent values, URI grants,
deep links and sensitive actions at their actual authorization boundary.

The source-manifest audit in `.github/scripts/checks/android_launcher.py`
recognizes only the app's reviewed `.MainActivity` and its single MAIN/LAUNCHER
filter. It rejects additional public components, data filters and extra routes
in Android source manifests. Semgrep still scans the source; result handling
exempts only its `exported_activity` audit finding inside that validated
component, in both JSON gating and SARIF publication. Other rules, files,
locations and malformed findings remain subject to the existing checks.

Adding a public entry or new Intent handling needs security review, including
input validation and authorization of the reachable operation. The manifest
guard cannot establish runtime authorization or audit third-party AAR manifests;
review dependency/merged-manifest changes and the packaged release separately.
Do not broaden count baselines or suppress unrelated findings to add an entry.

### Service and Distribution Contracts

Application endpoints belong in the existing canonical API service, not an
Android-specific proxy. Before adding real requests, implement the owning
transport, credentials/client identity, error/426 handling and native API
consumption compatibility inventory. Installed apps and API deployments are
independent; follow [deployment compatibility](../deployment-compatibility.md).
Public assets and signed storage transfers must not inherit API credentials.

Treat push registration/delivery, app links, signing and store availability as
their own verified platform contracts. Neither an APK nor a CI configuration
proves external configuration or delivery. Follow [Android testing](android-testing.md)
for verification and separate build, tests, device acceptance and publication.
