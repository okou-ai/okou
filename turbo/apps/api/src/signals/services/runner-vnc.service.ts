import { command } from "ccstate";
import {
  runnerVncSecuritySchema,
  type RunnerVncCheckRequest,
  type RunnerVncCheckResponse,
  type RunnerVncResolveRequest,
  type RunnerVncResolveResponse,
} from "@okouai/api-contracts/contracts/runner-vnc";
import {
  vncLegacyAuthenticationSchema,
  vncQemuScramAuthenticationSchema,
  vncRsaAesAuthenticationSchema,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { clerk$, type ClerkClient } from "../external/clerk";
import {
  isVncRsaAesSecurityType,
  isVncRsaAesAuthenticationOnly,
} from "@okouai/api-contracts/contracts/vnc-rsa-aes";
import { decryptStoredSecretValue } from "./crypto.utils";
import { settle, safeSync } from "../utils";
import { hasCurrentVncMembership } from "./vnc-owner-lifecycle.service";
import { currentRunnerVncAuthority$ } from "./runner-vnc-authority.service";
import { isVncProfileCompatible } from "./vnc-configuration.utils";
import { parseStoredVncClientIdentity } from "./vnc-client-identity.service";

type CurrentVncAuthority = NonNullable<
  Awaited<ReturnType<(typeof currentRunnerVncAuthority$)["write"]>>
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
    (row.sshNeedsRebind === false && row.sshAllowed)
  );
}

function hasValidAppleRoute(
  row: CurrentVncAuthority,
  transport: TransportSnapshot,
) {
  if (isVncRsaAesAuthenticationOnly(row.securityType)) {
    return (
      transport.type === "ssh" &&
      (row.host === "127.0.0.1" || row.host === "::1")
    );
  }
  return (
    (row.securityType !== "apple_vnc_password" &&
      row.securityType !== "apple_dh" &&
      row.securityType !== "apple_srp" &&
      row.securityType !== "apple_rsa_srp") ||
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
    return expected.type === "direct";
  }
  return (
    expected.type === "ssh" &&
    expected.connectionId === current.connectionId &&
    expected.generation === current.generation
  );
}

function validateStoredProfile(row: CurrentVncAuthority): void {
  if (
    !isVncProfileCompatible(row.authMethod, row.securityType) ||
    (row.authMethod === "none"
      ? row.credentialId !== null || row.joinedCredentialId !== null
      : row.credentialId === null ||
        row.joinedCredentialId !== row.credentialId)
  ) {
    throw new Error("VNC connection has an invalid stored profile");
  }
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
  return profiles.find((profile) => {
    return matchesProfile(profile) && profile.transportType === transport.type;
  });
}

async function isSameCurrentHandoff(
  current: Awaited<ReturnType<(typeof currentRunnerVncAuthority$)["write"]>>,
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

export const checkRunnerVnc$ = command(
  async (
    { get, set },
    input: RunnerVncCheckRequest & { readonly runId: string },
    signal: AbortSignal,
  ): Promise<RunnerVncCheckResponse> => {
    const clerk = get(clerk$);

    const row = await set(currentRunnerVncAuthority$, input, signal);
    if (!row || !(await hasCurrentVncMembership(clerk, row, signal))) {
      return { outcome: "unavailable" };
    }
    validateStoredProfile(row);
    const transport = storedTransportSnapshot(row);
    if (!hasTransportAuthority(row, transport)) {
      return { outcome: "unavailable" };
    }
    if (!hasValidAppleRoute(row, transport)) {
      return { outcome: "unavailable" };
    }
    return {
      outcome:
        row.generation === input.expectedGeneration &&
        matchesExpectedTransport(transport, input.expectedTransport)
          ? "valid"
          : "configuration_changed",
    };
  },
);

function storedRsaServerKeyPin(
  row: CurrentVncAuthority,
  transport: TransportSnapshot,
): string {
  if (
    !hasValidAppleRoute(row, transport) ||
    row.trustMode !== "none" ||
    row.caBundle !== null ||
    row.x509ServerName !== null ||
    row.rsaServerKeySha256 === null ||
    !/^[a-f0-9]{64}$/u.test(row.rsaServerKeySha256)
  ) {
    throw new Error(
      "VNC connection has an invalid stored RSA trust configuration",
    );
  }
  return row.rsaServerKeySha256;
}

function storedRunnerSecurity(
  row: CurrentVncAuthority,
  transport: TransportSnapshot,
) {
  if (isVncRsaAesSecurityType(row.securityType)) {
    return {
      type: row.securityType,
      serverKeySha256: storedRsaServerKeyPin(row, transport),
    };
  }
  if (row.rsaServerKeySha256 !== null) {
    throw new Error("VNC connection has unexpected stored RSA trust");
  }
  if (
    !hasValidAppleRoute(row, transport) ||
    (row.securityType !== "apple_vnc_password" &&
      row.securityType !== "apple_dh" &&
      row.securityType !== "apple_srp" &&
      row.securityType !== "apple_rsa_srp" &&
      ((row.trustMode === "system" && row.caBundle !== null) ||
        (row.trustMode === "custom_ca" && row.caBundle === null) ||
        row.trustMode === "none"))
  ) {
    throw new Error("VNC connection has an invalid stored trust configuration");
  }
  const security = runnerVncSecuritySchema.safeParse({
    type: row.securityType,
    ...(row.securityType === "apple_vnc_password" ||
    row.securityType === "apple_dh" ||
    row.securityType === "apple_srp" ||
    row.securityType === "apple_rsa_srp"
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

function parseStoredPasswordAuthentication(
  row: CurrentVncAuthority,
  password: string,
) {
  if (
    row.authMethod === "rsa_aes_password" ||
    row.authMethod === "rsa_aes_username_password"
  ) {
    const parsed = vncRsaAesAuthenticationSchema.safeParse({
      method: row.authMethod,
      password,
      ...(row.authMethod === "rsa_aes_username_password"
        ? { username: row.username }
        : {}),
    });
    if (
      !parsed.success ||
      (row.authMethod === "rsa_aes_password" && row.username !== null)
    ) {
      throw new Error(
        "VNC credential has an invalid stored authentication shape",
      );
    }
    return parsed.data;
  }
  if (row.authMethod === "qemu_scram_sha256") {
    // Validate stored plaintext again after KMS, without reflecting secrets or
    // schema diagnostics into the private endpoint's error observations.
    const scram = vncQemuScramAuthenticationSchema.safeParse({
      method: row.authMethod,
      username: row.username,
      password,
    });
    if (!scram.success) {
      throw new Error(
        "VNC credential has an invalid stored authentication shape",
      );
    }
    return scram.data;
  }
  const authentication = vncLegacyAuthenticationSchema.safeParse(
    row.authMethod === "username_password" ||
      row.authMethod === "apple_dh_username_password" ||
      row.authMethod === "apple_srp_username_password" ||
      row.authMethod === "apple_rsa_srp_username_password"
      ? {
          method: row.authMethod,
          username: row.username,
          password,
        }
      : { method: row.authMethod, password },
  );
  if (!authentication.success) {
    throw new Error(
      "VNC credential has an invalid stored authentication shape",
    );
  }
  return authentication.data;
}

async function decryptRunnerAuthentication(
  row: CurrentVncAuthority,
  signal: AbortSignal,
) {
  if (row.authMethod === "none") {
    return { method: "none" as const };
  }
  if (
    row.authMethod === "client_certificate" ||
    row.authMethod === "client_certificate_vnc_password"
  ) {
    if (
      row.encryptedClientIdentity === null ||
      (row.authMethod === "client_certificate"
        ? row.encryptedPassword !== null
        : row.encryptedPassword === null)
    ) {
      throw new Error("VNC client certificate credential is missing");
    }
    // No database transaction or lock spans KMS; no KMS work before the exact capability check.
    const identity = await settle(
      decryptStoredSecretValue(row.encryptedClientIdentity),
      signal,
    );
    if (!identity.ok) {
      throw new Error("VNC client certificate decryption failed");
    }
    const parsed = safeSync(() => {
      return parseStoredVncClientIdentity(identity.value);
    });
    if (!("ok" in parsed)) {
      throw new Error("Invalid stored VNC client certificate identity");
    }
    const wire = parsed.ok;
    signal.throwIfAborted();
    if (row.authMethod === "client_certificate") {
      return { method: "client_certificate" as const, ...wire };
    }
    const password = await settle(
      decryptStoredSecretValue(row.encryptedPassword!),
      signal,
    );
    if (!password.ok) {
      throw new Error("VNC credential decryption failed");
    }
    signal.throwIfAborted();
    const valid = vncLegacyAuthenticationSchema.options[0]!.safeParse({
      method: "vnc_password",
      password: password.value,
    });
    if (!valid.success) {
      throw new Error(
        "VNC credential has an invalid stored authentication shape",
      );
    }
    return {
      method: "client_certificate_vnc_password" as const,
      ...wire,
      password: valid.data.password,
    };
  }
  if (row.encryptedPassword === null || row.encryptedClientIdentity !== null) {
    throw new Error("VNC connection credential is missing");
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
  return parseStoredPasswordAuthentication(row, decrypted.value);
}

function validateRsaAesHandoffPair(
  security: ReturnType<typeof storedRunnerSecurity>,
  authentication: Awaited<ReturnType<typeof decryptRunnerAuthentication>>,
): void {
  const rsaAuthentication =
    authentication.method === "rsa_aes_password" ||
    authentication.method === "rsa_aes_username_password";
  if (isVncRsaAesSecurityType(security.type) !== rsaAuthentication) {
    throw new Error("VNC handoff has an invalid stored RSA-AES profile");
  }
}

function resolvedRunnerResponse(
  row: CurrentVncAuthority,
  transport: TransportSnapshot,
  security: ReturnType<typeof storedRunnerSecurity>,
  authentication: Awaited<ReturnType<typeof decryptRunnerAuthentication>>,
): RunnerVncResolveResponse {
  validateRsaAesHandoffPair(security, authentication);
  const resolved = {
    host: row.host,
    port: row.port,
    generation: row.generation,
    security,
    authentication,
  };
  if (isVncRsaAesSecurityType(security.type)) {
    return {
      outcome: "resolved_rsa_aes",
      ...resolved,
      security,
      authentication,
      transport,
    };
  }
  if (row.securityType === "apple_vnc_password") {
    if (
      transport.type !== "ssh" ||
      security.type !== "apple_vnc_password" ||
      authentication.method !== "vnc_password"
    ) {
      throw new Error(
        "VNC Apple classic-password handoff has an invalid stored profile",
      );
    }
    return {
      outcome: "resolved_apple_vnc_password",
      ...resolved,
      security,
      authentication,
      transport,
    };
  }
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
  if (row.securityType === "apple_rsa_srp") {
    if (
      transport.type !== "ssh" ||
      security.type !== "apple_rsa_srp" ||
      authentication.method !== "apple_rsa_srp_username_password"
    ) {
      throw new Error(
        "VNC Apple RSA/SRP handoff has an invalid stored profile",
      );
    }
    return {
      outcome: "resolved_apple_rsa_srp",
      ...resolved,
      security,
      authentication,
      transport,
    };
  }
  return {
    outcome: "resolved_transport",
    ...resolved,
    serverName: row.x509ServerName ?? row.host,
    security,
    authentication,
    transport,
  };
}

export const resolveRunnerVnc$ = command(
  async (
    { get, set },
    input: RunnerVncResolveRequest & { readonly runId: string },
    signal: AbortSignal,
  ): Promise<RunnerVncResolveResponse> => {
    const clerk = get(clerk$);

    const row = await set(currentRunnerVncAuthority$, input, signal);
    if (!row || !(await hasCurrentVncMembership(clerk, row, signal))) {
      return { outcome: "unavailable" };
    }
    validateStoredProfile(row);
    const transport = storedTransportSnapshot(row);
    if (!hasTransportAuthority(row, transport)) {
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
    const security = storedRunnerSecurity(row, transport);
    const authentication = await decryptRunnerAuthentication(row, signal);
    const current = await set(currentRunnerVncAuthority$, input, signal);
    if (!(await isSameCurrentHandoff(current, row, transport, clerk, signal))) {
      return { outcome: "unavailable" };
    }
    return resolvedRunnerResponse(row, transport, security, authentication);
  },
);
