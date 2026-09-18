import {
  testVncAuthorityStateContract,
  type TestVncAuthorityStateAction,
} from "@okouai/api-contracts/contracts/test-vnc-authority-state";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { executeRawRows } from "../../lib/db-raw-rows";
import { testOverride } from "../../lib/singleton";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { createDeferredPromise } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

interface LockGate {
  holderPid: number | null;
  readonly released: ReturnType<typeof createDeferredPromise<void>>;
}

// Every gate belongs to an explicit unique test owner and closes on request abort.
const lockGates = testOverride(() => {
  return new Map<string, LockGate>();
});

function ownerCondition(body: TestVncAuthorityStateAction) {
  return and(
    eq(vncConnections.id, body.connectionId),
    eq(vncConnections.orgId, body.orgId),
    eq(vncConnections.userId, body.userId),
  );
}

async function connectionLock(
  db: Db,
  body: TestVncAuthorityStateAction,
  signal: AbortSignal,
) {
  const gates = lockGates.get();
  const key = JSON.stringify([body.orgId, body.userId, body.connectionId]);
  if (body.action === "hold-connection-lock") {
    if (gates.has(key)) {
      throw new Error("Owned VNC lock is already active");
    }
    const gate: LockGate = {
      holderPid: null,
      released: createDeferredPromise<void>(signal),
    };
    gates.set(key, gate);
    await db
      .transaction(async (tx) => {
        const [owned] = await tx
          .select({ id: vncConnections.id })
          .from(vncConnections)
          .where(ownerCondition(body))
          .for("update");
        if (!owned) {
          throw new Error("Missing owned VNC connection");
        }
        const [row] = await executeRawRows(
          tx,
          sql`SELECT pg_backend_pid() AS pid`,
          z.object({ pid: z.int() }),
        );
        if (!row) {
          throw new Error("Missing VNC lock holder");
        }
        gate.holderPid = row.pid;
        await gate.released.promise;
      })
      .finally(() => {
        gates.delete(key);
      });
    return { status: 200 as const, body: { ok: true as const } };
  }
  const gate = gates.get(key);
  if (body.action === "release-connection-lock") {
    if (!gate) {
      throw new Error("Missing owned VNC lock gate");
    }
    gate.released.resolve(undefined);
    return { status: 200 as const, body: { ok: true as const } };
  }
  if (!gate || gate.holderPid === null) {
    return {
      status: 200 as const,
      body: { ok: true as const, held: false, waiting: false },
    };
  }
  const [state] = await executeRawRows(
    db,
    sql`SELECT EXISTS (
    SELECT 1 FROM pg_stat_activity WHERE ${gate.holderPid} = ANY(pg_blocking_pids(pid))
  ) AS waiting`,
    z.object({ waiting: z.boolean() }),
  );
  if (!state) {
    throw new Error("Missing VNC lock state");
  }
  return {
    status: 200 as const,
    body: { ok: true as const, held: true, waiting: state.waiting },
  };
}

const action$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const body = await get(bodyResultOf(testVncAuthorityStateContract.action));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const db = set(writeDb$);
  return await connectionLock(db, body.data, signal);
});

export const testVncAuthorityStateRoutes: readonly RouteEntry[] = [
  { route: testVncAuthorityStateContract.action, handler: action$ },
];
