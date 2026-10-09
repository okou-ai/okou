import { createHash } from "node:crypto";
import { command } from "ccstate";
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
import { and, asc, count, eq, ne, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { isUniqueViolation } from "../../lib/pg-errors";
import { settle } from "../utils";
import { encryptStoredSecretValue } from "./crypto.utils";
import { publishCloudflareAccessClientInvalidation } from "./cloudflare-access-client-invalidation.service";
import { sshCreationResult } from "./ssh-creation.service";
import { publishSshRuntimeInvalidation$ } from "./ssh-runtime-wakeup.service";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
type AccessScope = "personal" | "organization";
interface Actor extends Owner {
  readonly orgRole?: "admin" | "member";
}
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
export const listCloudflareAccessConfigs$ = command(
  async ({ set }, owner: Owner): Promise<ScopedCloudflareAccessConfig[]> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        config: metadata,
        host: {
          id: sshConnections.id,
          displayName: sshConnections.displayName,
        },
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
  },
);
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
interface CreateCloudflareAccessConfigArgs {
  readonly owner: Actor;
  readonly body: CreateCloudflareAccessConfigRequest;
  readonly id: string;
  readonly featureContext: FeatureSwitchContext;
}
export const createCloudflareAccessConfig$ = command(
  async ({ set }, args: CreateCloudflareAccessConfigArgs) => {
    const db = set(writeDb$);

    const scope = args.body.scope ?? "personal";
    if (scope === "organization" && args.owner.orgRole !== "admin") {
      return cloudflareAccessFailure("forbidden");
    }
    const prepared = await prepareCloudflareAccessConfig(
      args.body,
      args.featureContext,
    );
    const owner = {
      orgId: args.owner.orgId,
      userId: scope === "organization" ? null : args.owner.userId,
    };
    const transaction = await settle(
      db.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            orgId: cloudflareAccessConfigs.orgId,
            userId: cloudflareAccessConfigs.userId,
          })
          .from(cloudflareAccessConfigs)
          .where(eq(cloudflareAccessConfigs.id, args.id));
        const creation = sshCreationResult(owner, existing);
        if (!creation.ok) {
          return cloudflareAccessFailure("resourceIdConflict");
        }
        if (!creation.value) {
          return { ok: true as const, value: undefined };
        }
        const [created] = await tx
          .insert(cloudflareAccessConfigs)
          .values({ id: args.id, ...owner, scope, ...prepared })
          .returning(metadata);
        if (!created) {
          throw new Error("Cloudflare Access insert returned no row");
        }
        return { ok: true as const, value: response(created, []) };
      }),
    );
    if (!transaction.ok) {
      if (
        !isUniqueViolation(transaction.error, "cloudflare_access_configs_pkey")
      ) {
        throw transaction.error;
      }
      const [existing] = await db
        .select({
          orgId: cloudflareAccessConfigs.orgId,
          userId: cloudflareAccessConfigs.userId,
        })
        .from(cloudflareAccessConfigs)
        .where(eq(cloudflareAccessConfigs.id, args.id));
      return existing &&
        existing.orgId === owner.orgId &&
        existing.userId === owner.userId
        ? { ok: true as const, value: undefined }
        : cloudflareAccessFailure("resourceIdConflict");
    }
    const config = transaction.value;
    if (config.ok && config.value) {
      await publishCloudflareAccessClientInvalidation(args.owner, scope);
    }
    return config;
  },
);
function referencingHosts(owner: Owner, configId: string) {
  return and(
    eq(sshConnections.orgId, owner.orgId),
    eq(sshConnections.cloudflareAccessId, configId),
  );
}
function referencingHostsQuery(owner: Owner, configId: string) {
  // Parent-login RESTRICT checks take KEY SHARE on hosts. Do not conflict with
  // those implicit locks while holding hosts and waiting for configuration.
  return new QueryBuilder()
    .select({
      id: sshConnections.id,
      userId: sshConnections.userId,
      displayName: sshConnections.displayName,
      generation: sshConnections.generation,
    })
    .from(sshConnections)
    .where(referencingHosts(owner, configId))
    .orderBy(asc(sshConnections.id))
    .for("no key update")
    .as("cloudflare_referencing_hosts");
}
function referenceSetExpanded(
  lockedCount: number,
  current: { readonly count: number } | undefined,
) {
  if (!current) {
    throw new Error("Cloudflare Access reference count returned no row");
  }
  // READ COMMITTED locking readers recheck changed tuples before returning them.
  // Every returned host remains a matching, unchanged member under its retained
  // lock. After the config fence, SHARE admission blocks further additions. The
  // locked set is therefore a subset of this fresh count's set: equal cardinality
  // proves equal identities here, not for arbitrary sets. Reuse its metadata.
  if (current.count < lockedCount) {
    throw new Error("Locked Cloudflare Access references disappeared");
  }
  return current.count > lockedCount;
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
interface CloudflareInvalidationArgs {
  readonly actor: Owner;
  readonly scope: AccessScope;
  readonly affectedHosts: readonly {
    readonly id: string;
    readonly userId: string;
  }[];
}
const publishUpdateInvalidation$ = command(
  async ({ set }, args: CloudflareInvalidationArgs) => {
    await publishCloudflareAccessClientInvalidation(args.actor, args.scope);
    const owners = [...affectedByOwner(args.affectedHosts).entries()];
    for (let offset = 0; offset < owners.length; offset += 16) {
      await Promise.all(
        owners
          .slice(offset, offset + 16)
          .map(async ([userId, connectionIds]) => {
            await set(publishSshRuntimeInvalidation$, {
              orgId: args.actor.orgId,
              userId,
              connectionIds,
            });
          }),
      );
    }
  },
);
interface RenameCloudflareAccessConfigArgs {
  readonly owner: Actor;
  readonly configId: string;
  readonly body: Pick<
    UpdateCloudflareAccessRequest,
    "name" | "expectedRevision"
  >;
}
const renameCloudflareAccessConfig$ = command(
  async ({ set }, args: RenameCloudflareAccessConfigArgs) => {
    const db = set(writeDb$);
    const result = await db.transaction(async (tx) => {
      // Metadata-only: never follow configuration authority with a host lock or
      // write. The owner-filtered response below is a nonlocking MVCC read.
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
      if (config.revision !== args.body.expectedRevision) {
        return cloudflareAccessFailure("conflict");
      }
      if (config.revision === 2_147_483_647) {
        return cloudflareAccessFailure("exhausted");
      }
      const [updated] = await tx
        .update(cloudflareAccessConfigs)
        .set({
          name: args.body.name,
          revision: config.revision + 1,
          updatedAt: nowDate(),
        })
        .where(visibleConfig(args.owner, args.configId))
        .returning(metadata);
      if (!updated) {
        throw new Error("Cloudflare Access rename returned no row");
      }
      const hosts = await tx
        .select({
          id: sshConnections.id,
          displayName: sshConnections.displayName,
        })
        .from(sshConnections)
        .where(
          and(
            referencingHosts(args.owner, args.configId),
            eq(sshConnections.userId, args.owner.userId),
          ),
        )
        .orderBy(asc(sshConnections.id));
      return {
        ok: true as const,
        value: response(updated, hosts),
        scope: config.scope,
      };
    });
    if (result.ok) {
      await publishCloudflareAccessClientInvalidation(args.owner, result.scope);
    }
    return result;
  },
);
interface UpdateCloudflareAccessConfigArgs {
  readonly owner: Actor;
  readonly configId: string;
  readonly body: UpdateCloudflareAccessRequest;
  readonly featureContext: FeatureSwitchContext;
}
export const updateCloudflareAccessConfig$ = command(
  async ({ set }, args: UpdateCloudflareAccessConfigArgs) => {
    if (args.body.credentials === undefined) {
      return await set(renameCloudflareAccessConfig$, {
        owner: args.owner,
        configId: args.configId,
        body: args.body,
      });
    }
    const db = set(writeDb$);

    const [current] = await db
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
    const encrypted = await encryptCredentials(
      args.body.credentials,
      args.featureContext,
    );
    // Credentials and all bound-host generations must commit together. The
    // reference count needs a fresh statement snapshot after the config fence.
    const result = await db.transaction(async (tx) => {
      const hosts = await tx
        .select()
        .from(referencingHostsQuery(args.owner, args.configId));
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
      const [references] = await tx
        .select({ count: count() })
        .from(sshConnections)
        .where(referencingHosts(args.owner, args.configId));
      if (referenceSetExpanded(hosts.length, references)) {
        return cloudflareAccessFailure("conflict");
      }
      if (config.revision !== args.body.expectedRevision) {
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
      const [updated] = await tx
        .update(cloudflareAccessConfigs)
        .set({
          name: args.body.name,
          ...encrypted,
          revision: config.revision + 1,
          generation: config.generation + 1,
          updatedAt: nowDate(),
        })
        .where(visibleConfig(args.owner, args.configId))
        .returning(metadata);
      if (!updated) {
        throw new Error("Cloudflare Access update returned no row");
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
        affectedHosts: hosts,
        scope: config.scope,
      };
    });
    if (result.ok) {
      await set(publishUpdateInvalidation$, {
        actor: args.owner,
        scope: result.scope,
        affectedHosts: result.affectedHosts,
      });
    }
    return result;
  },
);
interface DeleteCloudflareAccessConfigArgs {
  readonly owner: Actor;
  readonly configId: string;
  readonly body: DeleteCloudflareAccessRequest;
}
export const deleteCloudflareAccessConfig$ = command(
  async ({ set }, args: DeleteCloudflareAccessConfigArgs) => {
    const db = set(writeDb$);

    // Protected detachment and config deletion must commit together under the
    // restrictive FK, with a fresh reference count after the config fence.
    const result = await db.transaction(async (tx) => {
      const hosts = await tx
        .select()
        .from(referencingHostsQuery(args.owner, args.configId));
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
      const [references] = await tx
        .select({ count: count() })
        .from(sshConnections)
        .where(referencingHosts(args.owner, args.configId));
      if (referenceSetExpanded(hosts.length, references)) {
        return cloudflareAccessFailure("conflict");
      }
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
  },
);

type ReferencingHost = Pick<
  typeof sshConnections.$inferSelect,
  "id" | "userId" | "displayName" | "generation"
>;

function impactSnapshot(
  config: Metadata,
  hosts: readonly Pick<ReferencingHost, "id" | "userId" | "generation">[],
) {
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

interface PreviewCloudflareAccessDeletionArgs {
  readonly owner: Actor;
  readonly configId: string;
}
export const previewCloudflareAccessDeletion$ = command(
  async ({ set }, args: PreviewCloudflareAccessDeletionArgs) => {
    const db = set(writeDb$);

    if (args.owner.orgRole !== "admin") {
      return cloudflareAccessFailure("forbidden");
    }
    const [config] = await db
      .select(metadata)
      .from(cloudflareAccessConfigs)
      .where(organizationConfig(args.owner, args.configId));
    if (!config) {
      return cloudflareAccessFailure("notFound");
    }
    const hosts = await db
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
    const affectedOwnerIds = new Set<string>();
    let otherHostCount = 0;
    for (const host of hosts) {
      if (host.userId !== args.owner.userId) {
        otherHostCount += 1;
        affectedOwnerIds.add(host.userId);
      }
    }
    return {
      ok: true as const,
      value: {
        expectedRevision: config.revision,
        ownHostCount: hosts.length - otherHostCount,
        otherHostCount,
        affectedOwnerIds: [...affectedOwnerIds].sort((a, b) => {
          return a.localeCompare(b);
        }),
        impactSnapshot: impactSnapshot(config, hosts),
      },
    };
  },
);

interface ConvertCloudflareAccessToOrganizationArgs {
  readonly owner: Actor;
  readonly configId: string;
  readonly expectedRevision: number;
}
export const convertCloudflareAccessToOrganization$ = command(
  async ({ set }, args: ConvertCloudflareAccessToOrganizationArgs) => {
    const db = set(writeDb$);

    if (args.owner.orgRole !== "admin") {
      return cloudflareAccessFailure("forbidden");
    }
    // Scope/owner and bound-host generations must commit together. Validate
    // the complete reference set in a fresh snapshot after the config fence.
    const result = await db.transaction(async (tx) => {
      const hosts = await tx
        .select()
        .from(referencingHostsQuery(args.owner, args.configId));
      const [config] = await tx
        .select(metadata)
        .from(cloudflareAccessConfigs)
        .where(ownedConfig(args.owner, args.configId))
        .for("update");
      if (!config) {
        return cloudflareAccessFailure("notFound");
      }
      const [references] = await tx
        .select({ count: count() })
        .from(sshConnections)
        .where(referencingHosts(args.owner, args.configId));
      if (referenceSetExpanded(hosts.length, references)) {
        return cloudflareAccessFailure("conflict");
      }
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
      // The count fence proved these locked records are the complete set.
      // Reject retained incompatible bindings before changing scope.
      if (
        hosts.some((host) => {
          return host.userId !== args.owner.userId;
        })
      ) {
        return cloudflareAccessFailure("inUse");
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
      await set(publishUpdateInvalidation$, {
        actor: args.owner,
        scope: "organization",
        affectedHosts: result.affectedHosts,
      });
    }
    return result;
  },
);

interface PreviewCloudflareAccessConversionArgs {
  readonly owner: Actor;
  readonly configId: string;
}
export const previewCloudflareAccessConversion$ = command(
  async ({ set }, args: PreviewCloudflareAccessConversionArgs) => {
    const db = set(writeDb$);

    const [config] = await db
      .select(metadata)
      .from(cloudflareAccessConfigs)
      .where(organizationConfig(args.owner, args.configId));
    if (!config) {
      return cloudflareAccessFailure("notFound");
    }
    if (args.owner.orgRole !== "admin") {
      return cloudflareAccessFailure("forbidden");
    }
    const hosts = await db
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
        ownHostCount: hosts.filter((host) => {
          return host.userId === args.owner.userId;
        }).length,
        affectedOwnerIds: [
          ...new Set(
            hosts
              .filter((host) => {
                return host.userId !== args.owner.userId;
              })
              .map((host) => {
                return host.userId;
              }),
          ),
        ].sort((a, b) => {
          return a.localeCompare(b);
        }),
        impactSnapshot: impactSnapshot(config, hosts),
      },
    };
  },
);

interface ConvertCloudflareAccessToPersonalArgs {
  readonly owner: Actor;
  readonly configId: string;
  readonly body: ConvertCloudflareAccessRequest;
}
export const convertCloudflareAccessToPersonal$ = command(
  async ({ set }, args: ConvertCloudflareAccessToPersonalArgs) => {
    const db = set(writeDb$);

    if (args.owner.orgRole !== "admin") {
      return cloudflareAccessFailure("forbidden");
    }
    // Other-owner detachment, own-host generations and adoption must commit
    // together, using a fresh post-fence count for the reviewed impact.
    const result = await db.transaction(async (tx) => {
      const hosts = await tx
        .select()
        .from(referencingHostsQuery(args.owner, args.configId));
      const [config] = await tx
        .select(metadata)
        .from(cloudflareAccessConfigs)
        .where(organizationConfig(args.owner, args.configId))
        .for("update");
      if (!config) {
        return cloudflareAccessFailure("notFound");
      }
      const [references] = await tx
        .select({ count: count() })
        .from(sshConnections)
        .where(referencingHosts(args.owner, args.configId));
      if (referenceSetExpanded(hosts.length, references)) {
        return cloudflareAccessFailure("conflict");
      }
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
      await set(publishUpdateInvalidation$, {
        actor: args.owner,
        scope: "organization",
        affectedHosts: result.affectedHosts,
      });
    }
    return result;
  },
);
