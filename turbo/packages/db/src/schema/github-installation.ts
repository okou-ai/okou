import { index, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agent";
import { githubInstallationColumns } from "../columns/github-installation";

export const githubInstallations = pgTable(
  "github_installations",
  {
    ...githubInstallationColumns(),
    // Retained for outgoing whole-row queries during rollout.
    defaultAgentId: uuid("default_agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "cascade" },
    ),
  },
  (table) => {
    return [
      uniqueIndex("github_installations_installation_id_unique")
        .on(table.installationId)
        .where(sql`installation_id IS NOT NULL`),
      index("idx_github_installations_org").on(table.orgId),
    ];
  },
);
