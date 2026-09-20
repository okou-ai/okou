import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { db } from "../lib/db";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type TransactionBarrier,
} from "./account-erasure-subject";

export interface ComputerUseHostStartTarget {
  readonly orgId: string;
  readonly userId: string;
  readonly installationId?: string;
}

interface ComputerUseHostStartTransactionBarrierHandle extends TransactionBarrier {
  readonly statements: () => readonly string[];
}

function firstHostStartSubjectLock(
  queryArgs: unknown[],
  target: ComputerUseHostStartTarget,
): boolean {
  const text = barrierQueryText(queryArgs);
  const lockKey = `account-erasure:${JSON.stringify([
    "organization",
    target.orgId,
  ])}`;
  return (
    text.startsWith("select") &&
    text.includes("erasure_isolation_probe") &&
    text.includes("pg_advisory_xact_lock_shared") &&
    barrierQueryBinds(queryArgs, lockKey)
  );
}

function hostWrite(
  queryArgs: unknown[],
  target: ComputerUseHostStartTarget,
  mode: "legacy" | "installation",
): boolean {
  const text = barrierQueryText(queryArgs);
  if (
    !text.startsWith('insert into "computer_use_hosts"') ||
    !barrierQueryBinds(queryArgs, target.orgId) ||
    !barrierQueryBinds(queryArgs, target.userId)
  ) {
    return false;
  }
  const upsert = text.includes("on conflict");
  return mode === "installation"
    ? upsert &&
        target.installationId !== undefined &&
        barrierQueryBinds(queryArgs, target.installationId)
    : !upsert;
}

function sawHostWrite(
  statements: readonly string[],
  mode: "legacy" | "installation",
): boolean {
  return statements.some((statement) => {
    const hostInsert = statement.startsWith('insert into "computer_use_hosts"');
    return mode === "installation"
      ? hostInsert && statement.includes("on conflict")
      : hostInsert && !statement.includes("on conflict");
  });
}

/**
 * Observe one target START transaction on real PostgreSQL and optionally stop
 * after its returned host write, before COMMIT dispatch, or after an executed
 * COMMIT while its driver callback is still withheld.
 */
export async function withComputerUseHostStartTransactionBarrierFixture<T>(
  options: {
    readonly target: ComputerUseHostStartTarget;
    readonly stopAt: "write" | "commit";
    readonly writeMode: "legacy" | "installation" | "none";
    readonly pauseAfterCommit?: boolean;
    readonly work: (
      handle: ComputerUseHostStartTransactionBarrierHandle,
    ) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  let selectedReceiver: unknown;
  let statements: readonly string[] = [];
  const statementsByReceiver = new Map<unknown, string[]>();
  return await withDatabaseTransactionBarrierFixture(
    {
      observe: (queryArgs, receiver) => {
        const text = barrierQueryText(queryArgs);
        if (text.startsWith("begin")) {
          statementsByReceiver.set(receiver, [text]);
        } else {
          statementsByReceiver.get(receiver)?.push(text);
        }
        if (
          selectedReceiver === undefined &&
          firstHostStartSubjectLock(queryArgs, options.target)
        ) {
          selectedReceiver = receiver;
        }
      },
      select: (queryArgs) => {
        return firstHostStartSubjectLock(queryArgs, options.target);
      },
      stopAt: (queryArgs) => {
        const text = barrierQueryText(queryArgs);
        const observed = statementsByReceiver.get(selectedReceiver) ?? [];
        const stops =
          options.stopAt === "write"
            ? options.writeMode !== "none" &&
              hostWrite(queryArgs, options.target, options.writeMode)
            : text === "commit" &&
              (options.writeMode === "none" ||
                sawHostWrite(observed, options.writeMode));
        if (stops) {
          statements = [...observed];
        }
        return stops;
      },
      pauseAfter:
        options.stopAt === "write" || options.pauseAfterCommit === true,
      work: async (barrier) => {
        return await options.work({
          ...barrier,
          statements: () => {
            return statements;
          },
        });
      },
    },
    signal,
  );
}

function targetDigest(target: ComputerUseHostStartTarget): string {
  return createHash("sha256")
    .update(
      `${target.orgId}|${target.userId}|${target.installationId ?? "legacy"}`,
    )
    .digest("hex")
    .slice(0, 32);
}

/** Inject one real PostgreSQL row-trigger fault into the exact target write. */
export async function failComputerUseHostStartWriteFixture(options: {
  readonly target: ComputerUseHostStartTarget;
  readonly operation: "insert" | "update";
}): Promise<{ readonly restore: () => Promise<void> }> {
  const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
  const triggerName = `fail_${targetDigest(options.target)}_${nonce}`;
  const functionName = `test_computer_use_host_start_${nonce}`;
  const event = options.operation === "insert" ? sql`INSERT` : sql`UPDATE`;
  await db().transaction(async (tx) => {
    await tx.execute(sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF substring(
             encode(
               sha256(convert_to(
                 NEW.org_id || '|' || NEW.user_id || '|' ||
                   COALESCE(NEW.installation_id::text, 'legacy'),
                 'UTF8'
               )),
               'hex'
             ) from 1 for 32
           ) = split_part(TG_NAME, '_', 2) THEN
          RAISE EXCEPTION 'test-scoped Computer Use host START write failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      BEFORE ${event} ON computer_use_hosts
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
    `);
  });

  let restored = false;
  const restore = async () => {
    if (restored) {
      return;
    }
    restored = true;
    await db().transaction(async (tx) => {
      await tx.execute(
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON computer_use_hosts`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
  onTestFinished(restore);
  return { restore };
}
