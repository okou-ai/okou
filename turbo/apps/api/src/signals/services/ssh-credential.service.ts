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
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, asc, eq, sql } from "drizzle-orm";
import { isForeignKeyViolation, isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$, type ReadonlyDb } from "../external/db";
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
export function isSshCredentialReferenceViolation(error: unknown): boolean {
  return (
    isForeignKeyViolation(error) &&
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "constraint" in error.cause &&
    error.cause.constraint === "ssh_connections_credential_owner_fk"
  );
}
/** Retain the outgoing writer key until all supported writers use member ownership. */
export function sshOwnerCompatibilitySql(owner: Owner) {
  // eslint-disable-next-line api/no-new-advisory-lock -- Existing R1 compatibility key; outgoing writers do not own the member row.
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ssh_connection_owner:${owner.orgId}:${owner.userId}`}, 0))`;
}
export function sshMemberOwnerWhere(owner: Owner) {
  return and(
    eq(orgMembersMetadata.orgId, owner.orgId),
    eq(orgMembersMetadata.userId, owner.userId),
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
export async function listSshCredentials(
  db: ReadonlyDb,
  owner: Owner,
): Promise<SshCredentialResponse[]> {
  const rows = await db
    .select({
      credential: sshCredentialMetadata,
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
export const createSshCredential$ = command(
  async (
    { set },
    args: {
      readonly owner: Owner;
      readonly body: CreateSshCredentialRequest;
      readonly id: string;
      readonly featureContext: FeatureSwitchContext;
    },
  ): Promise<SshResult<SshCredentialResponse | undefined>> => {
    const db = set(writeDb$);
    const prepared = await prepareCredential(args.body, args.featureContext);
    const transaction = await settle(
      db.transaction(async (tx) => {
        const [existing] = await tx
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
          return { ok: true as const, value: undefined };
        }
        const [created] = await tx
          .insert(sshCredentials)
          .values({ ...args.owner, ...prepared, id: args.id })
          .returning(sshCredentialMetadata);
        if (!created) {
          throw new Error("SSH credential insert returned no row");
        }
        return { ok: true as const, value: response(created, []) };
      }),
    );
    if (!transaction.ok) {
      if (!isUniqueViolation(transaction.error, "ssh_credentials_pkey")) {
        throw transaction.error;
      }
      const [existing] = await db
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
    const row = transaction.value;
    if (row.ok && row.value) {
      await publishSshClientInvalidation(args.owner);
    }
    return row;
  },
);
interface UpdateSshCredentialArgs {
  readonly owner: Owner;
  readonly credentialId: string;
  readonly body: UpdateSshCredentialRequest;
  readonly featureContext: FeatureSwitchContext;
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
    const encrypted =
      args.body.authentication === undefined
        ? undefined
        : await encryptAuthentication(
            args.body.authentication,
            args.featureContext,
          );
    const result = await db.transaction(async (tx) => {
      // Outgoing API writers only take this key. R2 removes it after their drain.
      await tx.execute(sshOwnerCompatibilitySql(args.owner));
      await tx
        .insert(orgMembersMetadata)
        .values(args.owner)
        .onConflictDoNothing();
      await tx
        .select({ orgId: orgMembersMetadata.orgId })
        .from(orgMembersMetadata)
        .where(sshMemberOwnerWhere(args.owner))
        .for("no key update");
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
        .select(sshCredentialMetadata)
        .from(sshCredentials)
        .where(ownedSshCredential(args.owner, args.credentialId))
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
        .where(ownedSshCredential(args.owner, args.credentialId))
        .returning(sshCredentialMetadata);
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
        await set(publishSshRuntimeInvalidation$, {
          ...args.owner,
          connectionId: null,
        });
      } else {
        await publishSshClientInvalidation(args.owner);
      }
    }
    return result;
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
    const result = await db.transaction(
      async (tx) => {
        // The FK takes KEY SHARE on the credential. Wait here before checking
        // references in a fresh READ COMMITTED statement; a single DELETE's
        // absence check can retain the snapshot from before an attachment commits.
        const [current] = await tx
          .select({ id: sshCredentials.id, revision: sshCredentials.revision })
          .from(sshCredentials)
          .where(ownedSshCredential(args.owner, args.credentialId))
          .for("update");
        if (!current) {
          return sshCredentialFailure("notFound");
        }
        if (current.revision !== args.expectedRevision) {
          return sshCredentialFailure("conflict");
        }
        // Do not lock hosts here: pin and rotation take the host before its
        // credential. Existing references must return inUse before DELETE's
        // RESTRICT check could wait on one of those host rows.
        const [host] = await tx
          .select({ id: sshConnections.id })
          .from(sshConnections)
          .where(eq(sshConnections.credentialId, current.id))
          .limit(1);
        if (host) {
          return sshCredentialFailure("inUse");
        }
        const [deleted] = await tx
          .delete(sshCredentials)
          .where(
            and(
              ownedSshCredential(args.owner, current.id),
              eq(sshCredentials.revision, args.expectedRevision),
            ),
          )
          .returning({ id: sshCredentials.id });
        if (!deleted) {
          throw new Error("SSH credential delete returned no row");
        }
        return { ok: true as const, value: undefined };
      },
      { isolationLevel: "read committed" },
    );
    if (result.ok) {
      await publishSshClientInvalidation(args.owner);
    }
    return result;
  },
);
