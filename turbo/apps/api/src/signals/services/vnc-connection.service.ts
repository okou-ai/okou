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
import { and, asc, count, eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import {
  canonicalizeVncHost,
  isVncProfileCompatible,
  prepareVncSecurity,
  prepareVncTransport,
  validateVncProfileRoute,
  vncFailure,
  type VncResult,
  type VncTransaction,
} from "./vnc-configuration.utils";
import {
  inspectVncCreationId,
  resolveVncCreationConflict,
} from "./vnc-creation.service";
import {
  findVncCredential,
  prepareVncCredentialSelection,
  selectVncCredential,
  validVncClientAuthentication,
} from "./vnc-credential.service";
import { enterVncWrite, type VncOwner } from "./vnc-owner-lifecycle.service";

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
  generation: vncConnections.generation,
  createdAt: vncConnections.createdAt,
  updatedAt: vncConnections.updatedAt,
});
type Metadata = Pick<typeof vncConnections.$inferSelect, keyof typeof metadata>;
type CredentialMetadata = NonNullable<
  Awaited<ReturnType<typeof findVncCredential>>
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

function validateStoredTrust(row: Metadata): void {
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

async function hasOwnedSshConnection(
  tx: VncTransaction,
  owner: VncOwner,
  connectionId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: sshConnections.id })
    .from(sshConnections)
    .where(
      and(
        eq(sshConnections.id, connectionId),
        eq(sshConnections.orgId, owner.orgId),
        eq(sshConnections.userId, owner.userId),
      ),
    )
    .limit(1)
    .for("key share");
  return row !== undefined;
}

async function hasReferencedSshConnection(
  tx: VncTransaction,
  owner: VncOwner,
  connectionId: string | null,
): Promise<boolean> {
  return (
    connectionId === null ||
    (await hasOwnedSshConnection(tx, owner, connectionId))
  );
}

export async function listVncConnections(
  db: ReadonlyDb,
  owner: VncOwner,
): Promise<VncConnectionResponse[]> {
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
  return rows.map(({ connection, credential }) => {
    return response(connection, credential);
  });
}

export async function summarizeVncConnections(
  db: ReadonlyDb,
  owner: VncOwner,
): Promise<{ readonly configuredCount: number }> {
  const [row] = await db
    .select({ configuredCount: count() })
    .from(vncConnections)
    .where(ownedConnections(owner));
  if (!row) {
    throw new Error("VNC connection count query returned no row");
  }
  return row;
}

async function selectUpdateVncCredential(args: {
  readonly tx: VncTransaction;
  readonly owner: VncOwner;
  readonly prepared: Awaited<
    ReturnType<typeof prepareVncCredentialSelection>
  > | null;
  readonly currentCredentialId: string | null;
  readonly securityType: Metadata["securityType"];
}): Promise<VncResult<CredentialMetadata>> {
  if (
    args.prepared?.create !== undefined &&
    !isVncProfileCompatible(args.prepared.create.authMethod, args.securityType)
  ) {
    return vncFailure("profileMismatch");
  }
  const selected =
    args.prepared === null
      ? undefined
      : await selectVncCredential(args.tx, args.owner, args.prepared);
  if (selected && !selected.ok) {
    return selected;
  }
  const credential =
    selected?.value ??
    (args.currentCredentialId === null
      ? null
      : await findVncCredential(args.tx, args.owner, args.currentCredentialId));
  if (!credential) {
    return vncFailure("profileMismatch");
  }
  return isVncProfileCompatible(credential.authMethod, args.securityType)
    ? { ok: true, value: credential }
    : vncFailure("profileMismatch");
}

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

function validInlineVncIdentity(
  credential: CreateVncConnectionRequest["credential"],
): boolean {
  return (
    !("create" in credential) ||
    validVncClientAuthentication(credential.create.authentication)
  );
}

async function preflightVncConnectionCreation(args: {
  readonly db: Db;
  readonly owner: VncOwner;
  readonly id: string;
}): Promise<VncResult<undefined> | null> {
  const inspected = await inspectVncCreationId(
    args.db,
    args.owner,
    vncConnections,
    args.id,
  );
  if (!inspected.ok) {
    return inspected;
  }
  return inspected.value ? null : { ok: true, value: undefined };
}

export async function createVncConnection(args: {
  readonly db: Db;
  readonly owner: VncOwner;
  readonly body: CreateVncConnectionRequest;
  readonly featureContext: FeatureSwitchContext;
}): Promise<VncResult<VncConnectionResponse | undefined>> {
  const preflight = await preflightVncConnectionCreation({
    db: args.db,
    owner: args.owner,
    id: args.body.id,
  });
  if (preflight !== null) {
    return preflight;
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
  if (!validInlineVncIdentity(args.body.credential)) {
    return vncFailure("invalidClientIdentity");
  }
  const preparedCredential =
    "type" in args.body.credential
      ? null
      : await prepareVncCredentialSelection(
          args.body.credential,
          args.featureContext,
        );
  const transaction = await settle(
    args.db.transaction(async (tx) => {
      await enterVncWrite(tx, args.owner);
      const owner = args.owner;
      const creation = await inspectVncCreationId(
        tx,
        owner,
        vncConnections,
        args.body.id,
      );
      if (!creation.ok) {
        return creation;
      }
      if (!creation.value) {
        return { ok: true as const, value: undefined };
      }
      if (
        !(await hasReferencedSshConnection(
          tx,
          owner,
          transport.value.sshConnectionId,
        ))
      ) {
        return vncFailure("sshConnectionNotFound");
      }
      const credential =
        preparedCredential === null
          ? null
          : await selectVncCredential(tx, owner, preparedCredential);
      if (credential !== null && !credential.ok) {
        return credential;
      }
      if (
        !validSelectedCredentialProfile(
          credential?.value ?? null,
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
          credentialId: credential?.value.id ?? null,
          authMethod: credential?.value.authMethod ?? "none",
          ...security.value,
        })
        .returning(metadata);
      if (!created) {
        throw new Error("VNC connection insert returned no row");
      }
      return {
        ok: true as const,
        value: response(created, credential?.value ?? null),
      };
    }),
  );
  if (!transaction.ok) {
    return resolveVncCreationConflict(
      args.db,
      args.owner,
      vncConnections,
      args.body.id,
      transaction.error,
    );
  }
  return transaction.value;
}

async function selectUpdatedProfileCredential(args: {
  readonly tx: VncTransaction;
  readonly owner: VncOwner;
  readonly requestedCredential: UpdateVncConnectionRequest["credential"];
  readonly prepared: Awaited<
    ReturnType<typeof prepareVncCredentialSelection>
  > | null;
  readonly currentCredentialId: string | null;
  readonly securityType: Metadata["securityType"];
}): Promise<VncResult<CredentialMetadata | null>> {
  if (
    args.requestedCredential !== undefined &&
    "type" in args.requestedCredential
  ) {
    return args.securityType === "x509_none"
      ? { ok: true, value: null }
      : vncFailure("profileMismatch");
  }
  if (
    args.currentCredentialId === null &&
    args.requestedCredential === undefined
  ) {
    return args.securityType === "x509_none"
      ? { ok: true, value: null }
      : vncFailure("profileMismatch");
  }
  return await selectUpdateVncCredential({
    tx: args.tx,
    owner: args.owner,
    prepared: args.prepared,
    currentCredentialId: args.currentCredentialId,
    securityType: args.securityType,
  });
}

function updatedVncTransport(
  current: Metadata,
  requested: UpdateVncConnectionRequest["transport"],
): NonNullable<UpdateVncConnectionRequest["transport"]> {
  return (
    requested ??
    (current.transportType === "ssh" && current.sshConnectionId !== null
      ? { type: "ssh", connectionId: current.sshConnectionId }
      : { type: "direct" })
  );
}

export async function updateVncConnection(args: {
  readonly db: Db;
  readonly owner: VncOwner;
  readonly connectionId: string;
  readonly body: UpdateVncConnectionRequest;
  readonly featureContext: FeatureSwitchContext;
}): Promise<VncResult<VncConnectionResponse>> {
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
  const [initial] = await args.db
    .select({ generation: vncConnections.generation })
    .from(vncConnections)
    .where(ownedConnection(args.owner, args.connectionId));
  if (!initial) {
    return vncFailure("connectionNotFound");
  }
  if (initial.generation !== args.body.expectedGeneration) {
    return vncFailure("generationConflict");
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
  return args.db.transaction(async (tx) => {
    await enterVncWrite(tx, args.owner);
    const owner = args.owner;
    const [current] = await tx
      .select(metadata)
      .from(vncConnections)
      .where(ownedConnection(owner, args.connectionId))
      .for("update");
    if (!current) {
      return vncFailure("connectionNotFound");
    }
    if (current.generation !== args.body.expectedGeneration) {
      return vncFailure("generationConflict");
    }
    if (current.generation === 2_147_483_647) {
      return vncFailure("exhausted");
    }
    const newHost = host?.value ?? current.host;
    const newPort = args.body.port ?? current.port;
    const requestedTransport = updatedVncTransport(
      current,
      args.body.transport,
    );
    const transport = prepareVncTransport(requestedTransport, newHost);
    if (!transport.ok) {
      return transport;
    }
    if (
      !(await hasReferencedSshConnection(
        tx,
        owner,
        transport.value.sshConnectionId,
      ))
    ) {
      return vncFailure("sshConnectionNotFound");
    }
    const securityType = security?.value.securityType ?? current.securityType;
    const route = validateVncProfileRoute(
      securityType,
      newHost,
      transport.value.transportType,
    );
    if (!route.ok) {
      return route;
    }
    const credential = await selectUpdatedProfileCredential({
      tx,
      owner,
      requestedCredential: args.body.credential,
      prepared: preparedCredential ?? null,
      currentCredentialId: current.credentialId,
      securityType,
    });
    if (!credential.ok) {
      return credential;
    }
    const [updated] = await tx
      .update(vncConnections)
      .set({
        displayName: args.body.displayName,
        host: newHost,
        port: newPort,
        ...transport.value,
        credentialId: credential.value?.id ?? null,
        authMethod: credential.value?.authMethod ?? "none",
        ...security?.value,
        generation: current.generation + 1,
        updatedAt: nowDate(),
      })
      .where(ownedConnection(owner, args.connectionId))
      .returning(metadata);
    if (!updated) {
      throw new Error("VNC connection update returned no row");
    }
    return {
      ok: true as const,
      value: response(updated, credential.value),
    };
  });
}

export function deleteVncConnection(args: {
  readonly db: Db;
  readonly owner: VncOwner;
  readonly connectionId: string;
  readonly expectedGeneration: number;
}): Promise<VncResult<undefined>> {
  return args.db.transaction(async (tx) => {
    await enterVncWrite(tx, args.owner);
    const owner = args.owner;
    const [current] = await tx
      .select({ generation: vncConnections.generation })
      .from(vncConnections)
      .where(ownedConnection(owner, args.connectionId))
      .for("update");
    if (!current) {
      return vncFailure("connectionNotFound");
    }
    if (current.generation !== args.expectedGeneration) {
      return vncFailure("generationConflict");
    }
    await tx
      .delete(vncConnections)
      .where(ownedConnection(owner, args.connectionId));
    return { ok: true as const, value: undefined };
  });
}
