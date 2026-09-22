import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { ACCOUNT_OWNERSHIP_INVENTORY } from "../account-erasure-ownership-inventory";
import {
  assertCatalogueInventoryCoverage,
  assertRelationalSweepComplete,
  catalogueForeignKeys,
  catalogueTables,
  planRelationalErasure,
  relationalErasureResidual,
} from "../account-erasure-relational-collector";

// Explicit external-behavior exception, matching the dormant B1 persistence
// suite. The relational sweep plan is derived from `pg_class`, `pg_constraint`
// and `pg_attribute`, so the contract under test is what a real PostgreSQL
// server reports it has. No production endpoint exposes the catalogue, and a
// schema fixture would defeat the point: this layer exists precisely because
// TypeScript exports are not the database.
describe("relational erasure plan", () => {
  const applicationName = `erasure_relational_${randomUUID()}`;
  const databaseUrl = new URL(env("DATABASE_URL"));
  databaseUrl.searchParams.set("application_name", applicationName);
  const pool = new Pool({
    connectionString: databaseUrl.toString(),
    application_name: applicationName,
    max: 4,
  });
  const db = drizzle(pool);
  testContext();

  afterAll(async () => {
    await pool.end();
  });

  it("agrees with the live catalogue in both directions", async () => {
    await expect(assertCatalogueInventoryCoverage(db)).resolves.toBeUndefined();

    const tables = await catalogueTables(db);
    expect(tables.length).toBeGreaterThan(200);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it("resolves a composite foreign key as ordered positional pairs", async () => {
    const keys = await catalogueForeignKeys(db);

    // `account_erasure_work_sink_fk` is a real two-column key, so it pins the
    // ordinality the aggregates carry. Dropping `ORDER BY ord` inside them
    // would still parse, and would still hand the sweep a join key whose
    // halves are paired in an unspecified order.
    const composite = keys.find((key) => {
      return (
        key.child === "account_erasure_work" &&
        key.parent === "account_erasure_sinks"
      );
    });
    expect(composite?.childColumns).toStrictEqual(["job_id", "sink_id"]);
    expect(composite?.parentColumns).toStrictEqual(["job_id", "sink_id"]);

    // Every key, not just that one: the lists are pairs or the decode fails.
    for (const key of keys) {
      expect(key.childColumns).toHaveLength(key.parentColumns.length);
      expect(key.childColumns.length).toBeGreaterThan(0);
    }
    expect(
      keys.filter((key) => {
        return key.childColumns.length > 1;
      }).length,
    ).toBeGreaterThan(0);
  });

  it("orders every root before the roots it references", async () => {
    const plan = await planRelationalErasure(db);
    const position = new Map(
      plan.order.map((root, index) => {
        return [root.table, index];
      }),
    );
    expect(position.size).toBe(plan.order.length);

    const keys = await catalogueForeignKeys(db);
    const rootEdges = keys.filter((key) => {
      return position.has(key.child) && position.has(key.parent);
    });
    // Guard against a vacuous property: roots really do reference each other.
    expect(rootEdges.length).toBeGreaterThan(0);

    const cycleMembers = new Set(
      plan.cycles.flatMap((pair) => {
        return [...pair];
      }),
    );
    const violations = rootEdges.filter((key) => {
      if (cycleMembers.has(key.child) || cycleMembers.has(key.parent)) {
        return false;
      }
      return (position.get(key.child) ?? 0) >= (position.get(key.parent) ?? 0);
    });
    expect(violations).toStrictEqual([]);
  });

  it("sweeps account-owned rows by the row's owner, not by its Agent", async () => {
    const plan = await planRelationalErasure(db);
    const byTable = new Map(
      plan.order.map((root) => {
        return [root.table, root.owners];
      }),
    );

    // The September 12 deletion kept threads the account created under Agents
    // owned by other members. The plan reaches them through the thread's own
    // owner column, so a surviving Agent cannot shelter them.
    expect(byTable.get("chat_threads")).toStrictEqual([
      { kind: "direct", column: "user_id" },
    ]);
    expect(byTable.get("agent_runs")).toStrictEqual([
      { kind: "direct", column: "user_id" },
    ]);
    expect(byTable.get("agent_sessions")).toStrictEqual([
      { kind: "direct", column: "user_id" },
    ]);
    expect(byTable.get("agents")).toStrictEqual([
      { kind: "direct", column: "owner" },
    ]);
    // Ordering alone cannot save the cross-owner case: `chat_threads`
    // references `agents`, `agent_runs` and `agent_sessions` and is referenced
    // back, so no sequence satisfies both directions. The plan says so out
    // loud rather than implying the order is sufficient.
    const pairs = plan.cycles.map((pair) => {
      return pair.join("<->");
    });
    expect(pairs).toContain("chat_threads<->agents");
    expect(pairs).toContain("chat_threads<->agent_runs");
  });

  it("refuses to call the sweep complete while rows are unreachable", () => {
    // Measured on the real schema: `chat_agentphone_context` is a root whose
    // uuid `user_link_id` has no foreign key to a link row naming the account,
    // and fourteen declared descendants have no foreign key to any declared
    // parent. A completion claim has to fail while that is true.
    expect(() => {
      return assertRelationalSweepComplete({
        order: [],
        descendants: [],
        unreachableDescendants: [],
        unreachableRoots: ["chat_agentphone_context"],
        cycles: [],
      });
    }).toThrow(
      "account_erasure_relational:root_unreachable:chat_agentphone_context",
    );
    expect(() => {
      return assertRelationalSweepComplete({
        order: [],
        descendants: [],
        unreachableDescendants: ["email_outbox"],
        unreachableRoots: [],
        cycles: [],
      });
    }).toThrow(
      "account_erasure_relational:descendant_unreachable:email_outbox",
    );
    expect(() => {
      return assertRelationalSweepComplete({
        order: [],
        descendants: [],
        unreachableDescendants: [],
        unreachableRoots: [],
        cycles: [],
      });
    }).not.toThrow();
  });

  it("reaches a link-keyed root through the row that names the account", async () => {
    const plan = await planRelationalErasure(db);
    const byTable = new Map(
      plan.order.map((root) => {
        return [root.table, root.owners];
      }),
    );

    // `agentphone_user_link_id` is a uuid: it cannot hold a Clerk account id,
    // so comparing the subject against it directly is a type error at best and
    // a predicate that never matches at worst. The plan resolves the hop.
    expect(byTable.get("agentphone_chat_thread_routes")).toStrictEqual([
      {
        kind: "indirect",
        column: "agentphone_user_link_id",
        parent: "agentphone_user_links",
        parentColumn: "id",
        parentOwnership: ["user_id"],
      },
    ]);

    // Every owner either holds the account id or names the hop that does.
    for (const root of plan.order) {
      expect(root.owners.length).toBeGreaterThan(0);
      for (const owner of root.owners) {
        if (owner.kind === "indirect") {
          expect(owner.parentOwnership.length).toBeGreaterThan(0);
        }
      }
    }
    // Every root is reachable: each one either holds the account id or names
    // the hop that does. A root the sweep cannot reach would be reported here
    // rather than silently skipped, and none is.
    expect(plan.unreachableRoots).toStrictEqual([]);
  });

  it("reaches every declared descendant through a declared parent", async () => {
    const plan = await planRelationalErasure(db);
    const declared = new Set(
      Object.entries(ACCOUNT_OWNERSHIP_INVENTORY).flatMap((entry) => {
        return entry[1].coverage === "user_descendant" ? [entry[0]] : [];
      }),
    );

    for (const edge of plan.descendants) {
      expect([...declared]).toContain(edge.child);
      const entry = ACCOUNT_OWNERSHIP_INVENTORY[edge.child];
      expect(entry?.coverage).toBe("user_descendant");
      if (entry?.coverage === "user_descendant") {
        expect(entry.parents).toContain(edge.parent);
      }
      expect(edge.childColumns).toHaveLength(edge.parentColumns.length);
    }
    // A descendant with no foreign key to any declared parent cannot be swept
    // through that parent, so it is reported rather than assumed deleted.
    for (const table of plan.unreachableDescendants) {
      expect([...declared]).toContain(table);
    }
    expect(plan.unreachableDescendants).toStrictEqual(
      [...plan.unreachableDescendants].sort(),
    );
  });

  it("reports relational residual for a subject that still has rows", async () => {
    const plan = await planRelationalErasure(db);
    const subjectId = `user_relational_${randomUUID().replaceAll("-", "")}`;
    const subject = { subjectKind: "user", subjectId } as const;

    await expect(
      relationalErasureResidual(db, subject, plan),
    ).resolves.toStrictEqual([]);

    onTestFinished(async () => {
      await db.execute(sql`DELETE FROM users WHERE id = ${subjectId}`);
    });
    await db.execute(sql`INSERT INTO users (id) VALUES (${subjectId})`);
    const residual = await relationalErasureResidual(db, subject, plan);
    expect(residual).toStrictEqual([{ table: "users", rows: 1 }]);

    await db.execute(sql`DELETE FROM users WHERE id = ${subjectId}`);
    await expect(
      relationalErasureResidual(db, subject, plan),
    ).resolves.toStrictEqual([]);
  });

  it("reads no rows outside the subject it is given", async () => {
    const plan = await planRelationalErasure(db);
    const mine = `user_relational_${randomUUID().replaceAll("-", "")}`;
    const theirs = `user_relational_${randomUUID().replaceAll("-", "")}`;

    onTestFinished(async () => {
      await db.execute(
        sql`DELETE FROM users WHERE id = ${mine} OR id = ${theirs}`,
      );
    });
    await db.execute(sql`INSERT INTO users (id) VALUES (${mine}), (${theirs})`);

    // Two accounts hold rows in the same table; the reader must see only one.
    const residual = await relationalErasureResidual(
      db,
      { subjectKind: "user", subjectId: mine },
      plan,
    );
    expect(residual).toStrictEqual([{ table: "users", rows: 1 }]);
  });
});
