import { randomUUID } from "node:crypto";
import type {
  RunnerVncAcquireRequest,
  RunnerVncAcquireResponse,
  RunnerVncCheckRequest,
  RunnerVncCheckResponse,
  RunnerVncReleaseResponse,
} from "@okouai/api-contracts/contracts/runner-vnc";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncControlLeases } from "@okouai/db/schema/vnc-control-lease";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../external/db";
import type { ClerkClient } from "../external/clerk";
import type { VncTransaction } from "./vnc-configuration.utils";
import {
  enterVncWrite,
  hasCurrentVncMembership,
} from "./vnc-owner-lifecycle.service";
import {
  currentRunnerVncAuthority,
  lockRunnerVncAuthority,
  matchesRunnerVncAuthority,
  type RunnerVncInput,
  type CurrentRunnerVncAuthority,
} from "./runner-vnc-authority.service";

type AcquireInput = RunnerVncAcquireRequest & { readonly runId: string };
type LeaseInput = RunnerVncCheckRequest & { readonly runId: string };
type Lease = typeof vncControlLeases.$inferSelect;
const unavailable = Object.freeze({ outcome: "unavailable" as const });
const changed = Object.freeze({ outcome: "configuration_changed" as const });
const expired = Object.freeze({ outcome: "expired" as const });

async function withLeaseAuthority<T>(
  db: Db,
  clerk: ClerkClient,
  input: AcquireInput | LeaseInput,
  operation: (tx: VncTransaction, row: CurrentRunnerVncAuthority) => Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof unavailable | typeof changed> {
  const initial = await currentRunnerVncAuthority(db, input, signal);
  if (!initial || !(await hasCurrentVncMembership(clerk, initial, signal))) {
    return unavailable;
  }
  if (!matchesRunnerVncAuthority(initial, input.authority)) {
    return changed;
  }
  const result = await db.transaction(async (tx) => {
    if (!(await enterVncWrite(tx, initial))) {
      return unavailable;
    }
    const row = await lockRunnerVncAuthority(tx, initial, input, signal);
    if (!row) {
      return unavailable;
    }
    if (!matchesRunnerVncAuthority(row, input.authority)) {
      return changed;
    }
    const result = await operation(tx, row);
    signal.throwIfAborted();
    return result;
  });
  // Cancellation after commit is ambiguous. The bounded reservation remains;
  // callers may retry their holder ID but must not assume control or replay input.
  signal.throwIfAborted();
  return result;
}

async function leaseState(tx: VncTransaction, connectionId: string) {
  const [lease] = await tx
    .select()
    .from(vncControlLeases)
    .where(eq(vncControlLeases.connectionId, connectionId));
  // Transaction-start now() would be stale after waiting for owner/parent locks.
  const [clock] = await tx
    .select({ now: sql`clock_timestamp()`.mapWith(vncControlLeases.expiresAt) })
    .from(vncConnections)
    .where(eq(vncConnections.id, connectionId));
  if (!clock) {
    throw new Error("VNC lease connection disappeared under lock");
  }
  return { lease, now: clock.now };
}

function sameProcess(lease: Lease, input: RunnerVncInput): boolean {
  return (
    lease.runId === input.runId &&
    lease.runnerId === input.runnerIdentity.runnerId &&
    lease.heartbeatGeneration === input.runnerIdentity.heartbeatGeneration
  );
}

function leaseTiming(lease: Lease, now: Date) {
  return {
    leaseToken: lease.leaseToken,
    serverTime: now.toISOString(),
    expiresAt: lease.expiresAt.toISOString(),
    validForMs: Math.min(
      30_000,
      Math.max(0, lease.expiresAt.getTime() - now.getTime()),
    ),
    renewAfterMs: 10_000 as const,
  };
}

export function acquireRunnerVnc(
  db: Db,
  clerk: ClerkClient,
  input: AcquireInput,
  signal: AbortSignal,
): Promise<RunnerVncAcquireResponse> {
  return withLeaseAuthority(
    db,
    clerk,
    input,
    async (tx, row) => {
      const { lease, now } = await leaseState(tx, row.id);
      const exactHolder =
        lease &&
        sameProcess(lease, input) &&
        lease.holderId === input.holderId &&
        matchesRunnerVncAuthority(lease, input.authority);
      if (lease && lease.expiresAt.getTime() > now.getTime()) {
        return exactHolder
          ? { outcome: "acquired" as const, ...leaseTiming(lease, now) }
          : { outcome: "busy" as const };
      }
      if (exactHolder) {
        return expired;
      }
      const values = {
        connectionId: row.id,
        ...input.authority,
        holderId: input.holderId,
        leaseToken: randomUUID(),
        runId: input.runId,
        runnerId: input.runnerIdentity.runnerId,
        heartbeatGeneration: input.runnerIdentity.heartbeatGeneration,
        expiresAt: new Date(now.getTime() + 30_000),
      };
      await tx.insert(vncControlLeases).values(values).onConflictDoUpdate({
        target: vncControlLeases.connectionId,
        set: values,
      });
      return { outcome: "acquired" as const, ...leaseTiming(values, now) };
    },
    signal,
  );
}

function holdsLease(
  lease: Lease | undefined,
  input: LeaseInput,
  now: Date,
): lease is Lease {
  return (
    lease !== undefined &&
    lease.expiresAt.getTime() > now.getTime() &&
    lease.leaseToken === input.leaseToken &&
    sameProcess(lease, input) &&
    matchesRunnerVncAuthority(lease, input.authority)
  );
}

export function checkRunnerVnc(
  db: Db,
  clerk: ClerkClient,
  input: LeaseInput,
  renew: boolean,
  signal: AbortSignal,
): Promise<RunnerVncCheckResponse> {
  return withLeaseAuthority(
    db,
    clerk,
    input,
    async (tx, row) => {
      const { lease, now } = await leaseState(tx, row.id);
      if (!holdsLease(lease, input, now)) {
        return expired;
      }
      if (!renew) {
        return { outcome: "valid" as const, ...leaseTiming(lease, now) };
      }
      const renewed = { ...lease, expiresAt: new Date(now.getTime() + 30_000) };
      await tx
        .update(vncControlLeases)
        .set({ expiresAt: renewed.expiresAt })
        .where(eq(vncControlLeases.connectionId, row.id));
      return { outcome: "valid" as const, ...leaseTiming(renewed, now) };
    },
    signal,
  );
}

export async function releaseRunnerVnc(
  db: Db,
  clerk: ClerkClient,
  input: LeaseInput,
  signal: AbortSignal,
): Promise<RunnerVncReleaseResponse> {
  const result = await withLeaseAuthority(
    db,
    clerk,
    input,
    async (tx, row) => {
      const { lease, now } = await leaseState(tx, row.id);
      if (!holdsLease(lease, input, now)) {
        return expired;
      }
      await tx
        .update(vncControlLeases)
        .set({ expiresAt: now })
        .where(eq(vncControlLeases.connectionId, row.id));
      return { outcome: "released" as const };
    },
    signal,
  );
  return result.outcome === "configuration_changed" ? unavailable : result;
}
