import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import type {
  TailscaleConfig,
  UpdateTailscaleRequest,
} from "@okouai/api-contracts/contracts/tailscale";
import { TAILSCALE_ERROR_CODES } from "@okouai/api-contracts/contracts/tailscale-errors";

export interface TailscaleOwner {
  readonly orgId: string;
  readonly userId: string;
}
export interface TailscaleActor extends TailscaleOwner {
  readonly orgRole?: "admin" | "member";
}
export interface TailscaleConfigArgs {
  readonly owner: TailscaleActor;
  readonly configId: string;
}
export type TailscaleMetadata = Pick<
  typeof tailscaleConfigs.$inferSelect,
  | "id"
  | "name"
  | "scope"
  | "tags"
  | "revision"
  | "generation"
  | "createdAt"
  | "updatedAt"
>;
export type ReferencingTailscaleHost = Pick<
  typeof sshConnections.$inferSelect,
  "id" | "userId" | "displayName" | "generation"
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
export function visibleTailscaleConfig(owner: TailscaleOwner, id?: string) {
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
export function deniedTailscaleConfig(
  row: TailscaleMetadata,
  actor: TailscaleActor,
) {
  return row.scope === "organization" && actor.orgRole !== "admin";
}
export function tailscaleConfigResponse(
  row: TailscaleMetadata,
  sshHosts: TailscaleConfig["sshHosts"],
): TailscaleConfig {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sshHosts,
  };
}
export function referencingHostPredicate(args: TailscaleConfigArgs) {
  return and(
    eq(sshConnections.orgId, args.owner.orgId),
    eq(sshConnections.tailscaleId, args.configId),
  );
}
export function ownHostReferences(
  hosts: ReferencingTailscaleHost[],
  owner: TailscaleOwner,
) {
  return hosts
    .filter((host) => {
      return host.userId === owner.userId;
    })
    .map(({ id, displayName }) => {
      return { id, displayName };
    });
}
export function exhaustedTailscaleConfig(
  config: TailscaleMetadata,
  hosts: ReferencingTailscaleHost[],
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
export function tailscaleImpactSnapshot(
  config: TailscaleMetadata,
  hosts: ReferencingTailscaleHost[],
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
export function selectedTailscaleBindingId(
  id: string | null,
  creatingInline: boolean,
) {
  return creatingInline ? null : id;
}
export function inlineTailscaleValues(
  owner: TailscaleOwner,
  prepared: Pick<
    typeof tailscaleConfigs.$inferInsert,
    "name" | "tags" | "encryptedClientId" | "encryptedClientSecret"
  >,
) {
  return {
    ...prepared,
    orgId: owner.orgId,
    userId: owner.userId,
    scope: "personal" as const,
  };
}
export function createdInlineTailscaleId(
  requested: boolean,
  created: { readonly id: string } | undefined,
) {
  if (requested && !created) {
    throw new Error("Tailscale insert returned no row");
  }
  return created?.id;
}
export function changesTagMembership(
  tags: UpdateTailscaleRequest["tags"],
  current: TailscaleMetadata["tags"],
) {
  return (
    tags !== undefined &&
    (tags.length !== current.length ||
      tags.some((tag) => {
        return !current.includes(tag);
      }))
  );
}
