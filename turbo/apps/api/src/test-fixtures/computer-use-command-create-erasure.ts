import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { db } from "../lib/db";
import {
  barrierQueryBinds,
  barrierQueryText,
  type TransactionBarrier,
  withDatabaseTransactionBarrierFixture,
} from "./account-erasure-subject";

const BEGIN = /^(?:begin|start transaction)(?:$|\s)/;
const SET_LOCK_TIMEOUT = /^select set_config\('lock_timeout', ?\$\d+, true\)$/;
const SET_STATEMENT_TIMEOUT =
  /^select set_config\('statement_timeout', ?\$\d+, true\)$/;
const FIRST_SUBJECT_LOCK =
  /^select (?=.*erasure_isolation_probe)(?=.*pg_advisory_xact_lock_shared).+$/;
const SECOND_SUBJECT_LOCK =
  /^select pg_advisory_xact_lock_shared\(hashtextextended\(\$\d+, \d+\)\)$/;
const SUBJECT_CLOSED_SELECT =
  /^select .+ from "account_erasure_jobs" where .+ limit \$\d+$/;
const HOST_SELECTION =
  /^select .+ from "computer_use_hosts" where \("computer_use_hosts"\."org_id" = \$\d+ and "computer_use_hosts"\."user_id" = \$\d+ and "computer_use_hosts"\."revoked_at" is null\) order by "computer_use_hosts"\."last_seen_at" desc$/;
const COMMAND_INSERT = /^insert into "computer_use_commands" .+ returning .+$/;
const COMMIT = /^commit$/;

const CREATED_STATEMENTS: readonly RegExp[] = [
  BEGIN,
  SET_LOCK_TIMEOUT,
  SET_STATEMENT_TIMEOUT,
  FIRST_SUBJECT_LOCK,
  SECOND_SUBJECT_LOCK,
  SUBJECT_CLOSED_SELECT,
  HOST_SELECTION,
  COMMAND_INSERT,
  COMMIT,
];

const CLOSED_STATEMENTS: readonly RegExp[] = [
  BEGIN,
  SET_LOCK_TIMEOUT,
  SET_STATEMENT_TIMEOUT,
  FIRST_SUBJECT_LOCK,
  SECOND_SUBJECT_LOCK,
  SUBJECT_CLOSED_SELECT,
  COMMIT,
];

function commandCreateStatements(
  path: "created" | "closed",
): readonly RegExp[] {
  return path === "created" ? CREATED_STATEMENTS : CLOSED_STATEMENTS;
}

function assertCommandCreateStatements(args: {
  readonly statements: readonly string[];
  readonly path: "created" | "closed";
  readonly stopAt: "host_selection" | "insert" | "commit";
}): void {
  const pathStatements = commandCreateStatements(args.path);
  const expected =
    args.stopAt === "host_selection"
      ? pathStatements.slice(0, 7)
      : args.stopAt === "insert"
        ? pathStatements.slice(0, 8)
        : pathStatements;
  if (args.statements.length !== expected.length) {
    throw new Error(
      `Unexpected computer-use command creation SQL count: ${args.statements.length}; expected ${expected.length}: ${args.statements.join(" | ")}`,
    );
  }
  for (const [index, statement] of args.statements.entries()) {
    const expectedStatement = expected[index];
    if (!expectedStatement?.test(statement)) {
      throw new Error(
        `Unexpected computer-use command creation SQL at index ${index}: ${statement}; expected ${String(expectedStatement)}`,
      );
    }
  }
}

interface ComputerUseCommandCreateBarrier extends TransactionBarrier {
  readonly startedTransactionCount: () => number;
  readonly statements: () => readonly string[];
}

/**
 * Captures one command-creation transaction selected by its first canonical
 * organization subject lock. It fails closed on statement-order drift and can pause after
 * host selection, after INSERT RETURNING, or immediately before COMMIT.
 */
export async function withComputerUseCommandCreateBarrierFixture<T>(
  args: {
    readonly orgId: string;
    readonly stopAt: "host_selection" | "insert" | "commit";
    readonly path?: "created" | "closed";
    readonly work: (barrier: ComputerUseCommandCreateBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  const path = args.path ?? "created";
  let selectedReceiver: unknown;
  let selectedStatements: readonly string[] = [];
  let startedTransactionCount = 0;
  const statementsByReceiver = new Map<unknown, string[]>();

  return await withDatabaseTransactionBarrierFixture(
    {
      observe: (queryArgs, receiver) => {
        const text = barrierQueryText(queryArgs).replaceAll(/\s+/g, " ").trim();
        if (BEGIN.test(text)) {
          startedTransactionCount += 1;
          statementsByReceiver.set(receiver, [text]);
        } else {
          statementsByReceiver.get(receiver)?.push(text);
        }
        const organizationLockKey = `account-erasure:${JSON.stringify(["organization", args.orgId])}`;
        if (
          selectedReceiver === undefined &&
          FIRST_SUBJECT_LOCK.test(text) &&
          barrierQueryBinds(queryArgs, organizationLockKey)
        ) {
          selectedReceiver = receiver;
        }
      },
      select: (queryArgs) => {
        const text = barrierQueryText(queryArgs).replaceAll(/\s+/g, " ").trim();
        const organizationLockKey = `account-erasure:${JSON.stringify(["organization", args.orgId])}`;
        return (
          FIRST_SUBJECT_LOCK.test(text) &&
          barrierQueryBinds(queryArgs, organizationLockKey)
        );
      },
      stopAt: (queryArgs) => {
        const text = barrierQueryText(queryArgs).replaceAll(/\s+/g, " ").trim();
        const stops =
          (args.stopAt === "host_selection" && HOST_SELECTION.test(text)) ||
          (args.stopAt === "insert" && COMMAND_INSERT.test(text)) ||
          (args.stopAt === "commit" && COMMIT.test(text));
        if (stops) {
          selectedStatements = [
            ...(statementsByReceiver.get(selectedReceiver) ?? [text]),
          ];
          assertCommandCreateStatements({
            statements: selectedStatements,
            path,
            stopAt: args.stopAt,
          });
        }
        return stops;
      },
      pauseAfter: args.stopAt !== "commit",
      work: async (barrier) => {
        return await args.work({
          ...barrier,
          startedTransactionCount: () => {
            return startedTransactionCount;
          },
          statements: () => {
            return selectedStatements;
          },
        });
      },
    },
    signal,
  );
}

interface ComputerUseCommandInsertFaultFixture {
  readonly restore: () => Promise<void>;
}

/** Installs a narrow real-PostgreSQL fault at computer-use command INSERT. */
export async function installComputerUseCommandInsertFaultFixture(args: {
  readonly userId: string;
}): Promise<ComputerUseCommandInsertFaultFixture> {
  const userDigest = createHash("sha256")
    .update(args.userId)
    .digest("hex")
    .slice(0, 32);
  const nonce = randomUUID().replaceAll("-", "").slice(0, 8);
  const functionName = `test_cu_command_fault_${nonce}`;
  const triggerName = `test_cu_command_fault_${userDigest}_${nonce}`;
  let restored = false;

  await db().transaction(async (tx) => {
    await tx.execute(sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF substring(
             encode(sha256(convert_to(NEW.user_id::text, 'UTF8')), 'hex')
             from 1 for 32
           ) = split_part(TG_NAME, '_', 5) THEN
          RAISE EXCEPTION 'test: computer-use command insert fault'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      BEFORE INSERT ON computer_use_commands
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
    `);
  });

  const restore = async (): Promise<void> => {
    if (restored) {
      return;
    }
    restored = true;
    await db().transaction(async (tx) => {
      await tx.execute(
        sql`DROP TRIGGER IF EXISTS ${sql.identifier(triggerName)} ON computer_use_commands`,
      );
      await tx.execute(
        sql`DROP FUNCTION IF EXISTS ${sql.identifier(functionName)}()`,
      );
    });
  };
  onTestFinished(restore);
  return { restore };
}
