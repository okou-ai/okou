import {
  and,
  arrayContained,
  arrayContains,
  asc,
  count,
  eq,
  exists,
  gte,
  lt,
  ne,
  not,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import {
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import {
  referencingHostPredicate,
  visibleTailscaleConfig,
} from "./tailscale-config-model";
import type { TailscaleMutationArgs } from "./tailscale-mutation-plan";

const tailscaleMutationMetadata = Object.freeze({
  id: tailscaleConfigs.id,
  name: tailscaleConfigs.name,
  scope: tailscaleConfigs.scope,
  tags: tailscaleConfigs.tags,
  revision: tailscaleConfigs.revision,
  generation: tailscaleConfigs.generation,
  createdAt: tailscaleConfigs.createdAt,
  updatedAt: tailscaleConfigs.updatedAt,
});
const hostFields = Object.freeze({
  id: sshConnections.id,
  userId: sshConnections.userId,
  displayName: sshConnections.displayName,
  generation: sshConnections.generation,
});

function mutationReadFences(args: TailscaleMutationArgs) {
  // Sessionless SQL builders: no database handle or query executor escapes.
  const qb = new QueryBuilder();
  const observed = qb.$with("observed_tailscale_mutation").as(
    qb
      .select({
        ...tailscaleMutationMetadata,
        version: sql`${tailscaleConfigs}.xmin::text`
          .mapWith(pgTextDecoder)
          .as("observed_version"),
      })
      .from(tailscaleConfigs)
      .where(visibleTailscaleConfig(args.owner, args.configId)),
  );
  const hosts = qb.$with("locked_tailscale_hosts").as(
    qb
      .select({ ...hostFields })
      .from(sshConnections)
      .where(
        and(
          referencingHostPredicate(args),
          exists(
            qb
              .select({ id: observed.id })
              .from(observed)
              .where(
                args.owner.orgRole === "admin"
                  ? undefined
                  : eq(observed.scope, "personal"),
              ),
          ),
        ),
      )
      .orderBy(asc(sshConnections.id))
      .for("no key update"),
  );
  const gathered = qb
    .$with("gathered_tailscale_hosts")
    .as(qb.select({ count: count().as("count") }).from(hosts));
  const current = qb.$with("current_tailscale_mutation").as(
    qb
      .select({
        ...tailscaleMutationMetadata,
        version: sql`${tailscaleConfigs}.xmin::text`
          .mapWith(pgTextDecoder)
          .as("current_version"),
      })
      .from(tailscaleConfigs)
      .crossJoin(gathered)
      .where(
        and(
          visibleTailscaleConfig(args.owner, args.configId),
          gte(gathered.count, 0),
        ),
      )
      .for("update", { of: tailscaleConfigs }),
  );
  return { qb, observed, hosts, gathered, current };
}

type MutationReads = ReturnType<typeof mutationReadFences>;
function effectiveMutation(
  args: TailscaleMutationArgs,
  current: MutationReads["current"],
) {
  if (args.operation !== "update" || args.encrypted !== undefined) {
    return sql`true`;
  }
  const tags = args.body.tags;
  return tags === undefined
    ? sql`false`
    : not(sql`(${arrayContains(current.tags, tags)}
    AND ${arrayContained(current.tags, tags)} AND cardinality(${current.tags}) = ${tags.length})`);
}
function impactDigest(reads: MutationReads) {
  const { current, hosts } = reads;
  // Serialize each value independently, preserving opaque user-ID escaping and
  // JSON.stringify's compact separators rather than hashing jsonb's spaced text.
  return sql`encode(sha256(convert_to(
    '[' || to_json(${current.id})::text || ',' || ${current.revision}::text || ',[' ||
    (SELECT coalesce(string_agg(
      '[' || to_json(${hosts.id})::text || ',' || to_json(${hosts.userId})::text || ',' ||
      ${hosts.generation}::text || ']', ',' ORDER BY ${hosts.id}), '') FROM ${hosts}) ||
    ']]', 'UTF8')), 'hex')`;
}
function operationGate(args: TailscaleMutationArgs, reads: MutationReads) {
  const { qb, current, hosts } = reads;
  const own = qb
    .select({ id: hosts.id })
    .from(hosts)
    .where(eq(hosts.userId, args.owner.userId));
  const other = qb
    .select({ id: hosts.id })
    .from(hosts)
    .where(ne(hosts.userId, args.owner.userId));
  switch (args.operation) {
    case "update": {
      return undefined;
    }
    case "promote": {
      return and(eq(current.scope, "personal"), notExists(other));
    }
    case "adopt": {
      return and(
        eq(current.scope, "organization"),
        eq(impactDigest(reads), args.body.impactSnapshot),
      );
    }
    case "delete": {
      const snapshot = args.body.impactSnapshot;
      return and(
        notExists(own),
        snapshot === undefined
          ? notExists(qb.select({ id: hosts.id }).from(hosts))
          : and(
              eq(impactDigest(reads), snapshot),
              or(
                eq(current.scope, "organization"),
                notExists(qb.select({ id: hosts.id }).from(hosts)),
              ),
            ),
      );
    }
  }
}
export function createTailscaleMutationReads(args: TailscaleMutationArgs) {
  const reads = mutationReadFences(args);
  const { qb, current, observed, hosts } = reads;
  const effective = effectiveMutation(args, current);
  const expectedRevision =
    args.operation === "promote"
      ? args.expectedRevision
      : args.body.expectedRevision;
  const exhaustedHosts = qb
    .select({ id: hosts.id })
    .from(hosts)
    .where(eq(hosts.generation, 2_147_483_647));
  const eligible = qb.$with("eligible_tailscale_mutation").as(
    qb
      .select({
        id: current.id,
        effective: effective.mapWith(pgBooleanDecoder).as("effective"),
      })
      .from(current)
      .innerJoin(observed, eq(observed.id, current.id))
      .where(
        and(
          eq(current.version, observed.version),
          args.owner.orgRole === "admin"
            ? undefined
            : eq(current.scope, "personal"),
          eq(current.revision, expectedRevision),
          operationGate(args, reads),
          args.operation === "delete"
            ? notExists(exhaustedHosts)
            : and(
                lt(current.revision, 2_147_483_647),
                or(
                  not(effective),
                  and(
                    lt(current.generation, 2_147_483_647),
                    notExists(exhaustedHosts),
                  ),
                ),
              ),
        ),
      ),
  );
  return {
    ...reads,
    eligible,
    ctes: [observed, hosts, reads.gathered, current, eligible],
  };
}
