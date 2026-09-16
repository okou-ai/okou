import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import type { UserTemplateManifest } from "@okouai/db/jsonb-contracts/user-template";

/**
 * Who can see a template. Private templates are visible only to their owner;
 * organization templates are available to every member of the owning
 * organization. There is no third level: a template compiled from a file the
 * organization already has is never published beyond it.
 */
export const USER_TEMPLATE_VISIBILITIES = ["private", "organization"] as const;
export type UserTemplateVisibility =
  (typeof USER_TEMPLATE_VISIBILITIES)[number];

/**
 * Templates compiled from a file the user uploaded.
 *
 * A row exists only once the reverse run publishes a validated package, so
 * there is no lifecycle column and no half-built row: a failed analysis leaves
 * only the chat thread that explains what happened. "In progress" and "failed"
 * are states of that run, not of this table.
 *
 * The compiled package is not referenced by a column: it is the storage named
 * `user-template@{id}`, derived from the row id the same way `workflows`
 * derives `custom-skill@{workflowId}`. One authoritative location, nothing to
 * keep in sync.
 *
 * `source_storage_key` and the manifest's page keys reference independently
 * owned objects created by the normal private upload route, so deleting a
 * template must not delete them. URLs remain a read-time decision.
 *
 * Neither the source format nor the product kind is stored. The format is the
 * `source_filename` extension, which is a display fact; the kind is the
 * reverse run's conclusion and lives in the manifest until a query needs to
 * filter by it.
 */
export const userTemplates = pgTable(
  "user_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<UserTemplateVisibility>()
      .notNull()
      .default("private"),
    title: text("title").notNull(),
    /** Private artifact object key assigned by the normal upload route. */
    sourceStorageKey: text("source_storage_key").notNull(),
    sourceFilename: text("source_filename").notNull(),
    /**
     * Kind-specific output of the reverse run. No default: a row cannot exist
     * before its package validated, so an empty manifest is a state this table
     * does not have and must not advertise.
     */
    manifest: jsonb("manifest").$type<UserTemplateManifest>().notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // The owner's own catalog remains the dominant access path.
      index("idx_user_templates_owner_created").on(
        table.orgId,
        table.ownerUserId,
        table.createdAt.desc(),
      ),
      // The same catalog also lists every member's organization-visible rows,
      // which share the organization prefix and are expected to stay sparse.
      index("idx_user_templates_org_visible")
        .on(table.orgId, table.createdAt.desc())
        .where(sql`${table.visibility} = 'organization'`),
      check(
        "chk_user_templates_visibility",
        sql`${table.visibility} IN ('private', 'organization')`,
      ),
    ];
  },
);
