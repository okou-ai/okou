# Android Development

Build native features around explicit domain contracts, identity, and lifecycle
owners. Setup, dependency pins, commands and distribution instructions belong
in the component [README](../../android/README.md).

## Ownership

| Owner                             | Responsibility                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ccstate`                         | UI-independent graph values, derivation, commands, subscriptions and evaluation invalidation           |
| `ccstate-compose`                 | Native observation, asynchronous display phases, stable actions and subscription teardown              |
| App workspace/draft/screen owners | Identity, semantic actions, retained work and native lifetime composition                              |
| Data services                     | Canonical API transport, confirmed synchronization, durable cache, uploads and authorization protocols |
| Domain values/projections         | Structured message meaning, event replay and pure business decisions                                   |
| Compose/native controls           | Rendering, keyboard/IME, selection, focus, scrolling, accessibility and presentation                   |

Keep data/SDK types out of the graph core. A ViewModel is appropriate when its
navigation lifetime matches the work; it is not automatically an authenticated
workspace owner. Replace identity-scoped owners on account/workspace changes
and reject late publication from retired scopes. Token renewal alone does not
change durable identity. Temporary UI detachment, configuration changes and
process death are distinct events. Persist meaningful drafts/cursors through
the owning data contract; a graph cache is not durable storage.

## State and Async Work

Follow [Kotlin CCState](android-ccstate.md) for graph semantics. Keep definitions
stable and mutable inputs private; expose read signals and semantic commands.
Pure helpers and API/storage services remain ordinary typed interfaces when
they do not consume graph accessors.

Each async operation has a trigger, owner, completion/error path and teardown.
Store operations are synchronous and confined to the creating thread. Native
work may use an injected serial/main owner and move disk/network/CPU work off
it, then return before graph access. A dependency read after suspension remains
a graph read and must obey the same thread contract.

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
The graph receives semantic text/document edits; rendering must not create a
fresh graph or imperatively start duplicate requests. Maintain accessibility
names, font scaling, contrast and system inset/keyboard handling.

## Service and Release Boundaries

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
