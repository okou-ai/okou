import { command } from "ccstate";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import type {
  CreateSshConnectionRequest,
  SshConnectionResponse,
  UpdateSshConnectionRequest,
} from "@okouai/api-contracts/contracts/ssh-connections";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import {
  sshOwnerCompatibilitySql,
  sshMemberOwnerWhere,
  ownedSshCredential,
  prepareSshCredentialSelection,
  isSshCredentialReferenceViolation,
  sshCredentialFailure,
} from "./ssh-credential.service";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { and, asc, count, eq, or, sql } from "drizzle-orm";

import {
  SSH_ERROR_CODES,
  type SshErrorCode,
} from "@okouai/api-contracts/contracts/ssh-errors";
import { safeSqlStateCode, isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$, type ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import { decryptStoredSecretValue } from "./crypto.utils";
import { publishSshRuntimeInvalidation$ } from "./ssh-runtime-wakeup.service";
import { sshCreationResult, resourceIdConflict } from "./ssh-creation.service";
import {
  cloudflareAccessFailure,
  prepareCloudflareAccessConfig,
} from "./cloudflare-access.service";
import { publishCloudflareAccessClientInvalidation } from "./cloudflare-access-client-invalidation.service";

const credentialSelection = Object.freeze({
  id: sshCredentials.id,
  name: sshCredentials.name,
  username: sshCredentials.username,
  authMethod: sshCredentials.authMethod,
  revision: sshCredentials.revision,
  createdAt: sshCredentials.createdAt,
  updatedAt: sshCredentials.updatedAt,
});
type SshConnectionRow = typeof sshConnections.$inferSelect;
type SshConnectionFailure = {
  readonly kind: "bad_request" | "not_found" | "conflict";
  readonly message: string;
  readonly code: SshErrorCode;
};
type SshConnectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | ({ readonly ok: false } & SshConnectionFailure);
type SshConnectionMutationResult<T> =
  | { readonly ok: true; readonly value: T; readonly createdAccess: boolean }
  | ({ readonly ok: false } & SshConnectionFailure);
type CreateSshConnectionArgs = {
  readonly orgId: string;
  readonly userId: string;
  readonly body: CreateSshConnectionRequest;
  readonly featureContext: FeatureSwitchContext;
};
type UpdateSshConnectionArgs = {
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly body: UpdateSshConnectionRequest;
  readonly featureContext: FeatureSwitchContext;
};

const SSH_FAILURES = {
  invalidHost: {
    kind: "bad_request",
    message: "Invalid SSH host",
    code: SSH_ERROR_CODES.INVALID_HOST,
  },
  notFound: {
    kind: "not_found",
    message: "SSH connection not found",
    code: SSH_ERROR_CODES.CONNECTION_NOT_FOUND,
  },
  connectionInUse: {
    kind: "conflict",
    message: "SSH connection is used by a VNC connection",
    code: SSH_ERROR_CODES.CONNECTION_IN_USE,
  },
  generationConflict: {
    kind: "conflict",
    message: "SSH connection was modified by another request",
    code: SSH_ERROR_CODES.GENERATION_CONFLICT,
  },
} satisfies Record<string, SshConnectionFailure>;

function failure(
  reason: keyof typeof SSH_FAILURES,
): SshConnectionFailure & { readonly ok: false } {
  return { ok: false, ...SSH_FAILURES[reason] };
}

function isVncReferenceRestriction(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { cause } = error;
  const code = safeSqlStateCode(error);
  return (
    (code === "23503" || code === "23001") &&
    typeof cause === "object" &&
    cause !== null &&
    "constraint" in cause &&
    cause.constraint === "vnc_connections_ssh_owner_fk"
  );
}

function canonicalizeIpv6(host: string): string {
  const parsed = new URL(`http://[${host}]`);
  return parsed.hostname.slice(1, -1);
}

function containsWhitespaceOrControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codeUnit = character.charCodeAt(0);
    return /\s/u.test(character) || codeUnit <= 0x1f || codeUnit === 0x7f;
  });
}

function canonicalizeSshHost(host: string): SshConnectionResult<string> {
  const trimmed = host.trim();
  const withoutRootDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (
    withoutRootDot.length === 0 ||
    withoutRootDot.length > 253 ||
    containsWhitespaceOrControl(withoutRootDot) ||
    withoutRootDot.includes("[") ||
    withoutRootDot.includes("]") ||
    withoutRootDot.includes("://")
  ) {
    return failure("invalidHost");
  }

  const ipVersion = isIP(withoutRootDot);
  if (ipVersion === 4) {
    return { ok: true, value: withoutRootDot };
  }
  if (ipVersion === 6) {
    return { ok: true, value: canonicalizeIpv6(withoutRootDot) };
  }

  const ascii = domainToASCII(withoutRootDot).toLowerCase();
  if (ascii.length === 0 || ascii.length > 253) {
    return failure("invalidHost");
  }

  const labels = ascii.split(".");
  if (
    labels.every((label) => {
      return /^\d+$/u.test(label);
    }) ||
    labels.some((label) => {
      return (
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
      );
    })
  ) {
    return failure("invalidHost");
  }

  return { ok: true, value: ascii };
}

function toSshConnectionResponse(
  row: SshConnectionRow,
  credential: { readonly name: string; readonly username: string },
): SshConnectionResponse {
  const hasAlgorithm = row.learnedHostKeyAlgorithm !== null;
  const hasFingerprint = row.learnedHostKeyFingerprint !== null;
  if (hasAlgorithm !== hasFingerprint) {
    throw new Error("SSH connection has an incomplete learned host-key pair");
  }

  return {
    ...(row.needsRebind
      ? {
          transport: {
            type: "cloudflare_access" as const,
            needsRebind: true as const,
          },
        }
      : row.cloudflareAccessId === null
        ? {}
        : {
            transport: {
              type: "cloudflare_access" as const,
              configId: row.cloudflareAccessId,
            },
          }),
    id: row.id,
    displayName: row.displayName,
    host: row.host,
    port: row.port,
    username: credential.username,
    credentialId: row.credentialId,
    credentialName: credential.name,
    generation: row.generation,
    learnedHostKey:
      row.learnedHostKeyAlgorithm === null ||
      row.learnedHostKeyFingerprint === null
        ? null
        : {
            algorithm: row.learnedHostKeyAlgorithm,
            fingerprint: row.learnedHostKeyFingerprint,
          },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function prepareAccessCreation(
  transport: CreateSshConnectionRequest["transport"],
  context: FeatureSwitchContext,
) {
  return transport?.type === "cloudflare_access" && "create" in transport
    ? prepareCloudflareAccessConfig(transport.create, context)
    : undefined;
}

function shouldClearLearnedHostKey(
  current: SshConnectionRow,
  host: string,
  port: number,
  selectedAccessId: string | null,
): boolean {
  return (
    (host !== current.host || port !== current.port) &&
    current.cloudflareAccessId === null &&
    selectedAccessId === null
  );
}

async function findOwnerConnection(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectionId: string;
  },
): Promise<SshConnectionRow | undefined> {
  const [row] = await db
    .select()
    .from(sshConnections)
    .where(
      and(
        eq(sshConnections.id, args.connectionId),
        eq(sshConnections.orgId, args.orgId),
        eq(sshConnections.userId, args.userId),
      ),
    )
    .limit(1);
  return row;
}

async function countOwnerConnections(
  db: Pick<ReadonlyDb, "select">,
  orgId: string,
  userId: string,
): Promise<number> {
  const [result] = await db
    .select({ value: count() })
    .from(sshConnections)
    .where(
      and(eq(sshConnections.orgId, orgId), eq(sshConnections.userId, userId)),
    );
  if (!result) {
    throw new Error("SSH connection count query returned no row");
  }
  return result.value;
}

export async function listSshConnections(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<readonly SshConnectionResponse[]> {
  const rows = await db
    .select({
      connection: sshConnections,
      credential: {
        name: sshCredentials.name,
        username: sshCredentials.username,
      },
    })
    .from(sshConnections)
    .innerJoin(
      sshCredentials,
      eq(sshCredentials.id, sshConnections.credentialId),
    )
    .where(
      and(eq(sshConnections.orgId, orgId), eq(sshConnections.userId, userId)),
    )
    .orderBy(asc(sshConnections.createdAt), asc(sshConnections.id));
  return rows.map(({ connection, credential }) => {
    return toSshConnectionResponse(connection, credential);
  });
}

export async function summarizeSshConnections(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<{ readonly configuredCount: number }> {
  return {
    configuredCount: await countOwnerConnections(db, orgId, userId),
  };
}

interface PreparedSshConnectionCreation extends CreateSshConnectionArgs {
  readonly canonicalHost: string;
  readonly accessId: string | null;
  readonly preparedAccess: Awaited<ReturnType<typeof prepareAccessCreation>>;
  readonly preparedCredential: Awaited<
    ReturnType<typeof prepareSshCredentialSelection>
  >;
}

const commitSshConnectionCreation$ = command(
  async (
    { set },
    args: PreparedSshConnectionCreation,
  ): Promise<
    SshConnectionMutationResult<SshConnectionResponse | undefined>
  > => {
    const db = set(writeDb$);
    const accessId = args.accessId;
    const transaction = await settle(
      db.transaction(async (tx) => {
        await tx.execute(sshOwnerCompatibilitySql(args));
        await tx
          .insert(orgMembersMetadata)
          .values({ orgId: args.orgId, userId: args.userId })
          .onConflictDoNothing();
        await tx
          .select({ orgId: orgMembersMetadata.orgId })
          .from(orgMembersMetadata)
          .where(sshMemberOwnerWhere(args))
          .for("no key update");
        const [existing] = await tx
          .select({
            orgId: sshConnections.orgId,
            userId: sshConnections.userId,
          })
          .from(sshConnections)
          .where(eq(sshConnections.id, args.body.id));
        const creation = sshCreationResult(args, existing);
        if (!creation.ok) {
          return creation;
        }
        if (!creation.value) {
          return {
            ok: true as const,
            value: undefined,
            createdAccess: false,
          };
        }
        if (
          (accessId !== null || args.preparedAccess !== undefined) &&
          (isIP(args.canonicalHost) !== 0 ||
            !args.canonicalHost.includes(".") ||
            args.body.port !== 443)
        ) {
          return failure("invalidHost");
        }
        if (accessId !== null) {
          const [config] = await tx
            .select({ id: cloudflareAccessConfigs.id })
            .from(cloudflareAccessConfigs)
            .where(visibleSshAccessConfig(args, accessId))
            .for("share");
          if (!config) {
            return cloudflareAccessFailure("notFound");
          }
        }
        const [credential] =
          args.preparedCredential.id !== undefined
            ? await tx
                .select(credentialSelection)
                .from(sshCredentials)
                .where(ownedSshCredential(args, args.preparedCredential.id))
            : await tx
                .insert(sshCredentials)
                .values({
                  orgId: args.orgId,
                  userId: args.userId,
                  ...args.preparedCredential.create,
                })
                .returning(credentialSelection);
        if (!credential) {
          return sshCredentialFailure("notFound");
        }
        const [createdAccess] =
          args.preparedAccess === undefined
            ? []
            : await tx
                .insert(cloudflareAccessConfigs)
                .values({
                  orgId: args.orgId,
                  userId: args.userId,
                  scope: "personal",
                  ...args.preparedAccess,
                })
                .returning({ id: cloudflareAccessConfigs.id });
        if (args.preparedAccess !== undefined && !createdAccess) {
          throw new Error("Cloudflare Access insert returned no row");
        }
        const selectedAccess = {
          id: createdAccess?.id ?? accessId,
          created: createdAccess !== undefined,
        };
        const [connection] = await tx
          .insert(sshConnections)
          .values(
            sshConnectionCreationValues(args, credential.id, selectedAccess.id),
          )
          .returning();
        if (!connection) {
          throw new Error("SSH connection insert returned no row");
        }
        return {
          ok: true as const,
          value: toSshConnectionResponse(connection, credential),
          createdAccess: selectedAccess.created,
        };
      }),
    );
    if (!transaction.ok) {
      if (isSshCredentialReferenceViolation(transaction.error)) {
        return sshCredentialFailure("notFound");
      }
      if (!isUniqueViolation(transaction.error, "ssh_connections_pkey")) {
        throw transaction.error;
      }
      const [existing] = await db
        .select({ orgId: sshConnections.orgId, userId: sshConnections.userId })
        .from(sshConnections)
        .where(eq(sshConnections.id, args.body.id));
      return existing && sshCreationResult(args, existing).ok
        ? { ok: true, value: undefined, createdAccess: false }
        : resourceIdConflict();
    }
    return transaction.value;
  },
);

export const createSshConnection$ = command(
  async (
    { set },
    args: CreateSshConnectionArgs,
  ): Promise<SshConnectionResult<SshConnectionResponse | undefined>> => {
    const canonicalHost = canonicalizeSshHost(args.body.host);
    if (!canonicalHost.ok) {
      return canonicalHost;
    }

    const accessId =
      args.body.transport?.type === "cloudflare_access" &&
      "configId" in args.body.transport
        ? args.body.transport.configId
        : null;
    const preparedAccess = await prepareAccessCreation(
      args.body.transport,
      args.featureContext,
    );

    const preparedCredential = await prepareSshCredentialSelection(
      args.body.credential,
      args.featureContext,
    );

    const result = await set(commitSshConnectionCreation$, {
      ...args,
      canonicalHost: canonicalHost.value,
      preparedAccess,
      preparedCredential,
      accessId,
    });
    if (result.ok && result.value) {
      await set(publishSshRuntimeInvalidation$, {
        orgId: args.orgId,
        userId: args.userId,
        connectionId: result.value.id,
      });
      if (result.createdAccess) {
        await publishCloudflareAccessClientInvalidation(args);
      }
    }
    return result;
  },
);

interface PreparedSshConnectionUpdate extends UpdateSshConnectionArgs {
  readonly canonicalHost: string | undefined;
  readonly preparedAccess: Awaited<ReturnType<typeof prepareAccessCreation>>;
  readonly preparedCredential:
    | Awaited<ReturnType<typeof prepareSshCredentialSelection>>
    | undefined;
}

const commitSshConnectionUpdate$ = command(
  async (
    { set },
    args: PreparedSshConnectionUpdate,
  ): Promise<SshConnectionMutationResult<SshConnectionResponse>> => {
    const db = set(writeDb$);
    const committed = await settle(
      db.transaction<SshConnectionMutationResult<SshConnectionResponse>>(
        async (tx) => {
          await tx.execute(sshOwnerCompatibilitySql(args));
          await tx
            .insert(orgMembersMetadata)
            .values({ orgId: args.orgId, userId: args.userId })
            .onConflictDoNothing();
          await tx
            .select({ orgId: orgMembersMetadata.orgId })
            .from(orgMembersMetadata)
            .where(sshMemberOwnerWhere(args))
            .for("no key update");
          const [currentBinding] = await tx
            .select()
            .from(sshConnections)
            .where(ownedSshConnection(args));
          if (!currentBinding) {
            return failure("notFound");
          }
          const accessId = requestedSshAccessId(
            args.body,
            currentBinding.cloudflareAccessId,
          );
          if (accessId !== null) {
            const [config] = await tx
              .select({ id: cloudflareAccessConfigs.id })
              .from(cloudflareAccessConfigs)
              .where(visibleSshAccessConfig(args, accessId))
              .for("share");
            if (!config) {
              return cloudflareAccessFailure("notFound");
            }
          }
          const [current] = await tx
            .select()
            .from(sshConnections)
            .where(ownedSshConnection(args))
            .for("update");
          if (!current) {
            return failure("notFound");
          }
          const host = args.canonicalHost ?? current.host;
          const port = args.body.port ?? current.port;
          const rejected = validateSshHostUpdate(current, {
            body: args.body,
            host,
            port,
            accessId,
            creatingAccess: args.preparedAccess !== undefined,
          });
          if (rejected) {
            return rejected;
          }
          const selectedCredential = args.preparedCredential ?? {
            id: current.credentialId,
          };
          const [credential] =
            selectedCredential.id !== undefined
              ? await tx
                  .select(credentialSelection)
                  .from(sshCredentials)
                  .where(ownedSshCredential(args, selectedCredential.id))
              : await tx
                  .insert(sshCredentials)
                  .values({
                    orgId: args.orgId,
                    userId: args.userId,
                    ...selectedCredential.create,
                  })
                  .returning(credentialSelection);
          if (!credential) {
            return sshCredentialFailure("notFound");
          }
          const [createdAccess] =
            args.preparedAccess === undefined
              ? []
              : await tx
                  .insert(cloudflareAccessConfigs)
                  .values({
                    orgId: args.orgId,
                    userId: args.userId,
                    scope: "personal",
                    ...args.preparedAccess,
                  })
                  .returning({ id: cloudflareAccessConfigs.id });
          if (args.preparedAccess !== undefined && !createdAccess) {
            throw new Error("Cloudflare Access insert returned no row");
          }
          const [updated] = await tx
            .update(sshConnections)
            .set(
              sshHostUpdateValues(current, {
                body: args.body,
                host,
                port,
                credentialId: credential.id,
                accessId: createdAccess?.id ?? accessId,
              }),
            )
            .where(eq(sshConnections.id, current.id))
            .returning();
          if (!updated) {
            throw new Error("SSH connection update returned no row");
          }
          return {
            ok: true,
            value: toSshConnectionResponse(updated, credential),
            createdAccess: createdAccess !== undefined,
          };
        },
      ),
    );
    if (committed.ok) {
      return committed.value;
    }
    if (isSshCredentialReferenceViolation(committed.error)) {
      return sshCredentialFailure("notFound");
    }
    throw committed.error;
  },
);

export const updateSshConnection$ = command(
  async (
    { set },
    args: UpdateSshConnectionArgs,
  ): Promise<SshConnectionResult<SshConnectionResponse>> => {
    const db = set(writeDb$);
    const canonicalHost =
      args.body.host === undefined
        ? undefined
        : canonicalizeSshHost(args.body.host);
    if (canonicalHost !== undefined && !canonicalHost.ok) {
      return canonicalHost;
    }
    const [preflight] = await db
      .select()
      .from(sshConnections)
      .where(ownedSshConnection(args));
    if (!preflight) {
      return failure("notFound");
    }
    if (preflight.generation !== args.body.expectedGeneration) {
      return failure("generationConflict");
    }
    const preparedAccess = await prepareAccessCreation(
      args.body.transport,
      args.featureContext,
    );
    const preparedCredential =
      args.body.credential === undefined
        ? undefined
        : await prepareSshCredentialSelection(
            args.body.credential,
            args.featureContext,
          );

    const result = await set(commitSshConnectionUpdate$, {
      ...args,
      canonicalHost: canonicalHost?.value,
      preparedAccess,
      preparedCredential,
    });
    if (result.ok) {
      await set(publishSshRuntimeInvalidation$, {
        orgId: args.orgId,
        userId: args.userId,
        connectionId: args.connectionId,
      });
      if (result.createdAccess) {
        await publishCloudflareAccessClientInvalidation(args);
      }
    }
    return result;
  },
);

export const deleteSshConnection$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectionId: string;
    },
  ): Promise<SshConnectionResult<undefined>> => {
    const db = set(writeDb$);
    const transaction = await settle(
      db.transaction<SshConnectionResult<undefined>>(async (tx) => {
        const [current] = await tx
          .select()
          .from(sshConnections)
          .where(
            and(
              eq(sshConnections.id, args.connectionId),
              eq(sshConnections.orgId, args.orgId),
              eq(sshConnections.userId, args.userId),
            ),
          )
          .limit(1)
          .for("update");
        if (!current) {
          return failure("notFound");
        }
        const [dependent] = await tx
          .select({ id: vncConnections.id })
          .from(vncConnections)
          .where(
            and(
              eq(vncConnections.sshConnectionId, current.id),
              eq(vncConnections.orgId, args.orgId),
              eq(vncConnections.userId, args.userId),
            ),
          )
          .limit(1);
        if (dependent) {
          return failure("connectionInUse");
        }
        const [deleted] = await tx
          .delete(sshConnections)
          .where(
            and(
              eq(sshConnections.id, args.connectionId),
              eq(sshConnections.orgId, args.orgId),
              eq(sshConnections.userId, args.userId),
            ),
          )
          .returning({ id: sshConnections.id });
        if (!deleted) {
          return failure("notFound");
        }
        return { ok: true, value: undefined };
      }),
    );
    if (!transaction.ok) {
      if (isVncReferenceRestriction(transaction.error)) {
        return failure("connectionInUse");
      }
      throw transaction.error;
    }
    const result = transaction.value;
    if (result.ok) {
      await set(publishSshRuntimeInvalidation$, {
        orgId: args.orgId,
        userId: args.userId,
        connectionId: args.connectionId,
      });
    }
    return result;
  },
);

export const resetSshConnectionHostKey$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectionId: string;
      readonly expectedGeneration: number;
    },
  ): Promise<SshConnectionResult<SshConnectionResponse>> => {
    const db = set(writeDb$);
    const result = await db.transaction<
      SshConnectionResult<SshConnectionResponse>
    >(async (tx) => {
      const [current] = await tx
        .select()
        .from(sshConnections)
        .where(
          and(
            eq(sshConnections.id, args.connectionId),
            eq(sshConnections.orgId, args.orgId),
            eq(sshConnections.userId, args.userId),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) {
        return failure("notFound");
      }
      if (current.generation !== args.expectedGeneration) {
        return failure("generationConflict");
      }

      if (current.generation === 2_147_483_647) {
        return sshCredentialFailure("exhausted");
      }
      const [credential] = await tx
        .select(credentialSelection)
        .from(sshCredentials)
        .where(ownedSshCredential(args, current.credentialId));
      if (!credential) {
        throw new Error("SSH connection credential is missing");
      }
      const [updated] = await tx
        .update(sshConnections)
        .set({
          learnedHostKeyAlgorithm: null,
          learnedHostKeyFingerprint: null,
          generation: sql`${sshConnections.generation} + 1`,
          updatedAt: nowDate(),
        })
        .where(eq(sshConnections.id, current.id))
        .returning();
      if (!updated) {
        throw new Error("SSH host-key reset returned no row");
      }
      return { ok: true, value: toSshConnectionResponse(updated, credential) };
    });
    if (result.ok) {
      await set(publishSshRuntimeInvalidation$, {
        orgId: args.orgId,
        userId: args.userId,
        connectionId: args.connectionId,
      });
    }
    return result;
  },
);

export async function matchSshConnectionCredentials(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly privateKey: string;
  readonly passphrase: string | null;
}): Promise<
  | {
      readonly privateKeyMatches: boolean;
      readonly passphraseMatches: boolean;
    }
  | undefined
> {
  const connection = await findOwnerConnection(args.db, args);
  if (!connection) {
    return undefined;
  }

  const [credential] = await args.db
    .select({
      encryptedPrivateKey: sshCredentials.encryptedPrivateKey,
      encryptedPassphrase: sshCredentials.encryptedPassphrase,
    })
    .from(sshCredentials)
    .where(eq(sshCredentials.id, connection.credentialId))
    .limit(1);
  if (!credential) {
    throw new Error("SSH connection credential row is missing");
  }

  if (credential.encryptedPrivateKey === null) {
    return { privateKeyMatches: false, passphraseMatches: false };
  }
  const privateKey = await decryptStoredSecretValue(
    credential.encryptedPrivateKey,
  );
  const passphrase =
    credential.encryptedPassphrase === null
      ? null
      : await decryptStoredSecretValue(credential.encryptedPassphrase);
  return {
    privateKeyMatches: privateKey === args.privateKey,
    passphraseMatches: passphrase === args.passphrase,
  };
}

function visibleSshAccessConfig(
  owner: { readonly orgId: string; readonly userId: string },
  id: string,
) {
  return and(
    eq(cloudflareAccessConfigs.orgId, owner.orgId),
    eq(cloudflareAccessConfigs.id, id),
    or(
      eq(cloudflareAccessConfigs.scope, "organization"),
      and(
        eq(cloudflareAccessConfigs.scope, "personal"),
        eq(cloudflareAccessConfigs.userId, owner.userId),
      ),
    ),
  );
}
function ownedSshConnection(owner: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
}) {
  return and(
    eq(sshConnections.id, owner.connectionId),
    eq(sshConnections.orgId, owner.orgId),
    eq(sshConnections.userId, owner.userId),
  );
}

function requestedSshAccessId(
  body: UpdateSshConnectionRequest,
  currentId: string | null,
) {
  const transport = body.transport;
  return transport === undefined
    ? currentId
    : transport.type === "cloudflare_access" && "configId" in transport
      ? transport.configId
      : null;
}
function validateSshHostUpdate(
  current: SshConnectionRow,
  args: {
    readonly body: UpdateSshConnectionRequest;
    readonly host: string;
    readonly port: number;
    readonly accessId: string | null;
    readonly creatingAccess: boolean;
  },
): (SshConnectionFailure & { readonly ok: false }) | undefined {
  if (
    (args.accessId !== null || args.creatingAccess) &&
    (isIP(args.host) !== 0 || !args.host.includes(".") || args.port !== 443)
  ) {
    return failure("invalidHost");
  }
  if (current.generation !== args.body.expectedGeneration) {
    return failure("generationConflict");
  }
  if (current.needsRebind && args.body.transport === undefined) {
    return {
      ok: false,
      kind: "bad_request",
      code: SSH_ERROR_CODES.INVALID_INPUT,
      message: "Choose a transport to recover this SSH host",
    };
  }
  if (current.generation === 2_147_483_647) {
    return sshCredentialFailure("exhausted");
  }
  return undefined;
}
function sshHostUpdateValues(
  current: SshConnectionRow,
  args: {
    readonly body: UpdateSshConnectionRequest;
    readonly host: string;
    readonly port: number;
    readonly credentialId: string;
    readonly accessId: string | null;
  },
) {
  const endpointChanged = shouldClearLearnedHostKey(
    current,
    args.host,
    args.port,
    args.accessId,
  );
  return {
    displayName: args.body.displayName,
    host: args.host,
    port: args.port,
    credentialId: args.credentialId,
    cloudflareAccessId: args.accessId,
    needsRebind: false,
    learnedHostKeyAlgorithm: endpointChanged
      ? null
      : current.learnedHostKeyAlgorithm,
    learnedHostKeyFingerprint: endpointChanged
      ? null
      : current.learnedHostKeyFingerprint,
    generation: sql`${sshConnections.generation} + 1`,
    updatedAt: nowDate(),
  };
}

function sshConnectionCreationValues(
  args: PreparedSshConnectionCreation,
  credentialId: string,
  accessId: string | null,
) {
  return {
    id: args.body.id,
    orgId: args.orgId,
    userId: args.userId,
    displayName: args.body.displayName,
    host: args.canonicalHost,
    port: args.body.port,
    credentialId,
    cloudflareAccessId: accessId,
  };
}
