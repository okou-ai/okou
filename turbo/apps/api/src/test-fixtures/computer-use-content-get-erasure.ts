import { computerUseCommands } from "@okouai/db/schema/computer-use-host";
import { eq } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { db } from "../lib/db";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type TransactionBarrier,
} from "./account-erasure-subject";

interface ComputerUseContentReadBarrier extends TransactionBarrier {
  /** Exact statements issued by the selected transaction, including control. */
  readonly statements: () => readonly string[];
}

function firstContentReadSubjectLock(
  queryArgs: unknown[],
  orgId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  const lockKey = `account-erasure:${JSON.stringify(["organization", orgId])}`;
  return (
    text.startsWith("select") &&
    text.includes("erasure_isolation_probe") &&
    text.includes("pg_advisory_xact_lock_shared") &&
    barrierQueryBinds(queryArgs, lockKey)
  );
}

function isContentProjection(
  queryArgs: unknown[],
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly commandId: string;
    readonly hostId?: string;
  },
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith('select "status", "result"') &&
    text.includes('from "computer_use_commands"') &&
    text.includes('"computer_use_commands"."org_id" =') &&
    text.includes('"computer_use_commands"."user_id" =') &&
    text.includes('"computer_use_commands"."id" =') &&
    text.includes(" limit ") &&
    !text.includes(" join ") &&
    !text.includes(" for ") &&
    barrierQueryBinds(queryArgs, args.orgId) &&
    barrierQueryBinds(queryArgs, args.userId) &&
    barrierQueryBinds(queryArgs, args.commandId) &&
    (!args.hostId || barrierQueryBinds(queryArgs, args.hostId))
  );
}

/**
 * Infrastructure exception: no public endpoint can pause its own admitted
 * transaction at the real command-content projection dispatch or at COMMIT.
 * Every PostgreSQL statement and result remains unchanged; only the selected
 * dispatch is delayed so another session can observe the real B1 lock edge
 * before the production request proceeds into controlled external S3 work.
 */
export async function withComputerUseContentReadBarrierFixture<T>(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly commandId: string;
    readonly hostId?: string;
    readonly stopAt: "projection" | "commit";
    readonly work: (barrier: ComputerUseContentReadBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  let selectedReceiver: unknown;
  let selectedStatements: readonly string[] = [];
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
          firstContentReadSubjectLock(queryArgs, args.orgId)
        ) {
          selectedReceiver = receiver;
        }
      },
      select: (queryArgs) => {
        return firstContentReadSubjectLock(queryArgs, args.orgId);
      },
      stopAt: (queryArgs) => {
        const text = barrierQueryText(queryArgs);
        const stops =
          (args.stopAt === "projection" &&
            isContentProjection(queryArgs, args)) ||
          (args.stopAt === "commit" && text === "commit");
        if (stops) {
          selectedStatements = [
            ...(statementsByReceiver.get(selectedReceiver) ?? [text]),
          ];
        }
        return stops;
      },
      pauseAfter: false,
      work: async (barrier) => {
        return await args.work({
          ...barrier,
          statements: () => {
            return selectedStatements;
          },
        });
      },
    },
    signal,
  );
}

/**
 * Infrastructure exception: every current public completion offloads a valid
 * image data URL before persistence, while the production reader deliberately
 * retains valid legacy inline rows. This creates one exact historical shape;
 * the bytes are still observed only through the authenticated HTTP endpoint.
 */
export async function createLegacyInlineScreenshotFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string;
  readonly screenshot: string;
  readonly createdAt: Date;
}): Promise<{ readonly commandId: string }> {
  const [created] = await db()
    .insert(computerUseCommands)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      hostId: args.hostId,
      kind: "app.state",
      status: "succeeded",
      payload: { app: "Safari" },
      result: {
        snapshotId: "legacy_inline_fixture",
        screenshot: args.screenshot,
      },
      timeoutMs: 60_000,
      createdAt: args.createdAt,
      claimedAt: args.createdAt,
      completedAt: args.createdAt,
      updatedAt: args.createdAt,
    })
    .returning({ id: computerUseCommands.id });
  if (!created) {
    throw new Error("Expected the legacy inline screenshot fixture");
  }
  onTestFinished(async () => {
    await db()
      .delete(computerUseCommands)
      .where(eq(computerUseCommands.id, created.id));
  });
  return { commandId: created.id };
}
