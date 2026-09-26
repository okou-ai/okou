import { sql } from "drizzle-orm";
import { z } from "zod";
import { createStore } from "ccstate";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { now } from "../lib/time";
import { createTestFixtureAgentRun$ } from "../signals/services/agent-runs-create.service";
import { withPreparedLaunchAdmissionTrackingForTest } from "../signals/services/prepared-launch-admission-lock.service";
import { createDeferredPromise } from "../signals/utils";

const waiterCountSchema = z.object({ waiterCount: z.number() });

// Infrastructure-only observation: no API exposes when this request has
// finished preparation and is about to acquire its final admission lock.
export function observePreparedLaunchAdmissionFixture(args: {
  readonly orgId: string;
  readonly signal: AbortSignal;
}) {
  const attempted = createDeferredPromise<void>(args.signal);
  return {
    attempted: attempted.promise,
    async track<T>(work: () => Promise<T>): Promise<T> {
      return await withPreparedLaunchAdmissionTrackingForTest((orgId) => {
        if (orgId === args.orgId && !attempted.settled()) {
          attempted.resolve(undefined);
        }
      }, work);
    },
  };
}

// Infrastructure-only observation for the refresh/terminal race. Product state
// is created and asserted through production APIs; no API exposes lock timing.
export async function countWaitingPersonalSubscriptionMutationsFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
}): Promise<number> {
  const key = `model_provider_state:${args.orgId}:${args.userId}:${args.type}`;
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT count(*)::int AS "waiterCount"
      FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
        AND objid = (hashtext(${key})::bigint & 4294967295)::oid
    `,
    waiterCountSchema,
  );
  if (!rows[0]) {
    throw new Error("Expected the aggregate lock waiter count");
  }
  return rows[0].waiterCount;
}

/** Infrastructure exception: current public model-first requests cannot name a
 * concrete account ID. Internal callers (chat continuation, workflows) pin the
 * captured account; replay that admission through the run fixture adapter and
 * assert the claimed/authenticated runtime through production APIs. */
export async function createPinnedSubscriptionRunFixture(
  args: {
    readonly owner: { readonly orgId: string | null; readonly userId: string };
    readonly agentId: string;
    readonly accountId: string;
    readonly type: "claude-code-oauth-token" | "codex-oauth-token";
    readonly model: string;
  },
  signal: AbortSignal,
) {
  if (!args.owner.orgId) {
    throw new Error("Expected a test-owned organization");
  }
  return await createStore().set(
    createTestFixtureAgentRun$,
    {
      auth: {
        orgId: args.owner.orgId,
        userId: args.owner.userId,
        tokenType: "session",
        orgRole: "admin",
      },
      body: {
        agentId: args.agentId,
        prompt: "continue an exact subscription selection",
      },
      apiStartTime: now(),
      piExecution: false,
      modelProviderId: args.accountId,
      modelProviderCredentialScope: "member",
      selectedModelOverride: args.model,
      agentRunModelPin: {
        modelProvider: args.type,
        modelProviderId: args.accountId,
        modelProviderCredentialScope: "member",
        selectedModel: args.model,
      },
    },
    signal,
  );
}
