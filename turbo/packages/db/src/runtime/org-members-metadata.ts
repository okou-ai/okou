import { pgTable } from "drizzle-orm/pg-core";
import { orgMembersMetadataColumns } from "../columns/org-members-metadata";

/** Omits the retired Native fence from implicit INSERT, SELECT and RETURNING. */
export const orgMembersMetadata = pgTable(
  "org_members_metadata",
  orgMembersMetadataColumns(),
);
