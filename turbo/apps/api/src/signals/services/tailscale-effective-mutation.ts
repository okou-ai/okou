import { command } from "ccstate";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { writeDb$ } from "../external/db";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { tailscaleFailure } from "./tailscale-config-model";
import type { TailscaleMutationArgs } from "./tailscale-mutation-plan";
import { createTailscaleMutationReads } from "./tailscale-mutation-query";
import { capturedTailscaleMutation } from "./tailscale-mutation-result";
import {
  tailscaleConfigMutationValues,
  tailscaleHostMutationValues,
} from "./tailscale-mutation-values";

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

const commitTailscaleMutationAttempt$ = command(
  async ({ set }, args: TailscaleMutationArgs) => {
    const db = set(writeDb$);
    const { ctes, current, observed, hosts, eligible } =
      createTailscaleMutationReads(args);
    const changedHosts = db.$with("changed_tailscale_hosts").as(
      db
        .update(sshConnections)
        .set(tailscaleHostMutationValues(args))
        .from(eligible)
        .where(
          and(
            eq(sshConnections.orgId, args.owner.orgId),
            eq(sshConnections.tailscaleId, eligible.id),
            inArray(sshConnections.id, db.select({ id: hosts.id }).from(hosts)),
            eq(eligible.effective, true),
          ),
        )
        .returning({ id: sshConnections.id }),
    );
    // Retained IDs cannot disappear or change binding under their Host locks.
    // A mismatch aborts this whole statement rather than leaving Host-only
    // effects. The data-dependent divisor prevents eager constant folding.
    const fanoutReady = eq(
      db
        .select({
          ready: sql`1 / CASE WHEN ${count()} = CASE
            WHEN (SELECT ${eligible.effective} FROM ${eligible})
            THEN (SELECT ${count()} FROM ${hosts}) ELSE 0 END
            THEN 1 ELSE 0 END`.mapWith(pgIntegerDecoder),
        })
        .from(changedHosts),
      1,
    );
    const writeGate = and(eq(tailscaleConfigs.id, eligible.id), fanoutReady);
    const changedConfig = db.$with("changed_tailscale_configuration").as(
      args.operation === "delete"
        ? db
            .delete(tailscaleConfigs)
            .where(
              and(
                eq(tailscaleConfigs.id, args.configId),
                fanoutReady,
                eq(
                  tailscaleConfigs.id,
                  db.select({ id: eligible.id }).from(eligible),
                ),
              ),
            )
            .returning({ ...metadata })
        : db
            .update(tailscaleConfigs)
            .set(tailscaleConfigMutationValues(args, eligible.effective))
            .from(eligible)
            .where(writeGate)
            .returning({ ...metadata }),
    );
    const rows = await db
      .with(...ctes, changedHosts, changedConfig)
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
        changed: {
          id: changedConfig.id,
          name: changedConfig.name,
          scope: changedConfig.scope,
          tags: changedConfig.tags,
          revision: changedConfig.revision,
          generation: changedConfig.generation,
          createdAt: changedConfig.createdAt,
          updatedAt: changedConfig.updatedAt,
        },
        observedVersion: observed.version,
        currentVersion: current.version,
        host: {
          id: hosts.id,
          userId: hosts.userId,
          displayName: hosts.displayName,
          generation: hosts.generation,
        },
      })
      .from(current)
      .innerJoin(observed, eq(current.id, observed.id))
      .leftJoin(changedConfig, eq(changedConfig.id, current.id))
      .leftJoin(hosts, eq(current.id, args.configId))
      .orderBy(asc(hosts.id));
    return capturedTailscaleMutation(args, rows);
  },
);
export const commitTailscaleMutation$ = command(
  async ({ set }, args: TailscaleMutationArgs) => {
    const first = await set(commitTailscaleMutationAttempt$, args);
    const result = first.retryBindings
      ? await set(commitTailscaleMutationAttempt$, args)
      : first;
    return result.retryBindings ? tailscaleFailure("conflict") : result.value;
  },
);
