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
  it("preserves production conflict targets while scoping test identities", () => {
    expect(officialWorkflowCatalogReleases.id.primary).toBe(true);
    expect(
      primaryKeyColumns(officialWorkflowDefinitionRevisions),
    ).toStrictEqual(["definition_name", "revision"]);
    expect(officialWorkflowReconciliationWork.definitionName.primary).toBe(
      true,
    );
    expect(officialWorkflowCatalogState.authority.primary).toBe(true);
    expect(
      getTableConfig(officialWorkflowCatalogReleases).uniqueConstraints.map(
        (constraint) => {
          return {
            name: constraint.name,
            columns: constraint.columns.map((column) => {
              return column.name;
            }),
          };
        },
      ),
    ).toContainEqual({
      name: "official_workflow_catalog_releases_authority_id_unique",
      columns: ["authority", "id"],
    });
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
