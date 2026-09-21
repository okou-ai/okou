# Publish the presentation extraction guide

The rename intentionally removes the old resource ID and extraction-directory
contract. Old CLI clients and the renamed API are incompatible. Keep the
product PR in **Draft** until the new resource has been published and read back;
coordinate its release with the renamed CLI. Preparing a bundle does not publish
it or establish that the resource exists in production.

This dedicated publisher only handles the guide from
[`okou-ai/vm0-skills@5426db7`](https://github.com/okou-ai/vm0-skills/tree/5426db7cc40e222b697f927645400994cd7e8b6b/extract-template/presentation).
It does not modify the presentation-template release protocol, add a workflow,
resolve old resource IDs, or delete historical archives.

## Prepare and verify locally

The pinned source fixture contains the three unchanged Git blobs from that
commit, as a deterministic contents-only archive. Its digest and source identity
are in `.github/scripts/presentation-extract-template-release/release.json`.
The output adds the `extract-template/` root that `okou resource pull` expects.
No file from the caller's working tree is substituted for the pinned source.

Use Node.js 24.21.0 and the pinned tooling versions. Install them outside the
checkout and copy only the publication tooling:

```bash
release_dir=$(mktemp -d)
cp .github/scripts/publish-presentation-extract-template.mjs "$release_dir/"
cp -R .github/scripts/presentation-extract-template-release "$release_dir/"
cp -R .github/scripts/presentation-template-release "$release_dir/"
npm install --prefix "$release_dir" --ignore-scripts --no-audit --no-fund \
  tar@7.5.22 @aws-sdk/client-s3@3.1116.0 postgres@3.4.9

node "$release_dir/publish-presentation-extract-template.mjs" prepare \
  --source-archive .github/scripts/__tests__/fixtures/presentation-extract-template-source.tar.gz \
  --output-dir ./generated/presentation-extract-template-release
node "$release_dir/publish-presentation-extract-template.mjs" verify \
  --output-dir ./generated/presentation-extract-template-release

PRESENTATION_EXTRACT_TEMPLATE_RELEASE_TOOL="$release_dir/publish-presentation-extract-template.mjs" \
  node --test .github/scripts/__tests__/publish-presentation-extract-template.test.mjs
```

The resulting `publication.json`, `manifest.json`, and archive must agree with
the pinned release. Independently prepared bundles have identical archive and
manifest bytes. The manifest uses the source commit timestamp; database
`created_at` records the later publication time. The planned storage UUID is
reserved in the release configuration; it is not evidence of an existing row.

## Publish during release

Provide `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, and `R2_USER_STORAGES_BUCKET_NAME` through the
release environment. Check that the database and bucket belong to the intended
environment. Do not paste credentials into command lines or release notes.

```bash
node "$release_dir/publish-presentation-extract-template.mjs" publish \
  --output-dir ./generated/presentation-extract-template-release \
  --execute
```

The publisher first verifies the local bundle, then derives the owner from the
exact historical storage version recorded as `ownerAnchorVersionId`. This is
solely a provisioning identity source. There is no old-ID lookup or fallback.
It checks for conflicting rows and R2 objects, uploads with `If-None-Match: *`,
and reads both objects back byte for byte. Only then does one transaction create
the new storage, register its version, and set its head. Existing state is
accepted only when it matches this release exactly. Retries cannot overwrite
different objects or advance a different storage head. Failed registration may
leave verified, unreferenced objects under the new prefix; it leaves the old
resource untouched.

Record the publisher's `published-and-verified` receipt. After deploying the
matching API and CLI, run:

```bash
okou resource pull skill:presentation-extract-template --dir ./generated/resources
```

Confirm `./generated/resources/extract-template/SKILL.md` and its two scripts
exist. Local tests cover deterministic preparation and rejection of altered
inputs; they do not exercise production PostgreSQL or R2. Production publishing
and the authenticated download are separate release checks.
