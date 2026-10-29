import { pgTable } from "drizzle-orm/pg-core";
import { orgMembersMetadataColumns } from "../columns/org-members-metadata";

/** Application mapping without the retired planning and translation preferences. */
export const orgMembersMetadata = pgTable(
  "org_members_metadata",
  orgMembersMetadataColumns(),
);
