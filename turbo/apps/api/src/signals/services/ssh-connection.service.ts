import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import type {
  CreateSshConnectionRequest,
  SshConnectionResponse,
  UpdateSshConnectionRequest,
} from "@okouai/api-contracts/contracts/ssh-connections";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { agents } from "@okouai/db/schema/agent";
import { agentSshAccess } from "@okouai/db/schema/agent-ssh-access";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import {
  findSshCredential,
  lockSshOwner,
  prepareSshCredentialSelection,
  selectSshCredential,
  sshCredentialFailure,
} from "./ssh-credential.service";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { and, asc, count, eq, sql } from "drizzle-orm";

import {
  SSH_ERROR_CODES,
  type SshErrorCode,
} from "@okouai/api-contracts/contracts/ssh-errors";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { decryptStoredSecretValue } from "./crypto.utils";
import { publishSshRuntimeInvalidation } from "./ssh-runtime-wakeup.service";
import { checkSshCreationId } from "./ssh-creation.service";
import {
  cloudflareAccessFailure,
  insertCloudflareAccessConfig,
  lockCloudflareAccessConfigForBinding,
  prepareCloudflareAccessConfig,
} from "./cloudflare-access.service";
import { publishCloudflareAccessMutationInvalidation } from "./cloudflare-access-client-invalidation.service";

type SshConnectionRow = typeof sshConnections.$inferSelect;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
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
type UpdateSshConnectionArgs = {
  readonly db: Db;
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

async function validateAccessBinding(
  tx: Transaction,
  owner: { readonly orgId: string; readonly userId: string },
  binding: { readonly configId: string | null; readonly creating: boolean },
  host: string,
  port: number,
) {
  const { configId, creating } = binding;
  if (configId === null && !creating) {
    return null;
  }
  if (isIP(host) !== 0 || !host.includes(".") || port !== 443) {
    return failure("invalidHost");
  }
  if (configId === null) {
    return null;
  }
  const config = await lockCloudflareAccessConfigForBinding(
    tx,
    owner,
    configId,
  );
  return config ? null : cloudflareAccessFailure("notFound");
}

function prepareAccessCreation(
  transport: CreateSshConnectionRequest["transport"],
  context: FeatureSwitchContext,
) {
  return transport?.type === "cloudflare_access" && "create" in transport
    ? prepareCloudflareAccessConfig(transport.create, context)
    : undefined;
}

async function insertAccessBinding(
  tx: Transaction,
  owner: { readonly orgId: string; readonly userId: string },
  prepared: Awaited<ReturnType<typeof prepareAccessCreation>>,
  configId: string | null,
) {
  if (prepared === undefined) {
    return { id: configId, created: false } as const;
  }
  const config = await insertCloudflareAccessConfig(tx, owner, prepared);
  return { id: config.id, created: true } as const;
}

function publishSshConnectionMutationInvalidation(
  db: ReadonlyDb,
  owner: { readonly orgId: string; readonly userId: string },
  connectionId: string | null,
  createdAccess: boolean,
): Promise<void> {
  const publishSshInvalidation = () => {
    return publishSshRuntimeInvalidation(db, { ...owner, connectionId });
  };
  return createdAccess
    ? publishCloudflareAccessMutationInvalidation(owner, publishSshInvalidation)
    : publishSshInvalidation();
}

async function validateAccessTransition(
  tx: Transaction,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly body: UpdateSshConnectionRequest;
  },
  current: SshConnectionRow,
  host: string,
  port: number,
): Promise<SshConnectionResult<string | null>> {
  const accessId =
    args.body.transport === undefined
      ? current.cloudflareAccessId
      : args.body.transport.type === "direct"
        ? null
        : "configId" in args.body.transport
          ? args.body.transport.configId
          : null;
  const bindingFailure = await validateAccessBinding(
    tx,
    args,
    {
      configId: accessId,
      creating:
        args.body.transport?.type === "cloudflare_access" &&
        "create" in args.body.transport,
    },
    host,
    port,
  );
  return bindingFailure ?? { ok: true, value: accessId };
}

async function lockAccessBeforeHostUpdate(
  tx: Transaction,
  args: UpdateSshConnectionArgs,
  preflight: SshConnectionRow,
): Promise<boolean> {
  // Rotation locks the configuration before collecting host rows. Take the
  // same lock before this host's row lock, including for an unchanged binding.
  const transport = args.body.transport;
  const targetAccessId =
    transport === undefined
      ? preflight.cloudflareAccessId
      : transport.type === "cloudflare_access" && "configId" in transport
        ? transport.configId
        : null;
  return (
    targetAccessId === null ||
    Boolean(
      await lockCloudflareAccessConfigForBinding(tx, args, targetAccessId),
    )
  );
}

async function lockOwnerHostForUpdate(
  tx: Transaction,
  args: UpdateSshConnectionArgs,
): Promise<SshConnectionResult<SshConnectionRow>> {
  await lockSshOwner(tx, args);
  // A previous request may have changed the binding after the optimistic
  // preflight. The owner lock makes this fresh read stable against host writes.
  const currentBinding = await findOwnerConnection(tx, args);
  if (!currentBinding) {
    return failure("notFound");
  }
  if (!(await lockAccessBeforeHostUpdate(tx, args, currentBinding))) {
    return cloudflareAccessFailure("notFound");
  }
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
  return current ? { ok: true, value: current } : failure("notFound");
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

export async function createSshConnection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly body: CreateSshConnectionRequest;
  readonly featureContext: FeatureSwitchContext;
}): Promise<SshConnectionResult<SshConnectionResponse | undefined>> {
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

  const result = await args.db.transaction(async (tx) => {
    await lockSshOwner(tx, args);
    const creation = await checkSshCreationId(
      tx,
      args,
      sshConnections,
      args.body.id,
    );
    if (!creation.ok) {
      return creation;
    }
    if (!creation.value) {
      return {
        ok: true as const,
        value: undefined,
        authorizedAgents: false,
        createdAccess: false,
      };
    }
    const bindingFailure = await validateAccessBinding(
      tx,
      args,
      { configId: accessId, creating: preparedAccess !== undefined },
      canonicalHost.value,
      args.body.port,
    );
    if (bindingFailure) {
      return bindingFailure;
    }
    const credential = await selectSshCredential(tx, args, preparedCredential);
    if (!credential.ok) {
      return credential;
    }
    const selectedAccess = await insertAccessBinding(
      tx,
      args,
      preparedAccess,
      accessId,
    );
    // Match Connector's zero-to-one account transition, including re-adding
    // after all hosts were deleted. The owner lock serializes concurrent adds.
    const firstHost =
      (await countOwnerConnections(tx, args.orgId, args.userId)) === 0;
    const visibleAgents = firstHost
      ? await tx
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.orgId, args.orgId),
              visibleJoinedAgentCondition(args.userId),
            ),
          )
          .orderBy(asc(agents.id))
          .for("update")
      : [];
    const [connection] = await tx
      .insert(sshConnections)
      .values({
        id: args.body.id,
        orgId: args.orgId,
        userId: args.userId,
        displayName: args.body.displayName,
        host: canonicalHost.value,
        port: args.body.port,
        credentialId: credential.value.id,
        cloudflareAccessId: selectedAccess.id,
      })
      .returning();
    if (!connection) {
      throw new Error("SSH connection insert returned no row");
    }
    if (visibleAgents.length > 0) {
      await tx
        .insert(agentSshAccess)
        .values(
          visibleAgents.map((agent) => {
            return {
              orgId: args.orgId,
              userId: args.userId,
              agentId: agent.id,
            };
          }),
        )
        .onConflictDoNothing();
    }
    return {
      ok: true as const,
      value: toSshConnectionResponse(connection, credential.value),
      authorizedAgents: visibleAgents.length > 0,
      createdAccess: selectedAccess.created,
    };
  });
  if (result.ok && result.value) {
    await publishSshConnectionMutationInvalidation(
      args.db,
      args,
      result.authorizedAgents ? null : result.value.id,
      result.createdAccess,
    );
  }
  return result;
}

export async function updateSshConnection(
  args: UpdateSshConnectionArgs,
): Promise<SshConnectionResult<SshConnectionResponse>> {
  const canonicalHost =
    args.body.host === undefined
      ? undefined
      : canonicalizeSshHost(args.body.host);
  if (canonicalHost !== undefined && !canonicalHost.ok) {
    return canonicalHost;
  }
  const preflight = await findOwnerConnection(args.db, args);
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

  const result = await args.db.transaction<
    SshConnectionMutationResult<SshConnectionResponse>
  >(async (tx) => {
    const locked = await lockOwnerHostForUpdate(tx, args);
    if (!locked.ok) {
      return locked;
    }
    const current = locked.value;
    const host = canonicalHost?.value ?? current.host;
    const port = args.body.port ?? current.port;
    const binding = await validateAccessTransition(
      tx,
      args,
      current,
      host,
      port,
    );
    if (!binding.ok) {
      return binding;
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
    const selected =
      preparedCredential === undefined
        ? undefined
        : await selectSshCredential(tx, args, preparedCredential);
    if (selected && !selected.ok) {
      return selected;
    }
    const credential =
      selected?.value ??
      (await findSshCredential(tx, args, current.credentialId));
    if (!credential) {
      throw new Error("SSH connection credential is missing");
    }
    const selectedAccess = await insertAccessBinding(
      tx,
      args,
      preparedAccess,
      binding.value,
    );
    const endpointChanged =
      (host !== current.host || port !== current.port) &&
      current.cloudflareAccessId === null &&
      selectedAccess.id === null;
    const [updated] = await tx
      .update(sshConnections)
      .set({
        displayName: args.body.displayName,
        host,
        port,
        credentialId: credential.id,
        cloudflareAccessId: selectedAccess.id,
        needsRebind: false,
        learnedHostKeyAlgorithm: endpointChanged
          ? null
          : current.learnedHostKeyAlgorithm,
        learnedHostKeyFingerprint: endpointChanged
          ? null
          : current.learnedHostKeyFingerprint,
        generation: sql`${sshConnections.generation} + 1`,
        updatedAt: nowDate(),
      })
      .where(eq(sshConnections.id, current.id))
      .returning();
    if (!updated) {
      throw new Error("SSH connection update returned no row");
    }
    return {
      ok: true,
      value: toSshConnectionResponse(updated, credential),
      createdAccess: selectedAccess.created,
    };
  });
  if (result.ok) {
    await publishSshConnectionMutationInvalidation(
      args.db,
      args,
      args.connectionId,
      result.createdAccess,
    );
  }
  return result;
}

export async function deleteSshConnection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
}): Promise<SshConnectionResult<undefined>> {
  const transaction = await settle(
    args.db.transaction<SshConnectionResult<undefined>>(async (tx) => {
      await lockSshOwner(tx, args);
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
    await publishSshRuntimeInvalidation(args.db, {
      orgId: args.orgId,
      userId: args.userId,
      connectionId: args.connectionId,
    });
  }
  return result;
}

export async function resetSshConnectionHostKey(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly expectedGeneration: number;
}): Promise<SshConnectionResult<SshConnectionResponse>> {
  const result = await args.db.transaction<
    SshConnectionResult<SshConnectionResponse>
  >(async (tx) => {
    await lockSshOwner(tx, args);
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
    const credential = await findSshCredential(tx, args, current.credentialId);
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
    await publishSshRuntimeInvalidation(args.db, {
      orgId: args.orgId,
      userId: args.userId,
      connectionId: args.connectionId,
    });
  }
  return result;
}

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
