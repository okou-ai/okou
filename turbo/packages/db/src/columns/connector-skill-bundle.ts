import { jsonb, varchar } from "drizzle-orm/pg-core";
import type { ContentBundle } from "@okouai/db/jsonb-contracts/content-bundle";

export function connectorSkillBundleColumns() {
  return {
    skillContentBundle: jsonb("skill_content_bundle").$type<ContentBundle>(),
    skillContentBundleSourceVersionId: varchar(
      "skill_content_bundle_source_version_id",
      { length: 64 },
    ),
  };
}
