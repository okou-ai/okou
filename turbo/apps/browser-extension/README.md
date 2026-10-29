# Okou Browser extension

The first-party MV3 extension owns source-window consolidation and native window/tab control. The portable CDP client/protocol lives in `@okouai/browser-extension-client`. The worker and client have independent connection/session lifetimes; disposing a client never closes user tabs or windows.

From this directory:

Packaging requires `zip` and `unzip`. Release-boundary tests also use `yq`; CI runs these commands on the standard Ubuntu runner.

- `pnpm build` builds the worker and deterministic ZIP/checksum/source provenance under `artifacts/`.
- `pnpm test` runs the owned full-Chromium scenarios against loopback fixtures, one worker at a time. Set `CHROMIUM_EXECUTABLE` to select an installed full Chromium. Headless Shell cannot load extensions.
- `pnpm verify-package` checks ZIP contents and repeatability across timezones.
- `pnpm check-types` and `pnpm lint` use the shared workspace conventions.

The manifest and package version are managed together by release-please. Production publication packages the immutable release source, uploads it to Browser Use, verifies the configured provider extension ID, and only then deploys API with that same ID. `OKOU_BROWSER_USE_EXTENSION_ID` is required; every new managed Browser installs that extension. The provider upload UUID differs from Chromium's runtime ID. A running Browser retains its installed ZIP until normal instance replacement.

The release command runs from the repository root. Extension publication takes `RELEASE_TARGET`, `BROWSER_EXTENSION_VERSION` and `BROWSER_EXTENSION_TAG`; credentials come from `GH_TOKEN`, `GITHUB_VARIABLES_TOKEN` and `OKOU_BROWSER_USE_API_KEY`. It reads the package's `artifacts/` directory and writes only the verified `extension_id` to `GITHUB_OUTPUT`. Only extension releases run the publication job and request a Variables token. Other releases retain the API job's required existing configuration. For an extension release, API deployment overlays the verified output onto its vars context immediately before rendering; a publication failure exits nonzero and blocks deployment. The first extension release initializes the Variable before API deployment, without a separate bootstrap path or extension-free fallback.

The release retains the ZIP, checksum, source provenance, upload attempt and completed upload receipt as immutable GitHub release assets. A rerun reuses a matching completed upload. If an attempt has no completion receipt, reconcile the provider outcome before rerunning; the publisher refuses to create a second upload. The existing CI GitHub App installation needs repository Variables write permission; its short-lived token is scoped to this repository and revoked after publication.

For explicitly authorized provider verification, `pnpm test:provider` uses `OKOU_BROWSER_USE_API_KEY` to upload a disposable artifact, create its own Browser, validate bridge/routing/worker behavior, and clean up those resources. It does not use an existing Browser or change live configuration. PR CI runs local Chromium and controlled provider-boundary fixtures instead.
