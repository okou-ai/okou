import type {
  RunnerVncCheckRequest,
  RunnerVncCheckResponse,
  RunnerVncResolveRequest,
  RunnerVncResolveResponse,
} from "@okouai/api-contracts/contracts/runner-vnc";
import { vncAuthenticationSchema } from "@okouai/api-contracts/contracts/vnc-credentials";
import { vncSecuritySchema } from "@okouai/api-contracts/contracts/vnc-connections";
import type { Db } from "../external/db";
import type { ClerkClient } from "../external/clerk";
import { decryptStoredSecretValue } from "./crypto.utils";
import { settle } from "../utils";
import { hasCurrentVncMembership } from "./vnc-owner-lifecycle.service";
import { currentRunnerVncAuthority } from "./runner-vnc-authority.service";

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
  return {
    outcome:
      row.generation === input.expectedGeneration
        ? "valid"
        : "configuration_changed",
  };
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
  if (
    !input.supportedProfiles.some((profile) => {
      return (
        profile.authMethod === row.authMethod &&
        profile.securityType === row.securityType
      );
    })
  ) {
    return { outcome: "unsupported_profile" };
  }
  if (
    (row.trustMode === "system" && row.caBundle !== null) ||
    (row.trustMode === "custom_ca" && row.caBundle === null)
  ) {
    throw new Error("VNC connection has an invalid stored trust configuration");
  }
  const security = vncSecuritySchema.safeParse({
    type: row.securityType,
    trust:
      row.trustMode === "system"
        ? { mode: "system" }
        : { mode: row.trustMode, caBundle: row.caBundle },
  });
  if (!security.success) {
    throw new Error("VNC connection has an invalid stored security profile");
  }
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
  const authentication = vncAuthenticationSchema.safeParse({
    method: row.authMethod,
    password: decrypted.value,
  });
  if (!authentication.success) {
    throw new Error(
      "VNC credential has an invalid stored authentication shape",
    );
  }
  const current = await currentRunnerVncAuthority(db, input, signal);
  if (
    !current ||
    current.generation !== row.generation ||
    !(await hasCurrentVncMembership(clerk, current, signal))
  ) {
    return { outcome: "unavailable" };
  }
  return {
    outcome: "resolved",
    host: row.host,
    port: row.port,
    generation: row.generation,
    security: security.data,
    authentication: authentication.data,
  };
}
