import { sql, type SQL } from "drizzle-orm";
import type { QueryBuilder } from "drizzle-orm/pg-core";
import {
  networkConfigTable,
  type NetworkProvider,
} from "./network-config-model";

/** Publish a new reference-set member without changing logical metadata. */
export function enteringNetworkConfig(
  qb: QueryBuilder,
  alias: string,
  provider: NetworkProvider,
  predicate: SQL,
) {
  const config = networkConfigTable(provider);
  return qb.$with(alias, { id: config.id }).as(
    sql`UPDATE ${config} SET ${sql.identifier(config.name.name)} = ${config.name}
      WHERE ${predicate} RETURNING ${config.id}`,
  );
}
