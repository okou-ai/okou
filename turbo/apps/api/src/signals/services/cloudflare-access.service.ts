import type {
  CloudflareAccessConfig,
  CreateCloudflareAccessRequest,
  UpdateCloudflareAccessRequest,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { and, asc, eq, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { encryptStoredSecretValue } from "./crypto.utils";
import { publishSshClientInvalidation } from "./ssh-client-invalidation.service";
import { lockSshOwner, sshCredentialFailure } from "./ssh-credential.service";
import { publishSshRuntimeInvalidation } from "./ssh-runtime-wakeup.service";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const metadata = Object.freeze({
  id: cloudflareAccessConfigs.id,
  name: cloudflareAccessConfigs.name,
  revision: cloudflareAccessConfigs.revision,
  generation: cloudflareAccessConfigs.generation,
  createdAt: cloudflareAccessConfigs.createdAt,
  updatedAt: cloudflareAccessConfigs.updatedAt,
});
type Metadata = Pick<
  typeof cloudflareAccessConfigs.$inferSelect,
  keyof typeof metadata
>;
const failures = {
  notFound: {
    kind: "not_found",
    code: SSH_ERROR_CODES.ACCESS_NOT_FOUND,
    message: "Cloudflare Access configuration not found",
  },
  conflict: {
    kind: "conflict",
    code: SSH_ERROR_CODES.ACCESS_REVISION_CONFLICT,
    message: "Cloudflare Access configuration was modified by another request",
  },
  inUse: {
    kind: "conflict",
    code: SSH_ERROR_CODES.ACCESS_IN_USE,
    message: "Cloudflare Access configuration is used by an SSH host",
  },
} as const;
export function cloudflareAccessFailure(reason: keyof typeof failures) {
  return { ok: false as const, ...failures[reason] };
}
function ownedConfig(owner: Owner, id?: string) {
  return and(
    eq(cloudflareAccessConfigs.orgId, owner.orgId),
    eq(cloudflareAccessConfigs.userId, owner.userId),
    id === undefined ? undefined : eq(cloudflareAccessConfigs.id, id),
  );
}
export async function findCloudflareAccessConfig(
  db: Pick<ReadonlyDb, "select">,
  owner: Owner,
  id: string,
) {
  const [row] = await db
    .select(metadata)
    .from(cloudflareAccessConfigs)
    .where(ownedConfig(owner, id));
  return row;
}
function response(
  row: Metadata,
  hosts: CloudflareAccessConfig["hosts"],
): CloudflareAccessConfig {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hosts,
  };
}
export async function listCloudflareAccessConfigs(
  db: ReadonlyDb,
  owner: Owner,
): Promise<CloudflareAccessConfig[]> {
  const rows = await db
    .select({
      config: metadata,
      host: { id: sshConnections.id, displayName: sshConnections.displayName },
    })
    .from(cloudflareAccessConfigs)
    .leftJoin(
      sshConnections,
      and(
        eq(sshConnections.cloudflareAccessId, cloudflareAccessConfigs.id),
        eq(sshConnections.orgId, owner.orgId),
        eq(sshConnections.userId, owner.userId),
      ),
    )
    .where(ownedConfig(owner))
    .orderBy(
      asc(cloudflareAccessConfigs.createdAt),
      asc(cloudflareAccessConfigs.id),
      asc(sshConnections.id),
    );
  const configs = new Map<string, CloudflareAccessConfig>();
  for (const row of rows) {
    let config = configs.get(row.config.id);
    if (!config) {
      config = response(row.config, []);
      configs.set(config.id, config);
    }
    if (row.host) {
      config.hosts.push(row.host);
    }
  }
  return [...configs.values()];
}
async function encryptCredentials(
  credentials: CreateCloudflareAccessRequest["credentials"],
  context: FeatureSwitchContext,
) {
  const encryptedClientId = await encryptStoredSecretValue(
    credentials.clientId,
    context,
  );
  const encryptedClientSecret = await encryptStoredSecretValue(
    credentials.clientSecret,
    context,
  );
  return { encryptedClientId, encryptedClientSecret };
}
export async function createCloudflareAccessConfig(args: {
  readonly db: Db;
  readonly owner: Owner;
  readonly body: CreateCloudflareAccessRequest;
  readonly featureContext: FeatureSwitchContext;
}) {
  const encrypted = await encryptCredentials(
    args.body.credentials,
    args.featureContext,
  );
  const config = await args.db.transaction(async (tx) => {
    await lockSshOwner(tx, args.owner);
    const [created] = await tx
      .insert(cloudflareAccessConfigs)
      .values({
        orgId: args.owner.orgId,
        userId: args.owner.userId,
        name: args.body.name,
        ...encrypted,
      })
      .returning(metadata);
    if (!created) {
      throw new Error("Cloudflare Access insert returned no row");
    }
    return response(created, []);
  });
  await publishSshClientInvalidation(args.owner);
  return config;
}
function lockReferencingHosts(tx: Transaction, owner: Owner, configId: string) {
  return tx
    .select({
      id: sshConnections.id,
      displayName: sshConnections.displayName,
      generation: sshConnections.generation,
    })
    .from(sshConnections)
    .where(
      and(
        eq(sshConnections.orgId, owner.orgId),
        eq(sshConnections.userId, owner.userId),
        eq(sshConnections.cloudflareAccessId, configId),
      ),
    )
    .orderBy(asc(sshConnections.id))
    .for("update");
}
export async function updateCloudflareAccessConfig(args: {
  readonly db: Db;
  readonly owner: Owner;
  readonly configId: string;
  readonly body: UpdateCloudflareAccessRequest;
  readonly featureContext: FeatureSwitchContext;
}) {
  const current = await findCloudflareAccessConfig(
    args.db,
    args.owner,
    args.configId,
  );
  if (!current) {
    return cloudflareAccessFailure("notFound");
  }
  if (current.revision !== args.body.expectedRevision) {
    return cloudflareAccessFailure("conflict");
  }
  const encrypted =
    args.body.credentials === undefined
      ? undefined
      : await encryptCredentials(args.body.credentials, args.featureContext);
  const result = await args.db.transaction(async (tx) => {
    await lockSshOwner(tx, args.owner);
    const hosts = await lockReferencingHosts(tx, args.owner, args.configId);
    const [config] = await tx
      .select(metadata)
      .from(cloudflareAccessConfigs)
      .where(ownedConfig(args.owner, args.configId))
      .for("update");
    if (!config) {
      return cloudflareAccessFailure("notFound");
    }
    if (config.revision !== args.body.expectedRevision) {
      return cloudflareAccessFailure("conflict");
    }
    const effective = encrypted !== undefined;
    if (
      config.revision === 2_147_483_647 ||
      (effective &&
        (config.generation === 2_147_483_647 ||
          hosts.some((host) => {
            return host.generation === 2_147_483_647;
          })))
    ) {
      return sshCredentialFailure("exhausted");
    }
    const [updated] = await tx
      .update(cloudflareAccessConfigs)
      .set({
        name: args.body.name,
        ...encrypted,
        revision: config.revision + 1,
        generation: config.generation + (effective ? 1 : 0),
        updatedAt: nowDate(),
      })
      .where(ownedConfig(args.owner, args.configId))
      .returning(metadata);
    if (!updated) {
      throw new Error("Cloudflare Access update returned no row");
    }
    if (effective && hosts.length > 0) {
      await tx
        .update(sshConnections)
        .set({
          generation: sql`${sshConnections.generation} + 1`,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(sshConnections.orgId, args.owner.orgId),
            eq(sshConnections.userId, args.owner.userId),
            eq(sshConnections.cloudflareAccessId, args.configId),
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
      affectedIds: effective
        ? hosts.map((host) => {
            return host.id;
          })
        : [],
    };
  });
  if (result.ok) {
    await publishSshRuntimeInvalidation(args.db, {
      ...args.owner,
      connectionIds: result.affectedIds,
    });
  }
  return result;
}
export async function deleteCloudflareAccessConfig(args: {
  readonly db: Db;
  readonly owner: Owner;
  readonly configId: string;
  readonly expectedRevision: number;
}) {
  const result = await args.db.transaction(async (tx) => {
    await lockSshOwner(tx, args.owner);
    const hosts = await lockReferencingHosts(tx, args.owner, args.configId);
    const [config] = await tx
      .select(metadata)
      .from(cloudflareAccessConfigs)
      .where(ownedConfig(args.owner, args.configId))
      .for("update");
    if (!config) {
      return cloudflareAccessFailure("notFound");
    }
    if (config.revision !== args.expectedRevision) {
      return cloudflareAccessFailure("conflict");
    }
    if (hosts.length > 0) {
      return cloudflareAccessFailure("inUse");
    }
    await tx
      .delete(cloudflareAccessConfigs)
      .where(ownedConfig(args.owner, args.configId));
    return { ok: true as const, value: undefined };
  });
  if (result.ok) {
    await publishSshClientInvalidation(args.owner);
  }
  return result;
}
