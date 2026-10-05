import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import type {
  CreateTailscaleConfigRequest,
  CreateTailscaleRequest,
  TailscaleConfig,
  UpdateTailscaleRequest,
  DeleteTailscaleRequest,
  ConvertTailscaleRequest,
} from "@okouai/api-contracts/contracts/tailscale";
import { TAILSCALE_ERROR_CODES } from "@okouai/api-contracts/contracts/tailscale-errors";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { nowDate } from "../../lib/time";
import { isUniqueViolation } from "../../lib/pg-errors";
import { writeDb$, type Db } from "../external/db";
import type { CreateSshConnectionRequest } from "@okouai/api-contracts/contracts/ssh-connections";
import { encryptStoredSecretValue } from "./crypto.utils";
import { sshCreationResult } from "./ssh-creation.service";
import { publishSshRuntimeInvalidation$ } from "./ssh-runtime-wakeup.service";
import { publishTailscaleClientInvalidation } from "./tailscale-client-invalidation.service";
import { settle } from "../utils";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
interface Actor extends Owner {
  readonly orgRole?: "admin" | "member";
}
const metadata = Object.freeze({
  id: tailscaleConfigs.id,
  name: tailscaleConfigs.name,
  scope: tailscaleConfigs.scope,
  tags: tailscaleConfigs.tags,
  revision: tailscaleConfigs.revision,
  generation: tailscaleConfigs.generation,
  createdAt: tailscaleConfigs.createdAt,
  updatedAt: tailscaleConfigs.updatedAt,
});
type Metadata = Pick<
  typeof tailscaleConfigs.$inferSelect,
  keyof typeof metadata
>;
const failures = {
  notFound: {
    kind: "not_found",
    code: TAILSCALE_ERROR_CODES.NOT_FOUND,
    message: "Tailscale configuration not found",
  },
  forbidden: {
    kind: "forbidden",
    code: TAILSCALE_ERROR_CODES.FORBIDDEN,
    message:
      "Only organization admins can manage shared Tailscale configuration",
  },
  resourceIdConflict: {
    kind: "conflict",
    code: TAILSCALE_ERROR_CODES.RESOURCE_ID_CONFLICT,
    message: "This resource ID cannot be used for this Tailscale configuration",
  },
  conflict: {
    kind: "conflict",
    code: TAILSCALE_ERROR_CODES.REVISION_CONFLICT,
    message: "Tailscale configuration was modified by another request",
  },
  impactConflict: {
    kind: "conflict",
    code: TAILSCALE_ERROR_CODES.IMPACT_CONFLICT,
    message: "Tailscale host impact changed; review it again",
  },
  exhausted: {
    kind: "conflict",
    code: TAILSCALE_ERROR_CODES.REVISION_EXHAUSTED,
    message: "Tailscale revision limit reached",
  },
  inUse: {
    kind: "conflict",
    code: TAILSCALE_ERROR_CODES.IN_USE,
    message: "Tailscale configuration is used by an SSH host",
  },
} as const;
export function tailscaleFailure<K extends keyof typeof failures>(reason: K) {
  return { ok: false as const, ...failures[reason] };
}
export function visibleTailscaleConfig(owner: Owner, id?: string) {
  return and(
    eq(tailscaleConfigs.orgId, owner.orgId),
    or(
      eq(tailscaleConfigs.scope, "organization"),
      and(
        eq(tailscaleConfigs.scope, "personal"),
        eq(tailscaleConfigs.userId, owner.userId),
      ),
    ),
    id === undefined ? undefined : eq(tailscaleConfigs.id, id),
  );
}
function denied(row: Metadata, actor: Actor) {
  return row.scope === "organization" && actor.orgRole !== "admin";
}
function response(
  row: Metadata,
  sshHosts: TailscaleConfig["sshHosts"],
): TailscaleConfig {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sshHosts,
  };
}
async function encryptCredentials(
  credentials: CreateTailscaleRequest["credentials"],
  context: FeatureSwitchContext,
) {
  return {
    encryptedClientId: await encryptStoredSecretValue(
      credentials.clientId,
      context,
    ),
    encryptedClientSecret: await encryptStoredSecretValue(
      credentials.clientSecret,
      context,
    ),
  };
}
export async function prepareTailscaleConfig(
  body: CreateTailscaleRequest,
  context: FeatureSwitchContext,
) {
  return {
    name: body.name,
    tags: body.tags,
    ...(await encryptCredentials(body.credentials, context)),
  };
}
export function requestedTailscaleConfigId(
  transport: CreateSshConnectionRequest["transport"],
  current: string | null = null,
): string | null {
  if (transport === undefined) {
    return current;
  }
  if (transport.type !== "tailscale") {
    return null;
  }
  return "configId" in transport ? transport.configId : null;
}

export async function prepareInlineTailscaleConfig(
  transport: CreateSshConnectionRequest["transport"],
  context: FeatureSwitchContext,
) {
  if (transport?.type !== "tailscale" || !("create" in transport)) {
    return undefined;
  }
  const prepared = await prepareTailscaleConfig(transport.create, context);
  return prepared;
}

export async function canBindTailscaleConfig(
  db: Pick<Db, "select">,
  owner: Owner,
  id: string | null,
  inline: Awaited<ReturnType<typeof prepareTailscaleConfig>> | undefined,
): Promise<boolean> {
  if (id === null || inline !== undefined) {
    return true;
  }
  const [row] = await db
    .select({ id: tailscaleConfigs.id })
    .from(tailscaleConfigs)
    .where(visibleTailscaleConfig(owner, id))
    .for("share");
  return row !== undefined;
}

export async function insertInlineTailscaleConfig(
  db: Pick<Db, "insert">,
  owner: Owner,
  inline: Awaited<ReturnType<typeof prepareTailscaleConfig>> | undefined,
): Promise<string | undefined> {
  if (inline === undefined) {
    return undefined;
  }
  const [created] = await db
    .insert(tailscaleConfigs)
    .values({
      ...inline,
      orgId: owner.orgId,
      userId: owner.userId,
      scope: "personal",
    })
    .returning({ id: tailscaleConfigs.id });
  if (!created) {
    throw new Error("Tailscale insert returned no row");
  }
  return created.id;
}

export const listTailscaleConfigs$ = command(
  async ({ set }, owner: Owner): Promise<TailscaleConfig[]> => {
    const rows = await set(writeDb$)
      .select({
        config: metadata,
        host: {
          id: sshConnections.id,
          displayName: sshConnections.displayName,
        },
      })
      .from(tailscaleConfigs)
      .leftJoin(
        sshConnections,
        and(
          eq(sshConnections.tailscaleConfigId, tailscaleConfigs.id),
          eq(sshConnections.orgId, owner.orgId),
          eq(sshConnections.userId, owner.userId),
        ),
      )
      .where(visibleTailscaleConfig(owner))
      .orderBy(
        asc(tailscaleConfigs.createdAt),
        asc(tailscaleConfigs.id),
        asc(sshConnections.id),
      );
    const configs = new Map<string, TailscaleConfig>();
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
export const createTailscaleConfig$ = command(
  async (
    { set },
    args: {
      readonly owner: Actor;
      readonly body: CreateTailscaleConfigRequest;
      readonly featureContext: FeatureSwitchContext;
    },
  ) => {
    const scope = args.body.scope ?? "personal";
    if (scope === "organization" && args.owner.orgRole !== "admin") {
      return tailscaleFailure("forbidden");
    }
    const db = set(writeDb$);
    const prepared = await prepareTailscaleConfig(
      args.body,
      args.featureContext,
    );
    const owner = {
      orgId: args.owner.orgId,
      userId: scope === "organization" ? null : args.owner.userId,
    };
    const created = await settle(
      db.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            orgId: tailscaleConfigs.orgId,
            userId: tailscaleConfigs.userId,
          })
          .from(tailscaleConfigs)
          .where(eq(tailscaleConfigs.id, args.body.id));
        const result = sshCreationResult(owner, existing);
        if (!result.ok) {
          return tailscaleFailure("resourceIdConflict");
        }
        if (!result.value) {
          return { ok: true as const, value: undefined };
        }
        const [row] = await tx
          .insert(tailscaleConfigs)
          .values({ id: args.body.id, ...owner, scope, ...prepared })
          .returning(metadata);
        if (!row) {
          throw new Error("Tailscale insert returned no row");
        }
        return { ok: true as const, value: response(row, []) };
      }),
    );
    if (!created.ok) {
      if (!isUniqueViolation(created.error, "tailscale_configs_pkey")) {
        throw created.error;
      }
      const [existing] = await db
        .select({
          orgId: tailscaleConfigs.orgId,
          userId: tailscaleConfigs.userId,
        })
        .from(tailscaleConfigs)
        .where(eq(tailscaleConfigs.id, args.body.id));
      return existing &&
        existing.orgId === owner.orgId &&
        existing.userId === owner.userId
        ? { ok: true as const, value: undefined }
        : tailscaleFailure("resourceIdConflict");
    }
    if (created.value.ok && created.value.value !== undefined) {
      await publishTailscaleClientInvalidation(args.owner, scope);
    }
    return created.value;
  },
);
type ReferencingHost = Pick<
  typeof sshConnections.$inferSelect,
  "id" | "userId" | "displayName" | "generation"
>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
interface ConfigArgs {
  readonly owner: Actor;
  readonly configId: string;
}
function referencingHosts(db: Pick<Db, "select">, args: ConfigArgs) {
  return db
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
        eq(sshConnections.tailscaleConfigId, args.configId),
      ),
    )
    .orderBy(asc(sshConnections.id));
}
// Follow the shared SSH host-before-credential/config order. The exclusive
// configuration fence also serializes FK admission of a first/new binding.
// Rescan once only after a known-unwritten transaction, never after an effect.
async function mutateConfig<T>(
  db: Db,
  args: ConfigArgs,
  change: (
    tx: Transaction,
    config: Metadata,
    hosts: ReferencingHost[],
  ) => Promise<T>,
) {
  const commit = () => {
    return db.transaction(async (tx) => {
      const [initial] = await tx
        .select(metadata)
        .from(tailscaleConfigs)
        .where(visibleTailscaleConfig(args.owner, args.configId));
      if (!initial) {
        return {
          retryBindings: false as const,
          value: tailscaleFailure("notFound"),
        };
      }
      if (denied(initial, args.owner)) {
        return {
          retryBindings: false as const,
          value: tailscaleFailure("forbidden"),
        };
      }
      const hosts = await referencingHosts(tx, args).for("no key update");
      const [config] = await tx
        .select(metadata)
        .from(tailscaleConfigs)
        .where(visibleTailscaleConfig(args.owner, args.configId))
        .for("update");
      if (!config) {
        return {
          retryBindings: false as const,
          value: tailscaleFailure("notFound"),
        };
      }
      if (denied(config, args.owner)) {
        return {
          retryBindings: false as const,
          value: tailscaleFailure("forbidden"),
        };
      }
      const ids = new Set(
        hosts.map((host) => {
          return host.id;
        }),
      );
      const current = await referencingHosts(tx, args);
      if (
        current.some((host) => {
          return !ids.has(host.id);
        })
      ) {
        return { retryBindings: true as const };
      }
      return {
        retryBindings: false as const,
        value: await change(tx, config, current),
      };
    });
  };
  const first = await commit();
  const result = first.retryBindings ? await commit() : first;
  return result.retryBindings ? tailscaleFailure("conflict") : result.value;
}
function ownHostReferences(hosts: ReferencingHost[], owner: Owner) {
  return hosts
    .filter((host) => {
      return host.userId === owner.userId;
    })
    .map(({ id, displayName }) => {
      return { id, displayName };
    });
}
function exhausted(
  config: Metadata,
  hosts: ReferencingHost[],
  effective = true,
) {
  return (
    config.revision === 2_147_483_647 ||
    (effective &&
      (config.generation === 2_147_483_647 ||
        hosts.some((host) => {
          return host.generation === 2_147_483_647;
        })))
  );
}
function impactSnapshot(config: Metadata, hosts: ReferencingHost[]) {
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
const publishUpdateInvalidation$ = command(
  async (
    { set },
    args: {
      readonly owner: Owner;
      readonly scope: "personal" | "organization";
      readonly hosts: ReferencingHost[];
    },
  ) => {
    await publishTailscaleClientInvalidation(args.owner, args.scope);
    const groups = new Map<string, string[]>();
    for (const host of args.hosts) {
      const ids = groups.get(host.userId) ?? [];
      ids.push(host.id);
      groups.set(host.userId, ids);
    }
    const owners = [...groups.entries()];
    for (let offset = 0; offset < owners.length; offset += 16) {
      await Promise.all(
        owners
          .slice(offset, offset + 16)
          .map(async ([userId, connectionIds]) => {
            await set(publishSshRuntimeInvalidation$, {
              orgId: args.owner.orgId,
              userId,
              connectionIds,
            });
          }),
      );
    }
  },
);
export const updateTailscaleConfig$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly body: UpdateTailscaleRequest;
      readonly featureContext: FeatureSwitchContext;
    },
  ) => {
    const db = set(writeDb$);
    const [initial] = await db
      .select(metadata)
      .from(tailscaleConfigs)
      .where(visibleTailscaleConfig(args.owner, args.configId));
    if (!initial) {
      return tailscaleFailure("notFound");
    }
    if (denied(initial, args.owner)) {
      return tailscaleFailure("forbidden");
    }
    if (initial.revision !== args.body.expectedRevision) {
      return tailscaleFailure("conflict");
    }
    const encrypted =
      args.body.credentials === undefined
        ? undefined
        : await encryptCredentials(args.body.credentials, args.featureContext);
    const result = await mutateConfig(db, args, async (tx, config, hosts) => {
      if (config.revision !== args.body.expectedRevision) {
        return tailscaleFailure("conflict");
      }
      const effective =
        encrypted !== undefined ||
        (args.body.tags !== undefined &&
          (args.body.tags.length !== config.tags.length ||
            args.body.tags.some((tag) => {
              return !config.tags.includes(tag);
            })));
      if (exhausted(config, hosts, effective)) {
        return tailscaleFailure("exhausted");
      }
      const [updated] = await tx
        .update(tailscaleConfigs)
        .set({
          name: args.body.name,
          tags: args.body.tags,
          ...encrypted,
          revision: config.revision + 1,
          generation: config.generation + (effective ? 1 : 0),
          updatedAt: nowDate(),
        })
        .where(eq(tailscaleConfigs.id, config.id))
        .returning(metadata);
      if (!updated) {
        throw new Error("Tailscale update returned no row");
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
              eq(sshConnections.tailscaleConfigId, args.configId),
            ),
          );
      }
      return {
        ok: true as const,
        value: response(updated, ownHostReferences(hosts, args.owner)),
        scope: config.scope,
        hosts: effective ? hosts : [],
      };
    });
    if (result.ok) {
      await set(publishUpdateInvalidation$, {
        owner: args.owner,
        scope: result.scope,
        hosts: result.hosts,
      });
    }
    return result;
  },
);
async function detachOtherHosts(tx: Transaction, args: ConfigArgs) {
  await tx
    .update(sshConnections)
    .set({
      tailscaleConfigId: null,
      needsRebind: true,
      rebindTransport: "tailscale",
      generation: sql`${sshConnections.generation} + 1`,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(sshConnections.orgId, args.owner.orgId),
        eq(sshConnections.tailscaleConfigId, args.configId),
        ne(sshConnections.userId, args.owner.userId),
      ),
    );
}
export const deleteTailscaleConfig$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly body: DeleteTailscaleRequest;
    },
  ) => {
    const result = await mutateConfig(
      set(writeDb$),
      args,
      async (tx, config, hosts) => {
        if (config.revision !== args.body.expectedRevision) {
          return tailscaleFailure("conflict");
        }
        if (
          hosts.some((host) => {
            return host.userId === args.owner.userId;
          })
        ) {
          return tailscaleFailure("inUse");
        }
        if (
          (args.body.impactSnapshot !== undefined &&
            args.body.impactSnapshot !== impactSnapshot(config, hosts)) ||
          (hosts.length > 0 &&
            (config.scope !== "organization" ||
              args.body.impactSnapshot === undefined))
        ) {
          return tailscaleFailure("impactConflict");
        }
        if (
          hosts.some((host) => {
            return host.generation === 2_147_483_647;
          })
        ) {
          return tailscaleFailure("exhausted");
        }
        if (hosts.length > 0) {
          await detachOtherHosts(tx, args);
        }
        await tx
          .delete(tailscaleConfigs)
          .where(eq(tailscaleConfigs.id, args.configId));
        return { ok: true as const, scope: config.scope };
      },
    );
    if (result.ok) {
      await publishTailscaleClientInvalidation(args.owner, result.scope);
    }
    return result;
  },
);
export const convertTailscaleToOrganization$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly expectedRevision: number;
    },
  ) => {
    if (args.owner.orgRole !== "admin") {
      return tailscaleFailure("forbidden");
    }
    const result = await mutateConfig(
      set(writeDb$),
      args,
      async (tx, config, hosts) => {
        if (config.scope !== "personal") {
          return tailscaleFailure("notFound");
        }
        if (config.revision !== args.expectedRevision) {
          return tailscaleFailure("conflict");
        }
        if (exhausted(config, hosts)) {
          return tailscaleFailure("exhausted");
        }
        if (
          hosts.some((host) => {
            return host.userId !== args.owner.userId;
          })
        ) {
          return tailscaleFailure("inUse");
        }
        const [converted] = await tx
          .update(tailscaleConfigs)
          .set({
            scope: "organization",
            userId: null,
            revision: config.revision + 1,
            generation: config.generation + 1,
            updatedAt: nowDate(),
          })
          .where(eq(tailscaleConfigs.id, args.configId))
          .returning(metadata);
        if (!converted) {
          throw new Error("Tailscale promotion returned no row");
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
              eq(sshConnections.tailscaleConfigId, args.configId),
            ),
          );
        return {
          ok: true as const,
          value: response(converted, ownHostReferences(hosts, args.owner)),
          hosts,
        };
      },
    );
    if (result.ok) {
      await set(publishUpdateInvalidation$, {
        owner: args.owner,
        scope: "organization",
        hosts: result.hosts,
      });
    }
    return result;
  },
);
export const previewTailscaleImpact$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly operation: "convert" | "delete";
    },
  ) => {
    if (args.operation === "delete" && args.owner.orgRole !== "admin") {
      return tailscaleFailure("forbidden");
    }
    const db = set(writeDb$);
    const [config] = await db
      .select(metadata)
      .from(tailscaleConfigs)
      .where(
        and(
          eq(tailscaleConfigs.orgId, args.owner.orgId),
          eq(tailscaleConfigs.id, args.configId),
          eq(tailscaleConfigs.scope, "organization"),
        ),
      );
    if (!config) {
      return tailscaleFailure("notFound");
    }
    if (args.owner.orgRole !== "admin") {
      return tailscaleFailure("forbidden");
    }
    const hosts = await referencingHosts(db, args);
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
        impactSnapshot: impactSnapshot(config, hosts),
      },
    };
  },
);
export const convertTailscaleToPersonal$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly body: ConvertTailscaleRequest;
    },
  ) => {
    if (args.owner.orgRole !== "admin") {
      return tailscaleFailure("forbidden");
    }
    const result = await mutateConfig(
      set(writeDb$),
      args,
      async (tx, config, hosts) => {
        if (config.scope !== "organization") {
          return tailscaleFailure("notFound");
        }
        if (config.revision !== args.body.expectedRevision) {
          return tailscaleFailure("conflict");
        }
        if (impactSnapshot(config, hosts) !== args.body.impactSnapshot) {
          return tailscaleFailure("impactConflict");
        }
        if (exhausted(config, hosts)) {
          return tailscaleFailure("exhausted");
        }
        await detachOtherHosts(tx, args);
        await tx
          .update(sshConnections)
          .set({
            generation: sql`${sshConnections.generation} + 1`,
            updatedAt: nowDate(),
          })
          .where(
            and(
              eq(sshConnections.orgId, args.owner.orgId),
              eq(sshConnections.tailscaleConfigId, args.configId),
              eq(sshConnections.userId, args.owner.userId),
            ),
          );
        const [converted] = await tx
          .update(tailscaleConfigs)
          .set({
            scope: "personal",
            userId: args.owner.userId,
            revision: config.revision + 1,
            generation: config.generation + 1,
            updatedAt: nowDate(),
          })
          .where(eq(tailscaleConfigs.id, args.configId))
          .returning(metadata);
        if (!converted) {
          throw new Error("Tailscale conversion returned no row");
        }
        return {
          ok: true as const,
          value: response(converted, ownHostReferences(hosts, args.owner)),
          hosts,
        };
      },
    );
    if (result.ok) {
      await set(publishUpdateInvalidation$, {
        owner: args.owner,
        scope: "organization",
        hosts: result.hosts,
      });
    }
    return result;
  },
);
