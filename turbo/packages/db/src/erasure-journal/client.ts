import {
  and,
  asc,
  desc,
  DrizzleQueryError,
  eq,
  gt,
  lte,
  or,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ErasureDecision } from "../operations/account-erasure";
import { connectErasureJournal } from "./connection";
import { journalDecisions as decisions, journalHead as head } from "./schema";

export type JournalAppend = Readonly<
  Omit<ErasureDecision, "authorityId" | "decisionSequence">
>;
export interface JournalWatermark {
  readonly authorityId: string;
  readonly sequence: bigint;
}
export interface JournalPageRequest {
  readonly afterSequence: bigint;
  readonly watermark: JournalWatermark;
  readonly limit: number;
}

const MAX_SEQUENCE = 9_223_372_036_854_775_807n;
const MAX_ATTEMPTS = 5;
const MAX_PAGE = 100;

function invariant(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`erasure_journal:${code}`);
}
function reference(value: string): void {
  invariant(
    typeof value === "string" &&
      value.length === 36 &&
      /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(value),
    "invalid_reference",
  );
}
function sequence(value: bigint): void {
  invariant(
    typeof value === "bigint" && value >= 0n && value <= MAX_SEQUENCE,
    "invalid_sequence",
  );
}
function validate(input: JournalAppend): JournalAppend {
  for (const value of [input.generation, input.dispositionVersion]) {
    invariant(
      Number.isInteger(value) && value > 0 && value <= 2_147_483_647,
      "invalid_version",
    );
  }
  invariant(
    (input.subjectKind === "user" || input.subjectKind === "organization") &&
      typeof input.subjectId === "string" &&
      input.subjectId.length > 0 &&
      Buffer.byteLength(input.subjectId) <= 192 &&
      !input.subjectId.includes("\0"),
    "invalid_subject",
  );
  reference(input.decisionRef);
  reference(input.confirmationRef);
  if (input.previousDecisionRef !== null) reference(input.previousDecisionRef);
  invariant(
    input.requestedAt instanceof Date &&
      input.deadlineAt instanceof Date &&
      Number.isFinite(input.requestedAt.getTime()) &&
      Number.isFinite(input.deadlineAt.getTime()) &&
      input.deadlineAt > input.requestedAt,
    "invalid_deadline",
  );
  // Capture only contract fields before the first await, including mutable Dates.
  return {
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    generation: input.generation,
    decisionRef: input.decisionRef,
    confirmationRef: input.confirmationRef,
    previousDecisionRef: input.previousDecisionRef,
    dispositionVersion: input.dispositionVersion,
    requestedAt: new Date(input.requestedAt),
    deadlineAt: new Date(input.deadlineAt),
  };
}
function projection(
  row: ErasureDecision,
  authorityId: string,
): ErasureDecision {
  const input = validate(row);
  reference(row.authorityId);
  sequence(row.decisionSequence);
  invariant(row.authorityId === authorityId, "authority_mismatch");
  invariant(row.decisionSequence > 0n, "invalid_sequence");
  return { ...input, authorityId, decisionSequence: row.decisionSequence };
}
function exact(existing: JournalAppend, input: JournalAppend): void {
  for (const key of Object.keys(input) as (keyof JournalAppend)[]) {
    const a = existing[key];
    const b = input[key];
    invariant(
      a instanceof Date && b instanceof Date
        ? a.getTime() === b.getTime()
        : a === b,
      "conflicting_decision",
    );
  }
}
function retryable(error: unknown): boolean {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  return (
    cause instanceof postgres.PostgresError &&
    (cause.code === "40001" || cause.code === "40P01")
  );
}

/** Internal persistence only: neither authorityId nor confirmationRef authenticates
 * a caller. G2d1b must supply real trust/lifecycle boundaries before activation.
 * No caller transaction or network callback is accepted by this client.
 */
export function createErasureJournal(
  connectionString: string,
  authorityId: string,
) {
  reference(authorityId);
  const connection = connectErasureJournal(connectionString);
  const db = drizzle(connection);

  async function readWatermark(): Promise<JournalWatermark> {
    const [current] = await db.select().from(head).where(eq(head.slot, 1));
    if (!current) return { authorityId, sequence: 0n }; // Initially empty store.
    invariant(current.authorityId === authorityId, "authority_mismatch");
    sequence(current.committedSequence);
    return { authorityId, sequence: current.committedSequence };
  }

  async function append(value: JournalAppend): Promise<ErasureDecision> {
    const input = validate(value);
    for (let attempt = 1; ; attempt++) {
      try {
        return await db.transaction(
          async (tx) => {
            await tx
              .insert(head)
              .values({ slot: 1, authorityId, committedSequence: 0n })
              .onConflictDoNothing();
            const [current] = await tx
              .select()
              .from(head)
              .where(eq(head.slot, 1))
              .for("update");
            invariant(current, "head_missing");
            invariant(
              current.authorityId === authorityId,
              "authority_mismatch",
            );
            sequence(current.committedSequence);
            const matches = await tx
              .select()
              .from(decisions)
              .where(
                or(
                  eq(decisions.decisionRef, input.decisionRef),
                  eq(decisions.confirmationRef, input.confirmationRef),
                ),
              );
            if (matches.length > 0) {
              invariant(matches.length === 1, "conflicting_decision");
              const existing = matches[0];
              invariant(existing, "decision_missing");
              exact(existing, input);
              invariant(
                existing.decisionSequence <= current.committedSequence,
                "invalid_watermark",
              );
              return projection(existing, authorityId);
            }
            const [latest] = await tx
              .select()
              .from(decisions)
              .where(
                and(
                  eq(decisions.subjectKind, input.subjectKind),
                  eq(decisions.subjectId, input.subjectId),
                ),
              )
              .orderBy(desc(decisions.generation))
              .limit(1);
            if (latest) {
              projection(latest, authorityId);
              invariant(
                input.previousDecisionRef === latest.decisionRef &&
                  input.generation > latest.generation &&
                  latest.decisionSequence <= current.committedSequence,
                "stale_decision",
              );
            } else {
              invariant(
                input.previousDecisionRef === null,
                "missing_predecessor",
              );
            }
            invariant(
              current.committedSequence < MAX_SEQUENCE,
              "sequence_exhausted",
            );
            const next = current.committedSequence + 1n;
            const [created] = await tx
              .insert(decisions)
              .values({ ...input, authorityId, decisionSequence: next })
              .returning();
            invariant(created, "decision_insert_failed");
            // This head lock lives until COMMIT. A later append cannot allocate
            // its sequence before this decision and watermark commit or roll back.
            await tx
              .update(head)
              .set({ committedSequence: next })
              .where(eq(head.slot, 1));
            return projection(created, authorityId);
          },
          { isolationLevel: "serializable" },
        );
      } catch (error) {
        // Only proven rolled-back transactions retry. Unknown commit outcomes,
        // connection failures and lock/statement timeouts propagate to the caller.
        if (attempt >= MAX_ATTEMPTS || !retryable(error)) throw error;
      }
    }
  }

  async function readDecisionByConfirmationRef(
    confirmationRef: string,
  ): Promise<ErasureDecision | undefined> {
    reference(confirmationRef);
    // A single statement binds the indexed lookup to the actual store head.
    // A different authority must fail even when this particular event is absent.
    const [row] = await db
      .select({ current: head, decision: decisions })
      .from(head)
      .leftJoin(decisions, eq(decisions.confirmationRef, confirmationRef))
      .where(eq(head.slot, 1));
    if (!row) return undefined; // Installed, initially empty authority.
    invariant(row.current.authorityId === authorityId, "authority_mismatch");
    sequence(row.current.committedSequence);
    if (!row.decision) return undefined;
    const decision = projection(row.decision, authorityId);
    invariant(
      decision.decisionSequence <= row.current.committedSequence,
      "invalid_watermark",
    );
    return decision;
  }

  async function readPage(request: JournalPageRequest) {
    const afterSequence = request.afterSequence;
    const watermark = { ...request.watermark };
    const limit = request.limit;
    sequence(afterSequence);
    sequence(watermark.sequence);
    invariant(watermark.authorityId === authorityId, "authority_mismatch");
    invariant(afterSequence <= watermark.sequence, "invalid_cursor");
    invariant(
      Number.isInteger(limit) && limit > 0 && limit <= MAX_PAGE,
      "invalid_limit",
    );
    const current = await readWatermark();
    invariant(watermark.sequence <= current.sequence, "future_watermark");
    const rows = await db
      .select()
      .from(decisions)
      .where(
        and(
          gt(decisions.decisionSequence, afterSequence),
          lte(decisions.decisionSequence, watermark.sequence),
        ),
      )
      .orderBy(asc(decisions.decisionSequence))
      .limit(limit);
    const page = rows.map((row) => {
      return projection(row, authorityId);
    });
    const nextAfterSequence =
      page.at(-1)?.decisionSequence ?? watermark.sequence;
    return {
      decisions: page,
      watermark,
      nextAfterSequence,
      done: page.length < limit || nextAfterSequence === watermark.sequence,
    };
  }

  return {
    append,
    readDecisionByConfirmationRef,
    readWatermark,
    readPage,
    close: () => {
      return connection.end();
    },
  };
}
