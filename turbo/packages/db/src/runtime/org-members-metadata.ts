import { pgTable } from "drizzle-orm/pg-core";
import { orgMembersMetadataColumns } from "../columns/org-members-metadata";

/** Application mapping. Retired preferences remain only in the migration schema. */
export const orgMembersMetadata = pgTable(
  "org_members_metadata",
  orgMembersMetadataColumns(),
);
