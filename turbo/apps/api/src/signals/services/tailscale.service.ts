import { command } from "ccstate";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
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
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { CreateSshConnectionRequest } from "@okouai/api-contracts/contracts/ssh-connections";
import { nowDate } from "../../lib/time";
import { isUniqueViolation } from "../../lib/pg-errors";
import { writeDb$ } from "../external/db";
import { encryptStoredSecretValue } from "./crypto.utils";
import { sshCreationResult } from "./ssh-creation.service";
import { publishSshRuntimeInvalidation$ } from "./ssh-runtime-wakeup.service";
import { publishTailscaleClientInvalidation } from "./tailscale-client-invalidation.service";
import { settle } from "../utils";
import {
  tailscaleFailure,
  visibleTailscaleConfig,
  deniedTailscaleConfig as denied,
  tailscaleConfigResponse as response,
  referencingHostPredicate,
  ownHostReferences,
  exhaustedTailscaleConfig as exhausted,
  tailscaleImpactSnapshot as impactSnapshot,
  changesTagMembership,
  type TailscaleOwner as Owner,
  type TailscaleActor as Actor,
  type TailscaleConfigArgs as ConfigArgs,
  type ReferencingTailscaleHost as ReferencingHost,
} from "./tailscale-config-model";
import {
  planTailscaleMutation,
  committedTailscaleMutation,
  type TailscaleMutationArgs,
} from "./tailscale-mutation-plan";

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
const referencingHostFields = Object.freeze({
  id: sshConnections.id,
  userId: sshConnections.userId,
  displayName: sshConnections.displayName,
  generation: sshConnections.generation,
});

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
export function requestedTailscaleId(
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
  return await prepareTailscaleConfig(transport.create, context);
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
          eq(sshConnections.tailscaleId, tailscaleConfigs.id),
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

// One attempt owns all SQL: retained UUID-ordered Hosts NKU -> config UPDATE.
// SHARE admission prevents post-fence arrivals; count equality is identity only
// because the actual returned locking-reader records remain a stable subset.
const commitTailscaleMutationAttempt$ = command(
  async ({ set }, args: TailscaleMutationArgs) => {
    return await set(writeDb$).transaction(async (tx) => {
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
      const hosts = await tx
        .select(referencingHostFields)
        .from(sshConnections)
        .where(referencingHostPredicate(args))
        .orderBy(asc(sshConnections.id))
        .for("no key update");
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
      const [references] = await tx
        .select({ count: count() })
        .from(sshConnections)
        .where(referencingHostPredicate(args));
      if (!references) {
        throw new Error("Tailscale reference count returned no row");
      }
      if (references.count < hosts.length) {
        throw new Error("Locked Tailscale reference count decreased");
      }
      if (references.count > hosts.length) {
        return { retryBindings: true as const };
      }
      const planned = planTailscaleMutation(args, config, hosts);
      if (!planned.ok) {
        return { retryBindings: false as const, value: planned };
      }
      const plan = planned.plan;
      // Adoption and deletion detach other owners before config scope/removal.
      if (plan.detachOthers) {
        await tx
          .update(sshConnections)
          .set({
            tailscaleId: null,
            transport: "tailscale",
            legacyNeedsRebind: true,
            generation: sql`${sshConnections.generation} + 1`,
            updatedAt: nowDate(),
          })
          .where(
            and(
              eq(sshConnections.orgId, args.owner.orgId),
              eq(sshConnections.tailscaleId, args.configId),
              ne(sshConnections.userId, args.owner.userId),
            ),
          );
      }
      if (plan.kind === "delete") {
        await tx
          .delete(tailscaleConfigs)
          .where(eq(tailscaleConfigs.id, args.configId));
        return committedTailscaleMutation(config, hosts, plan);
      }
      if (plan.advanceHosts === "own") {
        await tx
          .update(sshConnections)
          .set({
            generation: sql`${sshConnections.generation} + 1`,
            updatedAt: nowDate(),
          })
          .where(
            and(
              eq(sshConnections.orgId, args.owner.orgId),
              eq(sshConnections.tailscaleId, args.configId),
              eq(sshConnections.userId, args.owner.userId),
            ),
          );
      }
      const [updated] = await tx
        .update(tailscaleConfigs)
        .set({ ...plan.configUpdate, updatedAt: nowDate() })
        .where(eq(tailscaleConfigs.id, args.configId))
        .returning(metadata);
      if (!updated) {
        throw new Error(plan.missingRowMessage);
      }
      // Update/promotion preserve config-before-generation-write statement order.
      if (plan.advanceHosts === "all") {
        await tx
          .update(sshConnections)
          .set({
            generation: sql`${sshConnections.generation} + 1`,
            updatedAt: nowDate(),
          })
          .where(referencingHostPredicate(args));
      }
      return committedTailscaleMutation(updated, hosts, plan);
    });
  },
);
const commitTailscaleMutation$ = command(
  async ({ set }, args: TailscaleMutationArgs) => {
    const first = await set(commitTailscaleMutationAttempt$, args);
    // Exactly one fresh known-unwritten attempt. Never repeat preparation/KMS,
    // retry exceptions, or replay a successful/ambiguous effect.
    const result = first.retryBindings
      ? await set(commitTailscaleMutationAttempt$, args)
      : first;
    return result.retryBindings ? tailscaleFailure("conflict") : result.value;
  },
);
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
const updateTailscaleMetadata$ = command(
  async (
    { set },
    args: ConfigArgs & {
      readonly body: Pick<
        UpdateTailscaleRequest,
        "expectedRevision" | "name" | "tags"
      >;
    },
  ) => {
    const result = await set(writeDb$).transaction(async (tx) => {
      const [config] = await tx
        .select(metadata)
        .from(tailscaleConfigs)
        .where(visibleTailscaleConfig(args.owner, args.configId))
        .for("update");
      if (!config) {
        return tailscaleFailure("notFound");
      }
      if (denied(config, args.owner)) {
        return tailscaleFailure("forbidden");
      }
      if (
        config.revision !== args.body.expectedRevision ||
        changesTagMembership(args.body.tags, config.tags)
      ) {
        return tailscaleFailure("conflict");
      }
      if (exhausted(config, [], false)) {
        return tailscaleFailure("exhausted");
      }
      const [updated] = await tx
        .update(tailscaleConfigs)
        .set({
          name: args.body.name,
          tags: args.body.tags,
          revision: config.revision + 1,
          updatedAt: nowDate(),
        })
        .where(eq(tailscaleConfigs.id, config.id))
        .returning(metadata);
      if (!updated) {
        throw new Error("Tailscale metadata update returned no row");
      }
      // Caller MVCC metadata, not impact/authority. No later Host lock or write.
      const hosts = await tx
        .select({
          id: sshConnections.id,
          displayName: sshConnections.displayName,
        })
        .from(sshConnections)
        .where(
          and(
            referencingHostPredicate(args),
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
      await publishTailscaleClientInvalidation(args.owner, result.scope);
    }
    return result;
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
    const [initial] = await set(writeDb$)
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
    if (
      args.body.credentials === undefined &&
      !changesTagMembership(args.body.tags, initial.tags)
    ) {
      return await set(updateTailscaleMetadata$, args);
    }
    const encrypted =
      args.body.credentials === undefined
        ? undefined
        : await encryptCredentials(args.body.credentials, args.featureContext);
    const result = await set(commitTailscaleMutation$, {
      ...args,
      operation: "update",
      encrypted,
    });
    if (!result.ok) {
      return result;
    }
    await set(publishUpdateInvalidation$, {
      owner: args.owner,
      scope: result.scope,
      hosts: result.invalidatedHosts,
    });
    return {
      ok: true as const,
      value: response(
        result.config,
        ownHostReferences(result.hosts, args.owner),
      ),
      scope: result.scope,
      hosts: result.invalidatedHosts,
    };
  },
);
export const deleteTailscaleConfig$ = command(
  async (
    { set },
    args: ConfigArgs & { readonly body: DeleteTailscaleRequest },
  ) => {
    const result = await set(commitTailscaleMutation$, {
      ...args,
      operation: "delete",
    });
    if (!result.ok) {
      return result;
    }
    await publishTailscaleClientInvalidation(args.owner, result.scope);
    return { ok: true as const, scope: result.scope };
  },
);
export const convertTailscaleToOrganization$ = command(
  async ({ set }, args: ConfigArgs & { readonly expectedRevision: number }) => {
    if (args.owner.orgRole !== "admin") {
      return tailscaleFailure("forbidden");
    }
    const result = await set(commitTailscaleMutation$, {
      ...args,
      operation: "promote",
    });
    if (!result.ok) {
      return result;
    }
    await set(publishUpdateInvalidation$, {
      owner: args.owner,
      scope: "organization",
      hosts: result.invalidatedHosts,
    });
    return {
      ok: true as const,
      value: response(
        result.config,
        ownHostReferences(result.hosts, args.owner),
      ),
      hosts: result.invalidatedHosts,
    };
  },
);
export const previewTailscaleImpact$ = command(
  async (
    { set },
    args: ConfigArgs & { readonly operation: "convert" | "delete" },
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
    const hosts = await db
      .select(referencingHostFields)
      .from(sshConnections)
      .where(referencingHostPredicate(args))
      .orderBy(asc(sshConnections.id));
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
    args: ConfigArgs & { readonly body: ConvertTailscaleRequest },
  ) => {
    if (args.owner.orgRole !== "admin") {
      return tailscaleFailure("forbidden");
    }
    const result = await set(commitTailscaleMutation$, {
      ...args,
      operation: "adopt",
    });
    if (!result.ok) {
      return result;
    }
    await set(publishUpdateInvalidation$, {
      owner: args.owner,
      scope: "organization",
      hosts: result.invalidatedHosts,
    });
    return {
      ok: true as const,
      value: response(
        result.config,
        ownHostReferences(result.hosts, args.owner),
      ),
      hosts: result.invalidatedHosts,
    };
  },
);
