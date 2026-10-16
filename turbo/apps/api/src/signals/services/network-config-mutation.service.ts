import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { command } from "ccstate";
import { and, asc, count, eq, exists, gte, sql } from "drizzle-orm";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  networkConfigFields,
  type NetworkMetadata,
  type NetworkReference,
} from "./network-config-model";
import { networkReferenceColumns } from "./network-config-references";
import {
  networkMutationReads,
  networkFanoutExpected,
  type NetworkMutationArgs,
  type NetworkMutationOutcome,
} from "./network-config-mutation-query";
import {
  networkConfigMutationValues,
  networkSshMutationValues,
  networkVncMutationValues,
} from "./network-config-mutation-values";

/** No read fences or retry: each lost publication aborts this entire statement. */
export const commitNetworkConfigMutation$ = command(
  async ({ set }, args: NetworkMutationArgs) => {
    const db = set(writeDb$);
    const reads = networkMutationReads(args);
    const { table, observed, hosts, checked, eligible } = reads;
    const columns = networkReferenceColumns(args.provider);
    const effective = reads.authorizedEffective;
    const ssh = db.$with("changed_network_ssh_hosts").as(
      db
        .update(sshConnections)
        .set(networkSshMutationValues(args))
        .from(hosts)
        .where(
          and(
            eq(hosts.protocol, "ssh"),
            eq(sshConnections.id, hosts.id),
            eq(sshConnections.orgId, args.owner.orgId),
            eq(columns.ssh, args.configId),
            eq(sql`${sshConnections}.xmin::text`, hosts.version),
            effective,
          ),
        )
        .returning({ id: sshConnections.id }),
    );
    const vnc = db.$with("changed_network_vnc_hosts").as(
      db
        .update(vncConnections)
        .set(networkVncMutationValues(args))
        .from(hosts)
        .where(
          and(
            eq(hosts.protocol, "vnc"),
            eq(vncConnections.id, hosts.id),
            eq(vncConnections.orgId, args.owner.orgId),
            eq(sql`${vncConnections}.xmin::text`, hosts.version),
            effective,
            gte(db.select({ count: count() }).from(ssh), 0),
          ),
        )
        .returning({ id: vncConnections.id }),
    );
    const fanout = and(
      eq(
        db.select({ count: count() }).from(ssh),
        networkFanoutExpected(reads, "ssh"),
      ),
      eq(
        db.select({ count: count() }).from(vnc),
        networkFanoutExpected(reads, "vnc"),
      ),
    );
    const gate = and(
      eq(table.id, args.configId),
      eq(table.orgId, args.owner.orgId),
      eq(
        sql`${table}.xmin::text`,
        db.select({ version: observed.version }).from(observed),
      ),
      exists(db.select({ id: eligible.id }).from(eligible)),
      fanout,
    );
    const fields = networkConfigFields(args.provider, "changed_network_tags");
    const changed = db.$with("changed_network_configuration").as(
      args.operation === "delete"
        ? db
            .delete(table)
            .where(gate)
            .returning({ ...fields })
        : args.provider === "tailscale"
          ? db
              .update(tailscaleConfigs)
              .set({
                ...networkConfigMutationValues(args, eligible.effective),
                tags: args.operation === "update" ? args.tags : undefined,
              })
              .from(eligible)
              .where(gate)
              .returning({ ...fields })
          : db
              .update(table)
              .set(networkConfigMutationValues(args, eligible.effective))
              .from(eligible)
              .where(gate)
              .returning({ ...fields }),
    );
    // A config CAS can lose after Host writes. Consume every publication here so
    // that even the zero-host case either commits completely or changes nothing.
    const complete =
      sql`1 / CASE WHEN ${and(fanout, eq(db.select({ count: count() }).from(changed), db.select({ count: count() }).from(eligible)))}
    THEN 1 ELSE 0 END`.mapWith(pgIntegerDecoder);
    const result = await settle(
      db
        .with(...reads.ctes, ssh, vnc, changed)
        .select({
          scope: observed.scope,
          changed: {
            id: changed.id,
            name: changed.name,
            scope: changed.scope,
            revision: changed.revision,
            generation: changed.generation,
            createdAt: changed.createdAt,
            updatedAt: changed.updatedAt,
            tags: changed.tags,
          },
          outcome: checked.outcome,
          effective: checked.effective,
          host: { ...hosts._.selectedFields },
          complete,
        })
        .from(observed)
        .innerJoin(checked, eq(checked.id, observed.id))
        .leftJoin(changed, eq(changed.id, observed.id))
        .leftJoin(hosts, sql`true`)
        .orderBy(asc(hosts.protocol), asc(hosts.id)),
    );
    if (!result.ok) {
      // The only division in this statement is its completion guard. PostgreSQL
      // has rolled back every effect before reporting this known failed write.
      if (safeSqlStateCode(result.error) === "22012") {
        return { ok: false as const, reason: "conflict" as const };
      }
      throw result.error;
    }
    return mutationResult(args.operation, result.value);
  },
);

function mutationResult(
  operation: NetworkMutationArgs["operation"],
  rows: readonly {
    readonly scope: NetworkMetadata["scope"];
    readonly changed: NetworkMetadata | null;
    readonly outcome: NetworkMutationOutcome;
    readonly effective: boolean;
    readonly host: NetworkReference | null;
  }[],
) {
  const first = rows[0];
  if (!first) {
    return { ok: false as const, reason: "notFound" as const };
  }
  if (first.outcome !== "ready") {
    return { ok: false as const, reason: first.outcome };
  }
  if (!first.changed) {
    throw new Error("Complete network mutation returned no configuration");
  }
  const references = rows.flatMap(({ host }) => {
    return host ? [host] : [];
  });
  return {
    ok: true as const,
    config: first.changed,
    references,
    invalidatedHosts: first.effective ? references : [],
    scope:
      operation === "adopt" || operation === "promote"
        ? ("organization" as const)
        : first.scope,
  };
}
