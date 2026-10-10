import { createHash, randomBytes } from "node:crypto";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { runnerState } from "@okouai/db/schema/runner-state";
import { runnerWssTickets } from "@okouai/db/schema/runner-wss-ticket";
import { command } from "ccstate";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  buildRunnerWssTargetQuery,
  buildRunnerWssAuthorizationQuery,
  runnerWssTargetFromRow,
} from "./runner-wss-target.service";

const MAX_PENDING_PER_RUN = 16;
const TICKET_TTL_SECONDS = 30;
// PostgreSQL now() is fixed at transaction start. A Run-row lock can delay
// issuance or redemption past a short ticket's deadline, so use the actual
// database wall clock in the UTC convention of the stored timestamp columns.
const databaseNow = sql`timezone('UTC', clock_timestamp())`;
const oldestRedeemableCreatedAt = sql`${databaseNow} - ${TICKET_TTL_SECONDS} * interval '1 second'`;

function digestOf(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

interface RunOwner {
  readonly orgId: string;
  readonly userId: string;
}

// Complete each semantic transaction before the route observes cancellation.
export const issueRunnerWssTicket$ = command(
  async (
    { set },
    args: { readonly runId: string; readonly owner: RunOwner },
  ): Promise<{ wssUrl: string; ticket: string; expiresAt: string } | null> => {
    const ticket = randomBytes(32).toString("base64url");
    const digest = digestOf(ticket);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0240; new non-billing transactions are prohibited.
    return await set(writeDb$).transaction(async (tx) => {
      // Preserve inherited issuance serialization with terminal transitions.
      const [run] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, args.runId),
            eq(agentRuns.orgId, args.owner.orgId),
            eq(agentRuns.userId, args.owner.userId),
            eq(agentRuns.status, "running"),
          ),
        )
        .for("update");
      if (!run) {
        return null;
      }

      const query = buildRunnerWssTargetQuery({
        runId: run.id,
        owner: args.owner,
        now: nowDate(),
        purpose: "issue",
      });
      const [targetRow] = await tx
        .select(query.selection)
        .from(agentRuns)
        .innerJoin(activeAgentRuns, query.activeRunJoin)
        .innerJoin(runnerState, query.runnerStateJoin)
        .where(query.where);
      const target = runnerWssTargetFromRow(targetRow);
      if (!target) {
        return null;
      }

      const pending = await tx
        .select({ digest: runnerWssTickets.digest })
        .from(runnerWssTickets)
        .where(
          and(
            eq(runnerWssTickets.runId, run.id),
            gt(runnerWssTickets.createdAt, oldestRedeemableCreatedAt),
          ),
        )
        .limit(MAX_PENDING_PER_RUN);
      if (pending.length >= MAX_PENDING_PER_RUN) {
        return null;
      }

      // Tickets authorize only redemption; expired rows carry no live authority.
      await tx.delete(runnerWssTickets).where(
        inArray(
          runnerWssTickets.digest,
          tx
            .select({ digest: runnerWssTickets.digest })
            .from(runnerWssTickets)
            .where(lte(runnerWssTickets.createdAt, oldestRedeemableCreatedAt))
            .orderBy(runnerWssTickets.createdAt)
            .limit(100)
            // Never wait on another issuer's ticket row while holding this Run.
            .for("update", { skipLocked: true }),
        ),
      );

      const [issued] = await tx
        .insert(runnerWssTickets)
        .values({
          digest,
          runId: run.id,
          orgId: args.owner.orgId,
          userId: args.owner.userId,
          runnerId: target.runnerId,
          origin: target.publicOrigin,
          createdAt: databaseNow,
        })
        .returning({ createdAt: runnerWssTickets.createdAt });
      if (!issued) {
        throw new Error("WSS ticket insert returned no row");
      }
      return {
        wssUrl: `${target.publicOrigin}/ws/${target.runnerId}`,
        ticket,
        expiresAt: new Date(
          issued.createdAt.getTime() + TICKET_TTL_SECONDS * 1000,
        ).toISOString(),
      };
    });
  },
);

export const consumeRunnerWssTicket$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly runnerId: string;
      readonly origin: string;
      readonly ticket: string;
    },
  ): Promise<
    | (RunOwner & {
        runId: string;
        runnerId: string;
        origin: string;
        digest: string;
      })
    | null
  > => {
    const digest = digestOf(args.ticket);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0241; new non-billing transactions are prohibited.
    return await set(writeDb$).transaction(async (tx) => {
      const [candidate] = await tx
        .select({ runId: runnerWssTickets.runId })
        .from(runnerWssTickets)
        .where(eq(runnerWssTickets.digest, digest));
      if (!candidate || candidate.runId !== args.runId) {
        return null;
      }
      const [run] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, candidate.runId))
        .for("update");
      if (!run) {
        return null;
      }
      const [stored] = await tx
        .select({
          runId: runnerWssTickets.runId,
          orgId: runnerWssTickets.orgId,
          userId: runnerWssTickets.userId,
          runnerId: runnerWssTickets.runnerId,
          origin: runnerWssTickets.origin,
          digest: runnerWssTickets.digest,
        })
        .from(runnerWssTickets)
        .where(
          and(
            eq(runnerWssTickets.digest, digest),
            eq(runnerWssTickets.runId, args.runId),
            eq(runnerWssTickets.runnerId, args.runnerId),
            eq(runnerWssTickets.origin, args.origin),
            gt(runnerWssTickets.createdAt, oldestRedeemableCreatedAt),
          ),
        );
      if (!stored) {
        return null;
      }
      const query = buildRunnerWssTargetQuery({
        runId: stored.runId,
        owner: { orgId: stored.orgId, userId: stored.userId },
        now: nowDate(),
        purpose: "consume",
      });
      const [targetRow] = await tx
        .select(query.selection)
        .from(agentRuns)
        .innerJoin(activeAgentRuns, query.activeRunJoin)
        .innerJoin(runnerState, query.runnerStateJoin)
        .where(query.where);
      const target = runnerWssTargetFromRow(targetRow);
      if (
        !target ||
        target.runnerId !== stored.runnerId ||
        target.publicOrigin !== stored.origin
      ) {
        return null;
      }
      const [consumed] = await tx
        .delete(runnerWssTickets)
        .where(
          and(
            eq(runnerWssTickets.digest, digest),
            gt(runnerWssTickets.createdAt, oldestRedeemableCreatedAt),
          ),
        )
        .returning({ digest: runnerWssTickets.digest });
      return consumed ? stored : null;
    });
  },
);

/** Current Run authority for sessions already admitted by one-use redemption. */
export const checkRunnerWssAuthorizations$ = command(
  async (
    { get },
    args: {
      readonly runnerId: string;
      readonly origin: string;
      readonly authorizations: readonly {
        readonly runId: string;
        readonly digest: string;
        readonly orgId: string;
        readonly userId: string;
      }[];
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const query = buildRunnerWssAuthorizationQuery({ ...args, now: nowDate() });
    // db$ reads the same DATABASE_URL writer, never a replica. Initial one-use
    // consumption and the local live Guest assignment remain mandatory.
    const rows = await get(db$)
      .select(query.selection)
      .from(agentRuns)
      .innerJoin(activeAgentRuns, query.activeRunJoin)
      .innerJoin(runnerState, query.runnerStateJoin)
      .where(query.where);
    signal.throwIfAborted();
    return args.authorizations.filter((entry) => {
      return rows.some((row) => {
        const target = runnerWssTargetFromRow(row);
        return (
          target?.publicOrigin === args.origin &&
          row.runId === entry.runId &&
          row.orgId === entry.orgId &&
          row.userId === entry.userId
        );
      });
    });
  },
);

/** Existing minute cron owns bounded retirement even without new issuance. */
export const cleanupRunnerWssTickets$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    for (let batch = 0; batch < 10; batch += 1) {
      signal.throwIfAborted();
      const expired = db
        .select({ digest: runnerWssTickets.digest })
        .from(runnerWssTickets)
        .where(lte(runnerWssTickets.createdAt, oldestRedeemableCreatedAt))
        .orderBy(runnerWssTickets.createdAt)
        .limit(1000);
      const result = await db
        .delete(runnerWssTickets)
        .where(
          and(
            inArray(runnerWssTickets.digest, expired),
            lte(runnerWssTickets.createdAt, oldestRedeemableCreatedAt),
          ),
        );
      signal.throwIfAborted();
      if (result.rowCount === null) {
        throw new Error("WSS ticket cleanup returned no deletion count");
      }
      if (result.rowCount < 1000) {
        break;
      }
    }
  },
);
