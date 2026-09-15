import { settle } from "../utils";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { piDeferredSecretsSchema } from "./pi-deferred-sandbox-contract";
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, lt, inArray, notExists } from "drizzle-orm";
import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import {
  agentRunInferenceObjects,
  piInferenceObjects,
} from "@okouai/db/schema/pi-inference-object";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import type { Db } from "../external/db";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";

const objectKindSchema = z.enum(["configuration", "context", "h1", "secrets"]);
const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  orgId: z.string().min(1),
  userId: z.string().min(1),
  kind: objectKindSchema,
  value: z.unknown(),
});
type ObjectKind = z.infer<typeof objectKindSchema>;
interface ObjectOwner {
  readonly orgId: string;
  readonly userId: string;
}
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;

/** No executable environment or signed URL belongs in this immutable envelope.
 * Secret callers supply the persistent-secret ciphertext, never plaintext. */
export async function publishPiInferenceObject<T>(
  db: Db,
  owner: ObjectOwner,
  kind: ObjectKind,
  schema: z.ZodType<T>,
  value: T,
): Promise<string> {
  if (kind === "secrets") {
    piDeferredSecretsSchema.parse(value);
  }
  const content = JSON.stringify({
    schemaVersion: 1,
    orgId: owner.orgId,
    userId: owner.userId,
    kind,
    value: schema.parse(value),
  });
  if (Buffer.byteLength(content) > MAX_OBJECT_BYTES) {
    throw new Error("Pi inference object exceeds its byte limit");
  }
  const hash = createHash("sha256").update(content).digest("hex");
  await db.transaction(async (tx) => {
    await assertErasureSubjectWritable(tx, [
      { subjectKind: "organization", subjectId: owner.orgId },
      { subjectKind: "user", subjectId: owner.userId },
    ]);
    const result = await settle(
      tx
        .insert(piInferenceObjects)
        .values({ ...owner, kind, hash, content })
        .onConflictDoNothing(),
    );
    if (!result.ok) {
      throw new Error("Pi immutable object publication failed", {
        cause: { code: safeSqlStateCode(result.error) },
      });
    }
  });
  return hash;
}

/** Caller owns the run's complete admission/lifecycle locks. Attach in the SAME
 * transaction as the inference input/publication. FK locks serialize with GC. */
export async function retainPiInferenceObject(
  tx: Tx,
  args: ObjectOwner & {
    readonly runId: string;
    readonly kind: ObjectKind;
    readonly hash: string;
  },
): Promise<void> {
  const [run] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.userId),
      ),
    );
  const [object] = await tx
    .select({ hash: piInferenceObjects.hash })
    .from(piInferenceObjects)
    .where(
      and(
        eq(piInferenceObjects.hash, args.hash),
        eq(piInferenceObjects.kind, args.kind),
        eq(piInferenceObjects.orgId, args.orgId),
        eq(piInferenceObjects.userId, args.userId),
      ),
    )
    .for("key share");
  if (!run || !object) {
    throw new Error("Pi inference object is unavailable for this owner");
  }
  await tx
    .insert(agentRunInferenceObjects)
    .values({ runId: args.runId, kind: args.kind, hash: args.hash })
    .onConflictDoNothing();
}

/** Reading is scoped and integrity checked; it does not grant execution. */
export async function readPiInferenceObject<T>(
  db: Pick<Db, "select">,
  args: ObjectOwner & {
    readonly runId: string;
    readonly kind: ObjectKind;
    readonly hash: string;
  },
  schema: z.ZodType<T>,
): Promise<T> {
  const [reference] = await db
    .select({ hash: agentRunInferenceObjects.hash })
    .from(agentRunInferenceObjects)
    .where(
      and(
        eq(agentRunInferenceObjects.runId, args.runId),
        eq(agentRunInferenceObjects.kind, args.kind),
        eq(agentRunInferenceObjects.hash, args.hash),
      ),
    );
  if (!reference) {
    throw new Error("Pi immutable object is not retained by this Run");
  }
  return readPublishedPiInferenceObject(db, args, schema);
}

/** Pre-publication reader; only a retained reference plus fresh execution
 * admission can make these bytes executable. */
export async function readPublishedPiInferenceObject<T>(
  db: Pick<Db, "select">,
  args: ObjectOwner & { readonly kind: ObjectKind; readonly hash: string },
  schema: z.ZodType<T>,
): Promise<T> {
  const [row] = await db
    .select({ content: piInferenceObjects.content })
    .from(piInferenceObjects)
    .where(
      and(
        eq(piInferenceObjects.hash, args.hash),
        eq(piInferenceObjects.kind, args.kind),
        eq(piInferenceObjects.orgId, args.orgId),
        eq(piInferenceObjects.userId, args.userId),
      ),
    );
  if (
    !row ||
    Buffer.byteLength(row.content) > MAX_OBJECT_BYTES ||
    createHash("sha256").update(row.content).digest("hex") !== args.hash
  ) {
    throw new Error(
      "Pi inference object is missing or fails integrity validation",
    );
  }
  const envelope = envelopeSchema.parse(JSON.parse(row.content));
  if (
    envelope.orgId !== args.orgId ||
    envelope.userId !== args.userId ||
    envelope.kind !== args.kind
  ) {
    throw new Error("Pi inference object namespace mismatch");
  }
  return schema.parse(envelope.value);
}

/** Deleting the inference owner releases its exact edges by FK cascade, only
 * after the existing usage/release erasure preflight. Orphan publication has no
 * edge. Atomic DB reclamation cannot race a late remote PUT or a live retain. */
export async function reclaimPiInferenceObjects(db: Db): Promise<number> {
  return await db.transaction(async (tx) => {
    const unreferenced = notExists(
      tx
        .select({ hash: agentRunInferenceObjects.hash })
        .from(agentRunInferenceObjects)
        .where(eq(agentRunInferenceObjects.hash, piInferenceObjects.hash)),
    );
    const objects = await tx
      .select({ hash: piInferenceObjects.hash })
      .from(piInferenceObjects)
      .where(
        and(
          lt(
            piInferenceObjects.createdAt,
            new Date(nowDate().getTime() - 24 * 60 * 60 * 1000),
          ),
          unreferenced,
        ),
      )
      .orderBy(asc(piInferenceObjects.createdAt), asc(piInferenceObjects.hash))
      .limit(100)
      .for("update", { skipLocked: true });
    let removed = 0;
    for (const object of objects) {
      const rows = await tx
        .delete(piInferenceObjects)
        .where(and(eq(piInferenceObjects.hash, object.hash), unreferenced))
        .returning({ hash: piInferenceObjects.hash });
      removed += rows.length;
    }
    return removed;
  });
}

/** Owning deletion calls this after removing its exact reference edges. */
export async function deleteUnreferencedPiObjects(
  tx: Tx,
  hashes: readonly string[],
): Promise<void> {
  for (let offset = 0; offset < hashes.length; offset += 500) {
    const batch = hashes.slice(offset, offset + 500).sort();
    const unreferenced = notExists(
      tx
        .select({ hash: agentRunInferenceObjects.hash })
        .from(agentRunInferenceObjects)
        .where(eq(agentRunInferenceObjects.hash, piInferenceObjects.hash)),
    );
    const candidates = await tx
      .select({ hash: piInferenceObjects.hash })
      .from(piInferenceObjects)
      .where(and(inArray(piInferenceObjects.hash, batch), unreferenced))
      .orderBy(piInferenceObjects.hash)
      .for("update", { noWait: true });
    for (const candidate of candidates) {
      await tx
        .delete(piInferenceObjects)
        .where(and(eq(piInferenceObjects.hash, candidate.hash), unreferenced));
    }
  }
}

/** Orphan publications have no Run edge. Existing owned user/org cleanup must
 * sweep them as well; live edges still prevent deletion through the FK. */
export async function deletePiObjectOrphansForOwner(
  db: Db,
  owner: { readonly userId: string } | { readonly orgId: string },
): Promise<void> {
  while (true) {
    const removed = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ hash: piInferenceObjects.hash })
        .from(piInferenceObjects)
        .where(
          and(
            "userId" in owner
              ? eq(piInferenceObjects.userId, owner.userId)
              : eq(piInferenceObjects.orgId, owner.orgId),
            notExists(
              tx
                .select({ hash: agentRunInferenceObjects.hash })
                .from(agentRunInferenceObjects)
                .where(
                  eq(agentRunInferenceObjects.hash, piInferenceObjects.hash),
                ),
            ),
          ),
        )
        .orderBy(piInferenceObjects.hash)
        .limit(500)
        .for("update", { noWait: true });
      await deleteUnreferencedPiObjects(
        tx,
        rows.map((row) => {
          return row.hash;
        }),
      );
      return rows.length;
    });
    if (removed < 500) {
      return;
    }
  }
}
