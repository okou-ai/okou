import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  accountErasureIngress as ingress,
  accountErasureReplay as replay,
} from "../schema/account-erasure-bridge";
import type { JournalAppend } from "../erasure-journal/client";

type Db = NodePgDatabase<Record<string, never>>;
export type ErasureCapture = typeof ingress.$inferSelect;
export type ErasureReplayPass = typeof replay.$inferSelect;
export type ErasureBridgeBinding = Readonly<{
  authorityId: string;
  audience: string;
}>;
export type ErasureReplayIdentity = ErasureBridgeBinding &
  Readonly<{ targetId: string; replayGeneration: string }>;
export type CaptureInput = JournalAppend &
  ErasureBridgeBinding &
  Readonly<{ eventId: string }>;

function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`erasure_bridge:${code}`);
}
export function captureAppend(row: CaptureInput): JournalAppend {
  for (const ref of [
    row.authorityId,
    row.decisionRef,
    row.confirmationRef,
    ...(row.previousDecisionRef === null ? [] : [row.previousDecisionRef]),
  ]) {
    check(
      /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(ref),
      "invalid_reference",
    );
  }
  for (const value of [row.audience, row.eventId, row.subjectId]) {
    check(
      typeof value === "string" &&
        Buffer.byteLength(value) > 0 &&
        Buffer.byteLength(value) <= 192 &&
        !value.includes("\0"),
      "invalid_identity",
    );
  }
  check(
    row.subjectKind === "user" || row.subjectKind === "organization",
    "invalid_subject",
  );
  for (const version of [row.generation, row.dispositionVersion]) {
    check(
      Number.isInteger(version) && version > 0 && version <= 2147483647,
      "invalid_version",
    );
  }
  check(
    Number.isFinite(row.requestedAt.getTime()) &&
      Number.isFinite(row.deadlineAt.getTime()) &&
      row.deadlineAt > row.requestedAt,
    "invalid_deadline",
  );
  return {
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    generation: row.generation,
    decisionRef: row.decisionRef,
    confirmationRef: row.confirmationRef,
    previousDecisionRef: row.previousDecisionRef,
    dispositionVersion: row.dispositionVersion,
    requestedAt: new Date(row.requestedAt),
    deadlineAt: new Date(row.deadlineAt),
  };
}
export function assertExactAppend(a: JournalAppend, b: JournalAppend): void {
  for (const key of Object.keys(a) as (keyof JournalAppend)[]) {
    const left = a[key];
    const right = b[key];
    check(
      left instanceof Date && right instanceof Date
        ? left.getTime() === right.getTime()
        : left === right,
      "conflicting_capture",
    );
  }
}
function bindingCondition(binding: ErasureBridgeBinding) {
  return and(
    eq(ingress.authorityId, binding.authorityId),
    eq(ingress.audience, binding.audience),
  );
}
export async function readErasureCapture(
  db: Db,
  binding: ErasureBridgeBinding,
  ref: string,
) {
  const [row] = await db
    .select()
    .from(ingress)
    .where(eq(ingress.confirmationRef, ref));
  if (row) {
    check(
      row.authorityId === binding.authorityId &&
        row.audience === binding.audience,
      "binding_mismatch",
    );
    captureAppend(row);
  }
  return row;
}
export async function captureErasureIngress(db: Db, input: CaptureInput) {
  const frozen = {
    ...captureAppend(input),
    authorityId: input.authorityId,
    audience: input.audience,
    eventId: input.eventId,
  };
  // Conflict losers read the winner in the next READ COMMITTED statement. No
  // policy result from a later process can overwrite the first committed input.
  await db.insert(ingress).values(frozen).onConflictDoNothing();
  const row = await readErasureCapture(db, input, input.confirmationRef);
  check(row, "capture_missing");
  check(
    row.eventId === frozen.eventId &&
      row.subjectKind === frozen.subjectKind &&
      row.subjectId === frozen.subjectId &&
      row.requestedAt.getTime() === frozen.requestedAt.getTime(),
    "event_conflict",
  );
  return row;
}
export async function claimErasureIngress(
  db: Db,
  binding: ErasureBridgeBinding,
  ref?: string,
) {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(ingress)
      .where(
        and(
          bindingCondition(binding),
          ref === undefined ? undefined : eq(ingress.confirmationRef, ref),
          inArray(ingress.state, ["pending", "external_committed"]),
          lt(ingress.attempts, 5),
          lte(ingress.availableAt, sql`statement_timestamp()`),
        ),
      )
      .orderBy(asc(ingress.availableAt), asc(ingress.confirmationRef))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return undefined;
    captureAppend(row);
    const [claimed] = await tx
      .update(ingress)
      .set({
        leaseId: randomUUID(),
        attempts: row.attempts + 1,
        availableAt: sql`clock_timestamp() + interval '60 seconds'`,
      })
      .where(eq(ingress.confirmationRef, row.confirmationRef))
      .returning();
    return claimed;
  });
}
export async function recordErasureIngress(
  db: Db,
  claim: ErasureCapture,
  state: ErasureCapture["state"],
  decisionSequence: bigint | null,
  signal: AbortSignal,
) {
  check(claim.leaseId, "lease_missing");
  signal.throwIfAborted();
  const [row] = await db
    .update(ingress)
    .set({
      state,
      decisionSequence,
    })
    .where(
      and(
        eq(ingress.confirmationRef, claim.confirmationRef),
        eq(ingress.leaseId, claim.leaseId),
        gt(ingress.availableAt, sql`clock_timestamp()`),
      ),
    )
    .returning();
  check(row, "lease_lost");
  signal.throwIfAborted();
  return row;
}
export async function releaseErasureIngress(
  db: Db,
  claim: ErasureCapture,
  unresolved: boolean,
) {
  check(claim.leaseId, "lease_missing");
  await db
    .update(ingress)
    .set({
      leaseId: null,
      ...(unresolved || claim.attempts >= 5
        ? { state: "unresolved" as const }
        : {}),
      availableAt: sql`clock_timestamp() + interval '1 minute'`,
    })
    .where(
      and(
        eq(ingress.confirmationRef, claim.confirmationRef),
        eq(ingress.leaseId, claim.leaseId),
        gt(ingress.availableAt, sql`clock_timestamp()`),
      ),
    );
}

/** Remove completed retry detail only after the caller reconciles the exact
 * retained authority decision. Pending input never expires on a TTL.
 */
export async function retireCompletedErasureCapture(
  db: Db,
  row: ErasureCapture,
) {
  const deleted = await db
    .delete(ingress)
    .where(
      and(
        eq(ingress.confirmationRef, row.confirmationRef),
        eq(ingress.authorityId, row.authorityId),
        eq(ingress.audience, row.audience),
        eq(ingress.decisionRef, row.decisionRef),
        eq(ingress.state, "projection_committed"),
      ),
    )
    .returning({ confirmationRef: ingress.confirmationRef });
  return deleted.length === 1;
}
function passCondition(id: ErasureReplayIdentity) {
  return and(
    eq(replay.authorityId, id.authorityId),
    eq(replay.targetId, id.targetId),
    eq(replay.replayGeneration, id.replayGeneration),
  );
}
export async function beginErasureReplay(
  db: Db,
  id: ErasureReplayIdentity,
  watermark: bigint,
) {
  await db
    .insert(replay)
    .values({ ...id, watermark })
    .onConflictDoNothing();
  const [pass] = await db.select().from(replay).where(passCondition(id));
  check(pass?.audience === id.audience, "binding_mismatch");
  return pass;
}
export async function claimErasureReplay(db: Db, id: ErasureReplayIdentity) {
  const [pass] = await db
    .update(replay)
    .set({
      leaseId: randomUUID(),
      leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    })
    .where(
      and(
        passCondition(id),
        eq(replay.audience, id.audience),
        eq(replay.state, "pending"),
        or(
          isNull(replay.leaseId),
          lte(replay.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      ),
    )
    .returning();
  return pass;
}
export async function checkpointErasureReplay(
  db: Db,
  pass: ErasureReplayPass,
  cursor: bigint,
  state: ErasureReplayPass["state"],
  signal: AbortSignal,
) {
  check(pass.leaseId, "lease_missing");
  check(cursor >= pass.cursor && cursor <= pass.watermark, "invalid_cursor");
  signal.throwIfAborted();
  const [row] = await db
    .update(replay)
    .set({ cursor, state, leaseId: null, leaseExpiresAt: null })
    .where(
      and(
        passCondition(pass),
        eq(replay.audience, pass.audience),
        eq(replay.cursor, pass.cursor),
        eq(replay.leaseId, pass.leaseId),
        gt(replay.leaseExpiresAt, sql`clock_timestamp()`),
      ),
    )
    .returning();
  check(row, "lease_lost");
  signal.throwIfAborted();
  return row;
}
