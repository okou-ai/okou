# release-please-config

## release-please-config-001

- Vitest: "release-please API deployment graph > keeps every release package in the manifest"
- Mode: run
- Intent: review
- Given: Release Please has a package configuration and version manifest.
- When: The configured package paths are compared with the manifest.
- Then: The manifest contains every configured path.

## release-please-config-002

- Vitest: "release-please API deployment graph > keeps CLI build identity release-managed"
- Mode: run
- Intent: review
- Given: The release config, release manifest and CLI package metadata are present.
- When: The CLI entry for `turbo/apps/cli` is checked.
- Then: The entry is a Node release with component `cli`, and its manifest version equals the CLI package version.

## release-please-config-003

- Vitest: "release-please API deployment graph > release-manages the standalone App Worker deployment source"
- Mode: run
- Intent: review
- Given: The standalone App Worker package, release config, release manifest, exclusion inventory and release workflow are available.
- When: The CI release definitions for the App Worker are checked.
- Then: The App Worker is a Node release with a manifest version matching its package and is absent from workspace exclusions. The release job exposes the App Worker release flag, production promotion requires the App release and depends on the release job, build completion and successful API promotion. Its steps do not declare `continue-on-error`.

## release-please-config-004

- Vitest: "release-please API deployment graph > uses the release-managed connectors version as catalog validator identity"
- Mode: run
- Intent: review
- Given: The connectors workspace package version and Release Please manifest are present.
- When: The manifest entry for `turbo/packages/connectors` is inspected.
- Then: It equals the connectors package version.

## release-please-config-005

- Vitest: "release-please API deployment graph > tracks every API runtime workspace dependency"
- Mode: run
- Intent: review
- Given: The API package declares its runtime workspace dependencies.
- When: Every runtime dependency whose name starts with `@okouai/` and whose specifier is `workspace:*` is checked against the release manifest.
- Then: The manifest contains each corresponding package path.

## release-please-config-006

- Vitest: "release-please API deployment graph > builds and deploys API for every release"
- Mode: run
- Intent: review
- Given: The Release Please workflow defines API production promotion and API schema deployment.
- When: Their job definitions and conditional expressions are inspected.
- Then: Both jobs contain the GitHub Actions `always() &&` condition and omit the `api_release_created` gate in their job headers. The API promotion job does not declare `continue-on-error`.

## release-please-config-007

- Vitest: "release-please API deployment graph > builds the API before migrations and deploys it afterward"
- Mode: run
- Intent: review
- Given: The release workflow defines the API production promotion job.
- When: The build, environment resolution, schema upload, migration smoke, migration and Vercel deployment steps are checked in workflow order.
- Then: Toolchain initialization occurs once. The API artifact builds before production environment resolution and migrations. Schema upload follows the build, and production smoke migrations precede production migrations. The build step does not read secrets. Vercel setup runs before migrations, application deployment runs after migrations and deployment completion follows that deployment. The Vercel deploy receives `prebuilt: "true"` and `skip-setup: "true"`.

## release-please-config-008

- Vitest: "release-please API deployment graph > keeps Vercel setup enabled for other deployment callers"
- Mode: run
- Intent: review
- Given: The reusable Vercel deploy action declares a `skip-setup` input and a setup step.
- When: The action input default and step condition are inspected.
- Then: The input defaults to the string `false`, and setup runs unless it is set to the string `true`.

## release-please-config-009

- Vitest: "release-please API deployment graph > keeps Vercel setup enabled for other promotion callers"
- Mode: run
- Intent: review
- Given: The reusable Vercel promote action declares a `skip-setup` input and a setup step.
- When: The action input default and step condition are inspected.
- Then: The input defaults to the string `false`, and setup runs unless it is set to the string `true`.

## release-please-config-010

- Vitest: "release-please API deployment graph > promotes App after the API production lifecycle"
- Mode: run
- Intent: review
- Given: The Release Please workflow includes the App Worker production promotion job.
- When: Its condition is inspected.
- Then: The job requires successful API production promotion.
