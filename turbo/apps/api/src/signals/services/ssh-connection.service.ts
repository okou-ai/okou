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
  prepareSshCredentialSelection,
  selectSshCredential,
  sshCredentialFailure,
} from "./ssh-credential.service";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { and, asc, count, eq, sql } from "drizzle-orm";

import {
  SSH_ERROR_CODES,
  type SshErrorCode,
} from "@okouai/api-contracts/contracts/ssh-errors";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { decryptStoredSecretValue } from "./crypto.utils";
import { publishSshRuntimeInvalidation } from "./ssh-runtime-wakeup.service";
import { lockSshOwner } from "./ssh-owner.service";
import {
  findSshSaveAttempt,
  recordSshSaveAttempt,
  sshSaveAttemptResolved,
} from "./ssh-save-attempt.service";
import {
  cloudflareAccessFailure,
  findCloudflareAccessConfig,
  insertCloudflareAccessConfig,
  prepareCloudflareAccessConfig,
} from "./cloudflare-access.service";

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
    ...(row.cloudflareAccessId === null
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
  db: Pick<ReadonlyDb, "select">,
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
  const config = await findCloudflareAccessConfig(db, owner, configId);
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
  return prepared === undefined
    ? configId
    : (await insertCloudflareAccessConfig(tx, owner, prepared)).id;
}

async function validateAccessTransition(
  db: Pick<ReadonlyDb, "select">,
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
    db,
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
}): Promise<SshConnectionResult<SshConnectionResponse>> {
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
    if (await findSshSaveAttempt(tx, args, args.body.saveAttemptId)) {
      return sshSaveAttemptResolved;
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
    const selectedAccessId = await insertAccessBinding(
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
        orgId: args.orgId,
        userId: args.userId,
        displayName: args.body.displayName,
        host: canonicalHost.value,
        port: args.body.port,
        credentialId: credential.value.id,
        cloudflareAccessId: selectedAccessId,
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
    await recordSshSaveAttempt(tx, args, args.body.saveAttemptId, true);
    return {
      ok: true as const,
      value: toSshConnectionResponse(connection, credential.value),
      authorizedAgents: visibleAgents.length > 0,
    };
  });
  if (result.ok) {
    await publishSshRuntimeInvalidation(args.db, {
      orgId: args.orgId,
      userId: args.userId,
      connectionId: result.authorizedAgents ? null : result.value.id,
    });
  }
  return result;
}

async function resolveUpdatedCredential(
  tx: Transaction,
  current: SshConnectionRow,
  prepared:
    | Awaited<ReturnType<typeof prepareSshCredentialSelection>>
    | undefined,
) {
  const owner = { orgId: current.orgId, userId: current.userId };
  if (prepared !== undefined) {
    return await selectSshCredential(tx, owner, prepared);
  }
  const credential = await findSshCredential(tx, owner, current.credentialId);
  if (!credential) {
    throw new Error("SSH connection credential is missing");
  }
  return { ok: true as const, value: credential };
}

export async function updateSshConnection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly body: UpdateSshConnectionRequest;
  readonly featureContext: FeatureSwitchContext;
}): Promise<SshConnectionResult<SshConnectionResponse>> {
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
    SshConnectionResult<SshConnectionResponse>
  >(async (tx) => {
    await lockSshOwner(tx, args);
    if (await findSshSaveAttempt(tx, args, args.body.saveAttemptId)) {
      return sshSaveAttemptResolved;
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
    if (!current) {
      return failure("notFound");
    }
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

    if (current.generation === 2_147_483_647) {
      return sshCredentialFailure("exhausted");
    }
    const selected = await resolveUpdatedCredential(
      tx,
      current,
      preparedCredential,
    );
    if (!selected.ok) {
      return selected;
    }
    const credential = selected.value;
    const accessId = await insertAccessBinding(
      tx,
      args,
      preparedAccess,
      binding.value,
    );
    const endpointChanged =
      (host !== current.host || port !== current.port) &&
      current.cloudflareAccessId === null &&
      accessId === null;
    const [updated] = await tx
      .update(sshConnections)
      .set({
        displayName: args.body.displayName,
        host,
        port,
        credentialId: credential.id,
        cloudflareAccessId: accessId,
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

    await recordSshSaveAttempt(tx, args, args.body.saveAttemptId, true);
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

export async function deleteSshConnection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
}): Promise<SshConnectionResult<undefined>> {
  const result = await args.db.transaction<SshConnectionResult<undefined>>(
    async (tx) => {
      await lockSshOwner(tx, args);
      const current = await findOwnerConnection(tx, args);
      if (!current) {
        return failure("notFound");
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
    },
  );
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
