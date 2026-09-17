import type {
  CreateVncCredentialRequest,
  UpdateVncCredentialRequest,
  VncCredentialResponse,
  VncCredentialSelection,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, asc, eq, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { encryptStoredSecretValue } from "./crypto.utils";
import {
  vncFailure,
  type VncResult,
  type VncTransaction,
} from "./vnc-configuration.utils";
import {
  checkVncCreationId,
  inspectVncCreationId,
  recordVncCreationReceipt,
} from "./vnc-creation.service";
import {
  enterVncWrite,
  type VncAdmission,
  type VncOwner,
} from "./vnc-owner-lifecycle.service";

const metadata = Object.freeze({
  id: vncCredentials.id,
  name: vncCredentials.name,
  revision: vncCredentials.revision,
  createdAt: vncCredentials.createdAt,
  updatedAt: vncCredentials.updatedAt,
});
type Metadata = Pick<typeof vncCredentials.$inferSelect, keyof typeof metadata>;

function ownedCredential(owner: VncOwner, id: string) {
  return and(
    eq(vncCredentials.id, id),
    eq(vncCredentials.orgId, owner.orgId),
    eq(vncCredentials.userId, owner.userId),
    eq(vncCredentials.membershipId, owner.membershipId),
  );
}

function referencingConnections(owner: VncOwner, credentialId: string) {
  return and(
    eq(vncConnections.credentialId, credentialId),
    eq(vncConnections.orgId, owner.orgId),
    eq(vncConnections.userId, owner.userId),
    eq(vncConnections.membershipId, owner.membershipId),
  );
}

export async function findVncCredential(
  db: Pick<ReadonlyDb, "select">,
  owner: VncOwner,
  id: string,
): Promise<Metadata | undefined> {
  const [row] = await db
    .select(metadata)
    .from(vncCredentials)
    .where(ownedCredential(owner, id));
  return row;
}

function response(
  row: Metadata,
  hosts: VncCredentialResponse["hosts"],
): VncCredentialResponse {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hosts,
  };
}

export async function listVncCredentials(
  db: ReadonlyDb,
  owner: VncOwner,
): Promise<VncCredentialResponse[]> {
  const rows = await db
    .select({
      credential: metadata,
      host: { id: vncConnections.id, displayName: vncConnections.displayName },
    })
    .from(vncCredentials)
    .leftJoin(
      vncConnections,
      and(
        eq(vncConnections.credentialId, vncCredentials.id),
        eq(vncConnections.orgId, vncCredentials.orgId),
        eq(vncConnections.userId, vncCredentials.userId),
        eq(vncConnections.membershipId, vncCredentials.membershipId),
      ),
    )
    .where(
      and(
        eq(vncCredentials.orgId, owner.orgId),
        eq(vncCredentials.userId, owner.userId),
        eq(vncCredentials.membershipId, owner.membershipId),
      ),
    )
    .orderBy(
      asc(vncCredentials.createdAt),
      asc(vncCredentials.id),
      asc(vncConnections.id),
    );
  const values = new Map<string, VncCredentialResponse>();
  for (const row of rows) {
    let value = values.get(row.credential.id);
    if (!value) {
      value = response(row.credential, []);
      values.set(value.id, value);
    }
    if (row.host) {
      value.hosts.push(row.host);
    }
  }
  return [...values.values()];
}

async function prepareCredential(
  body: CreateVncCredentialRequest,
  featureContext: FeatureSwitchContext,
) {
  return {
    name: body.name,
    encryptedPassword: await encryptStoredSecretValue(
      body.password,
      featureContext,
    ),
  };
}

export async function prepareVncCredentialSelection(
  selection: VncCredentialSelection,
  featureContext: FeatureSwitchContext,
) {
  return "id" in selection
    ? { id: selection.id }
    : { create: await prepareCredential(selection.create, featureContext) };
}

// Call only after admission, endpoint validation, and creation replay checks.
// The caller must perform the connection write in this same transaction.
export async function selectVncCredential(
  tx: VncTransaction,
  owner: VncOwner,
  selection: Awaited<ReturnType<typeof prepareVncCredentialSelection>>,
): Promise<VncResult<Metadata>> {
  if (selection.id !== undefined) {
    const row = await findVncCredential(tx, owner, selection.id);
    return row ? { ok: true, value: row } : vncFailure("credentialNotFound");
  }
  const [row] = await tx
    .insert(vncCredentials)
    .values({ ...owner, ...selection.create })
    .returning(metadata);
  if (!row) {
    throw new Error("VNC credential insert returned no row");
  }
  await recordVncCreationReceipt(tx, owner, vncCredentials, row.id);
  return { ok: true, value: row };
}

export async function createVncCredential(args: {
  readonly db: Db;
  readonly admission: VncAdmission;
  readonly body: CreateVncCredentialRequest;
  readonly id: string;
  readonly featureContext: FeatureSwitchContext;
}): Promise<VncResult<VncCredentialResponse | undefined>> {
  const preflight = await inspectVncCreationId(
    args.db,
    args.admission.owner,
    vncCredentials,
    args.id,
  );
  if (!preflight.ok) {
    return preflight;
  }
  if (!preflight.value) {
    return { ok: true, value: undefined };
  }
  const prepared = await prepareCredential(args.body, args.featureContext);
  return args.db.transaction(async (tx) => {
    if (!(await enterVncWrite(tx, args.admission))) {
      return vncFailure("ownerChanged");
    }
    const owner = args.admission.owner;
    const creation = await checkVncCreationId(
      tx,
      owner,
      vncCredentials,
      args.id,
    );
    if (!creation.ok) {
      return creation;
    }
    if (!creation.value) {
      return { ok: true as const, value: undefined };
    }
    const [created] = await tx
      .insert(vncCredentials)
      .values({ ...owner, ...prepared, id: args.id })
      .returning(metadata);
    if (!created) {
      throw new Error("VNC credential insert returned no row");
    }
    await recordVncCreationReceipt(tx, owner, vncCredentials, created.id);
    return { ok: true as const, value: response(created, []) };
  });
}

export async function updateVncCredential(args: {
  readonly db: Db;
  readonly admission: VncAdmission;
  readonly credentialId: string;
  readonly body: UpdateVncCredentialRequest;
  readonly featureContext: FeatureSwitchContext;
}): Promise<VncResult<VncCredentialResponse>> {
  const initial = await findVncCredential(
    args.db,
    args.admission.owner,
    args.credentialId,
  );
  if (!initial) {
    return vncFailure("credentialNotFound");
  }
  if (initial.revision !== args.body.expectedRevision) {
    return vncFailure("credentialConflict");
  }
  const encryptedPassword =
    args.body.password === undefined
      ? undefined
      : await encryptStoredSecretValue(args.body.password, args.featureContext);
  return args.db.transaction(async (tx) => {
    if (!(await enterVncWrite(tx, args.admission))) {
      return vncFailure("ownerChanged");
    }
    const owner = args.admission.owner;
    // Connections precede credentials in the global row-lock order, including
    // rotation, owner cleanup, and the later runtime authority consumer.
    const hosts = await tx
      .select({
        id: vncConnections.id,
        displayName: vncConnections.displayName,
        generation: vncConnections.generation,
      })
      .from(vncConnections)
      .where(referencingConnections(owner, args.credentialId))
      .orderBy(asc(vncConnections.id))
      .for("update");
    const [current] = await tx
      .select(metadata)
      .from(vncCredentials)
      .where(ownedCredential(owner, args.credentialId))
      .for("update");
    if (!current) {
      return vncFailure("credentialNotFound");
    }
    if (current.revision !== args.body.expectedRevision) {
      return vncFailure("credentialConflict");
    }
    if (
      current.revision === 2_147_483_647 ||
      (encryptedPassword !== undefined &&
        hosts.some((host) => {
          return host.generation === 2_147_483_647;
        }))
    ) {
      return vncFailure("exhausted");
    }
    const [updated] = await tx
      .update(vncCredentials)
      .set({
        name: args.body.name,
        encryptedPassword,
        revision: current.revision + 1,
        updatedAt: nowDate(),
      })
      .where(ownedCredential(owner, args.credentialId))
      .returning(metadata);
    if (!updated) {
      throw new Error("VNC credential update returned no row");
    }
    if (encryptedPassword !== undefined && hosts.length > 0) {
      await tx
        .update(vncConnections)
        .set({
          generation: sql`${vncConnections.generation} + 1`,
          updatedAt: nowDate(),
        })
        .where(referencingConnections(owner, args.credentialId));
    }
    return {
      ok: true as const,
      value: response(
        updated,
        hosts.map(({ id, displayName }) => {
          return { id, displayName };
        }),
      ),
    };
  });
}

export function deleteVncCredential(args: {
  readonly db: Db;
  readonly admission: VncAdmission;
  readonly credentialId: string;
  readonly expectedRevision: number;
}): Promise<VncResult<undefined>> {
  return args.db.transaction(async (tx) => {
    if (!(await enterVncWrite(tx, args.admission))) {
      return vncFailure("ownerChanged");
    }
    const owner = args.admission.owner;
    const current = await findVncCredential(tx, owner, args.credentialId);
    if (!current) {
      return vncFailure("credentialNotFound");
    }
    if (current.revision !== args.expectedRevision) {
      return vncFailure("credentialConflict");
    }
    const [host] = await tx
      .select({ id: vncConnections.id })
      .from(vncConnections)
      .where(referencingConnections(owner, args.credentialId))
      .limit(1);
    if (host) {
      return vncFailure("credentialInUse");
    }
    await tx
      .delete(vncCredentials)
      .where(ownedCredential(owner, args.credentialId));
    return { ok: true as const, value: undefined };
  });
}
