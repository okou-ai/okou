import { describe, expect, it } from "vitest";

import {
  ACCOUNT_OWNERSHIP_INVENTORY,
  applicationOwnershipTables,
  assertOwnershipInventoryCoverage,
  userOwnedErasureRoots,
  type OwnershipTable,
} from "../account-erasure-ownership-inventory";

// Explicit external-behavior exception, matching the dormant B1 persistence
// suite: the erasure execution path has no HTTP entry point until activation,
// and the contract under test is the guard's verdict on a schema. The negative
// cases feed the guard a schema the repository does not currently have, which
// is the only way to prove it turns red before that schema exists.
describe("account erasure ownership coverage guard", () => {
  const schemaTables = applicationOwnershipTables();
  const withTable = (extra: OwnershipTable) => {
    return [...schemaTables, extra];
  };

  it("covers every table in the application schema", () => {
    expect(() => {
      return assertOwnershipInventoryCoverage(schemaTables);
    }).not.toThrow();
    expect(schemaTables.length).toBeGreaterThan(0);
  });

  it("reports the account-owned roots erasure must delete", () => {
    const roots = userOwnedErasureRoots();
    const tables = roots.map((root) => {
      return root.table;
    });

    // The September 12 deletion kept threads the account created under Agents
    // owned by other users. Ownership follows the row, not the Agent.
    expect(tables).toContain("chat_threads");
    expect(tables).toContain("agent_runs");
    expect(tables).toContain("agent_sessions");
    expect(tables).toContain("hosted_sites");
    expect(tables).toContain("run_uploaded_files");
    expect(tables).toContain("chat_event_search_messages");
    expect(roots).toContainEqual({ table: "agents", ownership: ["owner"] });
  });

  it("keeps billing records out of the deletable roots", () => {
    const tables = userOwnedErasureRoots().map((root) => {
      return root.table;
    });

    expect(tables).not.toContain("usage_event");
    expect(tables).not.toContain("usage_event_hourly_rollup");
    expect(tables).not.toContain("billing_run_attribution");
    expect(ACCOUNT_OWNERSHIP_INVENTORY.usage_event).toStrictEqual({
      coverage: "billing_preserved",
      ownership: ["user_id"],
    });
  });

  it("fails when a new account-owned table is added without coverage", () => {
    expect(() => {
      return assertOwnershipInventoryCoverage(
        withTable({
          name: "agent_private_notes",
          columns: ["id", "agent_id", "user_id", "body", "created_at"],
        }),
      );
    }).toThrow("account_erasure_inventory:uncovered_table:agent_private_notes");
  });

  it("fails when an existing table starts carrying an account identity", () => {
    // `blobs` is content-addressed and deliberately account-free today. Adding
    // an owner to it must reopen the classification rather than inherit one.
    const blobs = schemaTables.find((table) => {
      return table.name === "blobs";
    });
    expect(blobs).toBeDefined();
    const owned = schemaTables.map((table) => {
      return table.name === "blobs"
        ? { name: table.name, columns: [...table.columns, "user_id"] }
        : table;
    });

    expect(() => {
      return assertOwnershipInventoryCoverage(owned);
    }).toThrow(
      "account_erasure_inventory:unclassified_ownership:blobs.user_id",
    );
  });

  it("fails when a covered root's ownership column is renamed away", () => {
    const renamed = schemaTables.map((table) => {
      return table.name === "chat_threads"
        ? {
            name: table.name,
            columns: table.columns.map((column) => {
              return column === "user_id" ? "owner_account_id" : column;
            }),
          }
        : table;
    });

    expect(() => {
      return assertOwnershipInventoryCoverage(renamed);
    }).toThrow(
      "account_erasure_inventory:ownership_column_missing:chat_threads.user_id",
    );
  });

  it("fails when a root gains an undeclared second ownership column", () => {
    const widened = schemaTables.map((table) => {
      return table.name === "chat_threads"
        ? { name: table.name, columns: [...table.columns, "created_by"] }
        : table;
    });

    expect(() => {
      return assertOwnershipInventoryCoverage(widened);
    }).toThrow(
      "account_erasure_inventory:undeclared_ownership_column:chat_threads.created_by",
    );
  });

  it("fails when an inventory entry outlives its table", () => {
    const dropped = schemaTables.filter((table) => {
      return table.name !== "chat_threads";
    });

    expect(() => {
      return assertOwnershipInventoryCoverage(dropped);
    }).toThrow("account_erasure_inventory:unknown_table:chat_threads");
  });

  it("anchors every descendant to a root that still deletes it", () => {
    const descendants = Object.entries(ACCOUNT_OWNERSHIP_INVENTORY).flatMap(
      ([table, entry]) => {
        return entry.coverage === "user_descendant"
          ? [{ table, parent: entry.parent }]
          : [];
      },
    );
    expect(descendants.length).toBeGreaterThan(0);

    for (const descendant of descendants) {
      expect(ACCOUNT_OWNERSHIP_INVENTORY[descendant.parent]?.coverage).toBe(
        "user_root",
      );
    }
  });
});
