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
import { writeDb$ } from "../external/db";
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

const MAX_SSH_REVISION = 2_147_483_647;
function ownerHostsUsingCredential(owner: Owner, credentialId: string) {
  return and(
    eq(sshConnections.credentialId, credentialId),
    eq(sshConnections.orgId, owner.orgId),
    eq(sshConnections.userId, owner.userId),
  );
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
    const invalidate = effectiveChange && hosts.length > 0;
    const updated = await db.transaction(async (tx) => {
      if (invalidate) {
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
      return row;
    });
    if (!updated) {
      return sshCredentialFailure("notFound");
    }
    if (invalidate) {
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
        updated,
        hosts.map(({ id, displayName }) => {
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
    // The RESTRICT credential FK rejects deleting a credential used by a host.
    const deletion = await settle(
      db
        .delete(sshCredentials)
        .where(ownedSshCredential(args.owner, args.credentialId)),
    );
    if (!deletion.ok) {
      if (isSshCredentialReferenceViolation(deletion.error)) {
        return sshCredentialFailure("inUse");
      }
      throw deletion.error;
    }
    await publishSshClientInvalidation(args.owner);
    return { ok: true, value: undefined };
  },
);
