import { antigravityTerminal } from "@okouai/api-contracts/contracts/antigravity-personal-subscription";
import { antigravityMemberProfiles as profiles } from "@okouai/db/schema/antigravity-member-profile";
import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { array, object, string } from "zod";
import { envSingleton, optionalEnv } from "../../lib/env";
import { db$ } from "../external/db";
import { safeJsonParse } from "../utils";

const workerConfig = array(
  object({
    machineId: string().min(1),
    orgId: string().min(1),
    userId: string().min(1),
  }).and(antigravityTerminal),
);

// One service identity per member-owned native profile. Neither the browser nor
// the worker request body can choose the owner of a successful sign-in.
export const antigravityWorkers = envSingleton(() => {
  const parsed = workerConfig.safeParse(
    safeJsonParse(optionalEnv("ANTIGRAVITY_SUBSCRIPTION_WORKERS") ?? "[]"),
  );
  if (!parsed.success) {
    return [];
  }
  const machines = new Set(
    parsed.data.map((row) => {
      return row.machineId;
    }),
  );
  const members = new Set(
    parsed.data.map((row) => {
      return JSON.stringify([row.orgId, row.userId]);
    }),
  );
  const origins = parsed.data.flatMap((worker) => {
    return "loginOrigin" in worker ? [worker.loginOrigin] : [];
  });
  return new Set(origins).size === origins.length &&
    machines.size === parsed.data.length &&
    members.size === parsed.data.length
    ? parsed.data
    : [];
});

type Owner = { orgId: string; userId: string };
export function memberAntigravityWorker(owner: Owner) {
  return antigravityWorkers().find((row) => {
    return row.orgId === owner.orgId && row.userId === owner.userId;
  });
}

export function antigravityProfileOwner(owner: Owner) {
  return and(
    eq(profiles.orgId, owner.orgId),
    eq(profiles.userId, owner.userId),
  );
}

export const confirmedAntigravityProfile$ = command(
  async ({ get }, owner: Owner, signal: AbortSignal) => {
    const worker = memberAntigravityWorker(owner);
    if (!worker) {
      return null;
    }
    const [row] = await get(db$)
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        and(
          antigravityProfileOwner(owner),
          eq(profiles.machineId, worker.machineId),
          isNotNull(profiles.confirmedAt),
        ),
      );
    signal.throwIfAborted();
    return row ?? null;
  },
);
