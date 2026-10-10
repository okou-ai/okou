# Desktop Testing Patterns

Okou Desktop is a native Swift application under `desktop/`. Exercise production
entry points and mock only external operating-system, helper-process, and HTTP
boundaries. Keep host lifecycle, preferences, command budgets, and native
transport real.

## Automated Checks

```bash
swift test --package-path desktop -j 4
swift test --package-path desktop/ComputerUse -j 4 --disable-automatic-resolution
```

Core tests exercise existing Electron preferences, service-origin compatibility,
server claim deadlines, stdio protocol retirement, and the host HTTP lifecycle.
Verify that a late claim is completed without dispatch after admission closes,
that every host request obtains the current Clerk session token, and that input
cannot be replayed after helper retirement. Native helper tests cover Accessibility policy,
window targeting, screenshots, and input recovery in the existing backend.

Build each affected packaged configuration with `desktop/scripts/build.py`.
Use `--development` for preview isolation. Packaging must retain the Clerk
resource bundle, native backend, same production bundle ID, and legacy Swift
ShipIt relaunch bridge. `--smoke-test` checks startup without touching account
state or registering a host. `--auth-smoke-test` initializes the real Clerk SDK
and reports the Keychain service and signed-in state without registering a host.
Clean CI builds must start signed out in the new production/preview namespaces.
These checks do not prove interactive login, permissions, or remote commands.

## Native Acceptance

Use the actual packaged app for these cases:

- Signed-out users complete native sign-in and workspace selection.
- Electron upgrade users start signed out and retain their installation ID.
- Subsequent native launches and updates retain the new native session.
- Accessibility, Screen Recording, and browser Automation display their actual
  state and expose request/settings actions.
- Online, offline, recovery, disabled, and error states show the expected controls.
- Computer Use returns a target-window screenshot and indexed Accessibility
  state, and delivers input only to the selected app/window.
- Closing the window retains the menu-bar host; reopening restores the window.
- Stop, workspace changes, sign-out, quit, and updates drain work and report
  completion with the current Clerk session before retiring authority.
- Developer Tools and command diagnostics remain gated by the server switch.

For distribution changes, test signed ZIP and mounted DMG startup, validate
Developer ID and notarization, and exercise the actual old Squirrel replacement
and relaunch path in an isolated installation. A fabricated feed alone does not
prove that an installed updater can start the native app. Preserve the real
production feed and installation while using the isolated updater harness.

Exercise native automatic updates with complete signed/notarized apps, an
isolated bundle/profile, and an HTTPS appcast using an already trusted
certificate. Pinned Sparkle's code-signing-only validation rejects HTTP feeds.
Use a higher candidate version and verify background checking, download,
idle installation, replacement, and automatic relaunch. Validate the installed
app's signature, Gatekeeper acceptance, version, and executable against the
candidate; a successful feed response or download alone is insufficient.

## Release Workflow Contracts

The `.github/scripts/tests/` Desktop tests protect native version comparisons,
immutable SHA-addressed R2 artifacts, exact-artifact promotion, signing inputs,
and publishing the mutable manifest only after both notarized assets and API
deployment succeed. The API appcast route must be deployed before Electron
clients receive the first native ZIP. Run these checks when changing Desktop
workflow or release ownership. Release Please workspace coverage must recognize
the standalone `desktop` component.

The API's Desktop update-route tests protect both legacy `RELEASES.json` and
native `appcast.xml` responses, the frozen Electron migration hop, Native
blocked-version selection, retired lines, XML escaping, and manifest-unavailable
behavior.
