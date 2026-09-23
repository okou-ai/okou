import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_OWNERSHIP_INVENTORY,
  DESCENDANT_REACH,
  UNATTRIBUTABLE_DESCENDANTS,
  NON_OWNERSHIP_COLUMNS,
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

const MIGRATIONS = fileURLToPath(
  new URL("../../../../../../packages/db/src/migrations/", import.meta.url),
);

/** The tables the checked-in migrations actually leave behind.
 *
 * This is the guard's ground truth rather than any TypeScript export, because
 * a table reaches production through a migration whether or not a barrel, a
 * schema module or this repository's conventions ever mention it.
 */
function migrationLedgerTables(): Set<string> {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => {
      return name.endsWith(".sql");
    })
    .sort((left, right) => {
      return Number.parseInt(left, 10) - Number.parseInt(right, 10);
    });
  const table = String.raw`"?(?:public"?\."?)?([a-z0-9_]+)"?`;
  const created = new RegExp(
    String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?${table}`,
    "gi",
  );
  const dropped = new RegExp(
    String.raw`drop\s+table\s+(?:if\s+exists\s+)?${table}`,
    "gi",
  );
  const renamed = new RegExp(
    String.raw`alter\s+table\s+(?:if\s+exists\s+)?${table}\s+rename\s+to\s+"?([a-z0-9_]+)"?`,
    "gi",
  );
  const tables = new Set<string>();
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS}${file}`, "utf8");
    for (const match of sql.matchAll(created)) {
      tables.add(match[1] ?? "");
    }
    for (const match of sql.matchAll(renamed)) {
      tables.delete(match[1] ?? "");
      tables.add(match[2] ?? "");
    }
    for (const match of sql.matchAll(dropped)) {
      tables.delete(match[1] ?? "");
    }
  }
  return tables;
}

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

  it("covers every table the migrations leave behind", () => {
    // The `@okouai/db` barrel is a hand-maintained spread and omits 26 tables,
    // 18 of them account-owned. Anchoring to the migrations means a table
    // added outside the barrel cannot slip past the guard as it once did.
    const ledger = [...migrationLedgerTables()].sort();
    expect(ledger.length).toBeGreaterThan(200);

    const enumerated = new Set(
      schemaTables.map((table) => {
        return table.name;
      }),
    );
    expect(
      ledger.filter((name) => {
        return !enumerated.has(name);
      }),
    ).toStrictEqual([]);
    expect(
      ledger.filter((name) => {
        return !(name in ACCOUNT_OWNERSHIP_INVENTORY);
      }),
    ).toStrictEqual([]);
    expect(
      Object.keys(ACCOUNT_OWNERSHIP_INVENTORY).filter((name) => {
        return !ledger.includes(name);
      }),
    ).toStrictEqual([]);
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
    // Account-owned tables the barrel omits are roots too.
    expect(tables).toContain("push_subscriptions");
    expect(tables).toContain("user_connectors");
    expect(tables).toContain("archived_task_runs");
    expect(roots).toContainEqual({ table: "agents", ownership: ["owner"] });
  });

  it("refuses to sweep a provider identity as if it were the account", () => {
    // `sender_user_id` holds a Slack, Teams or Telegram identity. It is `text`,
    // exactly like a Clerk id, so a sweep comparing the subject against it
    // parses cleanly, matches nothing, and reports the table clean while every
    // row stays — worse than an uncovered table, which fails loudly.
    expect(NON_OWNERSHIP_COLUMNS.chat_slack_context).toStrictEqual({
      sender_user_id: "provider_identity",
    });
    expect(NON_OWNERSHIP_COLUMNS.chat_teams_context).toStrictEqual({
      sender_user_id: "provider_identity",
    });
    expect(NON_OWNERSHIP_COLUMNS.chat_telegram_context).toStrictEqual({
      sender_user_id: "provider_identity",
      user_link_id: "covered_by_parent",
    });
    expect(NON_OWNERSHIP_COLUMNS.telegram_messages).toStrictEqual({
      from_user_id: "provider_identity",
    });

    const roots = userOwnedErasureRoots().map((root) => {
      return root.table;
    });
    // None of them is a root on a provider identity; the three chat contexts
    // are reached through the thread instead.
    expect(roots).not.toContain("chat_slack_context");
    expect(roots).not.toContain("chat_teams_context");
    expect(roots).not.toContain("chat_telegram_context");
    // Telegram messages keep a root, on the account link rather than the
    // Telegram sender.
    expect(roots).toContain("telegram_messages");
    expect(ACCOUNT_OWNERSHIP_INVENTORY.telegram_messages).toStrictEqual({
      coverage: "user_root",
      ownership: ["official_user_link_id"],
    });
  });

  it("fails when a declared non-ownership column is renamed away", () => {
    const renamed = schemaTables.map((table) => {
      return table.name === "chat_slack_context"
        ? {
            name: table.name,
            columns: table.columns.filter((column) => {
              return column !== "sender_user_id";
            }),
          }
        : table;
    });

    expect(() => {
      return assertOwnershipInventoryCoverage(renamed);
    }).toThrow(
      "account_erasure_inventory:non_ownership_column_missing:chat_slack_context.sender_user_id",
    );
  });

  it("excludes one column, not the whole table", () => {
    // Declaring `sender_user_id` a provider identity must not exempt
    // `chat_slack_context` from classification if it gains a real owner.
    const owned = schemaTables.map((table) => {
      return table.name === "chat_slack_context"
        ? { name: table.name, columns: [...table.columns, "user_id"] }
        : table;
    });

    expect(() => {
      return assertOwnershipInventoryCoverage(owned);
    }).toThrow(
      "account_erasure_inventory:root_declared_as_descendant:chat_slack_context.user_id",
    );
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

  it("fails when a descendant starts carrying its own account identity", () => {
    // A row that names its own owner must be deleted directly. Leaving it
    // filed under a parent is how a cross-owner root goes missing.
    const promoted = schemaTables.map((table) => {
      return table.name === "chat_events"
        ? { name: table.name, columns: [...table.columns, "user_id"] }
        : table;
    });

    expect(() => {
      return assertOwnershipInventoryCoverage(promoted);
    }).toThrow(
      "account_erasure_inventory:root_declared_as_descendant:chat_events.user_id",
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

  it("anchors every descendant to roots that still delete it", () => {
    const descendants = Object.entries(ACCOUNT_OWNERSHIP_INVENTORY).flatMap(
      ([table, entry]) => {
        return entry.coverage === "user_descendant"
          ? [{ table, parents: entry.parents }]
          : [];
      },
    );
    expect(descendants.length).toBeGreaterThan(0);

    for (const descendant of descendants) {
      expect(descendant.parents.length).toBeGreaterThan(0);
      for (const parent of descendant.parents) {
        expect(ACCOUNT_OWNERSHIP_INVENTORY[parent]?.coverage).toBe("user_root");
      }
    }
    // Every current producer now persists the recipient account at enqueue.
    // A recipient address or a source run is not a durable owner identity.
    expect(ACCOUNT_OWNERSHIP_INVENTORY.email_outbox).toStrictEqual({
      coverage: "user_root",
      ownership: ["owner_user_id"],
    });
    expect(ACCOUNT_OWNERSHIP_INVENTORY.feishu_chat_ingress).toStrictEqual({
      coverage: "user_root",
      ownership: ["owner_user_id"],
    });
    // The thread composer draft now also lives in its own child row. It holds
    // account content and names no account, so it has to be reached through
    // the thread that does.
    expect(ACCOUNT_OWNERSHIP_INVENTORY.chat_thread_drafts).toStrictEqual({
      coverage: "user_descendant",
      parents: ["chat_threads"],
    });
  });

  it("checks every declared reach against the columns the schema has", () => {
    expect(Object.keys(DESCENDANT_REACH).length).toBeGreaterThan(0);

    for (const [table, reaches] of Object.entries(DESCENDANT_REACH)) {
      const entry = ACCOUNT_OWNERSHIP_INVENTORY[table];
      expect(entry?.coverage).toBe("user_descendant");
      expect(reaches.length).toBeGreaterThan(0);
      for (const reach of reaches) {
        // A reach without a reason is a guess about which rows are the
        // account's, so the guard requires one.
        expect(reach.basis.length).toBeGreaterThan(0);
        const last = reach.path[reach.path.length - 1];
        if (entry?.coverage === "user_descendant") {
          expect(entry.parents).toContain(last?.parent);
        }
      }
    }
    // A reach and an unattributable declaration disagree about whether the
    // rows can be deleted, so a table may not carry both.
    for (const table of Object.keys(UNATTRIBUTABLE_DESCENDANTS)) {
      expect(table in DESCENDANT_REACH).toBeFalsy();
      expect(ACCOUNT_OWNERSHIP_INVENTORY[table]?.coverage).toBe(
        "user_descendant",
      );
    }
  });

  it("fails when a declared reach names a column the schema does not have", () => {
    const renamed = schemaTables.map((table) => {
      return table.name === "browser_session_screenshots"
        ? {
            name: table.name,
            columns: table.columns.filter((column) => {
              return column !== "chat_thread_id";
            }),
          }
        : table;
    });

    expect(() => {
      return assertOwnershipInventoryCoverage(renamed);
    }).toThrow(
      "account_erasure_inventory:reach_column_missing:browser_session_screenshots.chat_thread_id",
    );
  });
});
