# Desktop Testing Patterns

This guide defines the integration-test boundaries for
`turbo/apps/desktop`. It extends the project-wide rule: write tests at entry
points, keep internal code real, and mock only external system boundaries.

Desktop has more than one entry point. It is an Electron app, a renderer UI, a
preload bridge, and a native macOS helper. Tests should
choose the smallest entry point that matches the behavior being protected.

## Entry Points

### Renderer App

Renderer tests should enter through the Desktop UI, not through extracted
formatters or internal helpers.

Use this boundary for behavior in:

- `src/renderer/App.tsx`
- `src/renderer/computer-use-state.ts`
- `src/desktop-bridge.ts`

Mock the external bridge objects on `window`:

- `window.okouDesktopComputerUse`
- `window.vm0DesktopAuth`

Keep renderer modules real. Assert visible user behavior and bridge outcomes:

- Signed-out users can start sign-in.
- Signed-in users without an active workspace can select one.
- Missing Accessibility or Screen Recording permissions show request/settings
  actions.
- Ready/offline, online, recovering, and error states expose the expected
  controls.
- Command history, app state, screenshots, and runtime errors render through the
  UI.

Do not export display helpers from the renderer just to unit-test them.

### Preload And IPC Bridge

Preload and IPC tests should exercise the bridge boundary between the renderer
and Electron main process.

Use this boundary for behavior in:

- `src/preload.ts`
- `src/computer-use-electron.ts`
- `src/desktop-auth-electron.ts`

Mock `electron` as the external runtime. Keep Desktop channel modules and
validation logic real.

Useful assertions include:

- Computer Use IPC rejects calls from non-Desktop renderer URLs.
- Desktop auth completion is accepted only from configured app origins.
- Invalid bridge payloads are rejected, such as empty auth tokens or non-boolean
  keep-awake values.
- Subscribe and unsubscribe attach and detach the expected channels.
- Change notifications are sent only to live windows.

### Native Helper Protocol

The JavaScript native backend should be tested at the helper process protocol
boundary. A fake helper process is the right test double because the helper is
external to the JavaScript runtime.

The Swift helper itself should keep using SwiftPM tests for native policy and
algorithm behavior under `native/computer-use-helper/Tests`.

### App Lifecycle And Packaged Artifacts

Avoid wholesale unit tests for `src/main.ts`. Main process behavior should be
covered through stable external boundaries:

- Electron lifecycle events when a focused event harness exists.
- IPC and preload bridge tests.
- URL callback and second-instance behavior.
- Packaged artifact verification in `.github/workflows/desktop.yml`.

Keep artifact checks focused on observable package contents and platform
configuration: bundled main/preload files, native helper executable presence,
bundle identifiers, URL schemes, icons, runtime config inclusion or exclusion,
and release/update packaging rules.

## Mock Boundary

Desktop tests may mock:

- `electron`, because it is the external app runtime.
- Fake native helper executables, because the helper is outside the JS process.
- External HTTP/API boundaries when a test exercises network behavior.
- Node process execution only when the behavior being tested is not the CLI
  process boundary.

Desktop tests should keep real:

- Desktop source modules.
- The filesystem, using temp directories.
- Channel constants, URL policy, payload validation, state machines, and bridge
  wiring.

Do not use relative internal `vi.mock()` paths for Desktop implementation
modules.

## Narrow Exceptions

Pure or matrix-style tests are allowed only when the integration boundary would
make the test much larger without adding equivalent confidence.

Accepted examples:

- Security and navigation policy matrices such as `window-policy.test.ts`.
- Tray menu state matrices such as `desktop-tray-menu.test.ts`.
- Native helper policy and algorithm tests in Swift.

New exceptions should be justified by security risk, algorithmic complexity, or
state-matrix size. Do not add unit tests just to raise coverage percentages.

## CI Expectations

Desktop PRs should use workspace-scoped checks:

```bash
pnpm -F @okouai/desktop check-types
pnpm -F @okouai/desktop lint
pnpm -F @okouai/desktop test
pnpm -F @okouai/desktop test:native
```

Use narrower focused commands while iterating, then run the relevant full
Desktop checks before opening or updating a PR.
