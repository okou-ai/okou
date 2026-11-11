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

## Native Presentation

Use Kotlin and Compose for application UI and native APIs for OS interactions.
External OAuth should retain its own system-browser/session and server-receipt
verification contract. Do not render provider credentials or first-party
application flows as an unowned embedded website.

Use Web semantic color roles through generated Android resources. Shared brand
assets and licensed Geist fonts retain their source artwork and licenses;
Android controls own dp/sp, touch targets, scaling, back navigation and focus.
Do not copy iOS point sizes, Apple materials or Swift UI APIs as Android rules.

Use string resources for product copy and preserve user text verbatim. Keep
IME composition, selection, undo and cursor state with the editing owner.
The feature owner receives semantic text/document edits; rendering must not create
new business owners or imperatively start duplicate requests. Maintain accessibility
names, font scaling, contrast and system inset/keyboard handling.

## Service and Release Boundaries

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
