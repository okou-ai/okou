import { command } from "ccstate";
import type {
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
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { isUniqueViolation } from "../../lib/pg-errors";
import { settle } from "../utils";
import { encryptStoredSecretValue } from "./crypto.utils";
import { publishCloudflareAccessClientInvalidation } from "./cloudflare-access-client-invalidation.service";
import { sshCreationResult } from "./ssh-creation.service";
import { commitNetworkConfigMutation$ } from "./network-config-mutation.service";
import {
  networkConfigListReads,
  networkReferencesQuery,
} from "./network-config-references";
import {
  cloudflareNetworkMetadata,
  networkHostMetadata,
  networkImpactSnapshot,
  ownNetworkReferences,
  presentNetworkReference,
  type NetworkReference,
} from "./network-config-model";
import { publishNetworkHostInvalidation$ } from "./network-config-invalidation.service";

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
  references: readonly NetworkReference[],
): ScopedCloudflareAccessConfig {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...networkHostMetadata(references),
  };
}
export const listCloudflareAccessConfigs$ = command(
  async ({ set }, owner: Owner): Promise<ScopedCloudflareAccessConfig[]> => {
    const { table, refs, predicate } = networkConfigListReads(
      "cloudflare_access",
      owner,
    );
    const rows = await set(writeDb$)
      .select({ config: metadata, host: { ...refs._.selectedFields } })
      .from(table)
      .leftJoinLateral(refs, eq(refs.userId, owner.userId))
      .where(predicate)
      .orderBy(
        asc(table.createdAt),
        asc(table.id),
        asc(refs.protocol),
        asc(refs.id),
      );
    const configs = new Map<
      string,
      { config: Metadata; hosts: NetworkReference[] }
    >();
    for (const row of rows) {
      let entry = configs.get(row.config.id);
      if (!entry) {
        entry = { config: row.config, hosts: [] };
        configs.set(row.config.id, entry);
      }
      const host = presentNetworkReference(row.host);
      if (host) {
        entry.hosts.push(host);
      }
    }
    return [...configs.values()].map(({ config, hosts }) => {
      return response(config, hosts);
    });
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
  async ({ get, set }, args: CreateCloudflareAccessConfigArgs) => {
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
    const [existing] = await get(db$)
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
    // The primary key, not the unlocked preflight, arbitrates concurrent creates.
    const inserted = await settle(
      db
        .insert(cloudflareAccessConfigs)
        .values({ id: args.id, ...owner, scope, ...prepared })
        .returning(metadata),
    );
    if (!inserted.ok) {
      if (
        !isUniqueViolation(inserted.error, "cloudflare_access_configs_pkey")
      ) {
        throw inserted.error;
      }
      const [existing] = await get(db$)
        .select({
          orgId: cloudflareAccessConfigs.orgId,
          userId: cloudflareAccessConfigs.userId,
        })
        .from(cloudflareAccessConfigs)
        .where(eq(cloudflareAccessConfigs.id, args.id));
      const creation = sshCreationResult(owner, existing);
      return creation.ok && existing
        ? { ok: true as const, value: undefined }
        : cloudflareAccessFailure("resourceIdConflict");
    }
    const [created] = inserted.value;
    if (!created) {
      throw new Error("Cloudflare Access insert returned no row");
    }
    await publishCloudflareAccessClientInvalidation(args.owner, scope);
    return { ok: true as const, value: response(created, []) };
  },
);

interface ConfigArgs {
  readonly owner: Actor;
  readonly configId: string;
}
function ownReferences(hosts: readonly NetworkReference[], owner: Owner) {
  return ownNetworkReferences(hosts, owner.userId);
}
const publishUpdateInvalidation$ = command(
  async (
    { set },
    args: {
      readonly actor: Actor;
      readonly scope: AccessScope;
      readonly affectedHosts: readonly NetworkReference[];
    },
  ) => {
    await publishCloudflareAccessClientInvalidation(args.actor, args.scope);
    await set(publishNetworkHostInvalidation$, {
      orgId: args.actor.orgId,
      hosts: args.affectedHosts,
    });
  },
);

const renameCloudflareAccessConfig$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly body: Pick<
        UpdateCloudflareAccessRequest,
        "name" | "expectedRevision"
      >;
    },
  ) => {
    const db = set(writeDb$);
    const renamed = db.$with("renamed_cloudflare_access_config").as(
      db
        .update(cloudflareAccessConfigs)
        .set({
          name: args.body.name,
          revision: sql`${cloudflareAccessConfigs.revision} + 1`,
          updatedAt: nowDate(),
        })
        .where(
          and(
            visibleConfig(args.owner, args.configId),
            args.owner.orgRole === "admin"
              ? undefined
              : eq(cloudflareAccessConfigs.scope, "personal"),
            eq(cloudflareAccessConfigs.revision, args.body.expectedRevision),
            lt(cloudflareAccessConfigs.revision, 2_147_483_647),
          ),
        )
        .returning({ ...metadata }),
    );
    const hosts = networkReferencesQuery(
      "cloudflare_access",
      args.owner.orgId,
      args.configId,
    ).as("renamed_cloudflare_hosts");
    const rows = await db
      .with(renamed)
      .select({
        config: { ...renamed._.selectedFields },
        host: { ...hosts._.selectedFields },
      })
      .from(renamed)
      .leftJoin(hosts, eq(hosts.userId, args.owner.userId))
      .orderBy(asc(hosts.protocol), asc(hosts.id));
    const first = rows[0];
    if (!first) {
      const [current] = await db
        .select(metadata)
        .from(cloudflareAccessConfigs)
        .where(visibleConfig(args.owner, args.configId));
      if (!current) {
        return cloudflareAccessFailure("notFound");
      }
      if (current.scope === "organization" && args.owner.orgRole !== "admin") {
        return cloudflareAccessFailure("forbidden");
      }
      return cloudflareAccessFailure(
        current.revision === args.body.expectedRevision &&
          current.revision === 2_147_483_647
          ? "exhausted"
          : "conflict",
      );
    }
    await publishCloudflareAccessClientInvalidation(
      args.owner,
      first.config.scope,
    );
    return {
      ok: true as const,
      value: response(
        first.config,
        rows.flatMap(({ host }) => {
          return host ? [host] : [];
        }),
      ),
      scope: first.config.scope,
    };
  },
);

export const updateCloudflareAccessConfig$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly body: UpdateCloudflareAccessRequest;
      readonly featureContext: FeatureSwitchContext;
    },
  ) => {
    if (args.body.credentials === undefined) {
      return await set(renameCloudflareAccessConfig$, args);
    }
    const [current] = await set(writeDb$)
      .select(metadata)
      .from(cloudflareAccessConfigs)
      .where(visibleConfig(args.owner, args.configId));
    if (!current) {
      return cloudflareAccessFailure("notFound");
    }
    if (current.scope === "organization" && args.owner.orgRole !== "admin") {
      return cloudflareAccessFailure("forbidden");
    }
    if (current.revision !== args.body.expectedRevision) {
      return cloudflareAccessFailure("conflict");
    }
    const encrypted = await encryptCredentials(
      args.body.credentials,
      args.featureContext,
    );
    const result = await set(commitNetworkConfigMutation$, {
      provider: "cloudflare_access",
      ...args,
      operation: "update",
      expectedRevision: args.body.expectedRevision,
      name: args.body.name,
      encrypted,
    });
    if (!result.ok) {
      return cloudflareAccessFailure(result.reason);
    }
    await set(publishUpdateInvalidation$, {
      actor: args.owner,
      scope: result.scope,
      affectedHosts: result.invalidatedHosts,
    });
    return {
      ok: true as const,
      value: response(
        cloudflareNetworkMetadata(result.config),
        ownReferences(result.references, args.owner),
      ),
      scope: result.scope,
      affectedHosts: result.invalidatedHosts,
    };
  },
);

export const deleteCloudflareAccessConfig$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly body: DeleteCloudflareAccessRequest;
    },
  ) => {
    const result = await set(commitNetworkConfigMutation$, {
      provider: "cloudflare_access",
      ...args,
      operation: "delete",
      ...args.body,
    });
    if (!result.ok) {
      return cloudflareAccessFailure(result.reason);
    }
    await set(publishUpdateInvalidation$, {
      actor: args.owner,
      scope: result.scope,
      affectedHosts: result.invalidatedHosts,
    });
    return { ok: true as const, scope: result.scope };
  },
);

export const convertCloudflareAccessToOrganization$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly expectedRevision: number;
    },
  ) => {
    if (args.owner.orgRole !== "admin") {
      return cloudflareAccessFailure("forbidden");
    }
    const result = await set(commitNetworkConfigMutation$, {
      provider: "cloudflare_access",
      ...args,
      operation: "promote",
    });
    if (!result.ok) {
      return cloudflareAccessFailure(result.reason);
    }
    await set(publishUpdateInvalidation$, {
      actor: args.owner,
      scope: "organization",
      affectedHosts: result.invalidatedHosts,
    });
    return {
      ok: true as const,
      value: response(
        cloudflareNetworkMetadata(result.config),
        ownReferences(result.references, args.owner),
      ),
      affectedHosts: result.invalidatedHosts,
    };
  },
);

const previewCloudflareAccessImpact$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly operation: "convert" | "delete";
    },
  ) => {
    if (args.operation === "delete" && args.owner.orgRole !== "admin") {
      return cloudflareAccessFailure("forbidden");
    }
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
    const query = networkReferencesQuery(
      "cloudflare_access",
      args.owner.orgId,
      args.configId,
    ).as("cloudflare_impact_hosts");
    const hosts = await db.select().from(query);
    const others = hosts.filter((host) => {
      return host.userId !== args.owner.userId;
    });
    return {
      ok: true as const,
      value: {
        expectedRevision: config.revision,
        ownHostCount: hosts.length - others.length,
        otherHostCount: others.length,
        affectedOwnerIds: [
          ...new Set(
            others.map((host) => {
              return host.userId;
            }),
          ),
        ].sort((a, b) => {
          return a.localeCompare(b);
        }),
        impactSnapshot: networkImpactSnapshot(config, hosts),
      },
    };
  },
);
export const previewCloudflareAccessDeletion$ = command(
  async ({ set }, args: ConfigArgs) => {
    return await set(previewCloudflareAccessImpact$, {
      ...args,
      operation: "delete",
    });
  },
);
export const previewCloudflareAccessConversion$ = command(
  async ({ set }, args: ConfigArgs) => {
    return await set(previewCloudflareAccessImpact$, {
      ...args,
      operation: "convert",
    });
  },
);
export const convertCloudflareAccessToPersonal$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly body: ConvertCloudflareAccessRequest;
    },
  ) => {
    if (args.owner.orgRole !== "admin") {
      return cloudflareAccessFailure("forbidden");
    }
    const result = await set(commitNetworkConfigMutation$, {
      provider: "cloudflare_access",
      ...args,
      operation: "adopt",
      ...args.body,
    });
    if (!result.ok) {
      return cloudflareAccessFailure(result.reason);
    }
    await set(publishUpdateInvalidation$, {
      actor: args.owner,
      scope: "organization",
      affectedHosts: result.invalidatedHosts,
    });
    return {
      ok: true as const,
      value: response(
        cloudflareNetworkMetadata(result.config),
        ownReferences(result.references, args.owner),
      ),
      affectedHosts: result.invalidatedHosts,
    };
  },
);
