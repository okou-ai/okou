import { command } from "ccstate";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
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
  ownedSshCredential,
  prepareSshCredentialSelection,
  isSshCredentialReferenceViolation,
  sshCredentialFailure,
} from "./ssh-credential.service";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import {
  and,
  asc,
  count,
  eq,
  exists,
  getTableColumns,
  or,
  sql,
} from "drizzle-orm";
import {
  pgBooleanDecoder,
  pgIntegerDecoder,
} from "../../lib/db-structured-result";
import {
  createSshCreationReads,
  createSshUpdateReads,
  stampedSshTailscaleConfig,
  stampedSshCredential,
  ownedSshConnection,
  visibleSshAccessConfig,
} from "./ssh-binding-query";
import {
  inlineSshCredentialSource,
  inlineSshAccessSource,
  inlineSshTailscaleSource,
  sshConnectionCreationSource,
  sshBindingUpdateValues,
} from "./ssh-binding-values";

import {
  SSH_ERROR_CODES,
  type SshErrorCode,
} from "@okouai/api-contracts/contracts/ssh-errors";
import {
  isForeignKeyViolation,
  safeSqlStateCode,
  isUniqueViolation,
} from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { publishSshRuntimeInvalidation$ } from "./ssh-runtime-wakeup.service";
import { sshCreationResult, resourceIdConflict } from "./ssh-creation.service";
import {
  cloudflareAccessFailure,
  prepareCloudflareAccessConfig,
} from "./cloudflare-access.service";
import { publishCloudflareAccessClientInvalidation } from "./cloudflare-access-client-invalidation.service";
import {
  prepareTailscaleConfig,
  requestedTailscaleId,
  prepareInlineTailscaleConfig,
} from "./tailscale.service";
import { canonicalTailscaleDestination } from "./tailscale-destination";
import {
  selectedTailscaleBindingId,
  tailscaleFailure,
  visibleTailscaleConfig,
} from "./tailscale-config-model";
import { publishTailscaleClientInvalidation } from "./tailscale-client-invalidation.service";

const MAX_SSH_GENERATION = 2_147_483_647;
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

/** A Cloudflare Access config deleted after the visibility read is not found. */
function isCloudflareAccessReferenceViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    isForeignKeyViolation(error) &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "constraint" in error.cause &&
    error.cause.constraint === "ssh_connections_cloudflare_access_org_fk"
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
    ...(row.transport === "direct"
      ? {}
      : row.transport === "tailscale"
        ? {
            transport:
              row.tailscaleId === null
                ? { type: "tailscale" as const, needsRebind: true as const }
                : { type: "tailscale" as const, configId: row.tailscaleId },
          }
        : {
            transport:
              row.cloudflareAccessId === null
                ? {
                    type: "cloudflare_access" as const,
                    needsRebind: true as const,
                  }
                : {
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

export const listSshConnections$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<readonly SshConnectionResponse[]> => {
    const db = set(writeDb$);
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
    signal.throwIfAborted();
    return rows.map(({ connection, credential }) => {
      return toSshConnectionResponse(connection, credential);
    });
  },
);

export const summarizeSshConnections$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<{ readonly configuredCount: number }> => {
    const db = set(writeDb$);
    const [result] = await db
      .select({ configuredCount: count() })
      .from(sshConnections)
      .where(
        and(eq(sshConnections.orgId, orgId), eq(sshConnections.userId, userId)),
      );
    signal.throwIfAborted();
    if (!result) {
      throw new Error("SSH connection count query returned no row");
    }
    return result;
  },
);

export interface PreparedSshConnectionCreation extends CreateSshConnectionArgs {
  readonly canonicalHost: string;
  readonly accessId: string | null;
  readonly tailscaleId: string | null;
  readonly preparedTailscale:
    Awaited<ReturnType<typeof prepareTailscaleConfig>> | undefined;
  readonly preparedAccess: Awaited<ReturnType<typeof prepareAccessCreation>>;
  readonly preparedCredential: Awaited<
    ReturnType<typeof prepareSshCredentialSelection>
  >;
}

// Pure sessionless SQL construction; execution remains in the owning command.
function sshConnectionCreationAdmission(args: PreparedSshConnectionCreation) {
  const endpointValid =
    (args.accessId === null && args.preparedAccess === undefined) ||
    !invalidSshAccessEndpoint(args.canonicalHost, args.body.port);
  const reads = createSshCreationReads(args, endpointValid);
  const selectedId = selectedTailscaleBindingId(
    args.tailscaleId,
    args.preparedTailscale !== undefined,
  );
  const predicate = and(
    selectedId === null ? sql`false` : visibleTailscaleConfig(args, selectedId),
    exists(reads.qb.select({ id: reads.admission.id }).from(reads.admission)),
  );
  if (predicate === undefined) {
    throw new Error("SSH Tailscale admission predicate is missing");
  }
  const stamp = stampedSshTailscaleConfig(
    reads.qb,
    "stamped_ssh_creation_tailscale",
    predicate,
  );
  const networkReady = reads.qb.$with("complete_ssh_creation_admission").as(
    reads.qb
      .select({ id: reads.admission.id })
      .from(reads.admission)
      .where(
        selectedId === null
          ? sql`true`
          : exists(reads.qb.select({ id: stamp.id }).from(stamp)),
      ),
  );
  const credentialPredicate = and(
    args.preparedCredential.id === undefined
      ? sql`false`
      : ownedSshCredential(args, args.preparedCredential.id),
    exists(reads.qb.select({ id: networkReady.id }).from(networkReady)),
  );
  if (credentialPredicate === undefined) {
    throw new Error("SSH credential admission predicate is missing");
  }
  const credentialStamp = stampedSshCredential(
    reads.qb,
    "stamped_ssh_creation_credential",
    credentialPredicate,
  );
  const ready = reads.qb.$with("admitted_ssh_creation_credential").as(
    reads.qb
      .select({ id: networkReady.id })
      .from(networkReady)
      .where(
        args.preparedCredential.id === undefined
          ? sql`true`
          : exists(
              reads.qb.select({ id: credentialStamp.id }).from(credentialStamp),
            ),
      ),
  );
  return {
    reads,
    endpointValid,
    selectedId,
    stamp,
    networkReady,
    credentialStamp,
    ready,
  };
}
const commitSshConnectionCreationAttempt$ = command(
  async (
    { set },
    args: PreparedSshConnectionCreation,
  ): Promise<
    SshConnectionMutationResult<SshConnectionResponse | undefined>
  > => {
    const db = set(writeDb$);
    const {
      reads,
      endpointValid,
      selectedId,
      stamp,
      networkReady,
      credentialStamp,
      ready,
    } = sshConnectionCreationAdmission(args);
    const prepared = args.preparedCredential;
    const credential =
      prepared.id === undefined
        ? db.$with("inline_ssh_creation_credential").as(
            db
              .insert(sshCredentials)
              .select(inlineSshCredentialSource(args, prepared.create, ready))
              .returning({
                id: sshCredentials.id,
                name: sshCredentials.name,
                username: sshCredentials.username,
              }),
          )
        : credentialStamp;
    const access =
      args.preparedAccess === undefined
        ? undefined
        : db.$with("inline_ssh_creation_access").as(
            db
              .insert(cloudflareAccessConfigs)
              .select(inlineSshAccessSource(args, args.preparedAccess, ready))
              .returning({ id: cloudflareAccessConfigs.id }),
          );
    const tailscale =
      args.preparedTailscale === undefined
        ? undefined
        : db.$with("inline_ssh_creation_tailscale").as(
            db
              .insert(tailscaleConfigs)
              .select(
                inlineSshTailscaleSource(args, args.preparedTailscale, ready),
              )
              .returning({ id: tailscaleConfigs.id }),
          );
    const accessId =
      access === undefined
        ? sql`${args.accessId}::uuid`
        : sql`(${reads.qb.select({ id: access.id }).from(access)})`;
    const tailscaleId =
      tailscale === undefined
        ? sql`${args.tailscaleId}::uuid`
        : sql`(${reads.qb.select({ id: tailscale.id }).from(tailscale)})`;
    const written = db.$with("created_ssh_binding_host").as(
      db
        .insert(sshConnections)
        .select(
          sshConnectionCreationSource(
            args,
            ready,
            sql`(${reads.qb.select({ id: credential.id }).from(credential)})`,
            accessId,
            tailscaleId,
          ),
        )
        .returning(),
    );
    const complete =
      sql`1 / CASE WHEN (${db.select({ count: count() }).from(written)}) = (${db.select({ count: count() }).from(ready)}) THEN 1 ELSE 0 END`.mapWith(
        pgIntegerDecoder,
      );
    const [captured] = await db
      .with(
        ...reads.ctes,
        stamp,
        networkReady,
        credentialStamp,
        ready,
        ...(prepared.id === undefined ? [credential] : []),
        ...(access === undefined ? [] : [access]),
        ...(tailscale === undefined ? [] : [tailscale]),
        written,
      )
      .select({
        existing: { ...reads.current._.selectedFields },
        credentialAvailable: (prepared.id === undefined
          ? sql`true`
          : sql`${exists(reads.qb.select({ id: credential.id }).from(credential))}`
        ).mapWith(pgBooleanDecoder),
        changed: { ...written._.selectedFields },
        credential: { ...credential._.selectedFields },
        access:
          sql`${exists(db.select({ id: reads.access.id }).from(reads.access))}`.mapWith(
            pgBooleanDecoder,
          ),
        tailscale:
          sql`${exists(db.select({ id: stamp.id }).from(stamp))}`.mapWith(
            pgBooleanDecoder,
          ),
        complete,
      })
      .from(reads.anchor)
      .leftJoin(reads.current, eq(reads.current.id, reads.anchor.id))
      .leftJoin(written, eq(written.id, reads.anchor.id))
      .leftJoin(credential, eq(credential.id, written.credentialId));
    return sshCreationOutcome(
      args,
      captured,
      endpointValid,
      selectedId,
      access !== undefined,
    );
  },
);
const commitSshConnectionCreation$ = command(
  async (
    { set },
    args: PreparedSshConnectionCreation,
  ): Promise<
    SshConnectionMutationResult<SshConnectionResponse | undefined>
  > => {
    const transaction = await settle(
      set(commitSshConnectionCreationAttempt$, args),
    );
    if (!transaction.ok) {
      if (isSshCredentialReferenceViolation(transaction.error)) {
        return sshCredentialFailure("notFound");
      }
      if (isTailscaleReferenceViolation(transaction.error)) {
        return tailscaleFailure("notFound");
      }
      if (isCloudflareAccessReferenceViolation(transaction.error)) {
        return cloudflareAccessFailure("notFound");
      }
      if (
        !isUniqueViolation(transaction.error, "ssh_connections_pkey") &&
        !isUniqueViolation(transaction.error, "uq_ssh_connections_owner_id")
      ) {
        throw transaction.error;
      }
      const [existing] = await set(writeDb$)
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
    const tailscaleTransport =
      args.body.transport?.type === "tailscale"
        ? args.body.transport
        : undefined;
    const canonicalHost = canonicalizeSelectedSshHost(
      args.body.host,
      tailscaleTransport !== undefined,
    );
    if (!canonicalHost.ok) {
      return canonicalHost;
    }

    const accessId =
      args.body.transport?.type === "cloudflare_access" &&
      "configId" in args.body.transport
        ? args.body.transport.configId
        : null;
    if (accessId !== null) {
      const db = set(writeDb$);
      const [config] = await db
        .select({ id: cloudflareAccessConfigs.id })
        .from(cloudflareAccessConfigs)
        .where(visibleSshAccessConfig(args, accessId));
      if (!config) {
        return cloudflareAccessFailure("notFound");
      }
    }
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
      tailscaleId: requestedTailscaleId(args.body.transport),
      preparedTailscale: await prepareInlineTailscaleConfig(
        args.body.transport,
        args.featureContext,
      ),
    });
    if (result.ok && result.value) {
      if (
        args.body.transport?.type === "tailscale" &&
        "create" in args.body.transport
      ) {
        await publishTailscaleClientInvalidation(args);
      }
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

export interface PreparedSshConnectionUpdate extends UpdateSshConnectionArgs {
  readonly tailscaleId: string | null;
  readonly preparedTailscale:
    Awaited<ReturnType<typeof prepareTailscaleConfig>> | undefined;
  readonly host: string;
  readonly port: number;
  readonly accessId: string | null;
  readonly preparedAccess: Awaited<ReturnType<typeof prepareAccessCreation>>;
  readonly preparedCredential:
    Awaited<ReturnType<typeof prepareSshCredentialSelection>> | undefined;
}

// Pure SQL/column projections; no database executor is captured or returned.
function sshConnectionUpdateAdmission(args: PreparedSshConnectionUpdate) {
  const endpointValid =
    (args.accessId === null && args.preparedAccess === undefined) ||
    !invalidSshAccessEndpoint(args.host, args.port);
  const reads = createSshUpdateReads(args, endpointValid);
  const selectedId = selectedTailscaleBindingId(
    args.tailscaleId,
    args.preparedTailscale !== undefined,
  );
  const predicate = and(
    selectedId === null ? sql`false` : visibleTailscaleConfig(args, selectedId),
    reads.entering,
  );
  if (predicate === undefined) {
    throw new Error("SSH Tailscale admission predicate is missing");
  }
  const stamp = stampedSshTailscaleConfig(
    reads.qb,
    "stamped_ssh_binding_tailscale",
    predicate,
  );
  const networkReady = reads.qb.$with("complete_ssh_binding_admission").as(
    reads.qb
      .select({ id: reads.admission.id })
      .from(reads.admission)
      .where(
        selectedId === null
          ? sql`true`
          : or(
              exists(reads.qb.select({ id: stamp.id }).from(stamp)),
              exists(
                reads.qb.select({ id: reads.retained.id }).from(reads.retained),
              ),
            ),
      ),
  );
  const selectedCredentialId = args.preparedCredential?.id;
  const credentialPredicate = and(
    selectedCredentialId === undefined
      ? sql`false`
      : ownedSshCredential(args, selectedCredentialId),
    exists(reads.qb.select({ id: networkReady.id }).from(networkReady)),
  );
  if (credentialPredicate === undefined) {
    throw new Error("SSH credential admission predicate is missing");
  }
  const credentialStamp = stampedSshCredential(
    reads.qb,
    "stamped_ssh_binding_credential",
    credentialPredicate,
  );
  const ready = reads.qb.$with("admitted_ssh_binding_credential").as(
    reads.qb
      .select({ id: networkReady.id })
      .from(networkReady)
      .where(
        selectedCredentialId === undefined
          ? sql`true`
          : exists(
              reads.qb.select({ id: credentialStamp.id }).from(credentialStamp),
            ),
      ),
  );
  return { reads, selectedId, stamp, networkReady, credentialStamp, ready };
}
const commitSshConnectionUpdateAttempt$ = command(
  async (
    { set },
    args: PreparedSshConnectionUpdate,
  ): Promise<SshConnectionMutationResult<SshConnectionResponse>> => {
    const db = set(writeDb$);
    const { reads, selectedId, stamp, networkReady, credentialStamp, ready } =
      sshConnectionUpdateAdmission(args);
    const prepared = args.preparedCredential;
    const credential =
      prepared !== undefined && prepared.id === undefined
        ? db.$with("inline_ssh_binding_credential").as(
            db
              .insert(sshCredentials)
              .select(inlineSshCredentialSource(args, prepared.create, ready))
              .returning({
                id: sshCredentials.id,
                name: sshCredentials.name,
                username: sshCredentials.username,
              }),
          )
        : prepared === undefined
          ? reads.credential
          : credentialStamp;
    const access =
      args.preparedAccess === undefined
        ? undefined
        : db.$with("inline_ssh_binding_access").as(
            db
              .insert(cloudflareAccessConfigs)
              .select(inlineSshAccessSource(args, args.preparedAccess, ready))
              .returning({ id: cloudflareAccessConfigs.id }),
          );
    const tailscale =
      args.preparedTailscale === undefined
        ? undefined
        : db.$with("inline_ssh_binding_tailscale").as(
            db
              .insert(tailscaleConfigs)
              .select(
                inlineSshTailscaleSource(args, args.preparedTailscale, ready),
              )
              .returning({ id: tailscaleConfigs.id }),
          );
    const accessId =
      access === undefined
        ? sql`${args.accessId}::uuid`
        : sql`(${reads.qb.select({ id: access.id }).from(access)})`;
    const tailscaleId =
      tailscale === undefined
        ? sql`${args.tailscaleId}::uuid`
        : sql`(${reads.qb.select({ id: tailscale.id }).from(tailscale)})`;
    const written = db.$with("updated_ssh_binding_host").as(
      db
        .update(sshConnections)
        .set(
          sshBindingUpdateValues(
            args,
            reads.current,
            sql`(${reads.qb.select({ id: credential.id }).from(credential)})`,
            accessId,
            tailscaleId,
          ),
        )
        .from(reads.current)
        .where(
          and(
            eq(sshConnections.id, reads.current.id),
            exists(
              db
                .select({ id: ready.id })
                .from(ready)
                .where(eq(ready.id, reads.current.id)),
            ),
          ),
        )
        .returning(getTableColumns(sshConnections)),
    );
    const complete =
      sql`1 / CASE WHEN (${db.select({ count: count() }).from(written)}) = (${db.select({ count: count() }).from(ready)}) THEN 1 ELSE 0 END`.mapWith(
        pgIntegerDecoder,
      );
    const [captured] = await db
      .with(
        ...reads.ctes,
        stamp,
        networkReady,
        credentialStamp,
        ready,
        ...(prepared !== undefined && prepared.id === undefined
          ? [credential]
          : []),
        ...(access === undefined ? [] : [access]),
        ...(tailscale === undefined ? [] : [tailscale]),
        written,
      )
      .select({
        current: { ...reads.current._.selectedFields },
        credentialAvailable: (prepared !== undefined &&
        prepared.id === undefined
          ? sql`true`
          : sql`${exists(reads.qb.select({ id: credential.id }).from(credential))}`
        ).mapWith(pgBooleanDecoder),
        changed: { ...written._.selectedFields },
        credential: { ...credential._.selectedFields },
        access:
          sql`${exists(db.select({ id: reads.access.id }).from(reads.access))}`.mapWith(
            pgBooleanDecoder,
          ),
        tailscale:
          sql`${or(exists(db.select({ id: stamp.id }).from(stamp)), exists(db.select({ id: reads.retained.id }).from(reads.retained)))}`.mapWith(
            pgBooleanDecoder,
          ),
        complete,
      })
      .from(reads.current)
      .leftJoin(written, eq(written.id, reads.current.id))
      .leftJoin(credential, eq(credential.id, written.credentialId));
    return sshUpdateOutcome(args, captured, selectedId, access !== undefined);
  },
);

const commitSshConnectionUpdate$ = command(
  async (
    { set },
    args: PreparedSshConnectionUpdate,
  ): Promise<SshConnectionMutationResult<SshConnectionResponse>> => {
    const committed = await settle(
      set(commitSshConnectionUpdateAttempt$, args),
    );
    if (committed.ok) {
      return committed.value;
    }
    if (isSshCredentialReferenceViolation(committed.error)) {
      return sshCredentialFailure("notFound");
    }
    if (isTailscaleReferenceViolation(committed.error)) {
      return tailscaleFailure("notFound");
    }
    if (isCloudflareAccessReferenceViolation(committed.error)) {
      return cloudflareAccessFailure("notFound");
    }
    throw committed.error;
  },
);

const prepareSshConnectionUpdate$ = command(
  async (
    { set },
    args: UpdateSshConnectionArgs,
  ): Promise<SshConnectionResult<PreparedSshConnectionUpdate>> => {
    const db = set(writeDb$);
    const canonicalHost =
      args.body.host === undefined
        ? undefined
        : canonicalizeSshHost(args.body.host);
    if (canonicalHost !== undefined && !canonicalHost.ok) {
      return canonicalHost;
    }
    const [current] = await db
      .select()
      .from(sshConnections)
      .where(ownedSshConnection(args));
    if (!current) {
      return failure("notFound");
    }
    const accessId = requestedSshAccessId(
      args.body,
      current.cloudflareAccessId,
    );
    if (accessId !== null) {
      const [config] = await db
        .select({ id: cloudflareAccessConfigs.id })
        .from(cloudflareAccessConfigs)
        .where(visibleSshAccessConfig(args, accessId));
      if (!config) {
        return cloudflareAccessFailure("notFound");
      }
    }
    const tailscaleId = requestedTailscaleId(
      args.body.transport,
      current.tailscaleId,
    );
    if (tailscaleId !== null) {
      const [config] = await db
        .select({ id: tailscaleConfigs.id })
        .from(tailscaleConfigs)
        .where(visibleTailscaleConfig(args, tailscaleId));
      if (!config) {
        return tailscaleFailure("notFound");
      }
    }
    const selectedHost = canonicalizeUpdatedSshHost(
      current,
      args.body,
      canonicalHost?.value,
    );
    if (!selectedHost.ok) {
      return selectedHost;
    }
    const host = selectedHost.value;
    const port = args.body.port ?? current.port;
    const rejected = validateSshHostUpdate(current, {
      body: args.body,
      host,
      port,
      accessId,
      creatingAccess:
        args.body.transport?.type === "cloudflare_access" &&
        "create" in args.body.transport,
    });
    if (rejected) {
      return rejected;
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

    return {
      ok: true,
      value: {
        ...args,
        host,
        port,
        accessId,
        preparedAccess,
        preparedCredential,
        tailscaleId,
        preparedTailscale: await prepareInlineTailscaleConfig(
          args.body.transport,
          args.featureContext,
        ),
      },
    };
  },
);
export const updateSshConnection$ = command(
  async (
    { set },
    args: UpdateSshConnectionArgs,
  ): Promise<SshConnectionResult<SshConnectionResponse>> => {
    const prepared = await set(prepareSshConnectionUpdate$, args);
    if (!prepared.ok) {
      return prepared;
    }
    const result = await set(commitSshConnectionUpdate$, prepared.value);
    if (result.ok) {
      if (
        args.body.transport?.type === "tailscale" &&
        "create" in args.body.transport
      ) {
        await publishTailscaleClientInvalidation(args);
      }
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
    // The RESTRICT VNC FK rejects deleting a host used by a VNC connection.
    const deletion = await settle(
      db.delete(sshConnections).where(ownedSshConnection(args)).returning({
        id: sshConnections.id,
      }),
    );
    if (!deletion.ok) {
      if (isVncReferenceRestriction(deletion.error)) {
        return failure("connectionInUse");
      }
      throw deletion.error;
    }
    if (deletion.value.length === 0) {
      return failure("notFound");
    }
    await set(publishSshRuntimeInvalidation$, {
      orgId: args.orgId,
      userId: args.userId,
      connectionId: args.connectionId,
    });
    return { ok: true, value: undefined };
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
    const [current] = await db
      .select()
      .from(sshConnections)
      .where(ownedSshConnection(args))
      .limit(1);
    if (!current) {
      return failure("notFound");
    }
    if (current.generation !== args.expectedGeneration) {
      return failure("generationConflict");
    }
    if (current.generation === MAX_SSH_GENERATION) {
      return sshCredentialFailure("exhausted");
    }
    const [credential] = await db
      .select(credentialSelection)
      .from(sshCredentials)
      .where(ownedSshCredential(args, current.credentialId));
    if (!credential) {
      throw new Error("SSH connection credential is missing");
    }
    const [updated] = await db
      .update(sshConnections)
      .set({
        learnedHostKeyAlgorithm: null,
        learnedHostKeyFingerprint: null,
        generation: sql`${sshConnections.generation} + 1`,
        updatedAt: nowDate(),
      })
      .where(
        and(
          ownedSshConnection(args),
          eq(sshConnections.generation, args.expectedGeneration),
        ),
      )
      .returning();
    if (!updated) {
      // The conditional write lost without changing trust. Distinguish deletion
      // from a stale generation; never replay the reset against a newer Host.
      const [remaining] = await db
        .select({ id: sshConnections.id })
        .from(sshConnections)
        .where(ownedSshConnection(args))
        .limit(1);
      return failure(remaining ? "generationConflict" : "notFound");
    }
    await set(publishSshRuntimeInvalidation$, {
      orgId: args.orgId,
      userId: args.userId,
      connectionId: args.connectionId,
    });
    return { ok: true, value: toSshConnectionResponse(updated, credential) };
  },
);

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
function invalidSshAccessEndpoint(host: string, port: number) {
  return isIP(host) !== 0 || !host.includes(".") || port !== 443;
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
    invalidSshAccessEndpoint(args.host, args.port)
  ) {
    return failure("invalidHost");
  }
  if (current.generation !== args.body.expectedGeneration) {
    return failure("generationConflict");
  }
  if (
    current.transport !== "direct" &&
    (current.transport === "tailscale"
      ? current.tailscaleId === null
      : current.cloudflareAccessId === null) &&
    args.body.transport === undefined
  ) {
    return {
      ok: false,
      kind: "bad_request",
      code: SSH_ERROR_CODES.INVALID_INPUT,
      message: "Choose a transport to recover this SSH host",
    };
  }
  if (current.generation === MAX_SSH_GENERATION) {
    return sshCredentialFailure("exhausted");
  }
  return undefined;
}
interface SshBindingCapture {
  readonly credentialAvailable: boolean;
  readonly changed: SshConnectionRow | null;
  readonly credential: {
    readonly name: string;
    readonly username: string;
  } | null;
  readonly access: boolean;
  readonly tailscale: boolean;
}
function sshCreationOutcome(
  args: PreparedSshConnectionCreation,
  captured:
    | (SshBindingCapture & {
        readonly existing: {
          readonly orgId: string;
          readonly userId: string;
        } | null;
      })
    | undefined,
  endpointValid: boolean,
  selectedId: string | null,
  createdAccess: boolean,
): SshConnectionMutationResult<SshConnectionResponse | undefined> {
  if (!captured) {
    throw new Error("SSH creation admission returned no row");
  }
  const creation = sshCreationResult(args, captured.existing ?? undefined);
  if (!creation.ok) {
    return creation;
  }
  if (!creation.value) {
    return { ok: true, value: undefined, createdAccess: false };
  }
  if (!endpointValid) {
    return failure("invalidHost");
  }
  if (!captured.credentialAvailable) {
    return sshCredentialFailure("notFound");
  }
  if (args.accessId !== null && !captured.access) {
    return cloudflareAccessFailure("notFound");
  }
  if (selectedId !== null && !captured.tailscale) {
    return tailscaleFailure("notFound");
  }
  if (!captured.changed || !captured.credential) {
    throw new Error("SSH connection creation returned no row");
  }
  return {
    ok: true,
    value: toSshConnectionResponse(captured.changed, captured.credential),
    createdAccess,
  };
}
function sshUpdateOutcome(
  args: PreparedSshConnectionUpdate,
  captured:
    (SshBindingCapture & { readonly current: SshConnectionRow }) | undefined,
  selectedId: string | null,
  createdAccess: boolean,
): SshConnectionMutationResult<SshConnectionResponse> {
  if (!captured) {
    return failure("notFound");
  }
  const rejected = validateSshHostUpdate(captured.current, {
    body: args.body,
    host: args.host,
    port: args.port,
    accessId: args.accessId,
    creatingAccess: args.preparedAccess !== undefined,
  });
  if (rejected) {
    return rejected;
  }
  if (!captured.credentialAvailable) {
    return sshCredentialFailure("notFound");
  }
  if (args.accessId !== null && !captured.access) {
    return cloudflareAccessFailure("notFound");
  }
  if (selectedId !== null && !captured.tailscale) {
    return tailscaleFailure("notFound");
  }
  if (!captured.changed || !captured.credential) {
    throw new Error("SSH connection update returned no row");
  }
  return {
    ok: true,
    value: toSshConnectionResponse(captured.changed, captured.credential),
    createdAccess,
  };
}
function canonicalizeSelectedSshHost(
  host: string,
  tailscale: boolean,
): SshConnectionResult<string> {
  if (!tailscale) {
    return canonicalizeSshHost(host);
  }
  const peer = canonicalTailscaleDestination(host);
  return peer === null ? failure("invalidHost") : { ok: true, value: peer };
}

function canonicalizeUpdatedSshHost(
  current: SshConnectionRow,
  body: UpdateSshConnectionRequest,
  canonicalHost: string | undefined,
): SshConnectionResult<string> {
  const tailscale =
    body.transport?.type === "tailscale" ||
    (body.transport === undefined && current.transport === "tailscale");
  return tailscale
    ? canonicalizeSelectedSshHost(body.host ?? current.host, true)
    : { ok: true, value: canonicalHost ?? current.host };
}

function isTailscaleReferenceViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    isForeignKeyViolation(error) &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "constraint" in error.cause &&
    error.cause.constraint === "ssh_connections_tailscale_org_fk"
  );
}
