import {
  and,
  arrayContained,
  arrayContains,
  asc,
  count,
  eq,
  exists,
  ne,
  not,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { enum as zEnum, type infer as zInfer } from "zod";

import {
  pgBooleanDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import {
  networkConfigFields,
  networkConfigTable,
  visibleNetworkConfig,
  type NetworkOwner,
  type NetworkProvider,
} from "./network-config-model";
import { networkReferencesQuery } from "./network-config-references";
import { cloudflareCustomConnectorReferencesQuery } from "./cloudflare-custom-connector-references";

export type NetworkMutationArgs = {
  readonly provider: NetworkProvider;
  readonly owner: NetworkOwner;
  readonly configId: string;
  readonly expectedRevision: number;
} & (
  | {
      readonly operation: "update";
      readonly name?: string;
      readonly tags?: string[];
      readonly encrypted:
        | {
            readonly encryptedClientId: string;
            readonly encryptedClientSecret: string;
          }
        | undefined;
    }
  | { readonly operation: "promote" }
  | { readonly operation: "adopt"; readonly impactSnapshot: string }
  | { readonly operation: "delete"; readonly impactSnapshot?: string }
);
const outcomeSchema = zEnum([
  "ready",
  "notFound",
  "forbidden",
  "conflict",
  "impactConflict",
  "inUse",
  "exhausted",
]);
export type NetworkMutationOutcome = zInfer<typeof outcomeSchema>;
const outcomeDecoder = zodEnumDriverValueDecoder(outcomeSchema);

function customConnectorReferences(args: NetworkMutationArgs) {
  return new QueryBuilder()
    .$with("observed_network_custom_connectors")
    .as(
      cloudflareCustomConnectorReferencesQuery(
        args.owner.orgId,
        args.configId,
        args.provider === "cloudflare_access",
      ),
    );
}

export function networkMutationReads(args: NetworkMutationArgs) {
  const qb = new QueryBuilder();
  const table = networkConfigTable(args.provider);
  const observed = qb.$with("observed_network_config").as(
    qb
      .select({
        ...networkConfigFields(args.provider, "observed_network_tags"),
      })
      .from(table)
      .where(visibleNetworkConfig(args.provider, args.owner, args.configId)),
  );
  const hosts = qb
    .$with("observed_network_references")
    .as(networkReferencesQuery(args.provider, args.owner.orgId, args.configId));
  const customConnectors = customConnectorReferences(args);
  const hasConnectorReferences = exists(
    qb.select({ id: customConnectors.id }).from(customConnectors),
  );
  const own = exists(
    qb
      .select({ id: hosts.id })
      .from(hosts)
      .where(eq(hosts.userId, args.owner.userId)),
  );
  const other = exists(
    qb
      .select({ id: hosts.id })
      .from(hosts)
      .where(ne(hosts.userId, args.owner.userId)),
  );
  const hasReferences = exists(qb.select({ id: hosts.id }).from(hosts));
  const exhausted = exists(
    qb
      .select({ id: hosts.id })
      .from(hosts)
      .where(eq(hosts.generation, 2_147_483_647)),
  );
  const effective =
    args.operation !== "update" || args.encrypted !== undefined
      ? sql`true`
      : args.tags === undefined
        ? sql`false`
        : not(
            sql`(${arrayContains(observed.tags, sql`${sql.param(args.tags, tailscaleConfigs.tags)}`)} AND ${arrayContained(observed.tags, sql`${sql.param(args.tags, tailscaleConfigs.tags)}`)} AND ${eq(sql`cardinality(${observed.tags})`, args.tags.length)})`,
          );
  const hostDigest = sql`encode(sha256(convert_to(
    '[' || to_json(${observed.id})::text || ',' || ${observed.revision}::text || ',[' ||
    (SELECT coalesce(string_agg(
      '[' || to_json(${hosts.protocol})::text || ',' || to_json(${hosts.id})::text || ',' ||
      to_json(${hosts.userId})::text || ',' || ${hosts.generation}::text || ',' ||
      ${hosts.rfb}::text || ',' || ${hosts.kdc}::text || ']', ',' ORDER BY ${asc(sql`${hosts.protocol} COLLATE "C"`)}, ${asc(hosts.id)}), '') FROM ${hosts}) ||
    ']]', 'UTF8')), 'hex')`;
  const digest = sql`CASE WHEN ${hasConnectorReferences} THEN encode(sha256(convert_to(
    ${hostDigest} || ':' || (SELECT string_agg(${customConnectors.id}::text || ':' || ${customConnectors.storageVersion}, ',' ORDER BY ${customConnectors.id}) FROM ${customConnectors}),
    'UTF8')), 'hex') ELSE ${hostDigest} END`;
  const invalidScope =
    args.operation === "promote"
      ? ne(observed.scope, "personal")
      : args.operation === "adopt"
        ? ne(observed.scope, "organization")
        : sql`false`;
  const denied =
    args.owner.orgRole === "admin"
      ? sql`false`
      : eq(observed.scope, "organization");
  const impactConflict =
    args.operation === "adopt"
      ? ne(digest, args.impactSnapshot)
      : args.operation === "delete"
        ? args.impactSnapshot === undefined
          ? hasReferences
          : sql`${ne(digest, args.impactSnapshot)} OR
              (${hasReferences} AND ${ne(observed.scope, "organization")})`
        : sql`false`;
  const limit =
    args.operation === "delete"
      ? exhausted
      : sql`${eq(observed.revision, 2_147_483_647)} OR
          (${effective} AND (${eq(observed.generation, 2_147_483_647)} OR ${exhausted}))`;
  const checked = qb.$with("checked_network_mutation").as(
    qb
      .select({
        id: observed.id,
        effective: sql`${effective}`.mapWith(pgBooleanDecoder).as("effective"),
        outcome: sql`CASE
      WHEN ${invalidScope} THEN 'notFound'
      WHEN ${denied} THEN 'forbidden'
      WHEN ${ne(observed.revision, args.expectedRevision)} THEN 'conflict'
      WHEN ${args.operation === "delete" || args.operation === "adopt" ? hasConnectorReferences : sql`false`} THEN 'inUse'
      WHEN ${args.operation === "delete" ? own : sql`false`} THEN 'inUse'
      WHEN ${impactConflict} THEN 'impactConflict'
      WHEN ${limit} THEN 'exhausted'
      WHEN ${args.operation === "promote" ? other : sql`false`} THEN 'inUse'
      ELSE 'ready' END`
          .mapWith(outcomeDecoder)
          .as("outcome"),
      })
      .from(observed),
  );
  const eligible = qb.$with("eligible_network_mutation").as(
    qb
      .select({
        id: checked.id,
        effective: checked.effective,
      })
      .from(checked)
      .where(eq(checked.outcome, "ready")),
  );
  return {
    qb,
    table,
    observed,
    hosts,
    checked,
    eligible,
    authorizedEffective: exists(
      qb
        .select({ id: eligible.id })
        .from(eligible)
        .where(eq(eligible.effective, true)),
    ),
    ctes: [observed, hosts, customConnectors, checked, eligible],
  };
}

export function networkFanoutExpected(
  reads: ReturnType<typeof networkMutationReads>,
  protocol: "ssh" | "vnc",
) {
  return reads.qb
    .select({ count: count() })
    .from(reads.hosts)
    .where(and(eq(reads.hosts.protocol, protocol), reads.authorizedEffective));
}
