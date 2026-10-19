import type { vncConnections } from "@okouai/db/schema/vnc-connection";
import { and, eq, sql, type SQLWrapper } from "drizzle-orm";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  pgIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { enteringNetworkConfig } from "./network-config-binding";
import {
  networkConfigTable,
  visibleNetworkConfig,
  type NetworkOwner,
} from "./network-config-model";

type Bindings = Pick<
  typeof vncConnections.$inferSelect,
  | "cloudflareAccessId"
  | "tailscaleId"
  | "kdcCloudflareAccessId"
  | "kdcTailscaleId"
>;

/** Membership is by protocol/Host/config, independent of its RFB/KDC roles. */
function vncNetworkReferences(bindings: Bindings) {
  return (["cloudflare_access", "tailscale"] as const).flatMap((provider) => {
    const ids =
      provider === "cloudflare_access"
        ? [bindings.cloudflareAccessId, bindings.kdcCloudflareAccessId]
        : [bindings.tailscaleId, bindings.kdcTailscaleId];
    return [
      ...new Set(
        ids
          .filter((id) => {
            return id !== null;
          })
          .map((id) => {
            return id.toLowerCase();
          }),
      ),
    ]
      .sort()
      .map((id) => {
        return { provider, id };
      });
  });
}

export const validateVncNetworkReferences$ = command(
  async (
    { set },
    owner: NetworkOwner,
    bindings: Bindings,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    for (const { provider, id } of vncNetworkReferences(bindings)) {
      const config = networkConfigTable(provider);
      const [available] = await db
        .select({ id: config.id })
        .from(config)
        .where(visibleNetworkConfig(provider, owner, id));
      signal.throwIfAborted();
      if (!available) {
        return false;
      }
    }
    return true;
  },
);

/** Sessionless statement fragments; the owning command retains its Db. */
export function vncNetworkPublication(
  owner: NetworkOwner,
  next: Bindings,
  current?: Bindings,
) {
  const qb = new QueryBuilder();
  const retained = current ? vncNetworkReferences(current) : [];
  const reads = vncNetworkReferences(next).map(({ provider, id }, index) => {
    const config = networkConfigTable(provider);
    const observed = qb.$with(`vnc_network_${index}`).as(
      qb
        .select({
          id: config.id,
          version: sql`${config}.xmin::text`
            .mapWith(pgTextDecoder)
            .as("config_version"),
        })
        .from(config)
        .where(visibleNetworkConfig(provider, owner, id)),
    );
    if (
      retained.some((ref) => {
        return ref.provider === provider && ref.id === id;
      })
    ) {
      return { observed, entered: null };
    }
    const predicate = and(
      visibleNetworkConfig(provider, owner, id),
      eq(
        sql`${config}.xmin::text`,
        qb.select({ version: observed.version }).from(observed),
      ),
    );
    if (!predicate) {
      throw new Error("VNC network entry predicate is missing");
    }
    const entered = enteringNetworkConfig(
      qb,
      `vnc_network_${index}_entered`,
      provider,
      predicate,
    );
    return { observed, entered };
  });
  const ctes = reads.flatMap(({ observed, entered }) => {
    return entered ? [observed, entered] : [observed];
  });
  return {
    ctes,
    // An aggregate over the actual Host RETURNING always produces one row,
    // including a lost Host CAS. Returning the division forces PostgreSQL to
    // abort all entering stamps and inline writes when any publication loses.
    completion(host: SQLWrapper) {
      const predicates = reads.flatMap(({ observed, entered }) => {
        return [
          sql`(SELECT count(*) FROM ${observed}) = 1`,
          ...(entered ? [sql`(SELECT count(*) FROM ${entered}) = 1`] : []),
        ];
      });
      const referenceGuard =
        predicates.length > 0
          ? sql`AND (${sql.join(predicates, sql` AND `)})`
          : sql.empty();
      return qb.$with("vnc_publication_complete").as(
        qb
          .select({
            complete:
              sql`1 / CASE WHEN count(*) = 1 ${referenceGuard} THEN 1 ELSE 0 END`
                .mapWith(pgIntegerDecoder)
                .as("complete"),
          })
          .from(sql`${host}`),
      );
    },
  };
}
