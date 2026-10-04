import { command } from "ccstate";
import { and, asc, eq, or } from "drizzle-orm";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import type {
  CreateTailscaleConfigRequest,
  CreateTailscaleRequest,
  TailscaleConfig,
  UpdateTailscaleRequest,
} from "@okouai/api-contracts/contracts/tailscale";
import { TAILSCALE_ERROR_CODES } from "@okouai/api-contracts/contracts/tailscale-errors";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { nowDate } from "../../lib/time";
import { isUniqueViolation, safeSqlStateCode } from "../../lib/pg-errors";
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
    id: body.id,
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
  return "configId" in transport ? transport.configId : transport.create.id;
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
    .where(visibleTailscaleConfig(owner, id));
  return row !== undefined;
}

export async function insertInlineTailscaleConfig(
  db: Pick<Db, "insert">,
  owner: Owner,
  inline: Awaited<ReturnType<typeof prepareTailscaleConfig>> | undefined,
): Promise<void> {
  if (inline === undefined) {
    return;
  }
  await db.insert(tailscaleConfigs).values({
    ...inline,
    orgId: owner.orgId,
    userId: owner.userId,
    scope: "personal",
  });
}

export const listTailscaleConfigs$ = command(
  async ({ set }, owner: Owner, id?: string): Promise<TailscaleConfig[]> => {
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
      .where(visibleTailscaleConfig(owner, id))
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
          .values({ ...owner, scope, ...prepared })
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
export const updateTailscaleConfig$ = command(
  async (
    { set },
    args: {
      readonly owner: Actor;
      readonly configId: string;
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
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select(metadata)
        .from(tailscaleConfigs)
        .where(visibleTailscaleConfig(args.owner, args.configId))
        .for("update");
      if (!row) {
        return tailscaleFailure("notFound");
      }
      if (denied(row, args.owner)) {
        return tailscaleFailure("forbidden");
      }
      if (row.revision !== args.body.expectedRevision) {
        return tailscaleFailure("conflict");
      }
      const effective =
        encrypted !== undefined ||
        (args.body.tags !== undefined &&
          JSON.stringify(args.body.tags) !== JSON.stringify(row.tags));
      if (
        row.revision === 2_147_483_647 ||
        (effective && row.generation === 2_147_483_647)
      ) {
        return tailscaleFailure("exhausted");
      }
      const [updated] = await tx
        .update(tailscaleConfigs)
        .set({
          name: args.body.name,
          tags: args.body.tags,
          ...encrypted,
          revision: row.revision + 1,
          generation: row.generation + (effective ? 1 : 0),
          updatedAt: nowDate(),
        })
        .where(eq(tailscaleConfigs.id, row.id))
        .returning(metadata);
      if (!updated) {
        throw new Error("Tailscale update returned no row");
      }
      // Do not lock or update hosts while holding a config lock: pin locks host then config.
      return { ok: true as const, value: updated, effective };
    });
    if (!result.ok) {
      return result;
    }
    if (result.effective) {
      const hosts = await db
        .select({ id: sshConnections.id, userId: sshConnections.userId })
        .from(sshConnections)
        .where(
          and(
            eq(sshConnections.orgId, args.owner.orgId),
            eq(sshConnections.tailscaleConfigId, args.configId),
          ),
        );
      const owners = new Map<string, string[]>();
      for (const host of hosts) {
        const ids = owners.get(host.userId) ?? [];
        ids.push(host.id);
        owners.set(host.userId, ids);
      }
      for (const [userId, connectionIds] of owners) {
        await set(publishSshRuntimeInvalidation$, {
          orgId: args.owner.orgId,
          userId,
          connectionIds,
        });
      }
    }
    await publishTailscaleClientInvalidation(args.owner, result.value.scope);
    const [view] = await set(listTailscaleConfigs$, args.owner, args.configId);
    return {
      ok: true as const,
      value: response(result.value, view?.sshHosts ?? []),
    };
  },
);
export const deleteTailscaleConfig$ = command(
  async (
    { set },
    args: {
      readonly owner: Actor;
      readonly configId: string;
      readonly expectedRevision: number;
    },
  ) => {
    const db = set(writeDb$);
    const deletion = await settle(
      db.transaction(async (tx) => {
        const [row] = await tx
          .select(metadata)
          .from(tailscaleConfigs)
          .where(visibleTailscaleConfig(args.owner, args.configId))
          .for("update");
        if (!row) {
          return tailscaleFailure("notFound");
        }
        if (denied(row, args.owner)) {
          return tailscaleFailure("forbidden");
        }
        if (row.revision !== args.expectedRevision) {
          return tailscaleFailure("conflict");
        }
        const [host] = await tx
          .select({ id: sshConnections.id })
          .from(sshConnections)
          .where(
            and(
              eq(sshConnections.orgId, args.owner.orgId),
              eq(sshConnections.tailscaleConfigId, row.id),
            ),
          )
          .limit(1);
        if (host) {
          return tailscaleFailure("inUse");
        }
        await tx
          .delete(tailscaleConfigs)
          .where(eq(tailscaleConfigs.id, row.id));
        return { ok: true as const, scope: row.scope };
      }),
    );
    if (!deletion.ok) {
      const e = deletion.error;
      const code = safeSqlStateCode(e);
      if (
        (code === "23503" || code === "23001") &&
        e instanceof Error &&
        typeof e.cause === "object" &&
        e.cause !== null &&
        "constraint" in e.cause &&
        e.cause.constraint === "ssh_connections_tailscale_org_fk"
      ) {
        return tailscaleFailure("inUse");
      }
      throw e;
    }
    if (deletion.value.ok) {
      await publishTailscaleClientInvalidation(
        args.owner,
        deletion.value.scope,
      );
    }
    return deletion.value;
  },
);
