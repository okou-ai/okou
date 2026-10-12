import { command, computed, type Computed } from "ccstate";
import { publishSshClientInvalidation } from "./ssh-client-invalidation.service";
import {
  sshHostKeySchema,
  type RunnerSshResolveRequest,
  type RunnerSshPinRequest,
  type RunnerSshPinResponse,
  runnerSshAccessResolvedSchema,
  type RunnerSshResolveResponse,
  type RunnerSshObservationRequest,
  runnerSshTailscaleResolvedSchema,
} from "@okouai/api-contracts/contracts/runner-ssh";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import {
  sshConnectionNeedsRebind,
  sshConnections,
} from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { and, eq, or } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { decryptStoredSecretValue } from "./crypto.utils";
import { commitRunnerSshPinAttempt$ } from "./runner-ssh-pin.service";
import { commitRunnerSshObservationAttempt$ } from "./runner-ssh-observation.service";
import { runThreadSshAccess } from "./run-thread-remote-access.service";

type SshResolveInput = RunnerSshResolveRequest & {
  readonly runId: string;
};
type SshPinInput = RunnerSshPinRequest & {
  readonly runId: string;
};
type SshObservationInput = RunnerSshObservationRequest & {
  readonly runId: string;
};
const unavailable = Object.freeze({ outcome: "unavailable" as const });

// Shared schema selections and predicates are pure data, never query executors.
const connectionFields = Object.freeze({
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
  transport: sshConnections.transport,
  accessId: sshConnections.cloudflareAccessId,
  tailscaleId: sshConnections.tailscaleId,
  tailscale: {
    id: tailscaleConfigs.id,
    generation: tailscaleConfigs.generation,
    tags: tailscaleConfigs.tags,
    encryptedClientId: tailscaleConfigs.encryptedClientId,
    encryptedClientSecret: tailscaleConfigs.encryptedClientSecret,
  },
  needsRebind: sshConnectionNeedsRebind,
  access: {
    id: cloudflareAccessConfigs.id,
    generation: cloudflareAccessConfigs.generation,
    encryptedClientId: cloudflareAccessConfigs.encryptedClientId,
    encryptedClientSecret: cloudflareAccessConfigs.encryptedClientSecret,
  },
});
const sessionAuthority = and(
  eq(agentSessions.id, agentRuns.sessionId),
  eq(agentSessions.orgId, agentRuns.orgId),
  eq(agentSessions.userId, agentRuns.userId),
);
const agentAuthority = and(
  eq(agents.id, agentSessions.agentId),
  eq(agents.orgId, agentRuns.orgId),
  or(eq(agents.visibility, "public"), eq(agents.owner, agentRuns.userId)),
);
const credentialAuthority = and(
  eq(sshCredentials.id, sshConnections.credentialId),
  eq(sshCredentials.orgId, agentRuns.orgId),
  eq(sshCredentials.userId, agentRuns.userId),
);
const cloudflareAuthority = and(
  eq(cloudflareAccessConfigs.id, sshConnections.cloudflareAccessId),
  eq(cloudflareAccessConfigs.orgId, agentRuns.orgId),
  or(
    eq(cloudflareAccessConfigs.scope, "organization"),
    and(
      eq(cloudflareAccessConfigs.scope, "personal"),
      eq(cloudflareAccessConfigs.userId, agentRuns.userId),
    ),
  ),
);
const tailscaleAuthority = and(
  eq(tailscaleConfigs.id, sshConnections.tailscaleId),
  eq(tailscaleConfigs.orgId, agentRuns.orgId),
  or(
    eq(tailscaleConfigs.scope, "organization"),
    and(
      eq(tailscaleConfigs.scope, "personal"),
      eq(tailscaleConfigs.userId, agentRuns.userId),
    ),
  ),
);
function connectionAuthority(input: SshResolveInput) {
  return and(
    eq(sshConnections.id, input.connectionId),
    eq(sshConnections.orgId, agentRuns.orgId),
    eq(sshConnections.userId, agentRuns.userId),
  );
}
function runAuthority(input: SshResolveInput) {
  return and(
    eq(agentRuns.id, input.runId),
    eq(agentRuns.status, "running"),
    eq(agentRuns.runnerId, input.runnerIdentity.runnerId),
    eq(
      agentRuns.runnerHeartbeatGeneration,
      input.runnerIdentity.heartbeatGeneration,
    ),
    runThreadSshAccess(),
  );
}

// Connect the request dependency once, before route commands execute. The
// joined snapshot is the JIT handoff; KMS never runs under authority locks.
export function createCurrentRunnerSshConnection(
  input$: Computed<Promise<SshResolveInput | null>>,
) {
  return computed(async (get) => {
    const input = await get(input$);
    if (!input) {
      return null;
    }
    const [row] = await get(db$)
      .select(connectionFields)
      .from(agentRuns)
      .innerJoin(agentSessions, sessionAuthority)
      .innerJoin(agents, agentAuthority)
      .innerJoin(sshConnections, connectionAuthority(input))
      .innerJoin(sshCredentials, credentialAuthority)
      .leftJoin(cloudflareAccessConfigs, cloudflareAuthority)
      .leftJoin(tailscaleConfigs, tailscaleAuthority)
      .where(runAuthority(input));
    return row ?? null;
  });
}
type Connection = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof createCurrentRunnerSshConnection>["read"]>
  >
>;

function availableConnection(row: Connection | null | undefined) {
  if (!row || row.needsRebind) {
    return null;
  }
  if (
    row.transport === "tailscale" &&
    (row.tailscale === null || row.tailscaleId === null)
  ) {
    throw new Error("SSH Tailscale configuration is missing");
  }
  if (
    row.transport === "cloudflare_access" &&
    (row.access === null || row.accessId === null)
  ) {
    throw new Error("SSH Cloudflare Access is missing");
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

// Decryption follows the request's cancellation, so this semantic handoff stays
// in a command. Its only input is the captured joined record, never a DB handle.
export const resolveRunnerSsh$ = command(
  async (
    _,
    selected: Connection | null,
    signal: AbortSignal,
  ): Promise<RunnerSshResolveResponse> => {
    signal.throwIfAborted();
    const row = availableConnection(selected);
    if (!row) {
      return unavailable;
    }
    const hostKey = learnedHostKey(row);
    const common = {
      host: row.host,
      port: row.port,
      username: row.username,
      generation: row.generation,
      learnedHostKey: hostKey,
    };
    const network = row.transport === "tailscale" ? row.tailscale : null;
    const tailscaleCredentials =
      network === null
        ? null
        : {
            configId: network.id,
            generation: network.generation,
            tags: network.tags,
            clientId: await decryptStoredSecretValue(network.encryptedClientId),
            clientSecret: await decryptStoredSecretValue(
              network.encryptedClientSecret,
            ),
          };
    signal.throwIfAborted();
    const access = row.transport === "cloudflare_access" ? row.access : null;
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
      if (tailscaleCredentials) {
        return runnerSshTailscaleResolvedSchema.parse({
          outcome: "resolved_tailscale",
          ...common,
          tailscale: tailscaleCredentials,
          authentication: { method: "password", password },
        });
      }
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
    if (tailscaleCredentials) {
      return runnerSshTailscaleResolvedSchema.parse({
        outcome: "resolved_tailscale",
        ...common,
        tailscale: tailscaleCredentials,
        authentication: { method: "private_key", privateKey, passphrase },
      });
    }
    if (accessCredentials) {
      return runnerSshAccessResolvedSchema.parse({
        outcome: "resolved_access",
        ...common,
        authentication: { method: "private_key", privateKey, passphrase },
        access: accessCredentials,
      });
    }
    return { outcome: "resolved", ...common, privateKey, passphrase };
  },
);

export const pinRunnerSsh$ = command(
  async (
    { set },
    args: { readonly input: SshPinInput; readonly initial: Connection | null },
    signal: AbortSignal,
  ): Promise<RunnerSshPinResponse> => {
    signal.throwIfAborted();
    const initial = availableConnection(args.initial);
    if (!initial) {
      return unavailable;
    }
    let attempt = await set(
      commitRunnerSshPinAttempt$,
      args.input,
      initial,
      signal,
    );
    if (attempt.retry) {
      // Drift gated off every effect. Only this known-unwritten case gets one
      // fresh statement; exceptions and uncertain effects are never replayed.
      attempt = await set(
        commitRunnerSshPinAttempt$,
        args.input,
        initial,
        signal,
      );
    }
    signal.throwIfAborted();
    if (attempt.result.outcome === "pinned") {
      await publishSshClientInvalidation({
        orgId: initial.orgId,
        userId: initial.userId,
      });
    }
    signal.throwIfAborted();
    return attempt.result;
  },
);

function observationTime(initial: Connection, input: SshObservationInput) {
  if (
    initial.accessId === null &&
    input.failureReason !== null &&
    input.failureReason.startsWith("access_")
  ) {
    return null;
  }
  const observedAt = new Date(input.observedAt);
  // Fleet clocks must not poison future observation ordering.
  return observedAt.getTime() > nowDate().getTime() + 60_000
    ? null
    : observedAt;
}

export const recordRunnerSshObservation$ = command(
  async (
    { set },
    args: {
      readonly input: SshObservationInput;
      readonly initial: Connection | null;
    },
    signal: AbortSignal,
  ): Promise<{ readonly outcome: "recorded" | "ignored" | "unavailable" }> => {
    signal.throwIfAborted();
    const initial = availableConnection(args.initial);
    if (!initial) {
      return unavailable;
    }
    const observedAt = observationTime(initial, args.input);
    if (!observedAt) {
      return { outcome: "ignored" };
    }
    let result = await set(
      commitRunnerSshObservationAttempt$,
      args.input,
      initial,
      observedAt,
      signal,
    );
    if (result.retry) {
      result = await set(
        commitRunnerSshObservationAttempt$,
        args.input,
        initial,
        observedAt,
        signal,
      );
    }
    signal.throwIfAborted();
    if (result.notify) {
      await publishSshClientInvalidation({
        orgId: initial.orgId,
        userId: initial.userId,
      });
    }
    signal.throwIfAborted();
    return { outcome: result.outcome };
  },
);
