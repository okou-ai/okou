import { publishSshClientInvalidation } from "./ssh-client-invalidation.service";
import {
  sshHostKeySchema,
  type RunnerSshResolveRequest,
  type RunnerSshPinRequest,
  type RunnerSshPinResponse,
  runnerSshAccessResolvedSchema,
  type RunnerSshResolveResponse,
  type RunnerSshObservationRequest,
} from "@okouai/api-contracts/contracts/runner-ssh";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentSshAccess } from "@okouai/db/schema/agent-ssh-access";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshConnectionObservations } from "@okouai/db/schema/ssh-connection-observation";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { and, eq, lt, ne, or, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { decryptStoredSecretValue } from "./crypto.utils";

type SshResolveInput = RunnerSshResolveRequest & {
  readonly runId: string;
};
type SshPinInput = RunnerSshPinRequest & {
  readonly runId: string;
};
const unavailable = Object.freeze({ outcome: "unavailable" as const });

function currentConnectionQuery(
  db: Pick<Db, "select">,
  input: SshResolveInput,
  lockAuthority: boolean,
) {
  const query = db
    .select({
      id: sshConnections.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      host: sshConnections.host,
      port: sshConnections.port,
      username: sshCredentials.username,
      authMethod: sshCredentials.authMethod,
      encryptedPassword: sshCredentials.encryptedPassword,
      generation: sshConnections.generation,
      algorithm: sshConnections.learnedHostKeyAlgorithm,
      fingerprint: sshConnections.learnedHostKeyFingerprint,
      encryptedPrivateKey: sshCredentials.encryptedPrivateKey,
      encryptedPassphrase: sshCredentials.encryptedPassphrase,
      accessId: sshConnections.cloudflareAccessId,
      access: {
        id: cloudflareAccessConfigs.id,
        generation: cloudflareAccessConfigs.generation,
        encryptedClientId: cloudflareAccessConfigs.encryptedClientId,
        encryptedClientSecret: cloudflareAccessConfigs.encryptedClientSecret,
      },
    })
    .from(agentRuns)
    .innerJoin(
      agentSessions,
      and(
        eq(agentSessions.id, agentRuns.sessionId),
        eq(agentSessions.orgId, agentRuns.orgId),
        eq(agentSessions.userId, agentRuns.userId),
      ),
    )
    .innerJoin(
      agents,
      and(
        eq(agents.id, agentSessions.agentId),
        eq(agents.orgId, agentRuns.orgId),
        or(eq(agents.visibility, "public"), eq(agents.owner, agentRuns.userId)),
      ),
    )
    .innerJoin(
      agentSshAccess,
      and(
        eq(agentSshAccess.agentId, agents.id),
        eq(agentSshAccess.orgId, agentRuns.orgId),
        eq(agentSshAccess.userId, agentRuns.userId),
      ),
    )
    .innerJoin(
      sshConnections,
      and(
        eq(sshConnections.id, input.connectionId),
        eq(sshConnections.orgId, agentRuns.orgId),
        eq(sshConnections.userId, agentRuns.userId),
      ),
    )
    .innerJoin(
      sshCredentials,
      and(
        eq(sshCredentials.id, sshConnections.credentialId),
        eq(sshCredentials.orgId, agentRuns.orgId),
        eq(sshCredentials.userId, agentRuns.userId),
      ),
    )
    .leftJoin(
      cloudflareAccessConfigs,
      and(
        eq(cloudflareAccessConfigs.id, sshConnections.cloudflareAccessId),
        eq(cloudflareAccessConfigs.orgId, agentRuns.orgId),
        eq(cloudflareAccessConfigs.userId, agentRuns.userId),
      ),
    )
    .where(
      and(
        eq(agentRuns.id, input.runId),
        eq(agentRuns.status, "running"),
        eq(agentRuns.runnerId, input.runnerIdentity.runnerId),
        eq(
          agentRuns.runnerHeartbeatGeneration,
          input.runnerIdentity.heartbeatGeneration,
        ),
      ),
    );
  return lockAuthority
    ? query.for("share", {
        of: [agentRuns, agentSessions, agents, agentSshAccess, sshCredentials],
      })
    : query;
}

async function currentConnection(
  db: Pick<Db, "select">,
  input: SshResolveInput,
  lockAuthority: boolean,
  signal: AbortSignal,
) {
  const [row] = await currentConnectionQuery(db, input, lockAuthority);
  signal.throwIfAborted();
  if (!row) {
    return null;
  }
  if (row.accessId === null) {
    return row;
  }
  // The FK makes a missing local config a broken invariant, not an external miss.
  if (row.access === null) {
    throw new Error("SSH Cloudflare Access configuration is missing");
  }
  if (lockAuthority) {
    // PostgreSQL cannot lock the nullable side of the outer join above. The
    // caller holds the host; lock its non-null protected configuration here.
    const [authority] = await db
      .select({ id: cloudflareAccessConfigs.id })
      .from(cloudflareAccessConfigs)
      .where(
        and(
          eq(cloudflareAccessConfigs.id, row.accessId),
          eq(cloudflareAccessConfigs.orgId, row.orgId),
          eq(cloudflareAccessConfigs.userId, row.userId),
          eq(cloudflareAccessConfigs.generation, row.access.generation),
        ),
      )
      .for("share");
    signal.throwIfAborted();
    if (!authority) {
      return null;
    }
  }
  return row;
}

function learnedHostKey(row: {
  readonly algorithm: string | null;
  readonly fingerprint: string | null;
}) {
  if (row.algorithm === null && row.fingerprint === null) {
    return null;
  }
  return sshHostKeySchema.parse({
    algorithm: row.algorithm,
    fingerprint: row.fingerprint,
  });
}

export async function resolveRunnerSsh(
  db: Pick<Db, "select">,
  input: SshResolveInput,
  signal: AbortSignal,
): Promise<RunnerSshResolveResponse> {
  const row = await currentConnection(db, input, false, signal);
  if (!row) {
    return unavailable;
  }
  const hostKey = learnedHostKey(row);
  // The joined snapshot is the authority handoff. Never hold DB locks across KMS.
  const common = {
    host: row.host,
    port: row.port,
    username: row.username,
    generation: row.generation,
    learnedHostKey: hostKey,
  };
  const access = row.accessId === null ? null : row.access;
  const accessCredentials =
    access === null
      ? null
      : {
          configId: access.id,
          generation: access.generation,
          clientId: await decryptStoredSecretValue(access.encryptedClientId),
          clientSecret: await decryptStoredSecretValue(
            access.encryptedClientSecret,
          ),
        };
  signal.throwIfAborted();
  if (row.authMethod === "password") {
    if (
      row.encryptedPassword === null ||
      row.encryptedPrivateKey !== null ||
      row.encryptedPassphrase !== null
    ) {
      throw new Error("SSH password credential has an invalid stored shape");
    }
    const password = await decryptStoredSecretValue(row.encryptedPassword);
    signal.throwIfAborted();
    if (accessCredentials) {
      return runnerSshAccessResolvedSchema.parse({
        outcome: "resolved_access",
        ...common,
        authentication: { method: "password", password },
        access: accessCredentials,
      });
    }
    return { outcome: "resolved_password", ...common, password };
  }
  if (row.encryptedPrivateKey === null || row.encryptedPassword !== null) {
    throw new Error("SSH private-key credential has an invalid stored shape");
  }
  const privateKey = await decryptStoredSecretValue(row.encryptedPrivateKey);
  signal.throwIfAborted();
  const passphrase =
    row.encryptedPassphrase === null
      ? null
      : await decryptStoredSecretValue(row.encryptedPassphrase);
  signal.throwIfAborted();
  if (accessCredentials) {
    return runnerSshAccessResolvedSchema.parse({
      outcome: "resolved_access",
      ...common,
      authentication: { method: "private_key", privateKey, passphrase },
      access: accessCredentials,
    });
  }
  return { outcome: "resolved", ...common, privateKey, passphrase };
}

export async function pinRunnerSsh(
  db: Db,
  input: SshPinInput,
  signal: AbortSignal,
): Promise<RunnerSshPinResponse> {
  const initial = await currentConnection(db, input, false, signal);
  if (!initial) {
    return unavailable;
  }
  const result = await db.transaction<RunnerSshPinResponse>(async (tx) => {
    // Same row as owner edit/reset, scoped only after non-locking authorization.
    const [locked] = await tx
      .select({ id: sshConnections.id })
      .from(sshConnections)
      .where(
        and(
          eq(sshConnections.id, initial.id),
          eq(sshConnections.orgId, initial.orgId),
          eq(sshConnections.userId, initial.userId),
        ),
      )
      .for("update");
    signal.throwIfAborted();
    if (!locked) {
      return unavailable;
    }
    const row = await currentConnection(tx, input, true, signal);
    if (!row) {
      return unavailable;
    }
    const existing = learnedHostKey(row);
    if (existing) {
      if (
        existing.algorithm !== input.observedHostKey.algorithm ||
        existing.fingerprint !== input.observedHostKey.fingerprint
      ) {
        return { outcome: "host_key_mismatch" };
      }
      return row.generation === input.expectedGeneration + 1
        ? { outcome: "matched", generation: row.generation }
        : { outcome: "configuration_changed" };
    }
    if (
      row.generation !== input.expectedGeneration ||
      row.generation === 2_147_483_647
    ) {
      return { outcome: "configuration_changed" };
    }
    await tx
      .update(sshConnections)
      .set({
        learnedHostKeyAlgorithm: input.observedHostKey.algorithm,
        learnedHostKeyFingerprint: input.observedHostKey.fingerprint,
        generation: sql`${sshConnections.generation} + 1`,
        updatedAt: nowDate(),
      })
      .where(eq(sshConnections.id, row.id));
    signal.throwIfAborted();
    return { outcome: "pinned", generation: row.generation + 1 };
  });
  if (result.outcome === "pinned") {
    await publishSshClientInvalidation({
      orgId: initial.orgId,
      userId: initial.userId,
    });
  }
  signal.throwIfAborted();
  return result;
}

export async function recordRunnerSshObservation(
  db: Db,
  input: RunnerSshObservationRequest & {
    readonly runId: string;
  },
  signal: AbortSignal,
): Promise<{ readonly outcome: "recorded" | "ignored" | "unavailable" }> {
  const initial = await currentConnection(db, input, false, signal);
  if (!initial) {
    return unavailable;
  }
  if (
    initial.accessId === null &&
    input.failureReason !== null &&
    input.failureReason.startsWith("access_")
  ) {
    return { outcome: "ignored" };
  }
  const observedAt = new Date(input.observedAt);
  // Fleet clocks need not be exact, but cannot poison future observation ordering.
  if (observedAt.getTime() > nowDate().getTime() + 60_000) {
    return { outcome: "ignored" };
  }
  const result = await db.transaction<{
    readonly outcome: "recorded" | "ignored" | "unavailable";
    readonly notify: boolean;
  }>(async (tx) => {
    const [locked] = await tx
      .select({ id: sshConnections.id })
      .from(sshConnections)
      .where(
        and(
          eq(sshConnections.id, initial.id),
          eq(sshConnections.orgId, initial.orgId),
          eq(sshConnections.userId, initial.userId),
        ),
      )
      .for("update");
    signal.throwIfAborted();
    if (!locked) {
      return { ...unavailable, notify: false };
    }
    const row = await currentConnection(tx, input, true, signal);
    if (!row) {
      return { ...unavailable, notify: false };
    }
    if (row.generation !== input.expectedGeneration) {
      return { outcome: "ignored", notify: false };
    }
    const [previous] = await tx
      .select({ failureReason: sshConnectionObservations.failureReason })
      .from(sshConnectionObservations)
      .where(
        and(
          eq(sshConnectionObservations.connectionId, row.id),
          eq(sshConnectionObservations.generation, row.generation),
        ),
      );
    const values = {
      connectionId: row.id,
      generation: row.generation,
      observedAt,
      failureReason: input.failureReason,
    };
    const [written] = await tx
      .insert(sshConnectionObservations)
      .values(values)
      .onConflictDoUpdate({
        target: sshConnectionObservations.connectionId,
        set: values,
        setWhere: or(
          ne(sshConnectionObservations.generation, row.generation),
          lt(sshConnectionObservations.observedAt, observedAt),
        ),
      })
      .returning({ connectionId: sshConnectionObservations.connectionId });
    signal.throwIfAborted();
    return {
      outcome: written ? "recorded" : "ignored",
      notify:
        Boolean(written) &&
        (input.failureReason !== null ||
          (previous !== undefined && previous.failureReason !== null)),
    };
  });
  if (result.notify) {
    await publishSshClientInvalidation({
      orgId: initial.orgId,
      userId: initial.userId,
    });
  }
  signal.throwIfAborted();
  return { outcome: result.outcome };
}
