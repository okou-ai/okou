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
import {
  currentRunnerVncAuthority$,
  type CurrentVncAuthority,
} from "./runner-vnc-authority.service";
import {
  storedVncSecurity,
  storedVncOriginTls,
  hasProtectedVncRawRoute,
} from "./vnc-stored-route";
import {
  storedTransportSnapshot,
  storedKdcSnapshot,
  hasTransportAuthority,
  hasKdcAuthority,
  sameTransport,
  sameKdc,
  decryptVncRoleTransport,
  type TransportSnapshot,
  type ResolvedVncTransport,
  type ResolvedVncKdcTransport,
} from "./runner-vnc-transport";
import { isVncProfileCompatible } from "./vnc-configuration.utils";
import { parseStoredVncClientIdentity } from "./vnc-client-identity.service";
import { parseStoredVncKerberos } from "./vnc-kerberos.service";
import { nowDate } from "../../lib/time";
import {
  isVncKerberosMethod,
  sameKerberosPrincipal,
  type VncKerberosMethod,
} from "@okouai/api-contracts/contracts/vnc-kerberos";

function hasLiveKerberosTicket(
  row: CurrentVncAuthority,
  nowSeconds = Math.floor(nowDate().getTime() / 1000),
) {
  if (row.authMethod !== "qemu_kerberos_ticket") {
    return true;
  }
  if (row.kerberosDeclaredExpiresAt === null) {
    throw new Error("Missing stored VNC Kerberos ticket expiry");
  }
  return row.kerberosDeclaredExpiresAt > nowSeconds;
}

function hasValidRawProfileRoute(row: CurrentVncAuthority) {
  if (isVncRsaAesAuthenticationOnly(row.securityType)) {
    return hasProtectedVncRawRoute(row);
  }
  return (
    (row.securityType !== "apple_vnc_password" &&
      row.securityType !== "apple_dh" &&
      row.securityType !== "apple_srp" &&
      row.securityType !== "apple_rsa_srp") ||
    (row.trustMode === "none" &&
      row.caBundle === null &&
      row.x509ServerName === null &&
      hasProtectedVncRawRoute(row))
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
  if (
    isVncKerberosMethod(row.authMethod) &&
    (row.kerberosInitiator === null ||
      row.kerberosService === null ||
      row.credentialRevision === null ||
      row.kerberosInitiator.realm !== row.kerberosService.realm ||
      (row.authMethod === "qemu_kerberos_ticket" &&
        (row.kerberosCredentialService === null ||
          !sameKerberosPrincipal(
            row.kerberosCredentialService,
            row.kerberosService,
          ))))
  ) {
    throw new Error("VNC connection has an invalid Kerberos binding");
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
      profile.securityType === row.securityType &&
      (!isVncKerberosMethod(row.authMethod) ||
        profile.kdcTransportType ===
          (row.authMethod === "qemu_kerberos_ticket"
            ? "none"
            : row.kdcTransportType))
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
    currentTransport !== null &&
    hasTransportAuthority(current, currentTransport) &&
    hasKdcAuthority(current) &&
    sameKdc(current, initial) &&
    current.createdAt === initial.createdAt &&
    (!isVncKerberosMethod(initial.authMethod) ||
      current.credentialRevision === initial.credentialRevision) &&
    current.generation === initial.generation &&
    sameTransport(currentTransport, transport) &&
    (await hasCurrentVncMembership(clerk, current, signal)) &&
    hasLiveKerberosTicket(current)
  );
}

export const checkRunnerVnc$ = command(
  async (
    { get, set },
    input: RunnerVncCheckRequest & { readonly runId: string },
    signal: AbortSignal,
  ): Promise<
    | Exclude<RunnerVncCheckResponse, { outcome: "valid" }>
    | {
        readonly outcome: "valid";
        readonly owner: { readonly orgId: string; readonly userId: string };
      }
  > => {
    const clerk = get(clerk$);

    const row = await set(currentRunnerVncAuthority$, input, signal);
    if (!row || !(await hasCurrentVncMembership(clerk, row, signal))) {
      return { outcome: "unavailable" };
    }
    validateStoredProfile(row);
    const transport = storedTransportSnapshot(row);
    if (
      transport === null ||
      !hasTransportAuthority(row, transport) ||
      !hasKdcAuthority(row) ||
      !hasLiveKerberosTicket(row)
    ) {
      return { outcome: "unavailable" };
    }
    if (!hasValidRawProfileRoute(row)) {
      return { outcome: "unavailable" };
    }
    const matches =
      row.generation === input.expectedGeneration &&
      sameTransport(transport, input.expectedTransport) &&
      (!isVncKerberosMethod(row.authMethod) ||
        (row.credentialRevision === input.expectedCredentialRevision &&
          (row.authMethod === "qemu_kerberos_ticket"
            ? input.expectedKdcTransport === undefined
            : input.expectedKdcTransport !== undefined &&
              sameTransport(
                storedKdcSnapshot(row)!,
                input.expectedKdcTransport,
              ))));
    return matches
      ? {
          outcome: "valid" as const,
          owner: { orgId: row.orgId, userId: row.userId },
        }
      : { outcome: "configuration_changed" as const };
  },
);

function storedRunnerSecurity(
  row: CurrentVncAuthority,
  kdcTransport: ResolvedVncKdcTransport | null,
) {
  const stored = storedVncSecurity(row);
  const parsed = runnerVncSecuritySchema.safeParse({
    type: stored.type,
    ...("trust" in stored ? { trust: stored.trust } : {}),
    ...("serverKeySha256" in stored
      ? { serverKeySha256: stored.serverKeySha256 }
      : {}),
    ...(stored.type === "qemu_x509_gssapi"
      ? {
          service: stored.service,
          kdc:
            kdcTransport === null
              ? null
              : {
                  host: row.kdcHost,
                  port: row.kdcPort,
                  transport: kdcTransport,
                  ticketLifetimeSeconds: row.kerberosTicketLifetimeSeconds,
                  renewableLifetimeSeconds:
                    row.kerberosRenewableLifetimeSeconds,
                },
        }
      : {}),
  });
  if (!parsed.success) {
    throw new Error("VNC connection has an invalid stored security profile");
  }
  return parsed.data;
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

async function decryptKerberosAuthentication(
  row: CurrentVncAuthority,
  method: VncKerberosMethod,
  signal: AbortSignal,
) {
  if (
    row.encryptedKerberosCredential === null ||
    row.encryptedPassword !== null ||
    row.encryptedClientIdentity !== null
  ) {
    throw new Error("Invalid stored VNC Kerberos credential");
  }
  const decrypted = await settle(
    decryptStoredSecretValue(row.encryptedKerberosCredential),
    signal,
  );
  if (!decrypted.ok) {
    throw new Error("VNC credential decryption failed");
  }
  const nowSeconds = Math.floor(nowDate().getTime() / 1000);
  if (!hasLiveKerberosTicket(row, nowSeconds)) {
    return null;
  }
  const parsed = safeSync(() => {
    return parseStoredVncKerberos(
      {
        authMethod: method,
        kerberosInitiator: row.kerberosInitiator,
        kerberosService: row.kerberosCredentialService,
        kerberosDeclaredExpiresAt: row.kerberosDeclaredExpiresAt,
      },
      decrypted.value,
      nowSeconds,
    );
  });
  if (!("ok" in parsed)) {
    throw new Error("Invalid stored VNC Kerberos credential");
  }
  signal.throwIfAborted();
  return parsed.ok;
}

async function decryptRunnerAuthentication(
  row: CurrentVncAuthority,
  signal: AbortSignal,
) {
  const method = row.authMethod;
  if (isVncKerberosMethod(method)) {
    return decryptKerberosAuthentication(row, method, signal);
  }
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
  authentication: NonNullable<
    Awaited<ReturnType<typeof decryptRunnerAuthentication>>
  >,
): void {
  const rsaAuthentication =
    authentication.method === "rsa_aes_password" ||
    authentication.method === "rsa_aes_username_password";
  if (isVncRsaAesSecurityType(security.type) !== rsaAuthentication) {
    throw new Error("VNC handoff has an invalid stored RSA-AES profile");
  }
}

function resolvedKerberosResponse(
  row: CurrentVncAuthority,
  transport: ResolvedVncTransport,
  security: ReturnType<typeof storedRunnerSecurity>,
  authentication: NonNullable<
    Awaited<ReturnType<typeof decryptRunnerAuthentication>>
  >,
): RunnerVncResolveResponse {
  if (
    !isVncKerberosMethod(authentication.method) ||
    row.credentialRevision === null
  ) {
    throw new Error("Invalid stored VNC Kerberos handoff");
  }
  return {
    outcome: "resolved_kerberos",
    host: row.host,
    port: row.port,
    generation: row.generation,
    security,
    authentication,
    transport,
    credentialRevision: row.credentialRevision,
    serverName: row.x509ServerName ?? row.host,
  };
}

function resolvedRunnerResponse(
  row: CurrentVncAuthority,
  transport: ResolvedVncTransport,
  security: ReturnType<typeof storedRunnerSecurity>,
  authentication: NonNullable<
    Awaited<ReturnType<typeof decryptRunnerAuthentication>>
  >,
): RunnerVncResolveResponse {
  validateRsaAesHandoffPair(security, authentication);
  const resolved = {
    host: row.host,
    port: row.port,
    generation: row.generation,
    security,
    authentication,
  };
  if (security.type === "qemu_x509_gssapi") {
    return resolvedKerberosResponse(row, transport, security, authentication);
  }
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
      !hasProtectedVncRawRoute(row) ||
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
      !hasProtectedVncRawRoute(row) ||
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
      !hasProtectedVncRawRoute(row) ||
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
      !hasProtectedVncRawRoute(row) ||
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
  ): Promise<{
    readonly response: RunnerVncResolveResponse;
    readonly createdAt: string | null;
  }> => {
    const clerk = get(clerk$);

    const row = await set(currentRunnerVncAuthority$, input, signal);
    if (!row || !(await hasCurrentVncMembership(clerk, row, signal))) {
      return { response: { outcome: "unavailable" }, createdAt: null };
    }
    validateStoredProfile(row);
    const transport = storedTransportSnapshot(row);
    if (
      transport === null ||
      !hasTransportAuthority(row, transport) ||
      !hasKdcAuthority(row) ||
      !hasLiveKerberosTicket(row)
    ) {
      return { response: { outcome: "unavailable" }, createdAt: null };
    }
    const capability = selectedCapability(
      row,
      transport,
      input.supportedProfiles,
    );
    if (!capability) {
      return { response: { outcome: "unsupported_profile" }, createdAt: null };
    }
    // Validate non-secret metadata before any KMS work, including native KDC routes.
    storedVncSecurity(row);
    const authentication = await decryptRunnerAuthentication(row, signal);
    if (authentication === null) {
      return { response: { outcome: "unavailable" }, createdAt: null };
    }
    const rfbTransport = await decryptVncRoleTransport(
      row,
      "rfb",
      transport,
      signal,
    );
    const resolvedTransport: ResolvedVncTransport =
      rfbTransport.type === "cloudflare_access"
        ? { ...rfbTransport, originTls: storedVncOriginTls(row) }
        : rfbTransport;
    const kdc = storedKdcSnapshot(row);
    const kdcTransport =
      kdc === null
        ? null
        : await decryptVncRoleTransport(row, "kdc", kdc, signal);
    const security = storedRunnerSecurity(row, kdcTransport);
    const current = await set(currentRunnerVncAuthority$, input, signal);
    if (!(await isSameCurrentHandoff(current, row, transport, clerk, signal))) {
      return { response: { outcome: "unavailable" }, createdAt: null };
    }
    return {
      response: resolvedRunnerResponse(
        row,
        resolvedTransport,
        security,
        authentication,
      ),
      createdAt: row.createdAt,
    };
  },
);
