# Release tools

These adapters prepare release decisions or promote verified artifacts. Run them
from the repository root; arguments and required environment are defined by each
command. [Artifact tools](../artifacts/) own build, fetch, verification and smoke.

| Responsibility                                 | Entry point                                  |
| ---------------------------------------------- | -------------------------------------------- |
| Immutable App asset publication                | `publish-okou-app-assets.sh`                 |
| Release PR gates                               | `pass-release-pr-ci-gates.sh`                |
| Browser extension publication                  | `publish-browser-extension.mjs`              |
| API deployment extension selection             | `resolve-browser-extension.mjs`              |
| Desktop version decision                       | `resolve-desktop-version-change.sh`          |
| Production rollback decision                   | `resolve-production-rollback-target.sh`      |
| Paired API Worker rollback                     | `rollback-api-worker-production.sh`          |
| Rollback dashboard body                        | `update-rollback-dashboard-body.sh`          |
| Presentation archive build, verify and publish | `publish-presentation-template-archives.mjs` |

Presentation commands retain their modules in `presentation-template-release/`
and load the sibling `presentation-template-release.json`. When copying the tool
to an isolated release directory, copy the entry point, configuration and entire
module directory together, preserving their relative layout.

Keep immutable byte identity, publish-last readiness, database/R2 publication,
rollback floors and workflow signing/notarization ordering intact. Running tests
or moving tools does not publish a release. Follow the
[GitHub scripts standard](../../../docs/github-scripts.md) and
[deployment compatibility](../../../docs/deployment-compatibility.md).
