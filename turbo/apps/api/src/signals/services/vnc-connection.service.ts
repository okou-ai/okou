import type {
  CreateVncConnectionRequest,
  UpdateVncConnectionRequest,
  VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, asc, count, eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import {
  canonicalizeVncHost,
  prepareVncSecurity,
  vncFailure,
  type VncResult,
} from "./vnc-configuration.utils";
import {
  checkVncCreationId,
  inspectVncCreationId,
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
  credentialId: vncConnections.credentialId,
  securityType: vncConnections.securityType,
  trustMode: vncConnections.trustMode,
  caBundle: vncConnections.caBundle,
  generation: vncConnections.generation,
  createdAt: vncConnections.createdAt,
  updatedAt: vncConnections.updatedAt,
});
type Metadata = Pick<typeof vncConnections.$inferSelect, keyof typeof metadata>;

function ownedConnections(owner: VncOwner) {
  return and(
    eq(vncConnections.orgId, owner.orgId),
    eq(vncConnections.userId, owner.userId),
  );
}

function ownedConnection(owner: VncOwner, connectionId: string) {
  return and(ownedConnections(owner), eq(vncConnections.id, connectionId));
}

function response(
  row: Metadata,
  credential: { readonly name: string },
): VncConnectionResponse {
  if (
    (row.trustMode === "system" && row.caBundle !== null) ||
    (row.trustMode === "custom_ca" && row.caBundle === null)
  ) {
    throw new Error("VNC connection has an invalid trust configuration");
  }
  return {
    id: row.id,
    displayName: row.displayName,
    host: row.host,
    port: row.port,
    credentialId: row.credentialId,
    credentialName: credential.name,
    security: {
      type: row.securityType,
      trust:
        row.trustMode === "custom_ca" && row.caBundle !== null
          ? { mode: "custom_ca", caBundle: row.caBundle }
          : { mode: "system" },
    },
    generation: row.generation,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
  const preparedCredential = await prepareVncCredentialSelection(
    args.body.credential,
    args.featureContext,
  );
  return args.db.transaction(async (tx) => {
    if (!(await enterVncWrite(tx, args.owner))) {
      return vncFailure("ownerChanged");
    }
    const owner = args.owner;
    const creation = await checkVncCreationId(
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
    const credential = await selectVncCredential(tx, owner, preparedCredential);
    if (!credential.ok) {
      return credential;
    }
    const [created] = await tx
      .insert(vncConnections)
      .values({
        ...owner,
        id: args.body.id,
        displayName: args.body.displayName,
        host: host.value,
        port: args.body.port,
        credentialId: credential.value.id,
        ...security.value,
      })
      .returning(metadata);
    if (!created) {
      throw new Error("VNC connection insert returned no row");
    }
    return { ok: true as const, value: response(created, credential.value) };
  });
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
    if (!(await enterVncWrite(tx, args.owner))) {
      return vncFailure("ownerChanged");
    }
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
    const selected =
      preparedCredential === undefined
        ? undefined
        : await selectVncCredential(tx, owner, preparedCredential);
    if (selected && !selected.ok) {
      return selected;
    }
    const credential =
      selected?.value ??
      (await findVncCredential(tx, owner, current.credentialId));
    if (!credential) {
      throw new Error("VNC connection credential is missing");
    }
    const [updated] = await tx
      .update(vncConnections)
      .set({
        displayName: args.body.displayName,
        host: newHost,
        port: newPort,
        credentialId: credential.id,
        ...security?.value,
        generation: current.generation + 1,
        updatedAt: nowDate(),
      })
      .where(ownedConnection(owner, args.connectionId))
      .returning(metadata);
    if (!updated) {
      throw new Error("VNC connection update returned no row");
    }
    return { ok: true as const, value: response(updated, credential) };
  });
}

export function deleteVncConnection(args: {
  readonly db: Db;
  readonly owner: VncOwner;
  readonly connectionId: string;
  readonly expectedGeneration: number;
}): Promise<VncResult<undefined>> {
  return args.db.transaction(async (tx) => {
    if (!(await enterVncWrite(tx, args.owner))) {
      return vncFailure("ownerChanged");
    }
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
