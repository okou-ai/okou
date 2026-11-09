# Frozen template guidance backfill

This operator converts reviewed legacy template package bytes into the existing
immutable template profile and conditionally publishes the descriptor on the
template owner. It does not change runtime selection, schema, source/page uploads,
legacy records or historical objects. It has no DELETE operation.

## Prerequisites and inventory

The bundle-only template writer must be serving, outgoing canonical writers
must have drained, and the API rollback floor must exclude legacy publishers.
Keep the existing compatible Runner reader floor. These are deployment facts to
verify before execution; `--writers-drained` records the operator's attestation,
not an automatic proof. Do not apply this command merely because its PR merged.

First export a complete, read-only owner-to-current-package inventory through
the authorized inventory boundary. Account for every current NULL owner, its
workspace, organization-owned legacy root, exact HEAD version and object keys.
Resolve mismatches before freezing it; retained older versions are preservation
targets, not automatically current-package backfill targets.

The input format is `template-guidance-sources-v1`, with `capturedAt`, `scope`
(`database`, `bucket`, `endpoint`) and at most 100 `rows`. Each row contains:

- `ownerKind`: `user-template` or `presentation-template`;
- `templateId`, `orgId`, `ownerUserId`, `ownerUpdatedAt` (UTC ISO milliseconds);
- `package`: `storageId`, `versionId`, `s3Key`, `archiveBytes`, `totalBytes`,
  `fileCount`. The key must be exactly `<orgId>/<storageId>/<versionId>`.

The operator deliberately receives frozen source identities rather than adding
another live generic-registry consumer. Its database queries access only template
owners. Source freezing therefore requires the verified writer/rollback boundary
above; this command does not promise to follow a moving legacy HEAD. Re-export
and review inventory if that boundary cannot be established or a source changes.

## Plan and isolated rehearsal

When source credentials are available only to GitHub's protected production
environment, use `capture-guidance` on the existing `copy-presentation-templates.yml`
manual workflow. It remains main-only and requires the normal production review.
Provide the frozen inventory JSON and an ephemeral RSA public key (2048 bits or
larger). Keep the private key only in the rehearsal controller's private directory.
The capture process only GETs the exact source objects, verifies every file, and
never opens a database connection. It uploads a metadata report and an AES-256-GCM
encrypted archive, with the data key wrapped using RSA-OAEP-SHA256; plaintext
temporary files are removed. The artifact expires after one day. Download it
from the verified run/commit, authenticate/decrypt it privately, and retain only
the reviewed source files for the isolated rehearsal. Never upload private keys,
plaintext packages, credentials or signed URLs as artifacts.

The capture command is also usable with a GET-only local/rehearsal object peer:

```sh
node --import tsx scripts/migrations/029-template-guidance-bundles/capture.ts \
  --inventory /private/frozen-sources.json --public-key /private/recipient.pem \
  --output /private/encrypted-capture
```

A capture is frozen byte evidence, not an owner-CAS plan or production apply.
Recheck the owner/root inventory after capture and build a database-bound plan
on the actual isolated target before rehearsing.

Required environment: `DATABASE_URL_FILE` (preferred) or `DATABASE_URL`,
`R2_ENDPOINT` (native R2 HTTPS, or loopback HTTP for fixtures),
`R2_USER_STORAGES_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
The plan database session is read-only. Use GET-only source credentials and a
read-only database role. Never expose credentials, signed URLs or file contents.

```sh
node --import tsx scripts/migrations/029-template-guidance-bundles/backfill.ts \
  --inventory /private/frozen-sources.json --output /private/template-plan.json
```

Planning downloads each original manifest/archive with bounded requests. It
verifies the original version identity, every file path/size/hash, complete
package counts, required guidance and the template profile's larger limits.
Only inert directory entries are discarded; links and unsafe entries fail.
Regular-file bytes remain exact; the canonical template archive uses mode 0644.
The plan captures both source object hashes, the new descriptor, and the owner's
lossless `xmin` plus a fingerprint of all non-bundle owner fields. Owner rows are
re-read after download. Partial plans are diagnostic and cannot be applied.

Rehearse on a fresh database child branch and an isolated object bucket/peer.
The target scope and plan hash must belong to that rehearsal, not production.
The native verification command uses only a disposable local/CI database:

```sh
pnpm test:template-guidance-backfill
```

## Separately reviewed apply

```sh
node --import tsx scripts/migrations/029-template-guidance-bundles/backfill.ts \
  --migrate --writers-drained --plan-file /private/template-plan.json \
  --expect-plan-sha256 <reviewed-file-sha256> --output /private/receipt.ndjson
```

Apply requires the exact complete plan digest, database address, bucket and R2
origin. It revalidates source bytes, uploads canonical objects conditionally
with `If-None-Match: *`, and verifies them before publishing any owner pointer.
Existing bytes must match. A lost PUT response is resolved by authoritative GET,
never an overwrite or blind retry. An exclusive private append-only receipt is
reserved before effects and each intent is fsynced before mutation.

Publication updates only `guidance_bundle`, conditional on owner ID, workspace,
owner user, captured `xmin` and a still-NULL pointer. It preserves timestamps,
title, visibility, source and pages. Concurrent edits, replacements and deletions
cannot be overwritten or resurrected. After an uncertain database response it
re-reads instead of replaying the mutation. Identical reruns verify the existing
pointer/object without changing the row again; incompatible state is a conflict.
Final per-owner reconciliation is recorded. No receipt claims a global atomic
snapshot or perpetual absence of later edits.

Keep partial immutable publications for reconciliation. After interruption,
inspect the recorded outcomes, then reuse the same reviewed plan with a fresh
receipt path only when its frozen source and owner conditions remain valid.
Changed owners require a fresh inventory/plan, never relaxed CAS predicates.

Production requires a separately reviewed production-bound plan and execution
authorization. Reconcile every current owner and verify real selection/claims
before removing the temporary NULL bridge. Historical Storage cleanup and Memory
migration remain separately scoped.
