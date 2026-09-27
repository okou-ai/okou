import { createHash, randomBytes } from "node:crypto";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runnerWssTickets } from "@okouai/db/schema/runner-wss-ticket";
import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { resolveRunnerWssTarget } from "./runner-wss-target.service";

const MAX_PENDING_PER_RUN = 16;
// PostgreSQL now() is fixed at transaction start. A Run-row lock can delay
// issuance or redemption past a short ticket's deadline, so use the actual
// database wall clock in the UTC convention of the stored timestamp columns.
const databaseNow = sql`timezone('UTC', clock_timestamp())`;

function digestOf(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

interface RunOwner {
  readonly orgId: string;
  readonly userId: string;
}

/** This switch is an operator gate, not evidence of listener or ingress health. */
export async function issueRunnerWssTicket(
  db: Db,
  args: { readonly runId: string; readonly owner: RunOwner },
): Promise<{ wssUrl: string; ticket: string; expiresAt: string } | null> {
  if (env("OKOU_WSS_TICKET_ISSUANCE_ENABLED") !== "true") {
    return null;
  }

  return await db.transaction(async (tx) => {
    // Serialize issue, consume and revoke with the run's terminal transition.
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

    const target = await resolveRunnerWssTarget(tx, {
      runId: run.id,
      owner: args.owner,
      now: nowDate(),
    });
    if (!target) {
      return null;
    }

    const pending = await tx
      .select({ digest: runnerWssTickets.digest })
      .from(runnerWssTickets)
      .where(
        and(
          eq(runnerWssTickets.runId, run.id),
          gt(runnerWssTickets.expiresAt, databaseNow),
          isNull(runnerWssTickets.consumedAt),
          isNull(runnerWssTickets.revokedAt),
        ),
      )
      .limit(MAX_PENDING_PER_RUN);
    if (pending.length >= MAX_PENDING_PER_RUN) {
      return null;
    }

    // Opportunistic, indexed and bounded retention. Every issuance adds one
    // row and can remove up to 100 rows older than a day; no broad DELETE.
    await tx.delete(runnerWssTickets).where(
      inArray(
        runnerWssTickets.digest,
        tx
          .select({ digest: runnerWssTickets.digest })
          .from(runnerWssTickets)
          .where(
            lt(
              runnerWssTickets.expiresAt,
              sql`${databaseNow} - interval '1 day'`,
            ),
          )
          .orderBy(runnerWssTickets.expiresAt)
          .limit(100)
          // Issuers hold different Run rows: do not wait on another issuer's
          // cleanup row while holding a Run lock (cross-run deadlock risk).
          .for("update", { skipLocked: true }),
      ),
    );

    const ticket = randomBytes(32).toString("base64url");
    const [issued] = await tx
      .insert(runnerWssTickets)
      .values({
        digest: digestOf(ticket),
        runId: run.id,
        orgId: args.owner.orgId,
        userId: args.owner.userId,
        runnerId: target.runnerId,
        origin: target.publicOrigin,
        createdAt: databaseNow,
        expiresAt: sql`${databaseNow} + interval '30 seconds'`,
      })
      .returning({ expiresAt: runnerWssTickets.expiresAt });
    if (!issued) {
      throw new Error("WSS ticket insert returned no row");
    }

    // Runner ID is a validated UUID from the winning official run claim; the
    // browser receives this complete URL and never constructs its own host.
    return {
      wssUrl: `${target.publicOrigin}/ws/${target.runnerId}`,
      ticket,
      expiresAt: issued.expiresAt.toISOString(),
    };
  });
}

export async function consumeRunnerWssTicket(
  db: Db,
  args: {
    readonly runId: string;
    readonly runnerId: string;
    readonly origin: string;
    readonly ticket: string;
  },
): Promise<
  (RunOwner & { runId: string; runnerId: string; origin: string }) | null
> {
  const digest = digestOf(args.ticket);
  return await db.transaction(async (tx) => {
    // Digest lookup reveals no ticket or owner to the caller on failure.
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
      })
      .from(runnerWssTickets)
      .where(
        and(
          eq(runnerWssTickets.digest, digest),
          eq(runnerWssTickets.runId, args.runId),
          eq(runnerWssTickets.runnerId, args.runnerId),
          eq(runnerWssTickets.origin, args.origin),
          gt(runnerWssTickets.expiresAt, databaseNow),
          isNull(runnerWssTickets.consumedAt),
          isNull(runnerWssTickets.revokedAt),
        ),
      );
    if (!stored) {
      return null;
    }
    const target = await resolveRunnerWssTarget(tx, {
      runId: stored.runId,
      owner: { orgId: stored.orgId, userId: stored.userId },
      now: nowDate(),
    });
    if (
      !target ||
      target.runnerId !== stored.runnerId ||
      target.publicOrigin !== stored.origin
    ) {
      return null;
    }
    const [consumed] = await tx
      .update(runnerWssTickets)
      .set({ consumedAt: databaseNow })
      .where(
        and(
          eq(runnerWssTickets.digest, digest),
          isNull(runnerWssTickets.consumedAt),
          isNull(runnerWssTickets.revokedAt),
          gt(runnerWssTickets.expiresAt, databaseNow),
        ),
      )
      .returning({ digest: runnerWssTickets.digest });
    return consumed ? stored : null;
  });
}

/** Invalidates pending tickets; active streams are closed by the Runner (#37027). */
export async function revokeRunnerWssTickets(
  db: Db,
  args: { readonly runId: string; readonly owner: RunOwner },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.orgId, args.owner.orgId),
          eq(agentRuns.userId, args.owner.userId),
        ),
      )
      .for("update");
    if (!run) {
      return false;
    }
    await tx
      .update(runnerWssTickets)
      .set({ revokedAt: databaseNow })
      .where(
        and(
          eq(runnerWssTickets.runId, run.id),
          isNull(runnerWssTickets.consumedAt),
          isNull(runnerWssTickets.revokedAt),
        ),
      );
    return true;
  });
}
