import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { sha256 } from "./backfill-plan";
import { fixture } from "./test-backfill-fixture";

const f = await fixture();
try {
  const inventory = await f.inventory();
  const planPath = await f.plan(inventory);
  const plan = await f.readPlan(planPath);
  const row = plan.rows[0]!;
  assert.equal(plan.complete, true);
  assert.equal(row.expectedHead, null);
  assert.equal(f.puts(), 0);
  assert.equal(await f.head(), undefined);
  await f.apply(planPath, true, "0".repeat(64));
  const otherScope = `${planPath}.other-scope`;
  await writeFile(
    otherScope,
    JSON.stringify({
      ...plan,
      scope: { ...plan.scope, targetBucket: "another-target" },
    }),
  );
  await f.apply(otherScope, true);
  assert.equal(f.puts(), 0);

  // The peer stores the upload then drops the response. Readback must resolve
  // the ambiguous outcome without another PUT or rewriting compressed bytes.
  f.loseNextPutResponse();
  const applied = await f.apply(planPath);
  assert.deepEqual(f.objects.get(row.objectKey), f.body);
  assert.equal(f.puts(), 1);
  assert.equal((await f.head()).sha256, row.archive.sha256);
  const receipt = await readFile(applied, "utf8");
  assert.match(receipt, /"event":"verified"/u);
  assert.match(receipt, /"complete":true/u);
  const originalHead = await f.head();
  const originalArchive = (
    await f.db.query(
      "SELECT xmin::text, created_at::text FROM registry_resource_archives WHERE resource_id = $1",
      [f.binding.id],
    )
  ).rows;
  await f.apply(planPath);
  assert.equal(f.puts(), 1);
  assert.deepEqual(await f.head(), originalHead);
  assert.deepEqual(
    (
      await f.db.query(
        "SELECT xmin::text, created_at::text FROM registry_resource_archives WHERE resource_id = $1",
        [f.binding.id],
      )
    ).rows,
    originalArchive,
  );

  // A conflicting immutable object cannot be overwritten by a reviewed plan.
  await f.clear();
  const corruptPlan = await f.plan(inventory);
  f.objects.set(row.objectKey, Buffer.from("conflicting object"));
  const putsBeforeConflict = f.puts();
  const conflict = await f.apply(corruptPlan, true);
  assert.match(await readFile(conflict, "utf8"), /ArchiveLengthMismatch/u);
  assert.equal(f.puts(), putsBeforeConflict);
  assert.equal(await f.head(), undefined);

  // External source movement during the R2 boundary blocks index publication.
  await f.clear();
  const movingPlan = await f.plan(inventory);
  f.beforeNextTargetRead(async () => {
    await f.db.query("UPDATE storages SET head_version_id = $1 WHERE id = $2", [
      f.nextVersionId,
      f.storageId,
    ]);
  });
  const moved = await f.apply(movingPlan, true);
  assert.match(await readFile(moved, "utf8"), /SourceChanged/u);
  assert.equal(await f.head(), undefined);
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int AS count FROM registry_resource_archives WHERE resource_id = $1",
        [f.binding.id],
      )
    ).rows[0].count,
    0,
  );
  assert.deepEqual(f.objects.get(row.objectKey), f.body);

  // The old inventory's xmin remains stale even if its source HEAD returns.
  await f.db.query("UPDATE storages SET head_version_id = $1 WHERE id = $2", [
    f.versionId,
    f.storageId,
  ]);
  const stale = await f.plan(inventory, true);
  assert.equal((await f.readPlan(stale)).complete, false);
  await f.apply(stale, true);
  const freshInventory = await f.inventory();
  const resumePlan = await f.plan(freshInventory);
  const putsBeforeResume = f.puts();
  await f.apply(resumePlan);
  assert.equal(f.puts(), putsBeforeResume);
  assert.equal((await f.head()).sha256, row.archive.sha256);
  await f.clear();
  const headA = sha256("previous independent release A");
  const headC = sha256("previous independent release C");
  for (const digest of [headA, headC]) {
    await f.db.query(
      "INSERT INTO registry_resource_archives (resource_id, sha256, archive_bytes, version_id, file_count, total_bytes) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        f.binding.id,
        digest,
        f.body.length,
        f.versionId,
        f.inspected.fileCount,
        f.inspected.totalBytes,
      ],
    );
  }
  await f.db.query(
    "INSERT INTO registry_resource_heads (resource_id, sha256) VALUES ($1, $2)",
    [f.binding.id, headA],
  );
  const abaPlan = await f.plan(freshInventory);
  f.beforeNextTargetRead(async () => {
    for (const digest of [headC, headA]) {
      await f.db.query(
        "UPDATE registry_resource_heads SET sha256 = $1, updated_at = now() WHERE resource_id = $2",
        [digest, f.binding.id],
      );
    }
  });
  const aba = await f.apply(abaPlan, true);
  assert.match(await readFile(aba, "utf8"), /TargetHeadConflict/u);
  assert.equal((await f.head()).sha256, headA);
  assert.notEqual(
    (await f.head()).xmin,
    (await f.readPlan(abaPlan)).rows[0]!.expectedHead?.xmin,
  );
  const deletedHeadPlan = await f.plan(freshInventory);
  await f.db.query(
    "DELETE FROM registry_resource_heads WHERE resource_id = $1",
    [f.binding.id],
  );
  const deleted = await f.apply(deletedHeadPlan, true);
  assert.match(await readFile(deleted, "utf8"), /TargetHeadConflict/u);
  assert.equal(await f.head(), undefined);
  await f.db.query(
    "INSERT INTO registry_resource_heads (resource_id, sha256) VALUES ($1, $2)",
    [f.binding.id, headA],
  );
  // Review a fresh observation to authorize replacing this specific head.
  const reconciled = await f.plan(freshInventory);
  await f.apply(reconciled);
  assert.equal((await f.head()).sha256, row.archive.sha256);

  // Existing immutable metadata conflicts also block a rerun; no repair-in-place.
  await f.db.query(
    "UPDATE registry_resource_archives SET version_id = $1 WHERE resource_id = $2 AND sha256 = $3",
    [headA, f.binding.id, row.archive.sha256],
  );
  const metadataConflict = await f.apply(reconciled, true);
  assert.match(
    await readFile(metadataConflict, "utf8"),
    /ImmutableArchiveMetadataConflict/u,
  );
  assert.equal(
    (
      await f.db.query(
        "SELECT version_id FROM registry_resource_archives WHERE resource_id = $1 AND sha256 = $2",
        [f.binding.id, row.archive.sha256],
      )
    ).rows[0].version_id,
    headA,
  );

  process.stdout.write(
    "Registry backfill CLI: dry-run, reviewed digest, original bytes, ambiguous PUT, rerun, source movement, target ABA, reconciliation and immutable conflicts passed\n",
  );
} finally {
  await f.close();
}
