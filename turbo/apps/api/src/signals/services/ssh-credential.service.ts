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
import { command } from "ccstate";
import { and, asc, eq, sql } from "drizzle-orm";
import { isForeignKeyViolation, isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { encryptStoredSecretValue } from "./crypto.utils";
import { publishSshClientInvalidation } from "./ssh-client-invalidation.service";
import { publishSshRuntimeInvalidation$ } from "./ssh-runtime-wakeup.service";
import { sshCreationResult } from "./ssh-creation.service";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
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
/** The RESTRICT credential FK reports 23001; a NO ACTION check reports 23503. */
export function isSshCredentialReferenceViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "constraint" in error.cause &&
    error.cause.constraint === "ssh_connections_credential_owner_fk" &&
    (isForeignKeyViolation(error) ||
      ("code" in error.cause && error.cause.code === "23001"))
  );
}
const sshCredentialMetadata = Object.freeze({
  id: sshCredentials.id,
  name: sshCredentials.name,
  username: sshCredentials.username,
  authMethod: sshCredentials.authMethod,
  revision: sshCredentials.revision,
  createdAt: sshCredentials.createdAt,
  updatedAt: sshCredentials.updatedAt,
});
type Metadata = Pick<
  typeof sshCredentials.$inferSelect,
  keyof typeof sshCredentialMetadata
>;
export function ownedSshCredential(owner: Owner, id: string) {
  return and(
    eq(sshCredentials.id, id),
    eq(sshCredentials.orgId, owner.orgId),
    eq(sshCredentials.userId, owner.userId),
  );
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
export const listSshCredentials$ = command(
  async (
    { set },
    owner: Owner,
    signal: AbortSignal,
  ): Promise<SshCredentialResponse[]> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        credential: sshCredentialMetadata,
        host: {
          id: sshConnections.id,
          displayName: sshConnections.displayName,
        },
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
    signal.throwIfAborted();
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
  },
);
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
export const createSshCredential$ = command(
  async (
    { get, set },
    args: {
      readonly owner: Owner;
      readonly body: CreateSshCredentialRequest;
      readonly id: string;
      readonly featureContext: FeatureSwitchContext;
    },
  ): Promise<SshResult<SshCredentialResponse | undefined>> => {
    const db = set(writeDb$);
    const prepared = await prepareCredential(args.body, args.featureContext);
    const [existing] = await get(db$)
      .select({
        orgId: sshCredentials.orgId,
        userId: sshCredentials.userId,
      })
      .from(sshCredentials)
      .where(eq(sshCredentials.id, args.id));
    const creation = sshCreationResult(args.owner, existing);
    if (!creation.ok) {
      return creation;
    }
    if (!creation.value) {
      return { ok: true, value: undefined };
    }
    // The primary key, not the unlocked preflight, arbitrates concurrent creates.
    const inserted = await settle(
      db
        .insert(sshCredentials)
        .values({ ...args.owner, ...prepared, id: args.id })
        .returning(sshCredentialMetadata),
    );
    if (!inserted.ok) {
      if (!isUniqueViolation(inserted.error, "ssh_credentials_pkey")) {
        throw inserted.error;
      }
      const [existing] = await get(db$)
        .select({ orgId: sshCredentials.orgId, userId: sshCredentials.userId })
        .from(sshCredentials)
        .where(eq(sshCredentials.id, args.id));
      const creation = sshCreationResult(args.owner, existing);
      return creation.ok && existing
        ? { ok: true, value: undefined }
        : {
            ok: false,
            kind: "conflict",
            code: SSH_ERROR_CODES.RESOURCE_ID_CONFLICT,
            message:
              "This resource ID cannot be used for this SSH configuration.",
          };
    }
    const [created] = inserted.value;
    if (!created) {
      throw new Error("SSH credential insert returned no row");
    }
    await publishSshClientInvalidation(args.owner);
    return { ok: true, value: response(created, []) };
  },
);
interface UpdateSshCredentialArgs {
  readonly owner: Owner;
  readonly credentialId: string;
  readonly body: UpdateSshCredentialRequest;
  readonly featureContext: FeatureSwitchContext;
}

const MAX_SSH_REVISION = 2_147_483_647;
function ownerHostsUsingCredential(owner: Owner, credentialId: string) {
  return and(
    eq(sshConnections.credentialId, credentialId),
    eq(sshConnections.orgId, owner.orgId),
    eq(sshConnections.userId, owner.userId),
  );
}

async function lockCurrentCredentialBindings(
  tx: Pick<Db, "select">,
  owner: Owner,
  credentialId: string,
) {
  // Serialize host edits without blocking RESTRICT's FK key-share check.
  const lockedHosts = await tx
    .select({ id: sshConnections.id })
    .from(sshConnections)
    .where(ownerHostsUsingCredential(owner, credentialId))
    .orderBy(asc(sshConnections.id))
    .for("no key update");
  const [credential] = await tx
    .select(sshCredentialMetadata)
    .from(sshCredentials)
    .where(ownedSshCredential(owner, credentialId))
    .for("update");
  if (!credential) {
    return sshCredentialFailure("notFound");
  }
  if (credential.revision === MAX_SSH_REVISION) {
    return sshCredentialFailure("exhausted");
  }
  // The credential lock also fences new FK bindings. If a host bound while
  // acquiring it, rescan without writes rather than reverse the lock order.
  const hosts = await tx
    .select({
      id: sshConnections.id,
      displayName: sshConnections.displayName,
      generation: sshConnections.generation,
    })
    .from(sshConnections)
    .where(ownerHostsUsingCredential(owner, credentialId))
    .orderBy(asc(sshConnections.id));
  const lockedIds = new Set(
    lockedHosts.map(({ id }) => {
      return id;
    }),
  );
  if (
    hosts.some(({ id }) => {
      return !lockedIds.has(id);
    })
  ) {
    return {
      ...sshCredentialFailure("conflict"),
      retryBindings: true as const,
    };
  }
  return { ok: true as const, value: { credential, hosts } };
}

export const updateSshCredential$ = command(
  async (
    { set },
    args: UpdateSshCredentialArgs,
  ): Promise<SshResult<SshCredentialResponse>> => {
    const db = set(writeDb$);
    const [initial] = await db
      .select(sshCredentialMetadata)
      .from(sshCredentials)
      .where(ownedSshCredential(args.owner, args.credentialId));
    if (!initial) {
      return sshCredentialFailure("notFound");
    }
    if (initial.revision !== args.body.expectedRevision) {
      return sshCredentialFailure("conflict");
    }
    if (initial.revision === MAX_SSH_REVISION) {
      return sshCredentialFailure("exhausted");
    }
    const hosts = await db
      .select({
        id: sshConnections.id,
        displayName: sshConnections.displayName,
        generation: sshConnections.generation,
      })
      .from(sshConnections)
      .where(ownerHostsUsingCredential(args.owner, args.credentialId))
      .orderBy(asc(sshConnections.id));
    const effectiveChange =
      args.body.authentication !== undefined ||
      (args.body.username !== undefined &&
        args.body.username !== initial.username);
    if (
      effectiveChange &&
      hosts.some((host) => {
        return host.generation === MAX_SSH_REVISION;
      })
    ) {
      return sshCredentialFailure("exhausted");
    }
    const encrypted =
      args.body.authentication === undefined
        ? undefined
        : await encryptAuthentication(
            args.body.authentication,
            args.featureContext,
          );
    const commitPreparedChange = () => {
      return db.transaction(async (tx) => {
        const bindings = await lockCurrentCredentialBindings(
          tx,
          args.owner,
          args.credentialId,
        );
        if (!bindings.ok) {
          return bindings;
        }
        const { credential, hosts: currentHosts } = bindings.value;
        const currentEffectiveChange =
          args.body.authentication !== undefined ||
          (args.body.username !== undefined &&
            args.body.username !== credential.username);
        if (
          currentEffectiveChange &&
          currentHosts.some(({ generation }) => {
            return generation === MAX_SSH_REVISION;
          })
        ) {
          return sshCredentialFailure("exhausted");
        }
        if (currentEffectiveChange) {
          await tx
            .update(sshConnections)
            .set({
              generation: sql`${sshConnections.generation} + 1`,
              updatedAt: nowDate(),
            })
            .where(ownerHostsUsingCredential(args.owner, args.credentialId));
        }
        const [row] = await tx
          .update(sshCredentials)
          .set({
            name: args.body.name,
            username: args.body.username,
            ...encrypted,
            revision: sql`${sshCredentials.revision} + 1`,
            updatedAt: nowDate(),
          })
          .where(ownedSshCredential(args.owner, args.credentialId))
          .returning(sshCredentialMetadata);
        if (!row) {
          throw new Error("Locked SSH credential update returned no row");
        }
        return {
          ok: true as const,
          value: {
            row,
            hosts: currentHosts,
            invalidate: currentEffectiveChange && currentHosts.length > 0,
          },
        };
      });
    };
    let updated = await commitPreparedChange();
    if (!updated.ok && "retryBindings" in updated) {
      // The first transaction wrote nothing. Re-lock once from a fresh set;
      // never repeat encryption or a successful/ambiguous mutation.
      updated = await commitPreparedChange();
    }
    if (!updated.ok) {
      return updated;
    }
    if (updated.value.invalidate) {
      await set(publishSshRuntimeInvalidation$, {
        ...args.owner,
        connectionId: null,
      });
    } else {
      await publishSshClientInvalidation(args.owner);
    }
    return {
      ok: true,
      value: response(
        updated.value.row,
        updated.value.hosts.map(({ id, displayName }) => {
          return { id, displayName };
        }),
      ),
    };
  },
);
export const deleteSshCredential$ = command(
  async (
    { set },
    args: {
      readonly owner: Owner;
      readonly credentialId: string;
      readonly expectedRevision: number;
    },
  ): Promise<SshResult<undefined>> => {
    const db = set(writeDb$);
    const [current] = await db
      .select({ revision: sshCredentials.revision })
      .from(sshCredentials)
      .where(ownedSshCredential(args.owner, args.credentialId));
    if (!current) {
      return sshCredentialFailure("notFound");
    }
    if (current.revision !== args.expectedRevision) {
      return sshCredentialFailure("conflict");
    }
    // Fence new bindings, then reject references without acquiring host locks.
    const deletion = await settle(
      db.transaction<SshResult<undefined>>(async (tx) => {
        const [locked] = await tx
          .select({ id: sshCredentials.id })
          .from(sshCredentials)
          .where(ownedSshCredential(args.owner, args.credentialId))
          .for("update");
        if (!locked) {
          // Preserve success when another delete removed the early-seen row.
          return { ok: true, value: undefined };
        }
        const [reference] = await tx
          .select({ id: sshConnections.id })
          .from(sshConnections)
          .where(ownerHostsUsingCredential(args.owner, args.credentialId))
          .limit(1);
        if (reference) {
          return sshCredentialFailure("inUse");
        }
        await tx
          .delete(sshCredentials)
          .where(ownedSshCredential(args.owner, args.credentialId));
        return { ok: true, value: undefined };
      }),
    );
    if (!deletion.ok) {
      if (isSshCredentialReferenceViolation(deletion.error)) {
        return sshCredentialFailure("inUse");
      }
      throw deletion.error;
    }
    if (!deletion.value.ok) {
      return deletion.value;
    }
    await publishSshClientInvalidation(args.owner);
    return { ok: true, value: undefined };
  },
);
