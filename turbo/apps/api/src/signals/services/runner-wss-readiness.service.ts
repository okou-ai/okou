import { createHash, timingSafeEqual } from "node:crypto";

import { runnerWssEndpoints } from "@okouai/db/schema/runner-wss-endpoint";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { safeJsonParse } from "../utils";

// The host agent reprobes every few seconds. A dead listener expires without
// trusting the fleet heartbeat or a best-effort shutdown callback.
const LEASE_MS = 15_000;
const MAX_PROOF_AGE_MS = 10_000;
const hostSchema = z
  .object({
    id: z.uuid(),
    hostname: z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
    credentialSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
type Host = z.infer<typeof hostSchema>;

function configuredHosts(): readonly Host[] | null {
  const raw = env("OKOU_WSS_HOST_PROOFS");
  if (!raw) {
    return null;
  }
  const parsed = z.array(hostSchema).min(1).safeParse(safeJsonParse(raw));
  if (!parsed.success) {
    return null;
  }
  const hosts = parsed.data;
  for (const field of ["id", "hostname", "credentialSha256"] as const) {
    if (
      new Set(
        hosts.map((host) => {
          return host[field];
        }),
      ).size !== hosts.length
    ) {
      return null;
    }
  }
  return hosts;
}

/** Null means disabled/misconfigured; never fall back to Runner or PAT auth. */
export function authenticateWssHost(
  authorization: string | undefined,
):
  | { readonly status: "disabled" }
  | { readonly status: "unauthorized" }
  | { readonly status: "authorized"; readonly host: Host } {
  const hosts = configuredHosts();
  if (!hosts) {
    return { status: "disabled" };
  }
  const match = /^Bearer (okou_wss_host_[A-Za-z0-9_-]{43})$/.exec(
    authorization ?? "",
  );
  const token = match?.[1];
  if (!token) {
    return { status: "unauthorized" };
  }
  const digest = Buffer.from(createHash("sha256").update(token).digest("hex"));
  let matched: Host | undefined;
  for (const host of hosts) {
    if (timingSafeEqual(digest, Buffer.from(host.credentialSha256))) {
      matched = host;
    }
  }
  return matched
    ? { status: "authorized", host: matched }
    : { status: "unauthorized" };
}

export async function renewLocalWssEndpoint(
  db: Db,
  host: Host,
  runnerId: string,
  observedAt: string,
): Promise<
  | { readonly status: "ready"; readonly expiresAt: Date }
  | { readonly status: "invalid-proof" }
  | { readonly status: "host-conflict" }
> {
  const now = nowDate();
  const observed = new Date(observedAt);
  if (
    !Number.isFinite(observed.getTime()) ||
    observed.getTime() > now.getTime() ||
    now.getTime() - observed.getTime() > MAX_PROOF_AGE_MS
  ) {
    return { status: "invalid-proof" };
  }
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  return await db.transaction(async (transaction) => {
    const rows = await transaction
      .insert(runnerWssEndpoints)
      .values({
        runnerId,
        hostId: host.id,
        lastProbedAt: observed,
        leaseExpiresAt: expiresAt,
        withdrawnAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runnerWssEndpoints.runnerId,
        set: {
          lastProbedAt: observed,
          leaseExpiresAt: expiresAt,
          withdrawnAt: null,
          updatedAt: now,
        },
        setWhere: and(
          eq(runnerWssEndpoints.hostId, host.id),
          isNull(runnerWssEndpoints.quarantinedAt),
        ),
      })
      .returning({ runnerId: runnerWssEndpoints.runnerId });
    if (rows.length === 0) {
      // A copied ID makes *both* locations unusable. Never let the winner of
      // a race remain eligible for a ticket while the collision is unresolved.
      await transaction
        .update(runnerWssEndpoints)
        .set({ quarantinedAt: now, withdrawnAt: now, updatedAt: now })
        .where(eq(runnerWssEndpoints.runnerId, runnerId));
      return { status: "host-conflict" as const };
    }
    return { status: "ready" as const, expiresAt };
  });
}

export async function withdrawLocalWssEndpoint(
  db: Db,
  host: Host,
  runnerId: string,
): Promise<void> {
  const now = nowDate();
  await db
    .update(runnerWssEndpoints)
    .set({ withdrawnAt: now, updatedAt: now })
    .where(
      and(
        eq(runnerWssEndpoints.runnerId, runnerId),
        eq(runnerWssEndpoints.hostId, host.id),
      ),
    );
}

export async function resolveLocalWssEndpoint(
  db: Pick<Db, "select">,
  runnerId: string,
  now = nowDate(),
): Promise<{
  readonly runnerId: string;
  readonly hostId: string;
  readonly hostname: string;
  readonly leaseExpiresAt: Date;
  readonly publicIngressReady: false;
} | null> {
  const hosts = configuredHosts();
  if (!hosts) {
    return null;
  }
  const [endpoint] = await db
    .select({
      hostId: runnerWssEndpoints.hostId,
      leaseExpiresAt: runnerWssEndpoints.leaseExpiresAt,
    })
    .from(runnerWssEndpoints)
    .where(
      and(
        eq(runnerWssEndpoints.runnerId, runnerId),
        gt(runnerWssEndpoints.leaseExpiresAt, now),
        isNull(runnerWssEndpoints.withdrawnAt),
        isNull(runnerWssEndpoints.quarantinedAt),
      ),
    )
    .limit(1);
  if (!endpoint) {
    return null;
  }
  const host = hosts.find((entry) => {
    return entry.id === endpoint.hostId;
  });
  if (!host) {
    return null;
  }
  // This local probe does not assert browser-trusted TLS, DNS or Caddy reachability.
  return {
    runnerId,
    hostId: host.id,
    hostname: host.hostname,
    leaseExpiresAt: endpoint.leaseExpiresAt,
    publicIngressReady: false,
  };
}
