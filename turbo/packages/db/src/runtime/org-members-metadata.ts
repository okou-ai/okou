import { pgTable } from "drizzle-orm/pg-core";
import { orgMembersMetadataColumns } from "../columns/org-members-metadata";

/** Runtime member preferences, without physical DDL constraints. */
export const orgMembersMetadata = pgTable(
  "org_members_metadata",
  orgMembersMetadataColumns(),
);
