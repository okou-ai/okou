import type {
  CreateSshCredentialRequest,
  SshAuthentication,
  SshCredentialResponse,
  SshCredentialSelection,
  UpdateSshCredentialRequest,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import {
  SSH_ERROR_CODES,
  type SshErrorCode,
} from "@okouai/api-contracts/contracts/ssh-errors";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { and, asc, eq, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { encryptStoredSecretValue } from "./crypto.utils";
import { publishSshClientInvalidation } from "./ssh-client-invalidation.service";
import { publishSshRuntimeInvalidation } from "./ssh-runtime-wakeup.service";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type SshResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: "bad_request" | "not_found" | "conflict";
      readonly code: SshErrorCode;
      readonly message: string;
    };
const failures = {
  notFound: {
    kind: "not_found",
    code: SSH_ERROR_CODES.CREDENTIAL_NOT_FOUND,
    message: "SSH credential not found",
  },
  conflict: {
    kind: "conflict",
    code: SSH_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT,
    message: "SSH credential was modified by another request",
  },
  inUse: {
    kind: "conflict",
    code: SSH_ERROR_CODES.CREDENTIAL_IN_USE,
    message: "SSH credential is used by a host",
  },
  exhausted: {
    kind: "conflict",
    code: SSH_ERROR_CODES.REVISION_EXHAUSTED,
    message: "SSH configuration revision limit reached",
  },
} as const;
export function sshCredentialFailure(reason: keyof typeof failures) {
  return { ok: false as const, ...failures[reason] };
}
export async function lockSshOwner(
  tx: Pick<Transaction, "execute">,
  owner: Owner,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ssh_connection_owner:${owner.orgId}:${owner.userId}`}, 0))`,
  );
}
const metadata = Object.freeze({
  id: sshCredentials.id,
  name: sshCredentials.name,
  username: sshCredentials.username,
  authMethod: sshCredentials.authMethod,
  revision: sshCredentials.revision,
  createdAt: sshCredentials.createdAt,
  updatedAt: sshCredentials.updatedAt,
});
type Metadata = Pick<typeof sshCredentials.$inferSelect, keyof typeof metadata>;
function ownedCredential(owner: Owner, id: string) {
  return and(
    eq(sshCredentials.id, id),
    eq(sshCredentials.orgId, owner.orgId),
    eq(sshCredentials.userId, owner.userId),
  );
}
export async function findSshCredential(
  db: Pick<ReadonlyDb, "select">,
  owner: Owner,
  id: string,
): Promise<Metadata | undefined> {
  const [row] = await db
    .select(metadata)
    .from(sshCredentials)
    .where(ownedCredential(owner, id));
  return row;
}
function response(
  row: Metadata,
  hosts: SshCredentialResponse["hosts"],
): SshCredentialResponse {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hosts,
  };
}
export async function listSshCredentials(
  db: ReadonlyDb,
  owner: Owner,
): Promise<SshCredentialResponse[]> {
  const rows = await db
    .select({
      credential: metadata,
      host: { id: sshConnections.id, displayName: sshConnections.displayName },
    })
    .from(sshCredentials)
    .leftJoin(
      sshConnections,
      and(
        eq(sshConnections.credentialId, sshCredentials.id),
        eq(sshConnections.orgId, sshCredentials.orgId),
        eq(sshConnections.userId, sshCredentials.userId),
      ),
    )
    .where(
      and(
        eq(sshCredentials.orgId, owner.orgId),
        eq(sshCredentials.userId, owner.userId),
      ),
    )
    .orderBy(
      asc(sshCredentials.createdAt),
      asc(sshCredentials.id),
      asc(sshConnections.id),
    );
  const values = new Map<string, SshCredentialResponse>();
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
async function encryptAuthentication(
  auth: SshAuthentication,
  context: FeatureSwitchContext,
) {
  if (auth.method === "password") {
    return {
      authMethod: auth.method,
      encryptedPrivateKey: null,
      encryptedPassphrase: null,
      encryptedPassword: await encryptStoredSecretValue(auth.password, context),
    };
  }
  return {
    authMethod: auth.method,
    encryptedPassword: null,
    encryptedPrivateKey: await encryptStoredSecretValue(
      auth.privateKey,
      context,
    ),
    encryptedPassphrase:
      auth.passphrase === null
        ? null
        : await encryptStoredSecretValue(auth.passphrase, context),
  };
}
async function prepareCredential(
  body: CreateSshCredentialRequest,
  context: FeatureSwitchContext,
) {
  return {
    name: body.name,
    username: body.username,
    ...(await encryptAuthentication(body.authentication, context)),
  };
}
export async function prepareSshCredentialSelection(
  selection: SshCredentialSelection,
  context: FeatureSwitchContext,
) {
  return "id" in selection
    ? { id: selection.id }
    : { create: await prepareCredential(selection.create, context) };
}
export async function selectSshCredential(
  tx: Transaction,
  owner: Owner,
  selection: Awaited<ReturnType<typeof prepareSshCredentialSelection>>,
): Promise<SshResult<Metadata>> {
  if (selection.id !== undefined) {
    const row = await findSshCredential(tx, owner, selection.id);
    return row ? { ok: true, value: row } : sshCredentialFailure("notFound");
  }
  const [row] = await tx
    .insert(sshCredentials)
    .values({ ...owner, ...selection.create })
    .returning(metadata);
  if (!row) {
    throw new Error("SSH credential insert returned no row");
  }
  return { ok: true, value: row };
}
export async function createSshCredential(args: {
  readonly db: Db;
  readonly owner: Owner;
  readonly body: CreateSshCredentialRequest;
  readonly featureContext: FeatureSwitchContext;
}): Promise<SshCredentialResponse> {
  const prepared = await prepareCredential(args.body, args.featureContext);
  const row = await args.db.transaction(async (tx) => {
    await lockSshOwner(tx, args.owner);
    const [created] = await tx
      .insert(sshCredentials)
      .values({ ...args.owner, ...prepared })
      .returning(metadata);
    if (!created) {
      throw new Error("SSH credential insert returned no row");
    }
    return created;
  });
  await publishSshClientInvalidation(args.owner);
  return response(row, []);
}
export async function updateSshCredential(args: {
  readonly db: Db;
  readonly owner: Owner;
  readonly credentialId: string;
  readonly body: UpdateSshCredentialRequest;
  readonly featureContext: FeatureSwitchContext;
}): Promise<SshResult<SshCredentialResponse>> {
  const initial = await findSshCredential(
    args.db,
    args.owner,
    args.credentialId,
  );
  if (!initial) {
    return sshCredentialFailure("notFound");
  }
  if (initial.revision !== args.body.expectedRevision) {
    return sshCredentialFailure("conflict");
  }
  const encrypted =
    args.body.authentication === undefined
      ? undefined
      : await encryptAuthentication(
          args.body.authentication,
          args.featureContext,
        );
  const result = await args.db.transaction(async (tx) => {
    await lockSshOwner(tx, args.owner);
    // Pin/observation lock a connection before sharing its credential. Keep that order.
    const hosts = await tx
      .select({
        id: sshConnections.id,
        displayName: sshConnections.displayName,
        generation: sshConnections.generation,
      })
      .from(sshConnections)
      .where(
        and(
          eq(sshConnections.credentialId, args.credentialId),
          eq(sshConnections.orgId, args.owner.orgId),
          eq(sshConnections.userId, args.owner.userId),
        ),
      )
      .orderBy(asc(sshConnections.id))
      .for("update");
    const [current] = await tx
      .select(metadata)
      .from(sshCredentials)
      .where(ownedCredential(args.owner, args.credentialId))
      .for("update");
    if (!current) {
      return sshCredentialFailure("notFound");
    }
    if (current.revision !== args.body.expectedRevision) {
      return sshCredentialFailure("conflict");
    }
    const effectiveChange =
      encrypted !== undefined ||
      (args.body.username !== undefined &&
        args.body.username !== current.username);
    if (
      current.revision === 2_147_483_647 ||
      (effectiveChange &&
        hosts.some((host) => {
          return host.generation === 2_147_483_647;
        }))
    ) {
      return sshCredentialFailure("exhausted");
    }
    const [updated] = await tx
      .update(sshCredentials)
      .set({
        name: args.body.name,
        username: args.body.username,
        ...encrypted,
        revision: current.revision + 1,
        updatedAt: nowDate(),
      })
      .where(ownedCredential(args.owner, args.credentialId))
      .returning(metadata);
    if (!updated) {
      throw new Error("SSH credential update returned no row");
    }
    if (effectiveChange && hosts.length > 0) {
      await tx
        .update(sshConnections)
        .set({
          generation: sql`${sshConnections.generation} + 1`,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(sshConnections.credentialId, args.credentialId),
            eq(sshConnections.orgId, args.owner.orgId),
            eq(sshConnections.userId, args.owner.userId),
          ),
        );
    }
    return {
      ok: true as const,
      value: response(
        updated,
        hosts.map(({ id, displayName }) => {
          return { id, displayName };
        }),
      ),
      invalidate: effectiveChange && hosts.length > 0,
    };
  });
  if (result.ok) {
    if (result.invalidate) {
      await publishSshRuntimeInvalidation(args.db, {
        ...args.owner,
        connectionId: null,
      });
    } else {
      await publishSshClientInvalidation(args.owner);
    }
  }
  return result;
}
export async function deleteSshCredential(args: {
  readonly db: Db;
  readonly owner: Owner;
  readonly credentialId: string;
  readonly expectedRevision: number;
}): Promise<SshResult<undefined>> {
  const result = await args.db.transaction(async (tx) => {
    await lockSshOwner(tx, args.owner);
    const current = await findSshCredential(tx, args.owner, args.credentialId);
    if (!current) {
      return sshCredentialFailure("notFound");
    }
    if (current.revision !== args.expectedRevision) {
      return sshCredentialFailure("conflict");
    }
    const [host] = await tx
      .select({ id: sshConnections.id })
      .from(sshConnections)
      .where(eq(sshConnections.credentialId, current.id))
      .limit(1);
    if (host) {
      return sshCredentialFailure("inUse");
    }
    await tx
      .delete(sshCredentials)
      .where(ownedCredential(args.owner, current.id));
    return { ok: true as const, value: undefined };
  });
  if (result.ok) {
    await publishSshClientInvalidation(args.owner);
  }
  return result;
}
