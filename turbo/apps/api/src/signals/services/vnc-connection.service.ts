import type {
  CreateVncConnectionRequest,
  UpdateVncConnectionRequest,
  VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { agents } from "@okouai/db/schema/agent";
import { agentVncAccess } from "@okouai/db/schema/agent-vnc-access";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, asc, count, eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import { visibleJoinedAgentCondition } from "./agent-data.service";
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
  credential: { readonly name: string },
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
  return {
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
    credentialId: row.credentialId,
    credentialName: credential.name,
    security: responseSecurity(row),
    generation: row.generation,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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

async function lockVisibleAgentsForFirstHost(
  tx: VncTransaction,
  owner: VncOwner,
): Promise<{ id: string }[]> {
  if ((await summarizeVncConnections(tx, owner)).configuredCount !== 0) {
    return [];
  }
  return await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, owner.orgId),
        visibleJoinedAgentCondition(owner.userId),
      ),
    )
    .orderBy(asc(agents.id))
    .for("update");
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
    .innerJoin(
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

async function grantFirstHostAccess(
  tx: VncTransaction,
  owner: VncOwner,
  visibleAgents: readonly { readonly id: string }[],
): Promise<void> {
  if (visibleAgents.length === 0) {
    return;
  }
  await tx
    .insert(agentVncAccess)
    .values(
      visibleAgents.map((agent) => {
        return { ...owner, agentId: agent.id };
      }),
    )
    .onConflictDoNothing();
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
  readonly currentCredentialId: string;
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
    (await findVncCredential(args.tx, args.owner, args.currentCredentialId));
  if (!credential) {
    throw new Error("VNC connection credential is missing");
  }
  return isVncProfileCompatible(credential.authMethod, args.securityType)
    ? { ok: true, value: credential }
    : vncFailure("profileMismatch");
}

export async function createVncConnection(args: {
  readonly db: Db;
  readonly owner: VncOwner;
  readonly body: CreateVncConnectionRequest;
  readonly featureContext: FeatureSwitchContext;
}): Promise<VncResult<VncConnectionResponse | undefined>> {
  const preflight = await inspectVncCreationId(
    args.db,
    args.owner,
    vncConnections,
    args.body.id,
  );
  if (!preflight.ok) {
    return preflight;
  }
  if (!preflight.value) {
    return { ok: true, value: undefined };
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
    "create" in args.body.credential &&
    !isVncProfileCompatible(
      args.body.credential.create.authentication.method,
      security.value.securityType,
    )
  ) {
    return vncFailure("profileMismatch");
  }
  const preparedCredential = await prepareVncCredentialSelection(
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
      const credential = await selectVncCredential(
        tx,
        owner,
        preparedCredential,
      );
      if (!credential.ok) {
        return credential;
      }
      if (
        !isVncProfileCompatible(
          credential.value.authMethod,
          security.value.securityType,
        )
      ) {
        return vncFailure("profileMismatch");
      }
      // Match SSH's zero-to-one host transition, including re-adding after all
      // hosts were deleted. enterVncWrite serializes concurrent owner writes.
      const visibleAgents = await lockVisibleAgentsForFirstHost(tx, owner);
      const [created] = await tx
        .insert(vncConnections)
        .values({
          ...owner,
          id: args.body.id,
          displayName: args.body.displayName,
          host: host.value,
          port: args.body.port,
          ...transport.value,
          credentialId: credential.value.id,
          authMethod: credential.value.authMethod,
          ...security.value,
        })
        .returning(metadata);
      if (!created) {
        throw new Error("VNC connection insert returned no row");
      }
      await grantFirstHostAccess(tx, owner, visibleAgents);
      return { ok: true as const, value: response(created, credential.value) };
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
  const preparedCredential =
    args.body.credential === undefined
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
    const credential = await selectUpdateVncCredential({
      tx,
      owner,
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
        credentialId: credential.value.id,
        authMethod: credential.value.authMethod,
        ...security?.value,
        generation: current.generation + 1,
        updatedAt: nowDate(),
      })
      .where(ownedConnection(owner, args.connectionId))
      .returning(metadata);
    if (!updated) {
      throw new Error("VNC connection update returned no row");
    }
    return { ok: true as const, value: response(updated, credential.value) };
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
