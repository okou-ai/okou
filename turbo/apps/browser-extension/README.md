# Okou Browser extension

The first-party MV3 extension owns source-window consolidation and native window/tab control. The portable CDP client/protocol lives in `@okouai/browser-extension-client`. The worker and client have independent connection/session lifetimes; disposing a client never closes user tabs or windows.

From this directory:

Packaging requires `zip` and `unzip`. Release-boundary tests also use `yq`; CI runs these commands on the standard Ubuntu runner.

- `pnpm build` builds the worker and deterministic ZIP/checksum/source provenance under `artifacts/`.
- `pnpm test` runs the owned full-Chromium scenarios against loopback fixtures, one worker at a time. Set `CHROMIUM_EXECUTABLE` to select an installed full Chromium. Headless Shell cannot load extensions.
- `pnpm verify-package` checks ZIP contents and repeatability across timezones.
- `pnpm check-types` and `pnpm lint` use the shared workspace conventions.

The manifest and package version are managed together by release-please. Production publication packages the immutable release source and uploads it to Browser Use before API deployment. When the release includes an extension, API deploys with that exact upload's ID. Without an extension release, the shared API deployment environment action queries Browser Use and selects the highest numeric `Okou Browser` version across all pages. Preview/staging API deployments use the same lookup. Missing extensions, ambiguous highest versions and provider failures stop deployment.

The resolved UUID is pinned in the API deployment's required `OKOU_BROWSER_USE_EXTENSION_ID` environment setting. It is not read from or persisted to a GitHub Variable. Every new managed Browser installs that deployment's selected extension; an existing Browser retains its installed ZIP until normal instance replacement. The provider upload UUID differs from Chromium's runtime ID. Future uploaded versions must remain compatible with supported API consumers.

Release commands run from the repository root. Publication takes `RELEASE_TARGET`, `BROWSER_EXTENSION_VERSION` and `BROWSER_EXTENSION_TAG`; credentials come from `GH_TOKEN` and `OKOU_BROWSER_USE_API_KEY`. It reads the package's `artifacts/` directory, preserves immutable artifacts and upload-attempt/completion receipts, and writes the verified `extension_id` to `GITHUB_OUTPUT`. A publication failure blocks that release's API deployment; an uncertain upload must be reconciled before rerunning.

The deployment resolver takes `BROWSER_EXTENSION_RELEASE_CREATED` (defaults to `false`). When `true`, `BROWSER_EXTENSION_ID` must be the valid UUID from this release's publication; lookup is not substituted for a missing output. Otherwise it uses `OKOU_BROWSER_USE_API_KEY` to list extensions and compare their stable `x.y.z` release versions numerically. It prints only the selected UUID to stdout and exits nonzero on failure. API runtime does not query the extension registry.

The release retains the ZIP, checksum, source provenance, upload attempt and completed upload receipt as immutable GitHub release assets. A rerun reuses a matching completed upload. If an attempt has no completion receipt, reconcile the provider outcome before rerunning; the publisher refuses to create a second upload.

For explicitly authorized provider verification, `pnpm test:provider` uses `OKOU_BROWSER_USE_API_KEY` to upload a disposable artifact, create its own Browser, validate bridge/routing/worker behavior, and clean up those resources. It does not use an existing Browser or change live configuration. PR CI runs local Chromium and controlled provider-boundary fixtures instead.
