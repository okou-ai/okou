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
    modelRuntimeProvider: varchar("model_runtime_provider", {
      length: 100,
    }).notNull(),
    modelRuntimeModel: varchar("model_runtime_model", {
      length: 255,
    }).notNull(),
    unavailableUntil: timestamp("unavailable_until").notNull(),
    connectionObservationStartedAt: timestamp(
      "connection_observation_started_at",
    ),
    connectionObservationUntil: timestamp("connection_observation_until"),
  },
  (table) => {
    return [
      primaryKey({
        columns: [
          table.selectedModel,
          table.modelRuntimeProvider,
          table.modelRuntimeModel,
        ],
      }),
      check(
        "built_in_model_cooldown_observation_pair_check",
        sql`(${table.connectionObservationStartedAt} IS NULL AND ${table.connectionObservationUntil} IS NULL) OR (${table.connectionObservationStartedAt} IS NOT NULL AND ${table.connectionObservationUntil} IS NOT NULL)`,
      ),
    ];
  },
);
