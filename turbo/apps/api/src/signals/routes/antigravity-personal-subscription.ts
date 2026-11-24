import { antigravityPersonalSubscriptionContract as contract } from "@okouai/api-contracts/contracts/antigravity-personal-subscription";
import { isStaffOrg } from "@okouai/core/staff-org";
import { antigravityMemberProfiles as profiles } from "@okouai/db/schema/antigravity-member-profile";
import { command } from "ccstate";
import { and, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { optionalEnv } from "../../lib/env";
import {
  conflict,
  notFound,
  providerUnavailable,
  resourceUnavailable,
} from "../../lib/error";
import { nowDate, nowDateSql } from "../../lib/time";
import { isUniqueViolation } from "../../lib/pg-errors";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { authenticateClerkMachine, clerk$ } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  antigravityWorkers,
  antigravityProfileOwner,
  memberAntigravityWorker,
} from "../services/antigravity-personal-subscription";
import { isAntigravityEnabledForMember$ } from "../services/feature-switches.service";
import { settle } from "../utils";

const disconnected = Object.freeze({
  status: 200 as const,
  body: Object.freeze({ status: "disconnected" as const }),
});
function profileResponse(row: typeof profiles.$inferSelect) {
  const bindingId = row.id;
  if (!row.confirmedAt && row.expiresAt <= nowDate()) {
    return {
      status: 200 as const,
      body: { status: "expired" as const, bindingId },
    };
  }
  const worker = memberAntigravityWorker(row);
  if (!worker || worker.machineId !== row.machineId) {
    return {
      status: 200 as const,
      body: { status: "unavailable" as const, bindingId },
    };
  }
  if (row.confirmedAt) {
    return {
      status: 200 as const,
      body: {
        status: "connected" as const,
        bindingId,
        loginHost: worker.loginHost,
      },
    };
  }
  return {
    status: 200 as const,
    body: {
      status: "pending" as const,
      bindingId,
      expiresAt: row.expiresAt.toISOString(),
      loginHost: worker.loginHost,
    },
  };
}

const getProfile$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = get(organizationAuthContext$);
  if (!isStaffOrg(owner.orgId)) {
    return notFound("Resource not found");
  }
  const [row] = await get(db$)
    .select()
    .from(profiles)
    .where(antigravityProfileOwner(owner));
  signal.throwIfAborted();
  if (row) {
    return profileResponse(row);
  }
  if (
    !(await set(
      isAntigravityEnabledForMember$,
      owner.orgId,
      owner.userId,
      signal,
    ))
  ) {
    return notFound("Resource not found");
  }
  return memberAntigravityWorker(owner) &&
    optionalEnv("OKOU_MACHINE_SECRET_KEY")
    ? disconnected
    : { status: 200 as const, body: { status: "unassigned" as const } };
});

const startProfile$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = get(organizationAuthContext$);
  const body = await get(bodyResultOf(contract.start));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (
    !(await set(
      isAntigravityEnabledForMember$,
      owner.orgId,
      owner.userId,
      signal,
    ))
  ) {
    return notFound("Resource not found");
  }
  const worker = memberAntigravityWorker(owner);
  if (!worker || !optionalEnv("OKOU_MACHINE_SECRET_KEY")) {
    return providerUnavailable(
      "A dedicated Antigravity login worker has not been assigned to this member",
    );
  }
  const db = set(writeDb$);
  const expiresAt = sql`${nowDateSql()} AT TIME ZONE 'UTC' + interval '15 minutes'`;
  const write = await settle(
    db
      .insert(profiles)
      .values({
        orgId: owner.orgId,
        userId: owner.userId,
        machineId: worker.machineId,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [profiles.orgId, profiles.userId],
        set: {
          id: sql`gen_random_uuid()`,
          expiresAt,
          machineId: worker.machineId,
        },
        setWhere: and(
          isNull(profiles.confirmedAt),
          lte(profiles.expiresAt, sql`${nowDateSql()} AT TIME ZONE 'UTC'`),
        ),
      })
      .returning(),
    signal,
  );
  signal.throwIfAborted();
  if (!write.ok) {
    if (
      isUniqueViolation(
        write.error,
        "antigravity_member_profiles_machine_id_unique",
      )
    ) {
      return conflict("The assigned worker still has a previous binding.");
    }
    throw write.error;
  }
  const [created] = write.value;
  if (created) {
    return profileResponse(created);
  }
  // An overlapping start reuses the live grant. A reassignment needs an
  // explicit disconnect before a different keyring can serve this member.
  const [existing] = await db
    .select()
    .from(profiles)
    .where(
      and(
        antigravityProfileOwner(owner),
        eq(profiles.machineId, worker.machineId),
      ),
    );
  signal.throwIfAborted();
  return existing
    ? profileResponse(existing)
    : conflict(
        "Profile changed. Refresh and disconnect the previous binding before retrying.",
      );
});

const disconnectProfile$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "no-store");
    const owner = get(organizationAuthContext$);
    if (!isStaffOrg(owner.orgId)) {
      return notFound("Resource not found");
    }
    const { bindingId } = get(pathParamsOf(contract.disconnect));
    const db = set(writeDb$);
    const removed = await db
      .delete(profiles)
      .where(and(antigravityProfileOwner(owner), eq(profiles.id, bindingId)))
      .returning({ id: profiles.id });
    signal.throwIfAborted();
    if (removed.length > 0) {
      return disconnected;
    }
    const [current] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(antigravityProfileOwner(owner));
    signal.throwIfAborted();
    return current ? notFound("Profile binding not found") : disconnected;
  },
);

const assignedWorker$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const secret = optionalEnv("OKOU_MACHINE_SECRET_KEY");
  if (!secret) {
    return providerUnavailable(
      "Antigravity worker authentication is not configured",
    );
  }
  const auth = await settle(
    authenticateClerkMachine(get(request$).raw, secret),
    signal,
  );
  signal.throwIfAborted();
  if (!auth.ok) {
    return providerUnavailable(
      "Antigravity worker authentication is unavailable",
    );
  }
  const worker = antigravityWorkers().find((row) => {
    return row.machineId === auth.value?.machineId;
  });
  if (!worker) {
    return resourceUnavailable("Worker is not assigned to this subscription");
  }
  return worker;
});

const enabledWorker$ = command(async ({ get, set }, signal: AbortSignal) => {
  const worker = await set(assignedWorker$, signal);
  if ("status" in worker) {
    return worker;
  }
  if (
    !(await set(
      isAntigravityEnabledForMember$,
      worker.orgId,
      worker.userId,
      signal,
    ))
  ) {
    return notFound("Resource not found");
  }
  const membership = await settle(
    get(clerk$).organizations.getOrganizationMembershipList(
      { organizationId: worker.orgId, userId: [worker.userId], limit: 1 },
      undefined,
      signal,
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!membership.ok) {
    return providerUnavailable(
      "Antigravity member verification is unavailable",
    );
  }
  if (
    !membership.value.data.some((entry) => {
      return (
        entry.organization.id === worker.orgId &&
        entry.publicUserData?.userId === worker.userId
      );
    })
  ) {
    return notFound("Resource not found");
  }
  return worker;
});

function workerBinding(
  worker: { orgId: string; userId: string; machineId: string },
  bindingId: string,
) {
  return and(
    antigravityProfileOwner(worker),
    eq(profiles.machineId, worker.machineId),
    eq(profiles.id, bindingId),
  );
}

const workerStatus$ = command(async ({ get, set }, signal: AbortSignal) => {
  const worker = await set(enabledWorker$, signal);
  if ("status" in worker) {
    return worker;
  }
  const { bindingId } = get(pathParamsOf(contract.workerStatus));
  const [row] = await get(db$)
    .select()
    .from(profiles)
    .where(workerBinding(worker, bindingId));
  signal.throwIfAborted();
  return row ? profileResponse(row) : notFound("Profile binding not found");
});

const confirmProfile$ = command(async ({ get, set }, signal: AbortSignal) => {
  const worker = await set(enabledWorker$, signal);
  if ("status" in worker) {
    return worker;
  }
  const body = await get(bodyResultOf(contract.confirm));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { bindingId } = get(pathParamsOf(contract.confirm));
  const [row] = await set(writeDb$)
    .update(profiles)
    .set({
      confirmedAt: sql`coalesce(${profiles.confirmedAt}, ${nowDateSql()} AT TIME ZONE 'UTC')`,
    })
    .where(
      and(
        workerBinding(worker, bindingId),
        or(
          isNotNull(profiles.confirmedAt),
          gt(profiles.expiresAt, sql`${nowDateSql()} AT TIME ZONE 'UTC'`),
        ),
      ),
    )
    .returning();
  signal.throwIfAborted();
  return row
    ? profileResponse(row)
    : notFound("Binding expired or disconnected. Start sign-in again.");
});

const workerDisconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const worker = await set(assignedWorker$, signal);
  if ("status" in worker) {
    return worker;
  }
  const { bindingId } = get(pathParamsOf(contract.workerDisconnect));
  await set(writeDb$).delete(profiles).where(workerBinding(worker, bindingId));
  signal.throwIfAborted();
  return disconnected;
});

const memberAuth = {
  requireOrganization: true,
  accept: ["session", "pat"],
} as const;
export const antigravityPersonalSubscriptionRoutes: readonly RouteEntry[] = [
  { route: contract.get, handler: authRoute(memberAuth, getProfile$) },
  { route: contract.start, handler: authRoute(memberAuth, startProfile$) },
  {
    route: contract.disconnect,
    handler: authRoute(memberAuth, disconnectProfile$),
  },
  { route: contract.confirm, handler: confirmProfile$ },
  { route: contract.workerStatus, handler: workerStatus$ },
  { route: contract.workerDisconnect, handler: workerDisconnect$ },
];
