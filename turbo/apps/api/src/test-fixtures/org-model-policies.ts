import type {
  ModelProviderType,
  SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";

import { db } from "../lib/db";

/**
 * Simulate a persisted discriminator written by a later release. The current
 * production API intentionally cannot construct this canonical row because
 * its write fence still rejects `built-in`; compatibility reads still require
 * permanent coverage before that later writer exists.
 */
export async function setOrgModelPolicyProviderTypeFixture(args: {
  readonly orgId: string;
  readonly model: SupportedRunModel;
  readonly defaultProviderType: ModelProviderType;
}): Promise<void> {
  const updated = await db()
    .update(orgModelPolicies)
    .set({ defaultProviderType: args.defaultProviderType })
    .where(
      and(
        eq(orgModelPolicies.orgId, args.orgId),
        eq(orgModelPolicies.model, args.model),
      ),
    )
    .returning({ id: orgModelPolicies.id });
  if (updated.length !== 1) {
    throw new Error("Expected one org model policy provider to update");
  }
}

/** A user cannot hold a transaction open through HTTP. Hold only the member
 * preference row to stop a real replacement after its revision decision; tests
 * observe both competing requests and their eventual API-visible results. */
export async function holdModelPolicyPreferenceFixture(
  orgId: string,
  signal: AbortSignal,
) {
  const started = createDeferredPromise<number>(signal);
  const release = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    await tx
      .select({ userId: orgMembersMetadata.userId })
      .from(orgMembersMetadata)
      .where(eq(orgMembersMetadata.orgId, orgId))
      .for("update");
    const [backend] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS pid`,
      z.object({ pid: z.int() }),
    );
    if (!backend) {
      throw new Error("Expected the preference lock owner");
    }
    started.resolve(backend.pid);
    await release.promise;
  });
  const pid = await started.promise;
  return {
    release: () => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    },
    done,
    blockedTransactions: async () => {
      const [result] = await executeRawRows(
        db(),
        sql`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity AS activity
          INNER JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        ) SELECT ${count()}::int AS total FROM blocked
      `,
        z.object({ total: z.int() }),
      );
      if (!result) {
        throw new Error("Expected the blocked transaction count");
      }
      return result.total;
    },
  };
}

/**
 * Historical/uninitialized storage is not constructible through policy PUT,
 * and policy GET repairs it. Own this persisted gap to prove rejected writes
 * cannot seed policies, repair defaults, or rewrite member preferences.
 */
export async function stageUnrepairedOrgModelPolicyFixture(args: {
  readonly orgId: string;
  readonly state: "unseeded" | "missing_default";
}): Promise<void> {
  if (args.state === "unseeded") {
    await db()
      .delete(orgModelPolicies)
      .where(eq(orgModelPolicies.orgId, args.orgId));
  } else {
    await db()
      .update(orgModelPolicies)
      .set({ isDefault: false })
      .where(eq(orgModelPolicies.orgId, args.orgId));
  }
}

/** The public GET cannot observe these states without repairing them first. */
export async function readUnrepairedOrgModelPolicyFixture(orgId: string) {
  const policies = await db()
    .select()
    .from(orgModelPolicies)
    .where(eq(orgModelPolicies.orgId, orgId))
    .orderBy(orgModelPolicies.model);
  const preferences = await db()
    .select({
      userId: orgMembersMetadata.userId,
      selectedModel: orgMembersMetadata.selectedModel,
      serviceTier: orgMembersMetadata.serviceTier,
      updatedAt: orgMembersMetadata.updatedAt,
    })
    .from(orgMembersMetadata)
    .where(eq(orgMembersMetadata.orgId, orgId))
    .orderBy(orgMembersMetadata.userId);
  return { policies, preferences };
}
