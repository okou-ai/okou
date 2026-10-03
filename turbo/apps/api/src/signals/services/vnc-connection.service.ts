import {
  vncConnectionResponseSchema,
  type CreateVncConnectionRequest,
  type UpdateVncConnectionRequest,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  canonicalizeVncHost,
  isVncProfileCompatible,
  prepareVncSecurity,
  prepareVncTransport,
  validateVncProfileRoute,
  vncFailure,
  type VncResult,
} from "./vnc-configuration.utils";
import {
  inspectVncCreationId$,
  resolveVncCreationConflict$,
} from "./vnc-creation.service";
import {
  prepareVncCredentialSelection,
  validVncClientAuthentication,
} from "./vnc-credential.service";
import type { VncOwner } from "./vnc-owner-lifecycle.service";
import { isVncRsaAesSecurityType } from "@okouai/api-contracts/contracts/vnc-rsa-aes";

const vncCredentialMetadata = Object.freeze({
  id: vncCredentials.id,
  name: vncCredentials.name,
  username: vncCredentials.username,
  authMethod: vncCredentials.authMethod,
  revision: vncCredentials.revision,
  createdAt: vncCredentials.createdAt,
  updatedAt: vncCredentials.updatedAt,
});

const metadata = Object.freeze({
  id: vncConnections.id,
  displayName: vncConnections.displayName,
  host: vncConnections.host,
  port: vncConnections.port,
  transportType: vncConnections.transportType,
  sshConnectionId: vncConnections.sshConnectionId,
  x509ServerName: vncConnections.x509ServerName,
  credentialId: vncConnections.credentialId,
  authMethod: vncConnections.authMethod,
  securityType: vncConnections.securityType,
  trustMode: vncConnections.trustMode,
  caBundle: vncConnections.caBundle,
  rsaServerKeySha256: vncConnections.rsaServerKeySha256,
  generation: vncConnections.generation,
  createdAt: vncConnections.createdAt,
  updatedAt: vncConnections.updatedAt,
});
type Metadata = Pick<typeof vncConnections.$inferSelect, keyof typeof metadata>;
type CredentialMetadata = Pick<
  typeof vncCredentials.$inferSelect,
  keyof typeof vncCredentialMetadata
>;

function ownedConnections(owner: VncOwner) {
  return and(
    eq(vncConnections.orgId, owner.orgId),
    eq(vncConnections.userId, owner.userId),
  );
}

function ownedConnection(owner: VncOwner, connectionId: string) {
  return and(ownedConnections(owner), eq(vncConnections.id, connectionId));
}

function validateStoredRsaTrust(row: Metadata): void {
  if (
    row.trustMode !== "none" ||
    row.caBundle !== null ||
    row.x509ServerName !== null ||
    row.rsaServerKeySha256 === null ||
    !/^[a-f0-9]{64}$/u.test(row.rsaServerKeySha256)
  ) {
    throw new Error("VNC connection has an invalid RSA trust configuration");
  }
}

function validateStoredTrust(row: Metadata): void {
  if (isVncRsaAesSecurityType(row.securityType)) {
    validateStoredRsaTrust(row);
    return;
  }
  if (row.rsaServerKeySha256 !== null) {
    throw new Error("VNC connection has unexpected RSA trust");
  }
  if (
    ((row.securityType === "apple_vnc_password" ||
      row.securityType === "apple_dh" ||
      row.securityType === "apple_srp" ||
      row.securityType === "apple_rsa_srp") &&
      (row.trustMode !== "none" ||
        row.caBundle !== null ||
        row.x509ServerName !== null)) ||
    (row.securityType !== "apple_vnc_password" &&
      row.securityType !== "apple_dh" &&
      row.securityType !== "apple_srp" &&
      row.securityType !== "apple_rsa_srp" &&
      ((row.trustMode === "system" && row.caBundle !== null) ||
        (row.trustMode === "custom_ca" && row.caBundle === null) ||
        row.trustMode === "none"))
  ) {
    throw new Error("VNC connection has an invalid trust configuration");
  }
}

function responseSecurity(row: Metadata): VncConnectionResponse["security"] {
  if (isVncRsaAesSecurityType(row.securityType)) {
    if (row.rsaServerKeySha256 === null) {
      throw new Error("VNC connection is missing RSA trust");
    }
    return { type: row.securityType, serverKeySha256: row.rsaServerKeySha256 };
  }
  const trust =
    row.trustMode === "custom_ca" && row.caBundle !== null
      ? ({ mode: "custom_ca", caBundle: row.caBundle } as const)
      : ({ mode: "system" } as const);
  if (
    row.securityType === "apple_vnc_password" ||
    row.securityType === "apple_dh" ||
    row.securityType === "apple_srp" ||
    row.securityType === "apple_rsa_srp"
  ) {
    return { type: row.securityType };
  }
  return {
    type: row.securityType,
    trust,
    ...(row.x509ServerName === null ? {} : { serverName: row.x509ServerName }),
  };
}

function response(
  row: Metadata,
  credential: { readonly name: string } | null,
): VncConnectionResponse {
  validateStoredTrust(row);
  if (!isVncProfileCompatible(row.authMethod, row.securityType)) {
    throw new Error("VNC connection has an invalid stored profile");
  }
  if (
    (row.transportType === "direct" && row.sshConnectionId !== null) ||
    (row.transportType === "ssh" && row.sshConnectionId === null)
  ) {
    throw new Error("VNC connection has an invalid stored transport");
  }
  const credentialless = row.authMethod === "none";
  if (credentialless !== (row.credentialId === null && credential === null)) {
    throw new Error(
      "VNC connection has an invalid stored credential reference",
    );
  }
  return vncConnectionResponseSchema.parse({
    ...(row.transportType === "ssh" && row.sshConnectionId !== null
      ? {
          transport: {
            type: "ssh" as const,
            connectionId: row.sshConnectionId,
          },
        }
      : {}),
    ...(row.authMethod === "rsa_aes_password" ||
    row.authMethod === "rsa_aes_username_password"
      ? { rsaAesAuthentication: row.authMethod }
      : {}),
    id: row.id,
    displayName: row.displayName,
    host: row.host,
    port: row.port,
    ...(credentialless
      ? { credential: { type: "none" } }
      : {
          credentialId: row.credentialId,
          credentialName: credential?.name,
          ...(row.authMethod === "client_certificate" ||
          row.authMethod === "client_certificate_vnc_password"
            ? { clientCertificateAuthentication: row.authMethod }
            : {}),
        }),
    security: responseSecurity(row),
    generation: row.generation,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export const listVncConnections$ = command(
  async (
    { set },
    owner: VncOwner,
    signal: AbortSignal,
  ): Promise<VncConnectionResponse[]> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        connection: metadata,
        credential: { name: vncCredentials.name },
      })
      .from(vncConnections)
      .leftJoin(
        vncCredentials,
        and(
          eq(vncCredentials.id, vncConnections.credentialId),
          eq(vncCredentials.orgId, vncConnections.orgId),
          eq(vncCredentials.userId, vncConnections.userId),
        ),
      )
      .where(ownedConnections(owner))
      .orderBy(asc(vncConnections.createdAt), asc(vncConnections.id));
    signal.throwIfAborted();
    return rows.map(({ connection, credential }) => {
      return response(connection, credential);
    });
  },
);

export const summarizeVncConnections$ = command(
  async (
    { set },
    owner: VncOwner,
    signal: AbortSignal,
  ): Promise<{ readonly configuredCount: number }> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({ configuredCount: count() })
      .from(vncConnections)
      .where(ownedConnections(owner));
    signal.throwIfAborted();
    if (!row) {
      throw new Error("VNC connection count query returned no row");
    }
    return row;
  },
);

function validCreateCredentialProfile(
  credential: CreateVncConnectionRequest["credential"],
  securityType: Metadata["securityType"],
): boolean {
  if ("type" in credential) {
    return securityType === "x509_none";
  }
  return (
    !("create" in credential) ||
    isVncProfileCompatible(
      credential.create.authentication.method,
      securityType,
    )
  );
}

function validSelectedCredentialProfile(
  credential: CredentialMetadata | null,
  securityType: Metadata["securityType"],
): boolean {
  return credential === null
    ? securityType === "x509_none"
    : isVncProfileCompatible(credential.authMethod, securityType);
}

function credentialDatabaseValues(credential: CredentialMetadata | null) {
  return {
    credentialId: credential?.id ?? null,
    authMethod: credential?.authMethod ?? ("none" as const),
  };
}

function validUpdatedCredentialProfile(
  currentCredentialId: string | null,
  credential: UpdateVncConnectionRequest["credential"],
  securityType: Metadata["securityType"],
) {
  if (credential !== undefined && "type" in credential) {
    return securityType === "x509_none";
  }
  return (
    credential !== undefined ||
    currentCredentialId !== null ||
    securityType === "x509_none"
  );
}

function ownedSshConnection(owner: VncOwner, sshConnectionId: string) {
  return and(
    eq(sshConnections.id, sshConnectionId),
    eq(sshConnections.orgId, owner.orgId),
    eq(sshConnections.userId, owner.userId),
  );
}

function ownedCredential(owner: VncOwner, credentialId: string) {
  return and(
    eq(vncCredentials.id, credentialId),
    eq(vncCredentials.orgId, owner.orgId),
    eq(vncCredentials.userId, owner.userId),
  );
}

interface CreateVncConnectionArgs {
  readonly owner: VncOwner;
  readonly body: CreateVncConnectionRequest;
  readonly featureContext: FeatureSwitchContext;
}

const prepareCreateVncConnection$ = command(
  async ({ set }, args: CreateVncConnectionArgs, signal: AbortSignal) => {
    const preflight = await set(
      inspectVncCreationId$,
      args.owner,
      "connection",
      args.body.id,
      signal,
    );
    signal.throwIfAborted();
    if (!preflight.ok) {
      return preflight;
    }
    if (!preflight.value) {
      return { ok: true as const, value: undefined };
    }
    const host = canonicalizeVncHost(args.body.host);
    if (!host.ok) {
      return host;
    }
    const security = prepareVncSecurity(args.body.security);
    if (!security.ok) {
      return security;
    }
    const transport = prepareVncTransport(args.body.transport, host.value);
    if (!transport.ok) {
      return transport;
    }
    const route = validateVncProfileRoute(
      security.value.securityType,
      host.value,
      transport.value.transportType,
    );
    if (!route.ok) {
      return route;
    }
    if (
      !validCreateCredentialProfile(
        args.body.credential,
        security.value.securityType,
      )
    ) {
      return vncFailure("profileMismatch");
    }
    if (
      "create" in args.body.credential &&
      !validVncClientAuthentication(args.body.credential.create.authentication)
    ) {
      return vncFailure("invalidClientIdentity");
    }
    const preparedCredential =
      "type" in args.body.credential
        ? null
        : await prepareVncCredentialSelection(
            args.body.credential,
            args.featureContext,
          );
    signal.throwIfAborted();
    return {
      ok: true as const,
      value: { host, security, transport, preparedCredential },
    };
  },
);

export const createVncConnection$ = command(
  async (
    { set },
    args: CreateVncConnectionArgs,
    signal: AbortSignal,
  ): Promise<VncResult<VncConnectionResponse | undefined>> => {
    const db = set(writeDb$);
    const prepared = await set(prepareCreateVncConnection$, args, signal);
    signal.throwIfAborted();
    if (!prepared.ok || prepared.value === undefined) {
      return prepared;
    }
    const { host, security, transport, preparedCredential } = prepared.value;
    const transaction = await settle(
      db.transaction(async (tx) => {
        const owner = args.owner;
        const [existing] = await tx
          .select({
            orgId: vncConnections.orgId,
            userId: vncConnections.userId,
          })
          .from(vncConnections)
          .where(eq(vncConnections.id, args.body.id));
        if (existing) {
          return existing.orgId === owner.orgId &&
            existing.userId === owner.userId
            ? { ok: true as const, value: undefined }
            : vncFailure("resourceIdConflict");
        }
        if (transport.value.sshConnectionId !== null) {
          const [ssh] = await tx
            .select({ id: sshConnections.id })
            .from(sshConnections)
            .where(ownedSshConnection(owner, transport.value.sshConnectionId));
          if (ssh === undefined) {
            return vncFailure("sshConnectionNotFound");
          }
        }
        let credential: CredentialMetadata | undefined | null = null;
        if (preparedCredential?.create !== undefined) {
          [credential] = await tx
            .insert(vncCredentials)
            .values({ ...owner, ...preparedCredential.create })
            .returning(vncCredentialMetadata);
        } else if (preparedCredential !== null) {
          [credential] = await tx
            .select(vncCredentialMetadata)
            .from(vncCredentials)
            .where(ownedCredential(owner, preparedCredential.id));
        }
        if (credential === undefined) {
          return vncFailure("credentialNotFound");
        }
        if (
          !validSelectedCredentialProfile(
            credential,
            security.value.securityType,
          )
        ) {
          return vncFailure("profileMismatch");
        }
        const [created] = await tx
          .insert(vncConnections)
          .values({
            ...owner,
            id: args.body.id,
            displayName: args.body.displayName,
            host: host.value,
            port: args.body.port,
            ...transport.value,
            ...credentialDatabaseValues(credential),
            ...security.value,
          })
          .returning(metadata);
        if (!created) {
          throw new Error("VNC connection insert returned no row");
        }
        return { ok: true as const, value: response(created, credential) };
      }),
    );
    signal.throwIfAborted();
    if (!transaction.ok) {
      const reference = referenceViolation(transaction.error);
      if (reference) {
        return vncFailure(reference);
      }
      return set(
        resolveVncCreationConflict$,
        {
          owner: args.owner,
          resource: "connection",
          id: args.body.id,
          error: transaction.error,
        },
        signal,
      );
    }
    return transaction.value;
  },
);

interface UpdateVncConnectionArgs {
  readonly owner: VncOwner;
  readonly connectionId: string;
  readonly body: UpdateVncConnectionRequest;
  readonly featureContext: FeatureSwitchContext;
}

const prepareUpdateVncConnection$ = command(
  async ({ set }, args: UpdateVncConnectionArgs, signal: AbortSignal) => {
    const db = set(writeDb$);
    const host =
      args.body.host === undefined
        ? undefined
        : canonicalizeVncHost(args.body.host);
    if (host !== undefined && !host.ok) {
      return host;
    }
    const security =
      args.body.security === undefined
        ? undefined
        : prepareVncSecurity(args.body.security);
    if (security !== undefined && !security.ok) {
      return security;
    }
    const [initial] = await db
      .select(metadata)
      .from(vncConnections)
      .where(ownedConnection(args.owner, args.connectionId));
    signal.throwIfAborted();
    if (!initial) {
      return vncFailure("connectionNotFound");
    }
    if (initial.generation !== args.body.expectedGeneration) {
      return vncFailure("generationConflict");
    }
    const prospective = resolveVncConnectionUpdate(
      initial,
      args,
      host,
      security,
      undefined,
    );
    if (!prospective.ok) {
      return prospective;
    }
    if (
      args.body.credential &&
      "create" in args.body.credential &&
      !isVncProfileCompatible(
        args.body.credential.create.authentication.method,
        prospective.value.securityType,
      )
    ) {
      return vncFailure("profileMismatch");
    }
    if (
      args.body.credential &&
      "create" in args.body.credential &&
      !validVncClientAuthentication(args.body.credential.create.authentication)
    ) {
      return vncFailure("invalidClientIdentity");
    }
    const preparedCredential =
      args.body.credential === undefined || "type" in args.body.credential
        ? undefined
        : await prepareVncCredentialSelection(
            args.body.credential,
            args.featureContext,
          );
    signal.throwIfAborted();
    return { ok: true as const, value: { host, security, preparedCredential } };
  },
);

function resolveVncConnectionUpdate(
  current: Metadata,
  args: UpdateVncConnectionArgs,
  host: ReturnType<typeof canonicalizeVncHost> | undefined,
  security: ReturnType<typeof prepareVncSecurity> | undefined,
  preparedCredential:
    | Awaited<ReturnType<typeof prepareVncCredentialSelection>>
    | undefined,
) {
  const newHost = (host?.ok ? host.value : undefined) ?? current.host;
  const newPort = args.body.port ?? current.port;
  const requestedTransport =
    args.body.transport ??
    (current.transportType === "ssh" && current.sshConnectionId !== null
      ? ({
          type: "ssh",
          connectionId: current.sshConnectionId,
        } as const)
      : ({ type: "direct" } as const));
  const transport = prepareVncTransport(requestedTransport, newHost);
  if (!transport.ok) {
    return transport;
  }
  const securityType =
    (security?.ok ? security.value : undefined)?.securityType ??
    current.securityType;
  const route = validateVncProfileRoute(
    securityType,
    newHost,
    transport.value.transportType,
  );
  if (!route.ok) {
    return route;
  }
  if (
    !validUpdatedCredentialProfile(
      current.credentialId,
      args.body.credential,
      securityType,
    )
  ) {
    return vncFailure("profileMismatch");
  }
  if (
    preparedCredential?.create !== undefined &&
    !isVncProfileCompatible(preparedCredential.create.authMethod, securityType)
  ) {
    return vncFailure("profileMismatch");
  }
  return {
    ok: true as const,
    value: { newHost, newPort, transport, securityType },
  };
}

/** A parent removed after the plain reads is caught by its RESTRICT key. */
function referenceViolation(
  error: unknown,
):
  | "sshConnectionNotFound"
  | "credentialNotFound"
  | "profileMismatch"
  | undefined {
  if (
    !isForeignKeyViolation(error) ||
    !(error instanceof Error) ||
    typeof error.cause !== "object" ||
    error.cause === null ||
    !("constraint" in error.cause)
  ) {
    return undefined;
  }
  switch (error.cause.constraint) {
    case "vnc_connections_ssh_owner_fk": {
      return "sshConnectionNotFound";
    }
    case "vnc_connections_credential_owner_fk": {
      return "credentialNotFound";
    }
    case "vnc_connections_credential_profile_fk": {
      return "profileMismatch";
    }
    default: {
      return undefined;
    }
  }
}

export const updateVncConnection$ = command(
  async (
    { set },
    args: UpdateVncConnectionArgs,
    signal: AbortSignal,
  ): Promise<VncResult<VncConnectionResponse>> => {
    const db = set(writeDb$);
    const prepared = await set(prepareUpdateVncConnection$, args, signal);
    signal.throwIfAborted();
    if (!prepared.ok) {
      return prepared;
    }
    const { host, security, preparedCredential } = prepared.value;
    const written = await settle(
      db.transaction(async (tx) => {
        const owner = args.owner;
        const [current] = await tx
          .select(metadata)
          .from(vncConnections)
          .where(ownedConnection(owner, args.connectionId));
        if (!current) {
          return vncFailure("connectionNotFound");
        }
        if (current.generation !== args.body.expectedGeneration) {
          return vncFailure("generationConflict");
        }
        if (current.generation === 2_147_483_647) {
          return vncFailure("exhausted");
        }
        const resolved = resolveVncConnectionUpdate(
          current,
          args,
          host,
          security,
          preparedCredential,
        );
        if (!resolved.ok) {
          return resolved;
        }
        const { newHost, newPort, transport, securityType } = resolved.value;
        if (transport.value.sshConnectionId !== null) {
          const [ssh] = await tx
            .select({ id: sshConnections.id })
            .from(sshConnections)
            .where(ownedSshConnection(owner, transport.value.sshConnectionId));
          if (ssh === undefined) {
            return vncFailure("sshConnectionNotFound");
          }
        }
        let credential: CredentialMetadata | undefined | null = null;
        if (preparedCredential?.create !== undefined) {
          [credential] = await tx
            .insert(vncCredentials)
            .values({ ...owner, ...preparedCredential.create })
            .returning(vncCredentialMetadata);
        } else if (securityType !== "x509_none") {
          const credentialId = preparedCredential?.id ?? current.credentialId;
          if (credentialId === null) {
            return vncFailure("credentialNotFound");
          }
          [credential] = await tx
            .select(vncCredentialMetadata)
            .from(vncCredentials)
            .where(ownedCredential(owner, credentialId));
        }
        if (credential === undefined) {
          return vncFailure("credentialNotFound");
        }
        if (!validSelectedCredentialProfile(credential, securityType)) {
          return vncFailure("profileMismatch");
        }
        const [updated] = await tx
          .update(vncConnections)
          .set({
            displayName: args.body.displayName,
            host: newHost,
            port: newPort,
            ...transport.value,
            ...credentialDatabaseValues(credential),
            ...security?.value,
            generation: sql`${vncConnections.generation} + 1`,
            updatedAt: nowDate(),
          })
          .where(ownedConnection(owner, args.connectionId))
          .returning(metadata);
        if (!updated) {
          throw new Error("VNC connection update returned no row");
        }
        return { ok: true as const, value: response(updated, credential) };
      }),
      signal,
    );
    if (written.ok) {
      return written.value;
    }
    const reference = referenceViolation(written.error);
    if (reference) {
      return vncFailure(reference);
    }
    throw written.error;
  },
);

export const deleteVncConnection$ = command(
  async (
    { set },
    args: {
      readonly owner: VncOwner;
      readonly connectionId: string;
      readonly expectedGeneration: number;
    },
    signal: AbortSignal,
  ): Promise<VncResult<undefined>> => {
    const db = set(writeDb$);
    const [current] = await db
      .select({ generation: vncConnections.generation })
      .from(vncConnections)
      .where(ownedConnection(args.owner, args.connectionId));
    signal.throwIfAborted();
    if (!current) {
      return vncFailure("connectionNotFound");
    }
    if (current.generation !== args.expectedGeneration) {
      return vncFailure("generationConflict");
    }
    await db
      .delete(vncConnections)
      .where(ownedConnection(args.owner, args.connectionId));
    signal.throwIfAborted();
    return { ok: true, value: undefined };
  },
);
