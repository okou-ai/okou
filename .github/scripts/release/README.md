# Release tools

These adapters prepare release decisions or promote verified artifacts. Run them
from the repository root; arguments and required environment are defined by each
command. [Artifact tools](../artifacts/) own build, fetch, verification and smoke.

| Responsibility                                                 | Entry point                                  |
| -------------------------------------------------------------- | -------------------------------------------- |
| Immutable CLI version publication                              | `publish-okou-cli-versioned-artifact.sh`     |
| Immutable App asset publication                                | `publish-okou-app-assets.sh`                 |
| Release PR gates                                               | `pass-release-pr-ci-gates.sh`                |
| Desktop version decision                                       | `resolve-desktop-version-change.sh`          |
| Production rollback decision                                   | `resolve-production-rollback-target.sh`      |
| Rollback dashboard body                                        | `update-rollback-dashboard-body.sh`          |
| Presentation archive build, verify and publish                 | `publish-presentation-template-archives.mjs` |
| Built-in Document archive verification and initial publication | `publish-document-template-bundle.mjs`       |

Presentation commands retain their modules in `presentation-template-release/`
and load the sibling `presentation-template-release.json`. When copying the tool
to an isolated release directory, copy the entry point, configuration and entire
module directory together, preserving their relative layout.

Keep immutable byte identity, publish-last readiness, database/R2 publication,
rollback floors and workflow signing/notarization ordering intact. Running tests
or moving tools does not publish a release. Follow the
[GitHub scripts standard](../../../docs/github-scripts.md) and
[deployment compatibility](../../../docs/deployment-compatibility.md).

## Built-in Document bundle

`document-template-bundle.json` pins the source commit, storage identity, version
and archive hash. The default command only verifies local bytes; publication
requires `--publish` and an existing official registry storage as the ownership
source. No database migration is required.

First merge the [template packages](https://github.com/okou-ai/Template-artifact/pull/84)
and [preview assets](https://github.com/okou-ai/static-files/pull/238). Check that
the preview files have mirrored to `static.vm0.io`. Keep
`builtinDocumentTemplates` disabled until the bundle is registered in the target
environment and both App/API and the runner CLI contain the Document resolver.
This adds a persisted `document` template discriminator: pre-change clients and
API rollback versions cannot parse those messages. Deploy compatible readers
first. Before broad enablement, refresh preview/staff clients and follow the
existing supported-client floor process for production; do not raise the floor
in the first release that introduces its replacement App. Once Document messages
exist, retain their schema reader even if the switch is disabled.

Build from a clean checkout of Template-artifact commit
`8dd104c4b805c1fdcbacf75a9f896a2b0c1e2b4b`:

```bash
python3 Document-built-in/tools/package.py \
  --out /tmp/document-template-bundle \
  --storage-id c192914c-af31-411d-8a17-77773e6866bf
```

From the Okou repository root, prepare isolated release tooling:

```bash
document_release_dir=$(mktemp -d)
cp .github/scripts/release/publish-document-template-bundle.mjs "$document_release_dir/"
cp .github/scripts/release/document-template-bundle.json "$document_release_dir/"
npm install --prefix "$document_release_dir" --ignore-scripts --no-fund \
  tar@7.5.22 postgres@3.4.9 @aws-sdk/client-s3@3.1116.0
node "$document_release_dir/publish-document-template-bundle.mjs" \
  --bundle /tmp/document-template-bundle
```

Verification checks the pinned archive digest, safe archive entries, every file's
hash/size, the content-addressed version and the 51-template catalog. It prints
`VERIFIED` and exits zero only after all checks pass. It needs no credentials.

For publication, use the existing release secret injection for `DATABASE_URL`,
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
`R2_USER_STORAGES_BUCKET_NAME`. Supply `--publish --owner-storage-id <UUID>` to the
same command; the UUID must be a verified existing official registry storage in
that environment. The publisher copies its organization/user ownership, uploads
immutable bytes with readback, registers the immutable storage/version through
existing unique keys, and advances HEAD with an identity-checked conditional
update. Interrupted preparation can be resumed with the same verified bundle.
Conflicting identities or bytes fail rather than overwrite.
`PUBLISHED` means the registration completed; any validation or provider failure
exits nonzero. Remove the temporary tooling directory after use.

Before enabling the switch, verify an authenticated
`okou resource pull template:document-builtins-v1 --dir ./generated/resources`
using the deployed CLI/API, then generate one invoice and one multi-page
agreement with the selected templates. Inspect both native output and page
previews. The agreement examples are layout outlines; their bundled upstream
clauses and confirmed user facts are the source for an actual agreement draft.
Disable the feature switch to roll back exposure; keep immutable assets and
registry versions intact for saved messages.
