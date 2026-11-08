import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { array, object, uuid } from "zod";
import { S3Client } from "@aws-sdk/client-s3";
import { contentBundleDigest } from "@okouai/core/content-bundle";
import {
  configuration,
  BackfillError,
  inventorySchema,
  ownerSchema,
  planSchema,
  validateSources,
  type Source,
  type PlannedRow,
  type Owner,
} from "./plan";
import { prepareSource, publishBundle } from "./archives";

function options() {
  const { values } = parseArgs({
    options: {
      inventory: { type: "string" },
      output: { type: "string" },
      migrate: { type: "boolean", default: false },
      "writers-drained": { type: "boolean", default: false },
      "plan-file": { type: "string" },
      "expect-plan-sha256": { type: "string" },
    },
  });
  if (
    !values.output ||
    (values.migrate
      ? !values["writers-drained"] ||
        !values["plan-file"] ||
        !values["expect-plan-sha256"] ||
        values.inventory
      : !values.inventory ||
        values["plan-file"] ||
        values["expect-plan-sha256"])
  )
    throw new BackfillError("UseFrozenInventoryOrReviewedPlanWithDrain");
  return values;
}
function classification(error: unknown) {
  return error instanceof BackfillError
    ? error.message
    : error instanceof Error
      ? error.name
      : "UnknownFailure";
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readInput(selected: ReturnType<typeof options>) {
  const input = await readFile(
    selected.migrate ? selected["plan-file"]! : selected.inventory!,
  );
  const hash = contentBundleDigest(input);
  if (selected.migrate && hash !== selected["expect-plan-sha256"])
    throw new BackfillError("ReviewedPlanHashMismatch");
  const data: unknown = JSON.parse(input.toString("utf8"));
  const reviewed = selected.migrate ? planSchema.parse(data) : null;
  const inventory = selected.migrate ? null : inventorySchema.parse(data);
  if (
    reviewed &&
    (!reviewed.complete || reviewed.failures.length || !reviewed.rows.length)
  )
    throw new BackfillError("IncompletePlanRejected");
  const sources = reviewed
    ? reviewed.rows.map((r) => {
        return r.source;
      })
    : inventory!.rows;
  validateSources(sources);
  const expectedScope = reviewed?.scope ?? inventory!.scope;
  return { hash, reviewed, sources, expectedScope };
}

function validateOwner(
  owner: Owner | null,
  source: Source,
  planned: PlannedRow | undefined,
): Owner {
  if (!owner) throw new BackfillError("OwnerDeleted");
  if (owner.orgId !== source.orgId || owner.ownerUserId !== source.ownerUserId)
    throw new BackfillError("OwnerScopeChanged");
  if (!planned) {
    if (
      owner.bundle !== null ||
      new Date(owner.updatedAt + "Z").toISOString() !== source.ownerUpdatedAt
    )
      throw new BackfillError("InventoryOwnerChanged");
    return owner;
  }
  if (owner.fingerprint !== planned.owner.fingerprint)
    throw new BackfillError("OwnerChanged");
  if (owner.bundle !== null && !same(owner.bundle, planned.bundle))
    throw new BackfillError("ConcurrentBundlePublication");
  if (owner.bundle === null && owner.revision !== planned.owner.revision)
    throw new BackfillError("OwnerRevisionChanged");
  return owner;
}

async function main() {
  const selected = options();
  const { hash, reviewed, sources, expectedScope } = await readInput(selected);
  const config = await configuration();
  if (JSON.stringify(config.scope) !== JSON.stringify(expectedScope))
    throw new BackfillError("ReviewedScopeMismatch");
  const output = await open(selected.output!, "wx", 0o600);
  const db = postgres(config.connection, {
    max: 1,
    connect_timeout: 10,
    connection: {
      default_transaction_read_only: !selected.migrate,
      statement_timeout: 30_000,
    },
    onnotice() {},
  });
  const client = new S3Client({
    endpoint: config.endpoint.toString(),
    region: "auto",
    credentials: config.credentials,
    maxAttempts: 1,
  });
  const record = async (event: object) => {
    await output.write(
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    );
    await output.sync();
  };
  // Only template-owned rows are accessed. Frozen source archives arrive through
  // the reviewed inventory; this operator does not add a generic registry reader.
  const loadOwner = async (source: Source) => {
    const table =
      source.ownerKind === "user-template"
        ? "user_templates"
        : "presentation_templates";
    const rows = array(ownerSchema).parse(
      await db`
      SELECT t.xmin::text AS revision, md5((to_jsonb(t) - 'guidance_bundle')::text) AS fingerprint,
        t.org_id AS "orgId", t.owner_user_id AS "ownerUserId", t.updated_at::text AS "updatedAt", t.guidance_bundle AS bundle
      FROM public.${db(table)} t WHERE t.id = ${source.templateId}::uuid`,
    );
    return rows[0] ?? null;
  };
  const processSource = async (
    source: Source,
    index: number,
  ): Promise<PlannedRow | null> => {
    const identity = {
      ownerKind: source.ownerKind,
      templateId: source.templateId,
    };
    const planned = reviewed?.rows[index];
    const owner = validateOwner(await loadOwner(source), source, planned);
    const prepared = await prepareSource(client, config.bucket, source);
    const row: PlannedRow = {
      source,
      owner,
      archiveSha256: prepared.archiveSha256,
      manifestSha256: prepared.manifestSha256,
      bundle: prepared.descriptor,
    };
    if (
      planned &&
      (!same(prepared.descriptor, planned.bundle) ||
        row.archiveSha256 !== planned.archiveSha256 ||
        row.manifestSha256 !== planned.manifestSha256)
    )
      throw new BackfillError("FrozenSourceBytesChanged");
    if (!planned) {
      if (!same(owner, await loadOwner(source)))
        throw new BackfillError("OwnerChangedDuringPlan");
      return row;
    }
    await record({ event: "intent", ...identity, bundle: planned.bundle });
    await publishBundle(client, config.bucket, planned, prepared.archive);
    let uncertain = false;
    if (owner.bundle === null) {
      const table =
        source.ownerKind === "user-template"
          ? "user_templates"
          : "presentation_templates";
      try {
        array(object({ id: uuid() })).parse(
          await db`
              UPDATE public.${db(table)} SET guidance_bundle = ${db.json(planned.bundle)}
              WHERE id = ${source.templateId}::uuid AND org_id = ${source.orgId} AND owner_user_id = ${source.ownerUserId}
                AND xmin::text = ${planned.owner.revision} AND guidance_bundle IS NULL RETURNING id`,
        );
      } catch {
        uncertain = true;
      }
    }
    const current = await loadOwner(source);
    if (
      !current ||
      current.fingerprint !== planned.owner.fingerprint ||
      !same(current.bundle, planned.bundle)
    )
      throw new BackfillError(
        uncertain ? "PublicationUnresolved" : "OwnerPublicationConflict",
      );
    await record({
      event: "verified",
      ...identity,
      bundle: planned.bundle,
      alreadyPublished: owner.bundle !== null,
    });
    return null;
  };
  try {
    const rows: PlannedRow[] = [];
    const failures: {
      ownerKind: string;
      templateId: string;
      classification: string;
    }[] = [];
    if (reviewed)
      await record({
        event: "start",
        planSha256: hash,
        scope: config.scope,
        rows: sources.length,
      });
    for (const [index, source] of sources.entries()) {
      const identity = {
        ownerKind: source.ownerKind,
        templateId: source.templateId,
      };
      try {
        const row = await processSource(source, index);
        if (row) rows.push(row);
      } catch (error) {
        const failure = { ...identity, classification: classification(error) };
        failures.push(failure);
        if (reviewed) await record({ event: "failed", ...failure });
      }
    }
    const complete = failures.length === 0;
    if (reviewed) {
      // Final per-owner reconciliation catches edits after an earlier publication.
      const conflicts = [];
      for (const row of reviewed.rows) {
        const current = await loadOwner(row.source);
        if (
          !current ||
          current.fingerprint !== row.owner.fingerprint ||
          !same(current.bundle, row.bundle)
        )
          conflicts.push(row.source.templateId);
      }
      await record({
        event: "complete",
        complete: complete && conflicts.length === 0,
        failures,
        conflicts,
      });
      if (!complete || conflicts.length) process.exitCode = 1;
    } else {
      const plan = {
        format: "template-guidance-backfill-v1",
        capturedAt: new Date().toISOString(),
        scope: config.scope,
        inventorySha256: hash,
        complete,
        rows,
        failures,
      };
      const bytes = JSON.stringify(planSchema.parse(plan), null, 2) + "\n";
      await output.writeFile(bytes);
      await output.sync();
      process.stdout.write(
        JSON.stringify({
          complete,
          verified: rows.length,
          failed: failures.length,
          planSha256: contentBundleDigest(Buffer.from(bytes)),
        }) + "\n",
      );
      if (!complete) process.exitCode = 1;
    }
  } finally {
    try {
      await db.end({ timeout: 5 });
    } finally {
      client.destroy();
      await output.close();
    }
  }
}
try {
  await main();
} catch (error) {
  process.stderr.write(
    (error instanceof BackfillError
      ? error.message
      : "TemplateBackfillFailed") + "\n",
  );
  process.exitCode = 1;
}
