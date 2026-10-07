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
that host requests use their independent host token, and that input cannot be
replayed after helper retirement. Native helper tests cover Accessibility policy,
window targeting, screenshots, and input recovery in the existing backend.

Build each affected packaged configuration with `desktop/scripts/build.py`.
Use `--development` for preview isolation. Packaging must retain the Clerk
resource bundle, native backend, same production bundle ID, and legacy Swift
ShipIt relaunch bridge. `--smoke-test` checks startup without touching account
state or registering a host. It does not prove login, permissions, or remote
command execution.

## Native Acceptance

Use the actual packaged app for these cases:

- Signed-out users complete native sign-in and workspace selection.
- Existing native sessions and the installation ID survive migration.
- Accessibility, Screen Recording, and browser Automation display their actual
  state and expose request/settings actions.
- Online, offline, recovery, disabled, and error states show the expected controls.
- Computer Use returns a target-window screenshot and indexed Accessibility
  state, and delivers input only to the selected app/window.
- Closing the window retains the menu-bar host; reopening restores the window.
- Stop, workspace changes, sign-out, quit, and updates drain work and report
  completion before retiring authority.
- Developer Tools and command diagnostics remain gated by the server switch.

For distribution changes, test signed ZIP and mounted DMG startup, validate
Developer ID and notarization, and exercise the actual old Squirrel replacement
and relaunch path in an isolated installation. A fabricated feed alone does not
prove that an installed updater can start the native app. Preserve the real
production feed and installation while using the isolated updater harness.

## Release Workflow Contracts

The `.github/scripts/tests/` Desktop tests protect version-file migration,
immutable SHA-addressed R2 artifacts, exact-artifact promotion, signing inputs,
and publishing the mutable manifest only after notarized assets succeed. Run
them when changing Desktop workflow or release ownership. Release Please
workspace coverage must recognize the standalone `desktop` component.

The API's Desktop update-route tests protect both legacy `RELEASES.json` and
native `appcast.xml` responses, shared blocked-version selection, retired lines,
XML escaping, and manifest-unavailable behavior.
