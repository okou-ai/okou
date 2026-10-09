import { command, computed, type Computed } from "ccstate";
import {
  and,
  arrayContained,
  arrayContains,
  asc,
  eq,
  lt,
  sql,
} from "drizzle-orm";
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
import { db$, writeDb$ } from "../external/db";
import { encryptStoredSecretValue } from "./crypto.utils";
import { publishSshRuntimeInvalidation$ } from "./ssh-runtime-wakeup.service";
import { publishTailscaleClientInvalidation } from "./tailscale-client-invalidation.service";
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
import { commitTailscaleMutation$ } from "./tailscale-effective-mutation";

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
export function createTailscaleConfigList(owner$: Computed<Owner>) {
  return computed(async (get): Promise<TailscaleConfig[]> => {
    const owner = get(owner$);
    const rows = await get(db$)
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
  });
}
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
    // Both unique arbiters contain the caller-chosen ID: the primary key and
    // its org-scoped FK backing key can each win speculative insertion races.
    // A conflict never updates credentials; only its owner may reconcile.
    const [created] = await db
      .insert(tailscaleConfigs)
      .values({ id: args.body.id, ...owner, scope, ...prepared })
      .onConflictDoNothing()
      .returning(metadata);
    if (!created) {
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
    await publishTailscaleClientInvalidation(args.owner, scope);
    return { ok: true as const, value: response(created, []) };
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
    const db = set(writeDb$);
    // Keep the existing config fence and its captured failure clock in one SQL
    // statement. This lane never acquires or mutates Host authority afterward.
    const current = db
      .$with("current_tailscale_metadata")
      .as(
        db
          .select(metadata)
          .from(tailscaleConfigs)
          .where(visibleTailscaleConfig(args.owner, args.configId))
          .for("update"),
      );
    const tags = args.body.tags;
    const updated = db.$with("updated_tailscale_metadata").as(
      db
        .update(tailscaleConfigs)
        .set({
          name: args.body.name,
          tags,
          revision: sql`${tailscaleConfigs.revision} + 1`,
          updatedAt: nowDate(),
        })
        .from(current)
        .where(
          and(
            eq(tailscaleConfigs.id, current.id),
            args.owner.orgRole === "admin"
              ? undefined
              : eq(current.scope, "personal"),
            eq(current.revision, args.body.expectedRevision),
            lt(current.revision, 2_147_483_647),
            tags === undefined
              ? undefined
              : and(
                  arrayContains(current.tags, tags),
                  arrayContained(current.tags, tags),
                  sql`cardinality(${current.tags}) = ${tags.length}`,
                ),
          ),
        )
        .returning({ ...metadata }),
    );
    // Host names are caller-only, nonlocking statement-snapshot observations,
    // not reviewed impact or revocation authority. Read changed config fields
    // from RETURNING: the base table retains the statement's initial snapshot.
    const rows = await db
      .with(current, updated)
      .select({
        config: {
          id: current.id,
          name: current.name,
          scope: current.scope,
          tags: current.tags,
          revision: current.revision,
          generation: current.generation,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
        },
        updated: {
          id: updated.id,
          name: updated.name,
          scope: updated.scope,
          tags: updated.tags,
          revision: updated.revision,
          generation: updated.generation,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
        host: {
          id: sshConnections.id,
          displayName: sshConnections.displayName,
        },
      })
      .from(current)
      .leftJoin(updated, eq(updated.id, current.id))
      .leftJoin(
        sshConnections,
        and(
          eq(sshConnections.tailscaleId, updated.id),
          eq(sshConnections.orgId, args.owner.orgId),
          eq(sshConnections.userId, args.owner.userId),
        ),
      )
      .orderBy(asc(sshConnections.id));
    const [first] = rows;
    if (!first) {
      return tailscaleFailure("notFound");
    }
    if (denied(first.config, args.owner)) {
      return tailscaleFailure("forbidden");
    }
    if (
      first.config.revision !== args.body.expectedRevision ||
      changesTagMembership(tags, first.config.tags)
    ) {
      return tailscaleFailure("conflict");
    }
    if (exhausted(first.config, [], false)) {
      return tailscaleFailure("exhausted");
    }
    if (!first.updated) {
      throw new Error("Tailscale metadata update returned no row");
    }
    const hosts = rows.flatMap(({ host }) => {
      return host ? [host] : [];
    });
    await publishTailscaleClientInvalidation(args.owner, first.updated.scope);
    return {
      ok: true as const,
      value: response(first.updated, hosts),
      scope: first.updated.scope,
    };
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
export function createTailscaleImpactPreview(
  args$: Computed<ConfigArgs & { readonly operation: "convert" | "delete" }>,
) {
  return computed(async (get) => {
    const args = get(args$);
    if (args.operation === "delete" && args.owner.orgRole !== "admin") {
      return tailscaleFailure("forbidden");
    }
    const db = get(db$);
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
  });
}
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
