import type { TemplateGuidanceBundle } from "../jsonb-contracts/content-bundle";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Who can see a template. Private templates are visible only to their owner;
 * public templates are available to every member of the owning organization.
 */
export const PRESENTATION_TEMPLATE_VISIBILITIES = [
  "private",
  "public",
] as const;
export type PresentationTemplateVisibility =
  (typeof PRESENTATION_TEMPLATE_VISIBILITIES)[number];

/**
 * Presentation templates compiled from a deck the user uploaded.
 *
 * A row exists only once the analysis run publishes a finished package, so
 * there is no import lifecycle to store. The run's own chat thread is where
 * the user watches the analysis, and an abandoned analysis simply never
 * inserts.
 *
 * Current publishers and the catalog copy operator require immutable guidance
 * bundles. Run preparation validates this descriptor without a Storage fallback.
 * Physical nullability is retained for the staged schema rollout.
 *
 * `source_storage_key` and `page_keys` reference independently owned objects
 * created by the normal private upload route. URLs remain a read-time
 * decision. Array position is the page number and element 0 is the cover, so
 * the page count is `array_length(page_keys, 1)` and never a stored column.
 * The template commit resolves those uploads directly instead of registering
 * the page images as `run_uploaded_files`, which would project every slide
 * crop into the user's artifact catalog.
 */
export const presentationTemplates = pgTable(
  "presentation_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<PresentationTemplateVisibility>()
      .notNull()
      .default("private"),
    title: text("title").notNull(),
    /** Immutable guidance identity; validated at publication and Run preparation. */
    guidanceBundle: jsonb("guidance_bundle").$type<TemplateGuidanceBundle>(),
    /** Private artifact object key assigned by the normal upload route. */
    sourceStorageKey: text("source_storage_key").notNull(),
    sourceFilename: text("source_filename").notNull(),
    pageKeys: text("page_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Legacy compatibility column retained until #26578; new imports leave it null. */
    aspectRatio: real("aspect_ratio"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Owner catalogs remain the dominant access path; workspace-public rows
      // share the same organization prefix and are expected to stay sparse.
      index("idx_presentation_templates_owner_created").on(
        table.orgId,
        table.ownerUserId,
        table.createdAt.desc(),
      ),
      check(
        "chk_presentation_templates_visibility",
        sql`${table.visibility} IN ('private', 'public')`,
      ),
    ];
  },
);
