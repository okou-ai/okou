# Commit Types and Releases

Choose a commit type that accurately describes the change. Do not relabel a
refactor as a fix merely to obtain a release.

## Sources of Truth

- [commitlint.config.mjs](../../../commitlint.config.mjs) validates commit types
  and formatting.
- [release-please-config.json](../../../release-please-config.json) owns package
  paths, visible/hidden changelog sections, and workspace plugins.
- [release-please.yml](../../../.github/workflows/release-please.yml) pins the
  action and owns release/deployment execution.

The behavior below was checked against action
[`3971df4`](https://github.com/maxandzoe/release-please-action/blob/3971df459631cdcf704dcbf86231cb26b790a7c8/package-lock.json),
whose lockfile resolves release-please to
[`4356ee0`](https://github.com/vm0-ai/release-please/tree/4356ee011768b5e6f8bb0f06b44135dea76cb8a5).
Recheck these sources when the action, configuration, or dependencies change.

## Current Direct Release Behavior

For commits assigned to a configured package, with an existing version and no
explicit version override:

| Commit                                                             | Default result                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| Breaking change (`!` or `BREAKING CHANGE`)                         | Major bump                                              |
| `feat`                                                             | Minor bump                                              |
| `fix`, `perf`, `docs`, `refactor`, `ci`                            | Patch bump; these types have visible changelog sections |
| `chore`, `style`, `test`, `build`, `revert` without breaking notes | Hidden; do not independently produce a release note     |

Release-please also has a visible `deps` section, but `deps` is not an allowed
manual commit type in the current commitlint configuration.

This is a two-part decision. The
[default version strategy](https://github.com/vm0-ai/release-please/blob/4356ee011768b5e6f8bb0f06b44135dea76cb8a5/src/versioning-strategies/default.ts)
selects major for breaking changes, minor for features, and patch otherwise.
The [base strategy](https://github.com/vm0-ai/release-please/blob/4356ee011768b5e6f8bb0f06b44135dea76cb8a5/src/strategies/base.ts)
skips a direct release with empty changelog notes; the
[changelog writer](https://github.com/vm0-ai/release-please/blob/4356ee011768b5e6f8bb0f06b44135dea76cb8a5/src/changelog-notes/default.ts)
uses the configured visible sections. Therefore documentation and refactoring
changes are not categorically release-free.

## Scope and Exceptions

- Package path assignment matters; a root documentation change is not itself a
  change in every versioned package.
- Multiple commits use the highest applicable bump. Breaking notes and explicit
  version overrides can change the result above.
- Node and Cargo workspace plugins can propagate dependency version updates to
  packages with no direct visible commit. A hidden type is not a guarantee that
  no package version will change.
- `skip-changelog` suppresses the changelog file update, not the package's entire
  release lifecycle.
- Check the generated release changes and workflow results for the actual
  version and deployment outcome. A commit type alone is not release evidence.
