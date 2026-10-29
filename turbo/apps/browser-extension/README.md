# Okou Browser extension

The first-party MV3 extension owns source-window consolidation and native window/tab control. The portable CDP client/protocol lives in `@okouai/browser-extension-client`. The worker and client have independent connection/session lifetimes; disposing a client never closes user tabs or windows.

From this directory:

- `pnpm build` builds the worker and deterministic ZIP/checksum/source provenance under `artifacts/`.
- `pnpm test` runs the owned full-Chromium scenarios against loopback fixtures, one worker at a time. Set `CHROMIUM_EXECUTABLE` to select an installed full Chromium. Headless Shell cannot load extensions.
- `pnpm verify-package` checks ZIP contents and repeatability across timezones.
- `pnpm check-types` and `pnpm lint` use the shared workspace conventions.

The manifest and package version are managed together by release-please. Production publication packages the immutable release source, uploads it to Browser Use, verifies the configured provider extension ID, and only then deploys API with that same ID. The provider upload UUID differs from Chromium's runtime ID. A running Browser retains its installed ZIP until normal instance replacement.

The release retains the ZIP, checksum, source provenance, upload attempt and completed upload receipt as immutable GitHub release assets. A rerun reuses a matching completed upload. If an attempt has no completion receipt, reconcile the provider outcome before rerunning; the publisher refuses to create a second upload. The existing CI GitHub App installation needs repository Variables write permission; its short-lived token is scoped to this repository and revoked after publication.

For explicitly authorized provider verification, `pnpm test:provider` uses `OKOU_BROWSER_USE_API_KEY` to upload a disposable artifact, create its own Browser, validate bridge/routing/worker behavior, and clean up those resources. It does not use an existing Browser or change live configuration. PR CI runs local Chromium and controlled provider-boundary fixtures instead.
