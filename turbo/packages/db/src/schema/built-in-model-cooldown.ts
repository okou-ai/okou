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
    // Canonical route identity mirroring agent_runs/activity context naming.
    // The legacy provider_type/upstream_model columns stay for the expand
    // window and can be contracted once every API instance writes these.
    modelRuntimeProvider: varchar("model_runtime_provider", { length: 100 }),
    modelRuntimeModel: varchar("model_runtime_model", { length: 255 }),
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
