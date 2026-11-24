# Authentication Setup and Workspace Sessions

Android uses the official Clerk Android API and UI. A signed-out launch opens
the native Compose `AuthView`, following the iOS root presentation contract.
Clerk renders enabled methods for email, codes, passwords, signup, legal steps,
extra verification and passkeys. Provider OAuth, including Google, uses the SDK's
system-browser session. First-party credentials are entered in native controls.

The platform launch window briefly covers SDK initialization. The first native
frame shows the shared brand if restoration is still pending. Initialization
errors expose a localized retry. An authenticated user without a usable workspace
sees membership selection or web workspace setup and refresh/sign-out actions.
The empty workspace page checks memberships when the user returns from web setup
in the same session. Full first-user onboarding remains a separate slice.

## Public configuration and provider setup

The default API/web origins and public Clerk publishable key match
`ios/Config/Shared.xcconfig`. Staging builds may override them with Gradle properties:

```bash
./gradlew :app:assembleDebug \
  -Pokou.apiOrigin=https://your-staging-api.example.com \
  -Pokou.webOrigin=https://your-staging-app.example.com \
  -Pokou.clerkPublishableKey=pk_test_YOUR_PUBLIC_KEY
```

These values are public APK configuration. Never supply a Clerk secret key.
API configuration must be an HTTPS origin. Debug logging, SDK telemetry and
cross-app session sharing are disabled. App backup remains disabled.

Before accepting a build against an instance, verify Native API enablement and
Android native registration in Clerk. The namespace is `ai.okou.android`; release
application ID is `ai.okou.android`, debug is `ai.okou.android.debug`. Review the
SDK routes for each package:

- `clerk://<applicationId>.oauth`
- `clerk://<applicationId>.callback`

Passkeys additionally require a valid Android Digital Asset Links association
for the actual package and signing certificate. A debug certificate, a production
certificate and successful iOS authentication are different evidence. Verify the
instance's `/.well-known/assetlinks.json` and an actual signed-device passkey flow.
Production signing material remains in the existing GitHub `production` environment;
this feature introduces no signing secrets or certificate files in source control.

The app does not receive tokens or user/workspace identities from Intent extras.
The pinned SDK owns callback state, pending OAuth and authoritative Clerk receipts.
If process death interrupts authentication, retain only SDK-restored session state
and restart login when needed; an incoming URL alone never authorizes a workspace.
There are no general application links or durable pending feature destinations yet.

The existing source-manifest and JSON/SARIF guard still exempts only the exact
MAIN/LAUNCHER entry. `check<Variant>AuthenticationManifest` also checks the actual
merged dependency manifest during debug/release assembly: exact package-specific
Clerk callback filters, permission-protected Google revocation/profile installer
entries, debug-only Compose test activity, no unknown public components, a private
disabled shared-session provider and no app backup. Clerk initialization addresses
that provider by component name, so it must remain registered even when sharing
is disabled. No Semgrep baseline is widened.

## Ownership and canonical bootstrap

`ClerkAuthentication` is the application-lifetime SDK adapter. `SessionModel` owns
authorization, the current API resource and its workspace presentation store.
Identity includes API origin, user, Clerk session and workspace. An additional
in-memory generation fences replaced work; it is not persisted as identity.

A locally restored active SDK session with a selected workspace opens the native
chat list immediately in its loading state. The workspace owner refreshes Clerk
and confirms the organization with the origin-bound API client. A selected
membership with known permissions in both the refreshed and observed SDK state
allows the complete workspace picker to load separately. Startup falls back to
the complete membership request when that evidence is unavailable. The existing
Room connection can open during these checks. Scoped rows are restored after
authorization while canonical preferences and list synchronization run.

A 409 or incomplete timezone, locale or member memory invokes the existing
idempotent preferences initialization endpoint. Complete preferences enable the
workspace's protected actions, settings and realtime attachment. Ordinary preference
failures leave the authorized list visible and retry initialization in the same
workspace. A change of identity, access loss or required update retires the owner.

After the user confirms sign-out, the waiting screen hides workspace content
during the Clerk request. A rejected request with the same authorization restores
the originating page and shows localized feedback. The Clerk session change
retires the former workspace.

There is no backend schema or migration. Existing server initialization can fill
missing preference/default-executor metadata and create missing member memory and
its existing proactive workflows. It does not replace existing memory content.
Clerk alone persists encrypted authentication/device credentials through its
Android Keystore owner. Credentials never enter appearance DataStore or content
caches. Workspace drafts remain in-memory presentation data.

`MemberPreferencesModel` belongs to that presentation store and owns canonical
preferences, pending selections and save/refresh/error state. Palette and locale
updates send only selected fields through the existing preferences API. Local
appearance stays in DataStore. A missing palette displays Default without a
write; a saved locale outside `supportedLocales` displays English as on Web.
Native app-locales APIs project the current workspace's language and return to
system language without a workspace. AppCompat supports Android 24–32 and the
platform handles Android 33+. Locale recreation retains the session, editing and
navigation owners. Server bootstrap restores canonical preferences on a new owner;
no separate member-preference cache or durable draft store is introduced.

Preferences refresh on foreground without replacing those owners. Automatic
refresh preserves unconfirmed selections after failed saves, including a resume
caused by locale recreation; explicit refresh reads back the canonical result.
A business read rejected with HTTP 401 can renew its credential and retry once
within the same workspace. If the API still rejects it, the app shows workspace
recovery. Explicit access loss and required updates retain their own screens.
Member preference and default-model reads keep the last confirmed values and
retry twice at three-second intervals on recoverable failures.

Signing out or changing account/workspace closes API resources, cancels pending
work and clears the old presentation store before another owner can be published.
Both before and after token acquisition, the captured identity and generation must
still match. Non-cooperative late completion cannot publish into a replacement.
Healthy requests use the SDK's cache and refresh policy. Concurrent read
rejections serialize credential renewal and reuse the replacement from Clerk.

## Verification

Run `bash android/scripts/check.sh`, instrumentation assembly and release assembly.
Host tests cover list first display and cached rows with held startup responses,
canonical initialization/write conditions,
membership/access changes, replacement, failed/retried bootstrap, late token/API
completion, native first display and Activity recreation. Test authentication and
the test Application/runner live only in test source sets; production has no bypass.
The existing native device suite exercises the real Activity with an explicitly
injected test workspace.

CI emulator tests exercise native controls, configuration/app-language changes,
system bars and retained editing with test-only authentication/API fixtures.
Keep that evidence distinct from live provider registration, OAuth/passkeys and
process-death acceptance. A successful build or fixture-backed test does not
establish that an external instance is configured. Provider setup above describes
those deployment requirements, rather than an additional physical-device CI gate.
