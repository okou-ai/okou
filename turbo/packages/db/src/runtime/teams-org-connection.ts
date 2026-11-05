import { pgTable } from "drizzle-orm/pg-core";
import { teamsOrgConnectionColumns } from "../columns/teams-org-connection";

/** Application mapping. Omits physical DDL declarations. */
export const teamsOrgConnections = pgTable(
  "teams_org_connections",
  teamsOrgConnectionColumns(),
);
