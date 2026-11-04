import { pgTable } from "drizzle-orm/pg-core";
import { teamsOrgConnectionColumns } from "../columns/teams-org-connection";

// Retire implicit SELECT/INSERT/RETURNING references before the physical
// discriminator is removed after the row, drain and rollback gates in #43729.
export const teamsOrgConnections = pgTable(
  "teams_org_connections",
  teamsOrgConnectionColumns(),
);
