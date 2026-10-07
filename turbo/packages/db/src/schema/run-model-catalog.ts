import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Global run model catalog: one row per stable model ID.
 *
 * `replaced_by` NULL marks an active model. A non-NULL value marks a retired
 * model whose stored selections resolve along the chain to the final active
 * model. Chains may have several hops; the constraints below keep them finite
 * without triggers:
 *
 * - The self foreign key `(replaced_by, replaced_by_lineage_rank)` →
 *   `(model, lineage_rank)` rejects dangling targets and copies the target's
 *   rank (`ON UPDATE CASCADE` keeps the copy current).
 * - `replaced_by_lineage_rank > lineage_rank` makes every hop strictly
 *   increase the rank, so no path can return to a row: self-references and
 *   cycles are impossible. `replaced_by <> model` states the self case
 *   directly.
 * - Both replacement columns are NULL or both are set, so `MATCH SIMPLE`
 *   cannot skip the foreign key for a retired row.
 *
 * To retire X in favor of Y: if Y.lineage_rank <= X.lineage_rank, raise
 * Y.lineage_rank first (raising a rank only widens the gap to its referrers),
 * then set X.replaced_by = Y and X.replaced_by_lineage_rank = Y.lineage_rank.
 *
 * The system default is the fixed Auto model owned by the API, not a catalog
 * column.
 */
export const runModelCatalog = pgTable(
  "run_model_catalog",
  {
    model: varchar("model", { length: 255 }).primaryKey(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    sortOrder: integer("sort_order").notNull(),
    replacedBy: varchar("replaced_by", { length: 255 }),
    /** Acyclicity rank: every replacement hop strictly increases it. */
    lineageRank: integer("lineage_rank").notNull(),
    /** The target's lineage_rank, maintained by the self foreign key. */
    replacedByLineageRank: integer("replaced_by_lineage_rank"),
    /**
     * Plan policy for organizations whose plan restricts Built-in models
     * (`org_plan_entitlements.restricted_built_in_models`, every free plan):
     * whether they may run this model on a Built-in route. A new model
     * defaults to paid-only. Only a member's connected personal subscription
     * on the model's catalog subscription route
     * (`model_routes.subscription_type`) is exempt.
     */
    builtInOnRestrictedPlans: boolean("built_in_on_restricted_plans")
      .notNull()
      .default(false),
    /**
     * The family of Pi route rules that admits the model
     * (`claude-native`, `gpt-codex` or `deepseek`). NULL means the model is
     * not Pi-eligible and runs on its vendor harness; a new model stays off
     * Pi until an operator sets it.
     */
    piRouteClass: varchar("pi_route_class", { length: 32 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_run_model_catalog_model_lineage_rank").on(
        table.model,
        table.lineageRank,
      ),
      foreignKey({
        name: "fk_run_model_catalog_replaced_by",
        columns: [table.replacedBy, table.replacedByLineageRank],
        foreignColumns: [table.model, table.lineageRank],
      }).onUpdate("cascade"),
      check(
        "chk_run_model_catalog_replacement_pair",
        sql`(${table.replacedBy} IS NULL) = (${table.replacedByLineageRank} IS NULL)`,
      ),
      check(
        "chk_run_model_catalog_not_self_replaced",
        sql`${table.replacedBy} <> ${table.model}`,
      ),
      check(
        "chk_run_model_catalog_replacement_rank",
        sql`${table.replacedByLineageRank} > ${table.lineageRank}`,
      ),
      check(
        "chk_run_model_catalog_pi_route_class",
        sql`${table.piRouteClass} IS NULL OR ${table.piRouteClass} IN ('claude-native', 'gpt-codex', 'deepseek')`,
      ),
    ];
  },
);
