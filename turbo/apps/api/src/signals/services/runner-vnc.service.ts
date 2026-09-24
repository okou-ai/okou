import {
  runnerVncSecuritySchema,
  type RunnerVncCheckRequest,
  type RunnerVncCheckResponse,
  type RunnerVncResolveRequest,
  type RunnerVncResolveResponse,
} from "@okouai/api-contracts/contracts/runner-vnc";
import { vncAuthenticationSchema } from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  assertErasureSubjectReadable,
  assertErasureSubjectWritable,
} from "@okouai/db/operations/account-erasure";
import type { Db } from "../external/db";
import type { ClerkClient } from "../external/clerk";
import { decryptStoredSecretValue } from "./crypto.utils";
import { settle } from "../utils";
import { hasCurrentVncMembership } from "./vnc-owner-lifecycle.service";
import { currentRunnerVncAuthority } from "./runner-vnc-authority.service";
import { isVncProfileCompatible } from "./vnc-configuration.utils";

type CurrentVncAuthority = NonNullable<
  Awaited<ReturnType<typeof currentRunnerVncAuthority>>
>;

type TransportSnapshot =
  | { readonly type: "direct" }
  | {
      readonly type: "ssh";
      readonly connectionId: string;
      readonly generation: number;
    };

function storedTransportSnapshot(row: CurrentVncAuthority): TransportSnapshot {
  if (row.transportType === "direct") {
    if (row.sshConnectionId !== null || row.sshGeneration !== null) {
      throw new Error("Direct VNC connection has an invalid SSH reference");
    }
    return { type: "direct" };
  }
  if (row.sshConnectionId === null) {
    throw new Error("SSH VNC connection is missing its SSH reference");
  }
  if (row.sshGeneration === null) {
    throw new Error("SSH VNC connection references a missing SSH connection");
  }
  return {
    type: "ssh",
    connectionId: row.sshConnectionId,
    generation: row.sshGeneration,
  };
}

function hasTransportAuthority(
  row: CurrentVncAuthority,
  transport: TransportSnapshot,
) {
  return (
    transport.type === "direct" ||
    (row.threadMode ? row.sshAllowed : row.sshGrantAgentId !== null)
  );
}

function hasValidAppleRoute(
  row: CurrentVncAuthority,
  transport: TransportSnapshot,
) {
  return (
    (row.securityType !== "apple_dh" && row.securityType !== "apple_srp") ||
    (row.trustMode === "none" &&
      row.caBundle === null &&
      row.x509ServerName === null &&
      transport.type === "ssh" &&
      (row.host === "127.0.0.1" || row.host === "::1"))
  );
}

function sameTransport(left: TransportSnapshot, right: TransportSnapshot) {
  return (
    left.type === right.type &&
    (left.type === "direct" ||
      (right.type === "ssh" &&
        left.connectionId === right.connectionId &&
        left.generation === right.generation))
  );
}

function matchesExpectedTransport(
  current: TransportSnapshot,
  expected: RunnerVncCheckRequest["expectedTransport"],
) {
  if (current.type === "direct") {
    // Old Runner -> new API: pre-transport Runners omit this snapshot. Remove
    // omission support after the replacement fleet and its two-hour Runs have
    // drained; #35894 owns that rollout evidence and retirement gate.
    return expected === undefined || expected.type === "direct";
  }
  return (
    expected?.type === "ssh" &&
    expected.connectionId === current.connectionId &&
    expected.generation === current.generation
  );
}

function selectedCapability(
  row: CurrentVncAuthority,
  transport: TransportSnapshot,
  profiles: RunnerVncResolveRequest["supportedProfiles"],
) {
  const matchesProfile = (
    profile: RunnerVncResolveRequest["supportedProfiles"][number],
  ) => {
    return (
      profile.authMethod === row.authMethod &&
      profile.securityType === row.securityType
    );
  };
  const explicit = profiles.find((profile) => {
    return matchesProfile(profile) && profile.transportType === transport.type;
  });
  if (explicit || transport.type === "ssh") {
    return explicit;
  }
  // Old Runner -> new API: pre-transport Runners advertise only the profile
  // pair. Remove this legacy direct selection and response after the replacement
  // fleet and its two-hour Runs have drained; #35894 owns the retirement gate.
  return profiles.find((profile) => {
    return matchesProfile(profile) && profile.transportType === undefined;
  });
}

async function isSameCurrentHandoff(
  current: Awaited<ReturnType<typeof currentRunnerVncAuthority>>,
  initial: CurrentVncAuthority,
  transport: TransportSnapshot,
  clerk: ClerkClient,
  signal: AbortSignal,
) {
  if (!current) {
    return false;
  }
  const currentTransport = storedTransportSnapshot(current);
  return (
    hasTransportAuthority(current, currentTransport) &&
    current.generation === initial.generation &&
    sameTransport(currentTransport, transport) &&
    (await hasCurrentVncMembership(clerk, current, signal))
  );
}

export async function checkRunnerVnc(
  db: Db,
  clerk: ClerkClient,
  input: RunnerVncCheckRequest & { readonly runId: string },
  signal: AbortSignal,
): Promise<RunnerVncCheckResponse> {
  const row = await currentRunnerVncAuthority(db, input, signal);
  if (!row || !(await hasCurrentVncMembership(clerk, row, signal))) {
    return { outcome: "unavailable" };
  }
  if (!isVncProfileCompatible(row.authMethod, row.securityType)) {
    throw new Error("VNC connection has an invalid stored profile");
  }
  const transport = storedTransportSnapshot(row);
  if (!hasTransportAuthority(row, transport)) {
    return { outcome: "unavailable" };
  }
  if (!hasValidAppleRoute(row, transport)) {
    return { outcome: "unavailable" };
  }
  const admission = await settle(
    db.transaction(async (tx) => {
      await assertErasureSubjectReadable(tx, [
        { subjectKind: "user", subjectId: row.userId },
        { subjectKind: "organization", subjectId: row.orgId },
      ]);
    }),
    signal,
  );
  if (!admission.ok) {
    if (
      admission.error instanceof Error &&
      admission.error.message === "account_erasure:subject_closed"
    ) {
      return { outcome: "unavailable" };
    }
    throw admission.error;
  }
  return {
    outcome:
      row.generation === input.expectedGeneration &&
      matchesExpectedTransport(transport, input.expectedTransport)
        ? "valid"
        : "configuration_changed",
  };
}

function storedRunnerSecurity(
  row: CurrentVncAuthority,
  transport: TransportSnapshot,
) {
  if (
    !hasValidAppleRoute(row, transport) ||
    (row.securityType !== "apple_dh" &&
      row.securityType !== "apple_srp" &&
      ((row.trustMode === "system" && row.caBundle !== null) ||
        (row.trustMode === "custom_ca" && row.caBundle === null) ||
        row.trustMode === "none"))
  ) {
    throw new Error("VNC connection has an invalid stored trust configuration");
  }
  const security = runnerVncSecuritySchema.safeParse({
    type: row.securityType,
    ...(row.securityType === "apple_dh" || row.securityType === "apple_srp"
      ? {}
      : {
          trust:
            row.trustMode === "system"
              ? { mode: "system" }
              : { mode: row.trustMode, caBundle: row.caBundle },
        }),
  });
  if (!security.success) {
    throw new Error("VNC connection has an invalid stored security profile");
  }
  return security.data;
}

async function decryptRunnerAuthentication(
  row: CurrentVncAuthority,
  signal: AbortSignal,
) {
  // No database transaction or row lock spans KMS. Never log this value or its validation issues.
  const decrypted = await settle(
    decryptStoredSecretValue(row.encryptedPassword),
    signal,
  );
  if (!decrypted.ok) {
    // Provider errors can contain arbitrary content; retain the failure without
    // carrying a secret-bearing cause into the API's error observations.
    throw new Error("VNC credential decryption failed");
  }
  signal.throwIfAborted();
  const authentication = vncAuthenticationSchema.safeParse(
    row.authMethod === "username_password" ||
      row.authMethod === "apple_dh_username_password" ||
      row.authMethod === "apple_srp_username_password"
      ? {
          method: row.authMethod,
          username: row.username,
          password: decrypted.value,
        }
      : { method: row.authMethod, password: decrypted.value },
  );
  if (!authentication.success) {
    throw new Error(
      "VNC credential has an invalid stored authentication shape",
    );
  }
  return authentication.data;
}

export async function resolveRunnerVnc(
  db: Db,
  clerk: ClerkClient,
  input: RunnerVncResolveRequest & { readonly runId: string },
  signal: AbortSignal,
): Promise<RunnerVncResolveResponse> {
  const row = await currentRunnerVncAuthority(db, input, signal);
  if (!row || !(await hasCurrentVncMembership(clerk, row, signal))) {
    return { outcome: "unavailable" };
  }
  if (!isVncProfileCompatible(row.authMethod, row.securityType)) {
    throw new Error("VNC connection has an invalid stored profile");
  }
  const transport = storedTransportSnapshot(row);
  if (row.threadMode && !hasTransportAuthority(row, transport)) {
    return { outcome: "unavailable" };
  }
  const capability = selectedCapability(
    row,
    transport,
    input.supportedProfiles,
  );
  if (!capability) {
    return { outcome: "unsupported_profile" };
  }
  if (!row.threadMode && !hasTransportAuthority(row, transport)) {
    return { outcome: "unavailable" };
  }
  const security = storedRunnerSecurity(row, transport);
  const authentication = await decryptRunnerAuthentication(row, signal);
  const current = await currentRunnerVncAuthority(db, input, signal);
  if (!(await isSameCurrentHandoff(current, row, transport, clerk, signal))) {
    return { outcome: "unavailable" };
  }
  // KMS and Clerk membership reads are outside the D1 fence. A final scoped
  // admission and primary read prevent a late SSH/VNC secret handoff after a
  // committed account closure or a concurrently cancelled Run.
  const admitted = await db.transaction(async (tx) => {
    const result = await settle(
      assertErasureSubjectWritable(tx, [
        { subjectKind: "user", subjectId: row.userId },
        { subjectKind: "organization", subjectId: row.orgId },
      ]),
      signal,
    );
    if (!result.ok) {
      if (
        result.error instanceof Error &&
        result.error.message === "account_erasure:subject_closed"
      ) {
        return false;
      }
      throw result.error;
    }
    const latest = await currentRunnerVncAuthority(tx, input, signal);
    if (!latest) {
      return false;
    }
    const latestTransport = storedTransportSnapshot(latest);
    return (
      hasTransportAuthority(latest, latestTransport) &&
      latest.generation === row.generation &&
      latest.encryptedPassword === row.encryptedPassword &&
      latest.username === row.username &&
      latest.authMethod === row.authMethod &&
      latest.securityType === row.securityType &&
      latest.trustMode === row.trustMode &&
      latest.caBundle === row.caBundle &&
      latest.host === row.host &&
      latest.port === row.port &&
      sameTransport(latestTransport, transport)
    );
  });
  if (!admitted) {
    return { outcome: "unavailable" };
  }
  const resolved = {
    host: row.host,
    port: row.port,
    generation: row.generation,
    security,
    authentication,
  };
  if (row.securityType === "apple_dh") {
    if (
      transport.type !== "ssh" ||
      security.type !== "apple_dh" ||
      authentication.method !== "apple_dh_username_password"
    ) {
      throw new Error("VNC Apple DH handoff has an invalid stored profile");
    }
    return {
      outcome: "resolved_apple_dh",
      ...resolved,
      security,
      authentication,
      transport,
    };
  }
  if (row.securityType === "apple_srp") {
    if (
      transport.type !== "ssh" ||
      security.type !== "apple_srp" ||
      authentication.method !== "apple_srp_username_password"
    ) {
      throw new Error("VNC Apple SRP handoff has an invalid stored profile");
    }
    return {
      outcome: "resolved_apple_srp",
      ...resolved,
      security,
      authentication,
      transport,
    };
  }
  if (capability.transportType === undefined) {
    return { outcome: "resolved", ...resolved };
  }
  return {
    outcome: "resolved_transport",
    ...resolved,
    serverName: row.x509ServerName ?? row.host,
    transport,
  };
}
