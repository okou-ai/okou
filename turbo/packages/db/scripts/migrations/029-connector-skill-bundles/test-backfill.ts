import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fixture } from "./test-fixture";

const f = await fixture();
try {
  const original = await f.row();
  const path = await f.plan();
  const plan = await f.readPlan(path);
  const entry = plan.rows[0]!;
  assert.equal(plan.complete, true);
  assert.equal(entry.source.sourceVersionId, f.versionId);
  assert.equal(f.puts(), 0);
  assert.deepEqual(await f.row(), original);
  await f.apply(path, true, "0".repeat(64));
  assert.equal(f.puts(), 0);
  const changedScope = `${path}.other-scope`;
  await writeFile(
    changedScope,
    JSON.stringify({ ...plan, scope: { ...plan.scope, bucket: "other" } }),
  );
  await f.apply(changedScope, true);
  assert.equal(f.puts(), 0);

  // An upload that committed but lost its response is resolved by exact readback.
  f.loseNextPut();
  await f.apply(path);
  assert.equal(f.puts(), 1);
  assert.deepEqual(f.objects.get(f.targetKey), f.archive);
  const prepared = await f.row();
  assert.deepEqual(prepared.owner, original.owner);
  assert.equal(prepared.source, f.versionId);
  assert.deepEqual(prepared.bundle, entry.target);
  await f.apply(path);
  assert.equal(f.puts(), 1);
  assert.deepEqual(await f.row(), prepared);

  // A new writer may use another valid compressed encoding for the same Skill.
  // Planning preserves an already-current reference instead of forcing a copy.
  assert.notDeepEqual(f.canonical.archive, f.archive);
  f.objects.set(f.canonicalKey, f.canonical.archive);
  await f.db.query(
    "UPDATE org_custom_connectors SET skill_content_bundle=$1,skill_content_bundle_source_version_id=$2 WHERE id=$3",
    [f.canonical.descriptor, f.versionId, f.id],
  );
  const writerPrepared = await f.row();
  const currentPlan = await f.plan();
  assert.equal((await f.readPlan(currentPlan)).complete, true);
  assert.deepEqual(
    (await f.readPlan(currentPlan)).rows[0]!.target,
    f.canonical.descriptor,
  );
  await f.apply(currentPlan);
  assert.deepEqual(await f.row(), writerPrepared);

  await f.db.query(
    "UPDATE org_custom_connectors SET skill_content_bundle=NULL,skill_content_bundle_source_version_id=NULL WHERE id=$1",
    [f.id],
  );
  const conflictPlan = await f.plan();
  f.objects.set(f.targetKey, Buffer.from("conflicting immutable object"));
  const beforeConflict = await f.row();
  const conflict = await f.apply(conflictPlan, true);
  assert.match(await readFile(conflict, "utf8"), /ArchiveLengthMismatch/u);
  assert.equal(f.puts(), 1);
  assert.deepEqual(await f.row(), beforeConflict);
  f.objects.delete(f.targetKey);

  // A preceding writer can change the pinned source while R2 work is in flight.
  // Shared bytes may remain, but no reference may bind them to the new source.
  const movingPlan = await f.plan();
  f.beforeNextTargetRead(async () => {
    await f.db.query(
      "UPDATE org_custom_connectors SET skill_storage_version_id=$1 WHERE id=$2",
      [f.nextVersionId, f.id],
    );
  });
  const moved = await f.apply(movingPlan, true);
  assert.match(await readFile(moved, "utf8"), /SourceChanged/u);
  const afterMove = await f.row();
  assert.equal(afterMove.owner.skill_storage_version_id, f.nextVersionId);
  assert.equal(afterMove.bundle, null);
  assert.equal(afterMove.source, null);

  // Returning to the same pointer cannot authorize a write from an old xmin.
  await f.db.query(
    "UPDATE org_custom_connectors SET skill_storage_version_id=$1 WHERE id=$2",
    [f.versionId, f.id],
  );
  const stale = await f.apply(movingPlan, true);
  assert.match(await readFile(stale, "utf8"), /OwnerChanged/u);
  const fresh = await f.plan();
  const putsBeforeResume = f.puts();
  await f.apply(fresh);
  assert.equal(f.puts(), putsBeforeResume);
  assert.deepEqual((await f.row()).owner, original.owner);

  // An existing FK is not tenant provenance: the owner and source storage
  // must belong to the same organization before any reference can be prepared.
  const beforeWrongTenant = await f.row();
  const beforeWrongTenantPuts = f.puts();
  await f.db.query("UPDATE storages SET org_id=$1 WHERE id=$2", [
    `${f.orgId}-other`,
    f.storageId,
  ]);
  const wrongTenant = await f.plan(true);
  assert.equal((await f.readPlan(wrongTenant)).complete, false);
  assert.deepEqual(await f.row(), beforeWrongTenant);
  assert.equal(f.puts(), beforeWrongTenantPuts);

  process.stdout.write(
    "Connector Skill backfill CLI: read-only plans, reviewed scope/hash, original bytes, uncertain PUT, source races, ABA, resume and unchanged owner data passed\n",
  );
} finally {
  await f.close();
}
