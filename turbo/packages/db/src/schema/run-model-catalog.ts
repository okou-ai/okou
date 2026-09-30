import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
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
 * `is_system_default` marks the one model new organizations and unresolved
 * selections start from. At most one row can be the default and it must be
 * active; "exactly one" and "has an enabled Built-in route" are validated by
 * the API catalog loader. Switch the default by clearing the old row before
 * setting the new one inside one transaction, then retire the old default.
 *
 * Transitional: `allow_new_org_policy` still gates adding a new organization
 * policy for code-active models (see docs/model-catalog.md). It is dropped
 * once readers switch to `replaced_by`.
 */
export const runModelCatalog = pgTable(
  "run_model_catalog",
  {
    model: varchar("model", { length: 255 }).primaryKey(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    sortOrder: integer("sort_order").notNull(),
    isSystemDefault: boolean("is_system_default").notNull().default(false),
    replacedBy: varchar("replaced_by", { length: 255 }),
    /** Acyclicity rank: every replacement hop strictly increases it. */
    lineageRank: integer("lineage_rank").notNull(),
    /** The target's lineage_rank, maintained by the self foreign key. */
    replacedByLineageRank: integer("replaced_by_lineage_rank"),
    allowNewOrgPolicy: boolean("allow_new_org_policy").notNull().default(false),
    /**
     * Plan policy for organizations whose plan restricts Built-in models
     * (`org_plan_entitlements.restricted_built_in_models`): whether they may
     * run this model on a Built-in route.
     */
    builtInOnRestrictedPlans: boolean("built_in_on_restricted_plans")
      .notNull()
      .default(false),
    /**
     * The same plan policy for routes the organization or member provides
     * (BYOK, personal subscriptions and custom gateways).
     */
    ownRoutesOnRestrictedPlans: boolean("own_routes_on_restricted_plans")
      .notNull()
      .default(true),
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
      uniqueIndex("idx_run_model_catalog_one_system_default")
        .on(table.isSystemDefault)
        .where(sql`${table.isSystemDefault}`),
      check(
        "chk_run_model_catalog_pi_route_class",
        sql`${table.piRouteClass} IS NULL OR ${table.piRouteClass} IN ('claude-native', 'gpt-codex', 'deepseek')`,
      ),
      check(
        "chk_run_model_catalog_default_active",
        sql`NOT ${table.isSystemDefault} OR ${table.replacedBy} IS NULL`,
      ),
    ];
  },
);
