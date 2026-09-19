import {
  assertErasureSubjectWritable,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import type { RunStatus } from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { storages } from "@okouai/db/schema/storage";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { executeRawRows } from "../../lib/db-raw-rows";
import type { Tx } from "../../lib/db-types";
import { settle } from "../utils";
import { lockPiMemoryPhase2MaintenanceCleanupProtection } from "./pi-memory-phase2-maintenance.service";
import {
  COMPUTE_CLOSURE_ERROR,
  stopErasureClosedComputeRun,
} from "./agent-run-terminal-transition.service";

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}

export interface ComputeRunOwner extends Owner {
  readonly agentId: string | null;
  readonly resourceOwner?: Owner;
  /** Cleanup retains the captured B1 subjects even after resource transfer. */
  readonly capturedCleanupOwner?: Owner;
  /**
   * Durable resource identity captured when the run was admitted. A threadless
   * private maintenance run is otherwise discoverable only through the live
   * `pi_memory_phase2_jobs.maintenance_run_id` binding, which normal checkpoint
   * settlement, success and failure retire. Cleanup callers pass the captured
   * identity so a later physical-release proof still finds the exact resource;
   * execution admission keeps validating the live lease separately.
   */
  readonly capturedMaintenanceStorageId?: string;
}

interface ResourceOwner extends Owner {
  readonly id: string;
  readonly kind: "agent" | "maintenance";
}

export interface ComputeRunAdmission {
  readonly runId: string;
  readonly sessionId: string;
  readonly owner: ComputeRunOwner;
  readonly sessionOwner: Owner;
  readonly closed: boolean;
}

interface ComputeRunAdmissionObservation {
  readonly admission: ComputeRunAdmission;
  readonly resource: ResourceOwner;
  readonly maintenance:
    | (Owner & {
        readonly id: string;
      })
    | undefined;
  readonly capturedMaintenance: string | undefined;
}

const agentClaimAdmissionLockRowSchema = z.object({
  resourceId: z.string().uuid().nullable(),
  resourceUserId: z.string().nullable(),
  resourceOrgId: z.string().nullable(),
  runId: z.string().uuid().nullable(),
  runUserId: z.string().nullable(),
  runOrgId: z.string().nullable(),
  runSessionId: z.string().uuid().nullable(),
  sessionId: z.string().uuid().nullable(),
  sessionUserId: z.string().nullable(),
  sessionOrgId: z.string().nullable(),
  sessionAgentId: z.string().uuid().nullable(),
});

class ComputeOwnershipChangedError extends Error {
  constructor() {
    super("Compute ownership changed during admission");
  }
}

/** Retry only an observed ownership race, with a fresh transaction and lock set. */
export async function withComputeOwnershipRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const result = await settle(operation());
    if (result.ok) {
      return result.value;
    }
    if (
      !(result.error instanceof ComputeOwnershipChangedError) ||
      attempt === 2
    ) {
      throw result.error;
    }
  }
}

function subjects(owner: Owner): ErasureSubject[] {
  return [
    { subjectKind: "user", subjectId: owner.userId },
    { subjectKind: "organization", subjectId: owner.orgId },
  ];
}

async function writable(tx: Tx, owners: readonly Owner[]): Promise<boolean> {
  const distinctSubjects = [
    ...new Map(
      owners.flatMap(subjects).map((subject) => {
        return [JSON.stringify(subject), subject];
      }),
    ).values(),
  ];
  const result = await settle(
    assertErasureSubjectWritable(tx, distinctSubjects),
  );
  if (result.ok) {
    return true;
  }
  // Only B1's exact closure error is a denial. Infrastructure failures propagate.
  if (
    result.error instanceof Error &&
    result.error.message === COMPUTE_CLOSURE_ERROR
  ) {
    return false;
  }
  throw result.error;
}

function sameOwner(a: Owner, b: Owner): boolean {
  return a.userId === b.userId && a.orgId === b.orgId;
}

async function readResource(
  tx: Tx,
  resource: Pick<ResourceOwner, "kind" | "id">,
  lock: boolean,
): Promise<ResourceOwner | undefined> {
  const query =
    resource.kind === "agent"
      ? tx
          .select({ id: agents.id, userId: agents.owner, orgId: agents.orgId })
          .from(agents)
          .where(eq(agents.id, resource.id))
      : tx
          .select({
            id: storages.id,
            userId: storages.userId,
            orgId: storages.orgId,
          })
          .from(storages)
          .where(eq(storages.id, resource.id));
  // Both tables have an identity/org/owner unique key. KEY SHARE prevents its
  // transfer/deletion while allowing ordinary non-identity updates to proceed.
  const [row] = await (lock ? query.for("key share") : query);
  return row ? { ...row, kind: resource.kind } : undefined;
}

async function lockResource(tx: Tx, observed: ResourceOwner): Promise<void> {
  const current = await readResource(tx, observed, true);
  if (!current || !sameOwner(current, observed)) {
    // Never add newly discovered subject locks to an already acquired set.
    throw new ComputeOwnershipChangedError();
  }
}

async function readNewComputeOwners(
  tx: Tx,
  identity: Pick<ResourceOwner, "kind" | "id">,
  existingSessionId: string | undefined,
) {
  if (identity.kind === "agent" && existingSessionId !== undefined) {
    const [observed] = await tx
      .select({
        resource: {
          id: agents.id,
          userId: agents.owner,
          orgId: agents.orgId,
        },
        session: {
          userId: agentSessions.userId,
          orgId: agentSessions.orgId,
          agentId: agentSessions.agentId,
        },
      })
      // Each observation survives independently, even if the other row is gone.
      .from(sql`(SELECT 1) AS admission`)
      .leftJoin(agents, eq(agents.id, identity.id))
      .leftJoin(agentSessions, eq(agentSessions.id, existingSessionId));
    if (!observed) {
      throw new Error("Missing new-run ownership observation");
    }
    return {
      resource: observed.resource
        ? { ...observed.resource, kind: identity.kind }
        : undefined,
      session: observed.session ?? undefined,
    };
  }
  const resource = await readResource(tx, identity, false);
  const [session] =
    existingSessionId === undefined
      ? []
      : await tx
          .select({
            userId: agentSessions.userId,
            orgId: agentSessions.orgId,
            agentId: agentSessions.agentId,
          })
          .from(agentSessions)
          .where(eq(agentSessions.id, existingSessionId));
  return { resource, session };
}

/** First operation in each new-run persistence transaction, including failures. */
export async function admitNewComputeRun(
  tx: Tx,
  args: ComputeRunOwner & {
    readonly ownerUserId: string;
    readonly agentOrgId: string;
    readonly maintenanceStorageId?: string;
    readonly existingSessionId?: string;
  },
): Promise<boolean> {
  const identity =
    args.agentId === null
      ? args.maintenanceStorageId === undefined
        ? undefined
        : { kind: "maintenance" as const, id: args.maintenanceStorageId }
      : { kind: "agent" as const, id: args.agentId };
  if (!identity) {
    return false;
  }
  const { resource, session } = await readNewComputeOwners(
    tx,
    identity,
    args.existingSessionId,
  );
  const expected = { userId: args.ownerUserId, orgId: args.agentOrgId };
  const allowed = await writable(tx, [
    args,
    expected,
    ...(resource ? [resource] : []),
    ...(session ? [session] : []),
  ]);
  if (!resource) {
    return false;
  }
  await lockResource(tx, resource);
  // A prepared payload belongs to its original owner. A transfer requires a
  // newly prepared request, even when the new owner is writable.
  return (
    allowed &&
    sameOwner(resource, expected) &&
    (args.existingSessionId === undefined ||
      (session !== undefined &&
        sameOwner(session, args) &&
        session.agentId === args.agentId)) &&
    (resource.kind !== "maintenance" || sameOwner(resource, args))
  );
}

const lockedComputeSessionTransaction = Symbol(
  "lockedComputeSessionTransaction",
);

export interface LockedComputeSessionSnapshot extends Owner {
  readonly id: string;
  readonly agentId: string | null;
  readonly conversationId: string | null;
  readonly [lockedComputeSessionTransaction]: Tx;
}

/** Only this locked read can establish the observation's transaction provenance. */
export async function lockComputeSessionSnapshot(
  tx: Tx,
  sessionId: string,
): Promise<LockedComputeSessionSnapshot | undefined> {
  const [session] = await tx
    .select({
      id: agentSessions.id,
      conversationId: agentSessions.conversationId,
      userId: agentSessions.userId,
      orgId: agentSessions.orgId,
      agentId: agentSessions.agentId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .for("update")
    .limit(1);
  return session
    ? Object.freeze({ ...session, [lockedComputeSessionTransaction]: tx })
    : undefined;
}

export async function validateNewComputeSession(
  tx: Tx,
  args: ComputeRunOwner & { readonly existingSessionId: string | undefined },
  observedSession?: LockedComputeSessionSnapshot,
): Promise<boolean> {
  if (args.existingSessionId === undefined) {
    return true;
  }
  const [session] =
    observedSession?.[lockedComputeSessionTransaction] === tx &&
    observedSession.id === args.existingSessionId
      ? [observedSession]
      : await tx
          .select({
            userId: agentSessions.userId,
            orgId: agentSessions.orgId,
            agentId: agentSessions.agentId,
          })
          .from(agentSessions)
          .where(eq(agentSessions.id, args.existingSessionId))
          .for("update");
  return (
    session !== undefined &&
    sameOwner(session, args) &&
    session.agentId === args.agentId
  );
}

/**
 * Only a cleanup caller that carries a captured cleanup owner may recover a
 * retired private maintenance identity. Execution admission never does.
 */
function recoveredMaintenanceId(
  expected: ComputeRunOwner,
  run: { readonly agentId: string | null; readonly bound: boolean },
): string | undefined {
  if (run.agentId !== null || run.bound) {
    return undefined;
  }
  return expected.capturedCleanupOwner === undefined
    ? undefined
    : expected.capturedMaintenanceStorageId;
}

/**
 * A live binding stays authoritative when it exists. A recovered identity is
 * accepted only when the storage still belongs to both the Run owner and the
 * captured cleanup owner.
 */
function maintenanceResourceOwned(args: {
  readonly resource: ResourceOwner;
  readonly owner: Owner;
  readonly bound: Owner | undefined;
  readonly capturedCleanupOwner: Owner | undefined;
}): boolean {
  if (!sameOwner(args.resource, args.owner)) {
    return false;
  }
  if (args.capturedCleanupOwner === undefined) {
    return args.bound !== undefined && sameOwner(args.bound, args.owner);
  }
  return sameOwner(args.resource, args.capturedCleanupOwner);
}

/** Resolve without business locks, then acquire the complete sorted B1 set. */
async function observeComputeRunAdmission(
  tx: Tx,
  runId: string,
  expected: ComputeRunOwner,
): Promise<ComputeRunAdmissionObservation | undefined> {
  const [owner] = await tx
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      agentId: agentSessions.agentId,
      sessionId: agentRuns.sessionId,
      sessionOwner: {
        userId: agentSessions.userId,
        orgId: agentSessions.orgId,
      },
      agentOwner: {
        id: agents.id,
        userId: agents.owner,
        orgId: agents.orgId,
      },
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .leftJoin(agents, eq(agents.id, agentSessions.agentId))
    .where(eq(agentRuns.id, runId));
  if (!owner) {
    return undefined;
  }
  const [maintenance] =
    owner.agentId === null
      ? await tx
          .select({
            id: piMemoryPhase2Jobs.memoryStorageId,
            userId: piMemoryPhase2Jobs.userId,
            orgId: piMemoryPhase2Jobs.orgId,
          })
          .from(piMemoryPhase2Jobs)
          .where(eq(piMemoryPhase2Jobs.maintenanceRunId, runId))
          .limit(1)
      : [];
  // A retired maintenance binding is not proof that no obligation remains. Fall
  // back to the caller's captured identity, which only cleanup supplies.
  const capturedMaintenance = recoveredMaintenanceId(expected, {
    agentId: owner.agentId,
    bound: maintenance !== undefined,
  });
  const maintenanceId = maintenance?.id ?? capturedMaintenance;
  // This join only discovers subjects. The resource still needs its locked
  // reread below, and maintenance keeps its independent job/Storage authority.
  const resource = owner.agentOwner
    ? { ...owner.agentOwner, kind: "agent" as const }
    : maintenanceId === undefined
      ? undefined
      : await readResource(
          tx,
          { kind: "maintenance", id: maintenanceId },
          false,
        );
  const allowed = await writable(tx, [
    owner,
    owner.sessionOwner,
    ...(expected.resourceOwner ? [expected.resourceOwner] : []),
    ...(expected.capturedCleanupOwner ? [expected.capturedCleanupOwner] : []),
    ...(resource ? [resource] : []),
    ...(maintenance ? [maintenance] : []),
  ]);
  if (
    !sameOwner(owner, expected) ||
    owner.agentId !== expected.agentId ||
    !resource
  ) {
    return undefined;
  }
  return {
    admission: {
      runId,
      sessionId: owner.sessionId,
      owner,
      sessionOwner: owner.sessionOwner,
      closed: !allowed,
    },
    resource,
    maintenance,
    capturedMaintenance,
  };
}

/** Resolve subjects and retain the generic resource-lock behavior for callers. */
export async function prepareComputeRunAdmission(
  tx: Tx,
  runId: string,
  expected: ComputeRunOwner,
): Promise<ComputeRunAdmission | undefined> {
  const observed = await observeComputeRunAdmission(tx, runId, expected);
  if (!observed) {
    return undefined;
  }
  await lockResource(tx, observed.resource);
  if (
    expected.resourceOwner &&
    !sameOwner(observed.resource, expected.resourceOwner)
  ) {
    return undefined;
  }
  if (
    observed.resource.kind === "maintenance" &&
    !maintenanceResourceOwned({
      resource: observed.resource,
      owner: observed.admission.owner,
      bound: observed.maintenance,
      capturedCleanupOwner: observed.capturedMaintenance
        ? expected.capturedCleanupOwner
        : undefined,
    })
  ) {
    return undefined;
  }
  return observed.admission;
}

async function validateAgentClaimAdmission(
  tx: Tx,
  observed: ComputeRunAdmissionObservation & {
    readonly resource: ResourceOwner & { readonly kind: "agent" };
  },
): Promise<boolean> {
  const { admission, resource } = observed;
  const [row] = await executeRawRows(
    tx,
    sql`
      WITH locked_resource AS MATERIALIZED (
        SELECT
          ${agents.id} AS "id",
          ${agents.owner} AS "userId",
          ${agents.orgId} AS "orgId"
        FROM ${agents}
        WHERE ${eq(agents.id, resource.id)}
        FOR KEY SHARE OF ${agents}
      ),
      matching_resource AS MATERIALIZED (
        SELECT ${admission.runId}::uuid AS "runId"
        FROM locked_resource
        WHERE locked_resource."userId" = ${resource.userId}
          AND locked_resource."orgId" = ${resource.orgId}
      ),
      locked_run AS MATERIALIZED (
        SELECT
          ${agentRuns.id} AS "id",
          ${agentRuns.userId} AS "userId",
          ${agentRuns.orgId} AS "orgId",
          ${agentRuns.sessionId} AS "sessionId"
        FROM ${agentRuns}
        INNER JOIN matching_resource
          ON matching_resource."runId" = ${agentRuns.id}
        WHERE ${and(
          eq(agentRuns.id, admission.runId),
          eq(agentRuns.status, "pending"),
        )}
        FOR UPDATE OF ${agentRuns}
      ),
      matching_run AS MATERIALIZED (
        SELECT locked_run."sessionId"
        FROM locked_run
        WHERE locked_run."userId" = ${admission.owner.userId}
          AND locked_run."orgId" = ${admission.owner.orgId}
          AND locked_run."sessionId" = ${admission.sessionId}::uuid
      ),
      locked_session AS MATERIALIZED (
        SELECT
          ${agentSessions.id} AS "id",
          ${agentSessions.userId} AS "userId",
          ${agentSessions.orgId} AS "orgId",
          ${agentSessions.agentId} AS "agentId"
        FROM ${agentSessions}
        INNER JOIN matching_run
          ON matching_run."sessionId" = ${agentSessions.id}
        WHERE ${eq(agentSessions.id, admission.sessionId)}
        FOR UPDATE OF ${agentSessions}
      )
      SELECT
        (SELECT locked_resource."id" FROM locked_resource) AS "resourceId",
        (
          SELECT locked_resource."userId" FROM locked_resource
        ) AS "resourceUserId",
        (
          SELECT locked_resource."orgId" FROM locked_resource
        ) AS "resourceOrgId",
        (SELECT locked_run."id" FROM locked_run) AS "runId",
        (SELECT locked_run."userId" FROM locked_run) AS "runUserId",
        (SELECT locked_run."orgId" FROM locked_run) AS "runOrgId",
        (
          SELECT locked_run."sessionId" FROM locked_run
        ) AS "runSessionId",
        (SELECT locked_session."id" FROM locked_session) AS "sessionId",
        (
          SELECT locked_session."userId" FROM locked_session
        ) AS "sessionUserId",
        (
          SELECT locked_session."orgId" FROM locked_session
        ) AS "sessionOrgId",
        (
          SELECT locked_session."agentId" FROM locked_session
        ) AS "sessionAgentId"
    `,
    agentClaimAdmissionLockRowSchema,
  );
  if (!row) {
    throw new Error("Missing Agent claim admission lock result");
  }
  if (
    row.resourceId !== resource.id ||
    row.resourceUserId === null ||
    row.resourceOrgId === null ||
    !sameOwner(
      { userId: row.resourceUserId, orgId: row.resourceOrgId },
      resource,
    )
  ) {
    throw new ComputeOwnershipChangedError();
  }
  if (row.runId === null) {
    return false;
  }
  if (
    row.runId !== admission.runId ||
    row.runUserId === null ||
    row.runOrgId === null ||
    row.runSessionId !== admission.sessionId ||
    !sameOwner({ userId: row.runUserId, orgId: row.runOrgId }, admission.owner)
  ) {
    throw new ComputeOwnershipChangedError();
  }
  if (
    row.sessionId !== admission.sessionId ||
    row.sessionUserId === null ||
    row.sessionOrgId === null ||
    row.sessionAgentId !== admission.owner.agentId ||
    !sameOwner(
      { userId: row.sessionUserId, orgId: row.sessionOrgId },
      admission.sessionOwner,
    )
  ) {
    throw new ComputeOwnershipChangedError();
  }
  return true;
}

/**
 * Keep the final run/queue transition separate, but coalesce the ordinary
 * Agent resource -> pending run -> Session locked rereads into one statement.
 */
export async function prepareAgentClaimAdmission(
  tx: Tx,
  runId: string,
  expected: ComputeRunOwner & { readonly agentId: string },
): Promise<
  | {
      readonly admission: ComputeRunAdmission;
      readonly valid: boolean;
    }
  | undefined
> {
  const observed = await observeComputeRunAdmission(tx, runId, expected);
  const resource = observed?.resource;
  if (!observed || !resource || resource.kind !== "agent") {
    return undefined;
  }
  const agentResource = { ...resource, kind: "agent" as const };
  // Preserve the generic path's stale expected-owner outcome. The actual
  // resource is still locked before returning unavailable.
  if (
    expected.resourceOwner &&
    !sameOwner(agentResource, expected.resourceOwner)
  ) {
    await lockResource(tx, agentResource);
    return undefined;
  }
  return {
    admission: observed.admission,
    valid: await validateAgentClaimAdmission(tx, {
      ...observed,
      resource: agentResource,
    }),
  };
}

/** Keep existing thread -> run -> provider ordering; caller owns earlier locks. */
export async function validateComputeRunCleanupOwnership(
  tx: Tx,
  admission: ComputeRunAdmission,
  requiredStatus?: RunStatus,
): Promise<boolean> {
  const [current] = await tx
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      sessionId: agentRuns.sessionId,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, admission.runId),
        requiredStatus === undefined
          ? undefined
          : eq(agentRuns.status, requiredStatus),
      ),
    )
    .for("update");
  // A stale claim must not lock a terminal run while waiting for its Session.
  // PostgreSQL rechecks this predicate if cancellation wins the row-lock race.
  if (!current && requiredStatus !== undefined) {
    return false;
  }
  if (
    !current ||
    !sameOwner(current, admission.owner) ||
    current.sessionId !== admission.sessionId
  ) {
    throw new ComputeOwnershipChangedError();
  }
  const [session] = await tx
    .select({
      userId: agentSessions.userId,
      orgId: agentSessions.orgId,
      agentId: agentSessions.agentId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, admission.sessionId))
    .for("update");
  if (
    !session ||
    !sameOwner(session, admission.sessionOwner) ||
    session.agentId !== admission.owner.agentId
  ) {
    throw new ComputeOwnershipChangedError();
  }
  return true;
}

export async function validateComputeRunAdmission(
  tx: Tx,
  admission: ComputeRunAdmission,
  requiredStatus?: RunStatus,
): Promise<boolean> {
  return (
    (await validateComputeRunCleanupOwnership(tx, admission, requiredStatus)) &&
    (admission.owner.agentId !== null ||
      (await lockPiMemoryPhase2MaintenanceCleanupProtection(tx, {
        runId: admission.runId,
        orgId: admission.owner.orgId,
        userId: admission.owner.userId,
      })))
  );
}

/** A selected closed candidate is stopped without deleting a cleanup/billing
 * locator or scheduling ordinary completion. Already running work is untouched.
 * In particular, retain creditAdmitted and canonical provider/account metadata.
 */
export async function stopClosedComputeCandidate(
  tx: Tx,
  admission: ComputeRunAdmission,
): Promise<void> {
  if (!admission.closed) {
    throw new Error("Closed compute disposition requires closure");
  }
  await stopErasureClosedComputeRun(tx, admission.runId);
}
