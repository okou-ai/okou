import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
  officialWorkflowReconciliationWork,
} from "../schema/official-workflow-catalog";

function primaryKeyColumns(
  table: Parameters<typeof getTableConfig>[0],
): readonly string[] {
  const [primaryKey] = getTableConfig(table).primaryKeys;
  return (
    primaryKey?.columns.map((column) => {
      return column.name;
    }) ?? []
  );
}

describe("Official Workflow catalog schema", () => {
  it("keys every durable catalog identity by authority", () => {
    expect(primaryKeyColumns(officialWorkflowCatalogReleases)).toStrictEqual([
      "authority",
      "id",
    ]);
    expect(
      primaryKeyColumns(officialWorkflowDefinitionRevisions),
    ).toStrictEqual(["authority", "definition_name", "revision"]);
    expect(primaryKeyColumns(officialWorkflowReconciliationWork)).toStrictEqual(
      ["authority", "definition_name"],
    );
    expect(officialWorkflowCatalogState.authority.primary).toBe(true);
  });

  it("keeps release references inside the same authority", () => {
    const references = [
      ...getTableConfig(officialWorkflowCatalogState).foreignKeys,
      ...getTableConfig(officialWorkflowReconciliationWork).foreignKeys,
    ].map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        name: foreignKey.getName(),
        columns: reference.columns.map((column) => {
          return column.name;
        }),
        foreignColumns: reference.foreignColumns.map((column) => {
          return column.name;
        }),
      };
    });
    expect(references).toStrictEqual([
      {
        name: "official_workflow_catalog_state_release_fk",
        columns: ["authority", "accepted_release_id"],
        foreignColumns: ["authority", "id"],
      },
      {
        name: "official_workflow_reconciliation_work_release_fk",
        columns: ["authority", "requested_release_id"],
        foreignColumns: ["authority", "id"],
      },
    ]);
  });

  it("accepts only production or UUID-backed test authorities", () => {
    const dialect = new PgDialect();
    for (const table of [
      officialWorkflowCatalogReleases,
      officialWorkflowCatalogState,
      officialWorkflowDefinitionRevisions,
      officialWorkflowReconciliationWork,
    ]) {
      const authorityCheck = getTableConfig(table).checks.find((check) => {
        return check.name.endsWith("authority");
      });
      expect(authorityCheck).toBeDefined();
      const authoritySql = dialect.sqlToQuery(authorityCheck!.value).sql;
      expect(authoritySql).toContain("= 'official'");
      expect(authoritySql).toContain("^test:[0-9a-f]{8}-");
    }
  });
});
