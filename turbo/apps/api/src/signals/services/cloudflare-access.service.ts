import { createHash } from "node:crypto";
import type {
  CloudflareAccessConfig,
  ScopedCloudflareAccessConfig,
  CreateCloudflareAccessConfigRequest,
  CreateCloudflareAccessRequest,
  UpdateCloudflareAccessRequest,
  ConvertCloudflareAccessRequest,
  DeleteCloudflareAccessRequest,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { CLOUDFLARE_ACCESS_ERROR_CODES } from "@okouai/api-contracts/contracts/cloudflare-access-errors";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { encryptStoredSecretValue } from "./crypto.utils";
import {
  publishCloudflareAccessClientInvalidation,
  publishCloudflareAccessMutationInvalidation,
} from "./cloudflare-access-client-invalidation.service";
import { lockSshOwner } from "./ssh-credential.service";
import { checkSshCreationId } from "./ssh-creation.service";
import { publishSshRunnerInvalidation } from "./ssh-runtime-wakeup.service";
import { publishSshClientInvalidation } from "./ssh-client-invalidation.service";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
type AccessScope = "personal" | "organization";
interface Actor extends Owner {
  readonly orgRole?: "admin" | "member";
}
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const metadata = Object.freeze({
  id: cloudflareAccessConfigs.id,
  name: cloudflareAccessConfigs.name,
  revision: cloudflareAccessConfigs.revision,
  generation: cloudflareAccessConfigs.generation,
  scope: cloudflareAccessConfigs.scope,
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
    code: CLOUDFLARE_ACCESS_ERROR_CODES.NOT_FOUND,
    message: "Cloudflare Access not found",
  },
  resourceIdConflict: {
    kind: "conflict",
    code: CLOUDFLARE_ACCESS_ERROR_CODES.RESOURCE_ID_CONFLICT,
    message:
      "This resource ID cannot be used for this Cloudflare Access configuration.",
  },
  conflict: {
    kind: "conflict",
    code: CLOUDFLARE_ACCESS_ERROR_CODES.REVISION_CONFLICT,
    message: "Cloudflare Access was modified by another request",
  },
  impactConflict: {
    kind: "conflict",
    code: CLOUDFLARE_ACCESS_ERROR_CODES.IMPACT_CONFLICT,
    message: "Cloudflare Access host impact changed; review it again",
  },
  inUse: {
    kind: "conflict",
    code: CLOUDFLARE_ACCESS_ERROR_CODES.IN_USE,
    message: "Cloudflare Access is used by an SSH host",
  },
  exhausted: {
    kind: "conflict",
    code: CLOUDFLARE_ACCESS_ERROR_CODES.REVISION_EXHAUSTED,
    message: "Cloudflare Access revision limit reached",
  },
  forbidden: {
    kind: "forbidden",
    code: CLOUDFLARE_ACCESS_ERROR_CODES.FORBIDDEN,
    message: "Only organization admins can manage shared Cloudflare Access",
  },
} as const;
export function cloudflareAccessFailure<K extends keyof typeof failures>(
  reason: K,
) {
  return { ok: false as const, ...failures[reason] };
}
function ownedConfig(owner: Owner, id?: string) {
  return and(
    eq(cloudflareAccessConfigs.orgId, owner.orgId),
    eq(cloudflareAccessConfigs.scope, "personal"),
    eq(cloudflareAccessConfigs.userId, owner.userId),
    id === undefined ? undefined : eq(cloudflareAccessConfigs.id, id),
  );
}
function visibleConfig(owner: Owner, id?: string) {
  return and(
    eq(cloudflareAccessConfigs.orgId, owner.orgId),
    or(eq(cloudflareAccessConfigs.scope, "organization"), ownedConfig(owner)),
    id === undefined ? undefined : eq(cloudflareAccessConfigs.id, id),
  );
}
function organizationConfig(owner: Owner, id: string) {
  return and(
    eq(cloudflareAccessConfigs.orgId, owner.orgId),
    eq(cloudflareAccessConfigs.id, id),
    eq(cloudflareAccessConfigs.scope, "organization"),
  );
}
export async function lockCloudflareAccessConfigForBinding(
  tx: Transaction,
  owner: Owner,
  id: string,
) {
  const [row] = await tx
    .select(metadata)
    .from(cloudflareAccessConfigs)
    .where(visibleConfig(owner, id))
    .for("share");
  return row;
}
function response(
  row: Metadata,
  sshHosts: CloudflareAccessConfig["sshHosts"],
): ScopedCloudflareAccessConfig {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sshHosts,
  };
}
export async function listCloudflareAccessConfigs(
  db: ReadonlyDb,
  owner: Owner,
): Promise<ScopedCloudflareAccessConfig[]> {
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
    .where(visibleConfig(owner))
    .orderBy(
      asc(cloudflareAccessConfigs.createdAt),
      asc(cloudflareAccessConfigs.id),
      asc(sshConnections.id),
    );
  const configs = new Map<string, ScopedCloudflareAccessConfig>();
  for (const row of rows) {
    let config = configs.get(row.config.id);
    if (!config) {
      config = response(row.config, []);
      configs.set(config.id, config);
    }
    if (row.host) {
      config.sshHosts.push(row.host);
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
export async function prepareCloudflareAccessConfig(
  body: CreateCloudflareAccessRequest,
  context: FeatureSwitchContext,
) {
  return {
    name: body.name,
    ...(await encryptCredentials(body.credentials, context)),
  };
}
export async function insertCloudflareAccessConfig(
  tx: Transaction,
  owner: Owner,
  prepared: Awaited<ReturnType<typeof prepareCloudflareAccessConfig>>,
  options: {
    readonly id?: string;
    readonly scope?: AccessScope;
  } = {},
) {
  const scope = options.scope ?? "personal";
  const [created] = await tx
    .insert(cloudflareAccessConfigs)
    .values({
      id: options.id,
      orgId: owner.orgId,
      userId: scope === "organization" ? null : owner.userId,
      scope,
      ...prepared,
    })
    .returning(metadata);
  if (!created) {
    throw new Error("Cloudflare Access insert returned no row");
  }
  return response(created, []);
}
export async function createCloudflareAccessConfig(args: {
  readonly db: Db;
  readonly owner: Actor;
  readonly body: CreateCloudflareAccessConfigRequest;
  readonly id: string;
  readonly featureContext: FeatureSwitchContext;
}) {
  const scope = args.body.scope ?? "personal";
  if (scope === "organization" && args.owner.orgRole !== "admin") {
    return cloudflareAccessFailure("forbidden");
  }
  const prepared = await prepareCloudflareAccessConfig(
    args.body,
    args.featureContext,
  );
  const config = await args.db.transaction(async (tx) => {
    await lockSshOwner(tx, args.owner);
    const creation = await checkSshCreationId(
      tx,
      {
        orgId: args.owner.orgId,
        userId: scope === "organization" ? null : args.owner.userId,
      },
      cloudflareAccessConfigs,
      args.id,
    );
    if (!creation.ok) {
      return cloudflareAccessFailure("resourceIdConflict");
    }
    if (!creation.value) {
      return { ok: true as const, value: undefined };
    }
    const value = await insertCloudflareAccessConfig(tx, args.owner, prepared, {
      id: args.id,
      scope,
    });
    return { ok: true as const, value };
  });
  if (config.ok && config.value) {
    await publishCloudflareAccessClientInvalidation(args.owner, scope);
  }
  return config;
}
function lockReferencingHosts(
  tx: Transaction,
  owner: Owner,
  configId: string,
  scope: AccessScope,
) {
  return tx
    .select({
      id: sshConnections.id,
      userId: sshConnections.userId,
      displayName: sshConnections.displayName,
      generation: sshConnections.generation,
    })
    .from(sshConnections)
    .where(
      and(
        eq(sshConnections.orgId, owner.orgId),
        scope === "personal"
          ? eq(sshConnections.userId, owner.userId)
          : undefined,
        eq(sshConnections.cloudflareAccessId, configId),
      ),
    )
    .orderBy(asc(sshConnections.id))
    .for("update");
}
function managementFailure(config: Metadata, actor: Actor) {
  return config.scope === "organization" && actor.orgRole !== "admin"
    ? cloudflareAccessFailure("forbidden")
    : null;
}
function affectedByOwner(
  hosts: readonly { readonly id: string; readonly userId: string }[],
) {
  const groups = new Map<string, string[]>();
  for (const host of hosts) {
    const ids = groups.get(host.userId) ?? [];
    ids.push(host.id);
    groups.set(host.userId, ids);
  }
  return groups;
}
async function publishUpdateInvalidation(
  db: ReadonlyDb,
  actor: Owner,
  scope: AccessScope,
  affectedHosts: readonly { readonly id: string; readonly userId: string }[],
) {
  const publishSshInvalidation = async () => {
    const owners = [...affectedByOwner(affectedHosts).entries()];
    for (let offset = 0; offset < owners.length; offset += 16) {
      await Promise.all(
        owners
          .slice(offset, offset + 16)
          .map(async ([userId, connectionIds]) => {
            await Promise.all([
              publishSshClientInvalidation({ orgId: actor.orgId, userId }),
              publishSshRunnerInvalidation(db, {
                orgId: actor.orgId,
                userId,
                connectionIds,
              }),
            ]);
          }),
      );
    }
  };
  if (scope === "organization") {
    await Promise.all([
      publishCloudflareAccessClientInvalidation(actor, scope),
      publishSshInvalidation(),
    ]);
  } else {
    await publishCloudflareAccessMutationInvalidation(
      actor,
      publishSshInvalidation,
    );
  }
}
export async function updateCloudflareAccessConfig(args: {
  readonly db: Db;
  readonly owner: Actor;
  readonly configId: string;
  readonly body: UpdateCloudflareAccessRequest;
  readonly featureContext: FeatureSwitchContext;
}) {
  const [current] = await args.db
    .select(metadata)
    .from(cloudflareAccessConfigs)
    .where(visibleConfig(args.owner, args.configId));
  if (!current) {
    return cloudflareAccessFailure("notFound");
  }
  const denied = managementFailure(current, args.owner);
  if (denied) {
    return denied;
  }
  if (current.revision !== args.body.expectedRevision) {
    return cloudflareAccessFailure("conflict");
  }
  const encrypted =
    args.body.credentials === undefined
      ? undefined
      : await encryptCredentials(args.body.credentials, args.featureContext);
  const result = await args.db.transaction(async (tx) => {
    const [config] = await tx
      .select(metadata)
      .from(cloudflareAccessConfigs)
      .where(visibleConfig(args.owner, args.configId))
      .for("update");
    if (!config) {
      return cloudflareAccessFailure("notFound");
    }
    const denied = managementFailure(config, args.owner);
    if (denied) {
      return denied;
    }
    const hosts = await lockReferencingHosts(
      tx,
      args.owner,
      args.configId,
      config.scope,
    );
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
      return cloudflareAccessFailure("exhausted");
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
      .where(visibleConfig(args.owner, args.configId))
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
            eq(sshConnections.cloudflareAccessId, args.configId),
            config.scope === "personal"
              ? eq(sshConnections.userId, args.owner.userId)
              : undefined,
          ),
        );
    }
    return {
      ok: true as const,
      value: response(
        updated,
        hosts
          .filter((host) => {
            return host.userId === args.owner.userId;
          })
          .map(({ id, displayName }) => {
            return { id, displayName };
          }),
      ),
      affectedHosts: effective ? hosts : [],
      scope: config.scope,
    };
  });
  if (result.ok) {
    await publishUpdateInvalidation(
      args.db,
      args.owner,
      result.scope,
      result.affectedHosts,
    );
  }
  return result;
}
export async function deleteCloudflareAccessConfig(args: {
  readonly db: Db;
  readonly owner: Actor;
  readonly configId: string;
  readonly body: DeleteCloudflareAccessRequest;
}) {
  const result = await args.db.transaction(async (tx) => {
    const [config] = await tx
      .select(metadata)
      .from(cloudflareAccessConfigs)
      .where(visibleConfig(args.owner, args.configId))
      .for("update");
    if (!config) {
      return cloudflareAccessFailure("notFound");
    }
    const denied = managementFailure(config, args.owner);
    if (denied) {
      return denied;
    }
    const hosts = await lockReferencingHosts(
      tx,
      args.owner,
      args.configId,
      config.scope,
    );
    if (config.revision !== args.body.expectedRevision) {
      return cloudflareAccessFailure("conflict");
    }
    if (
      hosts.some((host) => {
        return host.userId === args.owner.userId;
      })
    ) {
      return cloudflareAccessFailure("inUse");
    }
    if (
      (args.body.impactSnapshot !== undefined &&
        args.body.impactSnapshot !== impactSnapshot(config, hosts)) ||
      (hosts.length > 0 &&
        (config.scope !== "organization" ||
          args.body.impactSnapshot === undefined))
    ) {
      return cloudflareAccessFailure("impactConflict");
    }
    if (
      hosts.some((host) => {
        return host.generation === 2_147_483_647;
      })
    ) {
      return cloudflareAccessFailure("exhausted");
    }
    if (hosts.length > 0) {
      await tx
        .update(sshConnections)
        .set({
          cloudflareAccessId: null,
          needsRebind: true,
          generation: sql`${sshConnections.generation} + 1`,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(sshConnections.orgId, args.owner.orgId),
            eq(sshConnections.cloudflareAccessId, args.configId),
            ne(sshConnections.userId, args.owner.userId),
          ),
        );
    }
    await tx
      .delete(cloudflareAccessConfigs)
      .where(visibleConfig(args.owner, args.configId));
    return { ok: true as const, value: undefined, scope: config.scope };
  });
  if (result.ok) {
    await publishCloudflareAccessClientInvalidation(args.owner, result.scope);
  }
  return result;
}

type ReferencingHost = Awaited<ReturnType<typeof lockReferencingHosts>>[number];

function impactSnapshot(config: Metadata, hosts: readonly ReferencingHost[]) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.id,
        config.revision,
        hosts.map((host) => {
          return [host.id, host.userId, host.generation];
        }),
      ]),
    )
    .digest("hex");
}

export async function previewCloudflareAccessDeletion(args: {
  readonly db: ReadonlyDb;
  readonly owner: Actor;
  readonly configId: string;
}) {
  if (args.owner.orgRole !== "admin") {
    return cloudflareAccessFailure("forbidden");
  }
  const [config] = await args.db
    .select(metadata)
    .from(cloudflareAccessConfigs)
    .where(organizationConfig(args.owner, args.configId));
  if (!config) {
    return cloudflareAccessFailure("notFound");
  }
  const hosts = await args.db
    .select({
      id: sshConnections.id,
      userId: sshConnections.userId,
      generation: sshConnections.generation,
    })
    .from(sshConnections)
    .where(
      and(
        eq(sshConnections.orgId, args.owner.orgId),
        eq(sshConnections.cloudflareAccessId, args.configId),
      ),
    )
    .orderBy(asc(sshConnections.id));
  const counts = new Map<string, number>();
  for (const host of hosts) {
    if (host.userId !== args.owner.userId) {
      counts.set(host.userId, (counts.get(host.userId) ?? 0) + 1);
    }
  }
  return {
    ok: true as const,
    value: {
      expectedRevision: config.revision,
      ownHostCount: hosts.filter((host) => {
        return host.userId === args.owner.userId;
      }).length,
      affectedOwners: [...counts]
        .sort(([a], [b]) => {
          return a.localeCompare(b);
        })
        .map(([userId, hostCount]) => {
          return {
            userId,
            displayName: null as string | null,
            hostCount,
          };
        }),
      impactSnapshot: impactSnapshot(config, hosts),
    },
  };
}

export async function convertCloudflareAccessToOrganization(args: {
  readonly db: Db;
  readonly owner: Actor;
  readonly configId: string;
  readonly expectedRevision: number;
}) {
  if (args.owner.orgRole !== "admin") {
    return cloudflareAccessFailure("forbidden");
  }
  const result = await args.db.transaction(async (tx) => {
    const [config] = await tx
      .select(metadata)
      .from(cloudflareAccessConfigs)
      .where(ownedConfig(args.owner, args.configId))
      .for("update");
    if (!config) {
      return cloudflareAccessFailure("notFound");
    }
    const hosts = await lockReferencingHosts(
      tx,
      args.owner,
      args.configId,
      "personal",
    );
    if (config.revision !== args.expectedRevision) {
      return cloudflareAccessFailure("conflict");
    }
    if (
      config.revision === 2_147_483_647 ||
      config.generation === 2_147_483_647 ||
      hosts.some((host) => {
        return host.generation === 2_147_483_647;
      })
    ) {
      return cloudflareAccessFailure("exhausted");
    }
    const [converted] = await tx
      .update(cloudflareAccessConfigs)
      .set({
        scope: "organization",
        userId: null,
        revision: config.revision + 1,
        generation: config.generation + 1,
        updatedAt: nowDate(),
      })
      .where(ownedConfig(args.owner, args.configId))
      .returning(metadata);
    if (!converted) {
      throw new Error("Cloudflare Access promotion returned no row");
    }
    if (hosts.length > 0) {
      await tx
        .update(sshConnections)
        .set({
          generation: sql`${sshConnections.generation} + 1`,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(sshConnections.orgId, args.owner.orgId),
            eq(sshConnections.cloudflareAccessId, args.configId),
            eq(sshConnections.userId, args.owner.userId),
          ),
        );
    }
    return {
      ok: true as const,
      value: response(
        converted,
        hosts.map(({ id, displayName }) => {
          return { id, displayName };
        }),
      ),
      affectedHosts: hosts,
    };
  });
  if (result.ok) {
    await publishUpdateInvalidation(
      args.db,
      args.owner,
      "organization",
      result.affectedHosts,
    );
  }
  return result;
}

export async function previewCloudflareAccessConversion(args: {
  readonly db: ReadonlyDb;
  readonly owner: Actor;
  readonly configId: string;
}) {
  const [config] = await args.db
    .select(metadata)
    .from(cloudflareAccessConfigs)
    .where(organizationConfig(args.owner, args.configId));
  if (!config) {
    return cloudflareAccessFailure("notFound");
  }
  if (args.owner.orgRole !== "admin") {
    return cloudflareAccessFailure("forbidden");
  }
  const hosts = await args.db
    .select({
      id: sshConnections.id,
      userId: sshConnections.userId,
      displayName: sshConnections.displayName,
      generation: sshConnections.generation,
    })
    .from(sshConnections)
    .where(
      and(
        eq(sshConnections.orgId, args.owner.orgId),
        eq(sshConnections.cloudflareAccessId, args.configId),
      ),
    )
    .orderBy(asc(sshConnections.id));
  return {
    ok: true as const,
    value: {
      expectedRevision: config.revision,
      otherHostCount: hosts.filter((host) => {
        return host.userId !== args.owner.userId;
      }).length,
      impactSnapshot: impactSnapshot(config, hosts),
    },
  };
}

export async function convertCloudflareAccessToPersonal(args: {
  readonly db: Db;
  readonly owner: Actor;
  readonly configId: string;
  readonly body: ConvertCloudflareAccessRequest;
}) {
  if (args.owner.orgRole !== "admin") {
    return cloudflareAccessFailure("forbidden");
  }
  const result = await args.db.transaction(async (tx) => {
    const [config] = await tx
      .select(metadata)
      .from(cloudflareAccessConfigs)
      .where(organizationConfig(args.owner, args.configId))
      .for("update");
    if (!config) {
      return cloudflareAccessFailure("notFound");
    }
    const hosts = await lockReferencingHosts(
      tx,
      args.owner,
      args.configId,
      "organization",
    );
    if (config.revision !== args.body.expectedRevision) {
      return cloudflareAccessFailure("conflict");
    }
    if (impactSnapshot(config, hosts) !== args.body.impactSnapshot) {
      return cloudflareAccessFailure("impactConflict");
    }
    if (
      config.revision === 2_147_483_647 ||
      config.generation === 2_147_483_647 ||
      hosts.some((host) => {
        return host.generation === 2_147_483_647;
      })
    ) {
      return cloudflareAccessFailure("exhausted");
    }
    if (
      hosts.some((host) => {
        return host.userId !== args.owner.userId;
      })
    ) {
      await tx
        .update(sshConnections)
        .set({
          cloudflareAccessId: null,
          needsRebind: true,
          generation: sql`${sshConnections.generation} + 1`,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(sshConnections.orgId, args.owner.orgId),
            eq(sshConnections.cloudflareAccessId, args.configId),
            ne(sshConnections.userId, args.owner.userId),
          ),
        );
    }
    await tx
      .update(sshConnections)
      .set({
        generation: sql`${sshConnections.generation} + 1`,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(sshConnections.orgId, args.owner.orgId),
          eq(sshConnections.cloudflareAccessId, args.configId),
          eq(sshConnections.userId, args.owner.userId),
        ),
      );
    const [converted] = await tx
      .update(cloudflareAccessConfigs)
      .set({
        scope: "personal",
        userId: args.owner.userId,
        revision: config.revision + 1,
        generation: config.generation + 1,
        updatedAt: nowDate(),
      })
      .where(organizationConfig(args.owner, args.configId))
      .returning(metadata);
    if (!converted) {
      throw new Error("Cloudflare Access conversion returned no row");
    }
    return {
      ok: true as const,
      value: response(
        converted,
        hosts
          .filter((host) => {
            return host.userId === args.owner.userId;
          })
          .map(({ id, displayName }) => {
            return { id, displayName };
          }),
      ),
      affectedHosts: hosts,
    };
  });
  if (result.ok) {
    await publishUpdateInvalidation(
      args.db,
      args.owner,
      "organization",
      result.affectedHosts,
    );
  }
  return result;
}
