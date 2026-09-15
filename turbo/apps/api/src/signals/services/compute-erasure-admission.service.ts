import {
  assertErasureSubjectWritable,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { storages } from "@okouai/db/schema/storage";
import { eq } from "drizzle-orm";

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
}

interface ResourceOwner extends Owner {
  readonly id: string;
  readonly kind: "agent" | "maintenance";
}

interface ComputeRunAdmission {
  readonly runId: string;
  readonly sessionId: string;
  readonly owner: ComputeRunOwner;
  readonly sessionOwner: Owner;
  readonly closed: boolean;
}

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
  const resource = await readResource(tx, identity, false);
  const [session] =
    args.existingSessionId === undefined
      ? []
      : await tx
          .select({
            userId: agentSessions.userId,
            orgId: agentSessions.orgId,
            agentId: agentSessions.agentId,
          })
          .from(agentSessions)
          .where(eq(agentSessions.id, args.existingSessionId));
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

export async function validateNewComputeSession(
  tx: Tx,
  args: ComputeRunOwner & { readonly existingSessionId: string | undefined },
): Promise<boolean> {
  if (args.existingSessionId === undefined) {
    return true;
  }
  const [session] = await tx
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

/** Resolve without business locks, then acquire the complete sorted B1 set. */
export async function prepareComputeRunAdmission(
  tx: Tx,
  runId: string,
  expected: ComputeRunOwner,
): Promise<ComputeRunAdmission | undefined> {
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
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
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
  const identity =
    owner.agentId !== null
      ? { kind: "agent" as const, id: owner.agentId }
      : maintenance
        ? { kind: "maintenance" as const, id: maintenance.id }
        : undefined;
  const resource = identity
    ? await readResource(tx, identity, false)
    : undefined;
  const allowed = await writable(tx, [
    owner,
    owner.sessionOwner,
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
  await lockResource(tx, resource);
  if (expected.resourceOwner && !sameOwner(resource, expected.resourceOwner)) {
    return undefined;
  }
  if (
    resource.kind === "maintenance" &&
    (!maintenance ||
      !sameOwner(maintenance, owner) ||
      !sameOwner(resource, owner))
  ) {
    return undefined;
  }
  return {
    runId,
    sessionId: owner.sessionId,
    owner,
    sessionOwner: owner.sessionOwner,
    closed: !allowed,
  };
}

/** Keep existing thread -> run -> provider ordering; caller owns earlier locks. */
export async function validateComputeRunAdmission(
  tx: Tx,
  admission: ComputeRunAdmission,
): Promise<boolean> {
  const [current] = await tx
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      sessionId: agentRuns.sessionId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, admission.runId))
    .for("update");
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
  return (
    session.agentId !== null ||
    (await lockPiMemoryPhase2MaintenanceCleanupProtection(tx, {
      runId: admission.runId,
      ...current,
    }))
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
