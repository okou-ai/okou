import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const builtInModelCandidateCooldown = pgTable(
  "built_in_model_candidate_cooldown",
  {
    selectedModel: varchar("selected_model", { length: 255 }).notNull(),
    providerType: varchar("provider_type", { length: 100 }).notNull(),
    upstreamModel: varchar("upstream_model", { length: 255 }).notNull(),
    unavailableUntil: timestamp("unavailable_until").notNull(),
    connectionObservationStartedAt: timestamp(
      "connection_observation_started_at",
    ),
    connectionObservationUntil: timestamp("connection_observation_until"),
    // Logical provider for the cooled-down route. Always "built-in" for this
    // table; stored so cooldown reports expose the same four model concepts as
    // run/activity views.
    modelProvider: varchar("model_provider", { length: 100 })
      .notNull()
      .default("built-in"),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.selectedModel, table.providerType, table.upstreamModel],
      }),
      check(
        "built_in_model_cooldown_observation_pair_check",
        sql`(${table.connectionObservationStartedAt} IS NULL AND ${table.connectionObservationUntil} IS NULL) OR (${table.connectionObservationStartedAt} IS NOT NULL AND ${table.connectionObservationUntil} IS NOT NULL)`,
      ),
    ];
  },
);
