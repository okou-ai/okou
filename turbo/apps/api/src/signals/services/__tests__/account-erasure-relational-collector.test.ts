import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { feishuChatIngress } from "@okouai/db/schema/feishu-chat-ingress";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import {
  claimErasureWork,
  executeErasureWork,
  finalizeErasureJob,
  projectErasureDecision,
  reviseErasureInventory,
  sealErasureCapture,
  type ErasureSink,
} from "@okouai/db/operations/account-erasure";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { ACCOUNT_OWNERSHIP_INVENTORY } from "../account-erasure-ownership-inventory";
import { encryptErasureSelector } from "../account-erasure-selector";
import {
  RELATIONAL_ERASURE_COLLECTOR_VERSION,
  assertCatalogueInventoryCoverage,
  assertRelationalSweepComplete,
  catalogueForeignKeys,
  catalogueTables,
  createRelationalErasureCollector,
  deleteErasedArtifactCatalog,
  planRelationalErasure,
  relationalErasureResidual,
  type RelationalDescendantPath,
  type RelationalErasurePlan,
} from "../account-erasure-relational-collector";

/** A plan with nothing in it, so a gate case states only what it changes. */
function emptyPlan(): RelationalErasurePlan {
  return {
    order: [],
    descendants: [],
    unreachableDescendants: [],
    unattributableDescendants: [],
    unreachableRoots: [],
    rewritingEdges: [],
    cycles: [],
  };
}

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
    // Only a key the server will refuse to violate constrains the order. A
    // cascading key deletes the child for us and a nulling key rewrites it.
    const rootEdges = keys.filter((key) => {
      return (
        position.has(key.child) &&
        position.has(key.parent) &&
        (key.onDelete === "a" || key.onDelete === "r")
      );
    });
    // Guard against a vacuous property: blocking root-to-root keys exist.
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
    const order = plan.order.map((root) => {
      return root.table;
    });
    // `chat_threads` and `agents` reference each other, but the catalogue says
    // how: `chat_threads -> agents` is `ON DELETE CASCADE`, so it imposes no
    // ordering and the pair is not a cycle. Treating every key as an ordering
    // constraint is what made these look mutually blocked.
    const keys = await catalogueForeignKeys(db);
    const threadToAgent = keys.find((key) => {
      return key.child === "chat_threads" && key.parent === "agents";
    });
    expect(threadToAgent?.onDelete).toBe("c");
    expect(plan.cycles).toStrictEqual([]);

    // The one blocking key between roots does constrain the order: `storages`
    // references `storage_versions` with `NO ACTION`, so it is deleted first.
    const storageEdge = keys.find((key) => {
      return key.child === "storages" && key.parent === "storage_versions";
    });
    expect(storageEdge?.onDelete).toBe("a");
    expect(order.indexOf("storages")).toBeLessThan(
      order.indexOf("storage_versions"),
    );
  });

  it("refuses to call the sweep complete while rows are unreachable", () => {
    // Measured on the real schema: `chat_agentphone_context` is a root whose
    // uuid `user_link_id` has no foreign key to a link row naming the account.
    // A completion claim has to fail while that is true.
    expect(() => {
      return assertRelationalSweepComplete({
        ...emptyPlan(),
        unreachableRoots: ["chat_agentphone_context"],
      });
    }).toThrow(
      "account_erasure_relational:root_unreachable:chat_agentphone_context",
    );
    expect(() => {
      return assertRelationalSweepComplete({
        ...emptyPlan(),
        unreachableDescendants: ["browser_session_screenshots"],
      });
    }).toThrow(
      "account_erasure_relational:descendant_unreachable:browser_session_screenshots",
    );
    // A descendant whose account attribution does not exist in the schema is
    // refused under its own code rather than quietly counted as reached.
    expect(() => {
      return assertRelationalSweepComplete({
        ...emptyPlan(),
        unattributableDescendants: ["unattributed_account_data_fixture"],
      });
    }).toThrow(
      "account_erasure_relational:descendant_unattributable:unattributed_account_data_fixture",
    );
    expect(() => {
      return assertRelationalSweepComplete(emptyPlan());
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
        return "parents" in entry[1] && entry[1].parents ? [entry[0]] : [];
      }),
    );

    for (const path of plan.descendants) {
      expect([...declared]).toContain(path.child);
      const entry = ACCOUNT_OWNERSHIP_INVENTORY[path.child];
      expect(["user_descendant", "user_root"]).toContain(entry?.coverage);
      if (entry && "parents" in entry) {
        expect(entry.parents).toContain(path.root);
      }
      expect(path.hops.length).toBeGreaterThan(0);
      expect(path.hops[path.hops.length - 1]?.parent).toBe(path.root);
      for (const hop of path.hops) {
        expect(hop.childColumns).toHaveLength(hop.parentColumns.length);
        expect(hop.childColumns.length).toBeGreaterThan(0);
      }
      // A declared reach states why the schema has no key; a catalogue path
      // is the key itself and needs none.
      expect(path.basis === null).toBe(path.source === "catalogue");
    }
    // Every declared reach is anchored on a root the plan can actually sweep.
    const planned = new Set(
      plan.order.map((root) => {
        return root.table;
      }),
    );
    for (const path of plan.descendants) {
      expect([...planned]).toContain(path.root);
    }
    // The order is derived, not a hop count: every path runs before each
    // table it joins through loses its rows, or the join would match nothing.
    // A path's terminal root is excluded because roots go in a later phase.
    const firstIndex = new Map<string, number>();
    for (const [index, path] of plan.descendants.entries()) {
      if (!firstIndex.has(path.child)) {
        firstIndex.set(path.child, index);
      }
    }
    let traversedDescendants = 0;
    for (const [index, path] of plan.descendants.entries()) {
      for (const hop of path.hops.slice(0, -1)) {
        const intermediate = firstIndex.get(hop.parent);
        if (intermediate === undefined) {
          continue;
        }
        traversedDescendants += 1;
        expect(index).toBeLessThan(intermediate);
      }
    }
    // The live schema really does exercise that ordering, so a future change
    // that stopped producing multi-hop paths would not silently pass this.
    expect(traversedDescendants).toBeGreaterThan(0);

    // A descendant with neither a foreign key to a declared parent nor a
    // declared reach cannot be swept, so it is reported rather than assumed
    // deleted. On the live schema there are none left.
    expect(plan.unreachableDescendants).toStrictEqual([]);
    // The two explicit deferred-retention tables are not account-erasure
    // descendants; every other declared descendant still needs attribution.
    expect(plan.unattributableDescendants).toStrictEqual([]);
  });

  it("reaches the descendants a foreign key cannot, through declared keys", async () => {
    const plan = await planRelationalErasure(db);
    const byChild = new Map<string, RelationalDescendantPath[]>();
    for (const path of plan.descendants) {
      byChild.set(path.child, [...(byChild.get(path.child) ?? []), path]);
    }

    // The twelve of the fourteen previously unreachable descendants this
    // sink can now reach. Each is measured against the live catalogue, not
    // asserted from the declaration alone.
    for (const table of [
      "active_input_delivery_items",
      "browser_session_resize_states",
      "browser_session_screenshot_deletions",
      "browser_session_screenshots",
      "chat_agent_run_context",
      "chat_event_search_message_watermarks",
      "official_automation_result_email_claims",
      "pi_resource_version_indexes",
      "stripe_workflow_deliveries",
    ]) {
      const paths = byChild.get(table) ?? [];
      expect(paths.length).toBeGreaterThan(0);
    }

    // `pi_resource_version_indexes` needed no declared key at all: its real
    // foreign key lands on `storage_versions`, and the inventory had named
    // the grandparent.
    expect(byChild.get("pi_resource_version_indexes")).toStrictEqual([
      {
        child: "pi_resource_version_indexes",
        root: "storage_versions",
        hops: [
          {
            childColumns: ["storage_version_id"],
            parent: "storage_versions",
            parentColumns: ["id"],
          },
        ],
        source: "catalogue",
        basis: null,
      },
    ]);

    // A two-hop reach: the only key lands on a descendant, so the join has to
    // continue to the root that names the account.
    const items = byChild.get("active_input_delivery_items") ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.root).toBe("chat_threads");
    expect(items[0]?.source).toBe("declared");
    expect(items[0]?.hops).toStrictEqual([
      {
        childColumns: ["delivery_id"],
        parent: "active_input_deliveries",
        parentColumns: ["id"],
      },
      {
        childColumns: ["chat_thread_id"],
        parent: "chat_threads",
        parentColumns: ["id"],
      },
    ]);

    // The three tables the schema itself says are not the account's: a shared
    // X read cache, an installation-scoped provider retry receipt, and a
    // platform provider-cost fact with no owner linkage left once the
    // owner-scoped row is gone. None of them appears as a descendant.
    for (const table of [
      "x_resource_reads",
      "feishu_org_events",
      "morning_brief_platform_generation_receipts",
    ]) {
      expect(byChild.has(table)).toBeFalsy();
      expect(ACCOUNT_OWNERSHIP_INVENTORY[table]?.coverage).not.toBe(
        "user_descendant",
      );
    }
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

// A dormant end-to-end run of the relational sink through the B1 job. No route
// or worker reaches this handler; the job is driven here the way the future
// worker will drive it, so the sweep, its fence and its verification are
// exercised against real rows rather than asserted about.
describe("dormant relational sweep", () => {
  const applicationName = `erasure_sweep_${randomUUID()}`;
  const databaseUrl = new URL(env("DATABASE_URL"));
  databaseUrl.searchParams.set("application_name", applicationName);
  const pool = new Pool({
    connectionString: databaseUrl.toString(),
    application_name: applicationName,
    max: 8,
  });
  const db = drizzle(pool);
  const context = testContext();

  afterAll(async () => {
    await pool.end();
  });

  function account(label: string) {
    return `user_sweep_${label}_${randomUUID().replaceAll("-", "")}`;
  }

  async function sealedJob(subjectId: string, collectorVersion: string) {
    const selector = await encryptErasureSelector({
      version: 1,
      kind: "subject",
      subjectKind: "user",
      subjectId,
    });
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "relational",
      collectorVersion,
      selector,
      dependencies: [],
    };
    const initial = await projectErasureDecision(db, {
      subjectKind: "user",
      subjectId,
      generation: 1,
      authorityId: randomUUID(),
      decisionRef: randomUUID(),
      decisionSequence: 1n,
      confirmationRef: randomUUID(),
      previousDecisionRef: null,
      dispositionVersion: 1,
      requestedAt: new Date("2026-09-22T00:00:00Z"),
      deadlineAt: new Date("2090-01-01T00:00:00Z"),
    });
    const job = await reviseErasureInventory(db, initial.id, initial, [sink]);
    return { job, sink };
  }

  async function seal(
    jobId: string,
    expected: Awaited<ReturnType<typeof sealedJob>>["job"],
  ) {
    return await sealErasureCapture(
      db,
      jobId,
      expected,
      {
        verify: () => {
          return Promise.resolve({
            jobId,
            generation: expected.generation,
            captureRevision: expected.captureRevision,
            inventoryRevision: expected.inventoryRevision,
            reference: randomUUID(),
          });
        },
      },
      context.signal,
    );
  }

  async function drive(subjectId: string, plan: RelationalErasurePlan) {
    const handler = createRelationalErasureCollector(db, plan);
    const { job } = await sealedJob(
      subjectId,
      RELATIONAL_ERASURE_COLLECTOR_VERSION,
    );
    const [collector] = await claimErasureWork(db, job.id, "inventory");
    expect(collector).toBeDefined();
    if (collector) {
      await executeErasureWork(db, collector, handler, context.signal);
    }
    const sealed = await seal(job.id, job);
    const claimed = await claimErasureWork(db, job.id, "verification");
    expect(claimed.length).toBeGreaterThan(0);
    for (const lease of claimed) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    return { job, sealed };
  }

  it("retains deferred outbox and Feishu payloads through a real account sweep", async () => {
    const mine = account("deferred");
    const outboxId = randomUUID();
    const installationId = randomUUID();
    const ingressId = randomUUID();
    onTestFinished(async () => {
      await db.delete(emailOutbox).where(eq(emailOutbox.id, outboxId));
      await db
        .delete(feishuOrgInstallations)
        .where(eq(feishuOrgInstallations.id, installationId));
      await db.execute(sql`DELETE FROM users WHERE id = ${mine}`);
    });
    await db.execute(sql`INSERT INTO users (id) VALUES (${mine})`);
    // Sent mail is retained by the existing queue lifecycle; account erasure
    // must not reinterpret a recipient address as a durable ownership key.
    await db.execute(sql`
      INSERT INTO email_outbox
        (id, from_address, to_addresses, subject, template, status)
      VALUES (${outboxId}, 'test@example.test',
              ${JSON.stringify([`${mine}@example.test`])}::jsonb,
              'retained fixture', '{}'::jsonb, 'sent')
    `);
    await db.insert(feishuOrgInstallations).values({
      id: installationId,
      orgId: `org_${randomUUID()}`,
      appId: `cli_${randomUUID()}`,
      encryptedAppSecret: "fixture",
      encryptedVerificationToken: "fixture",
      encryptedEncryptKey: "fixture",
    });
    await db.insert(feishuChatIngress).values({
      id: ingressId,
      installationId,
      eventId: `event_${randomUUID()}`,
      payload: JSON.stringify({ userId: mine }),
      publicBrand: "vm0",
      status: "processed",
    });

    const plan = await planRelationalErasure(db);
    for (const table of ["email_outbox", "feishu_chat_ingress"]) {
      expect(
        plan.order.some((root) => {
          return root.table === table;
        }),
      ).toBeFalsy();
      expect(
        plan.descendants.some((path) => {
          return path.child === table;
        }),
      ).toBeFalsy();
    }
    await drive(mine, plan);
    expect(
      (await db.execute(sql`SELECT id FROM users WHERE id = ${mine}`)).rows,
    ).toStrictEqual([]);
    await expect(
      db
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(eq(emailOutbox.id, outboxId)),
    ).resolves.toStrictEqual([{ id: outboxId }]);
    await expect(
      db
        .select({ ownerUserId: feishuOrgInstallations.ownerUserId })
        .from(feishuOrgInstallations)
        .where(eq(feishuOrgInstallations.id, installationId)),
    ).resolves.toStrictEqual([{ ownerUserId: null }]);
    await expect(
      db
        .select({ id: feishuChatIngress.id })
        .from(feishuChatIngress)
        .where(eq(feishuChatIngress.id, ingressId)),
    ).resolves.toStrictEqual([{ id: ingressId }]);
  });

  it("keeps its durable deletion task while sweeping other owner jobs", async () => {
    const mine = account("control");
    const theirs = account("control-survivor");
    const controlId = randomUUID();
    const exportId = randomUUID();
    const survivorId = randomUUID();
    onTestFinished(async () => {
      await db.execute(sql`
        DELETE FROM background_jobs
        WHERE id IN (${controlId}, ${exportId}, ${survivorId})
      `);
    });
    await db.execute(sql`
      INSERT INTO background_jobs
        (id, kind, handler_version, user_id, org_id, input)
      VALUES
        (${controlId}, 'clerk-user-deletion', 1, ${mine}, '', '{}'::jsonb),
        (${exportId}, 'account-task-fixture', 1, ${mine}, '', '{}'::jsonb),
        (${survivorId}, 'account-task-fixture', 1, ${theirs}, '', '{}'::jsonb)
    `);

    const plan = await planRelationalErasure(db);
    const { job, sealed } = await drive(mine, {
      ...plan,
      unattributableDescendants: [],
    });
    const remaining = await db.execute(sql`
      SELECT id FROM background_jobs
      WHERE id IN (${controlId}, ${exportId}, ${survivorId})
      ORDER BY id
    `);
    expect(remaining.rows).toStrictEqual(
      [{ id: controlId }, { id: survivorId }].sort((a, b) => {
        return a.id.localeCompare(b.id);
      }),
    );
    await expect(
      relationalErasureResidual(
        db,
        { subjectKind: "user", subjectId: mine },
        plan,
      ),
    ).resolves.toStrictEqual([]);
    // The inventory proof may run before its erase sibling. Retry it after
    // the sweep so the gate sees the same sealed revision with no residual.
    await db.execute(sql`
      UPDATE account_erasure_work SET available_at = clock_timestamp()
      WHERE job_id = ${job.id} AND kind = 'inventory'
    `);
    const [inventory] = await claimErasureWork(db, job.id, "verification");
    expect(inventory).toBeDefined();
    if (inventory) {
      await executeErasureWork(
        db,
        inventory,
        createRelationalErasureCollector(db, {
          ...plan,
          unattributableDescendants: [],
        }),
        context.signal,
      );
    }
    expect((await finalizeErasureJob(db, job.id, sealed)).state).toBe(
      "verified_erased",
    );
  });

  it("holds the relational sweep while an export cleanup coordinator exists", async () => {
    const mine = account("export-inflight");
    const exportId = randomUUID();
    onTestFinished(async () => {
      await db.execute(sql`DELETE FROM background_jobs WHERE id = ${exportId}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${mine}`);
    });
    await db.execute(sql`INSERT INTO users (id) VALUES (${mine})`);
    await db.execute(sql`
      INSERT INTO background_jobs
        (id, kind, handler_version, user_id, org_id, input)
      VALUES (${exportId}, 'user-export', 1, ${mine}, '', '{}'::jsonb)
    `);
    const plan = await planRelationalErasure(db);
    const { job, sealed } = await drive(mine, {
      ...plan,
      unattributableDescendants: [],
    });
    const remaining = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM users WHERE id = ${mine}) AS users,
        (SELECT count(*)::int FROM background_jobs WHERE id = ${exportId}) AS export_jobs
    `);
    expect(remaining.rows).toStrictEqual([{ users: 1, export_jobs: 1 }]);
    const [pending] = (
      await db.execute(sql`
        SELECT state, error_code AS "errorCode", attempt_count AS "attemptCount"
        FROM account_erasure_work
        WHERE job_id = ${job.id} AND kind = 'erase'
      `)
    ).rows;
    expect(pending).toMatchObject({
      state: "pending",
      errorCode: "boundary_unproven",
      attemptCount: 0,
    });
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  });

  it("releases only deleted conversation and candidate blob retains", async () => {
    const mine = account("blob-owner");
    const theirs = account("blob-survivor");
    const orgId = `org_sweep_${randomUUID().replaceAll("-", "")}`;
    const historyHash = randomBytes(32).toString("hex");
    const candidateHash = randomBytes(32).toString("hex");
    const ownStorage = randomUUID();
    const theirStorage = randomUUID();
    const ownSession = randomUUID();
    const theirSession = randomUUID();
    const ownRun = randomUUID();
    const theirRun = randomUUID();
    onTestFinished(async () => {
      await db.execute(sql`DELETE FROM pi_memory_stage1_candidates
        WHERE memory_storage_id IN (${ownStorage}, ${theirStorage})`);
      await db.execute(sql`DELETE FROM conversations
        WHERE run_id IN (${ownRun}, ${theirRun})`);
      await db.execute(sql`DELETE FROM agent_runs
        WHERE id IN (${ownRun}, ${theirRun})`);
      await db.execute(sql`DELETE FROM agent_sessions
        WHERE id IN (${ownSession}, ${theirSession})`);
      await db.execute(sql`DELETE FROM storages
        WHERE id IN (${ownStorage}, ${theirStorage})`);
      await db.execute(sql`DELETE FROM blobs
        WHERE hash IN (${historyHash}, ${candidateHash})`);
    });
    await db.execute(sql`INSERT INTO blobs
      (hash, raw_size, encoding, encoded_size, ref_count)
      VALUES (${historyHash}, 1, 'raw', 1, 2),
             (${candidateHash}, 1, 'raw', 1, 2)`);
    await db.execute(sql`INSERT INTO storages
      (id, user_id, org_id, name, s3_prefix)
      VALUES (${ownStorage}, ${mine}, ${orgId}, 'memory', ${`storage/${ownStorage}`}),
             (${theirStorage}, ${theirs}, ${orgId}, 'memory', ${`storage/${theirStorage}`})`);
    await db.execute(sql`INSERT INTO pi_memory_stage1_candidates
      (memory_storage_id, org_id, user_id, pi_session_id, source_run_id,
       source_history_hash, source_completed_at, eligible_at)
      VALUES (${ownStorage}, ${orgId}, ${mine}, 'mine', ${ownRun},
              ${candidateHash}, now(), now()),
             (${theirStorage}, ${orgId}, ${theirs}, 'theirs', ${theirRun},
              ${candidateHash}, now(), now())`);
    await db.execute(sql`INSERT INTO agent_sessions (id, user_id, org_id)
      VALUES (${ownSession}, ${mine}, ${orgId}),
             (${theirSession}, ${theirs}, ${orgId})`);
    await db.execute(sql`INSERT INTO agent_runs
      (id, user_id, org_id, session_id, status, prompt)
      VALUES (${ownRun}, ${mine}, ${orgId}, ${ownSession}, 'completed', ''),
             (${theirRun}, ${theirs}, ${orgId}, ${theirSession}, 'completed', '')`);
    await db.execute(sql`INSERT INTO conversations
      (run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history_hash)
      VALUES (${ownRun}, 'pi', 'mine', ${historyHash}),
             (${theirRun}, 'pi', 'theirs', ${historyHash})`);

    const plan = await planRelationalErasure(db);
    const candidateRoot = plan.order.find((root) => {
      return root.table === "pi_memory_stage1_candidates";
    });
    expect(candidateRoot).toBeDefined();
    // Force the dangerous but FK-valid order: storage cascades candidates
    // before the generic loop could inspect them. Capture must not depend on
    // the catalogue's incidental root order.
    await drive(mine, {
      ...plan,
      order: [
        ...plan.order.filter((root) => {
          return root.table !== "pi_memory_stage1_candidates";
        }),
        ...(candidateRoot ? [candidateRoot] : []),
      ],
      unattributableDescendants: [],
    });

    const rows = await db.execute(sql`SELECT hash, ref_count
      FROM blobs WHERE hash IN (${historyHash}, ${candidateHash})`);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows).toStrictEqual(
      expect.arrayContaining([
        { hash: historyHash, ref_count: 1 },
        { hash: candidateHash, ref_count: 1 },
      ]),
    );
    const survivor = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM conversations WHERE run_id = ${theirRun}) AS conversations,
      (SELECT count(*)::int FROM pi_memory_stage1_candidates
       WHERE memory_storage_id = ${theirStorage}) AS candidates`);
    expect(survivor.rows).toStrictEqual([{ conversations: 1, candidates: 1 }]);
  });

  it("rolls back the sweep when a blob retain cannot be released", async () => {
    const mine = account("missing-blob-retain");
    const orgId = `org_sweep_${randomUUID().replaceAll("-", "")}`;
    const storageId = randomUUID();
    const hash = randomBytes(32).toString("hex");
    onTestFinished(async () => {
      await db.execute(sql`DELETE FROM pi_memory_stage1_candidates
        WHERE memory_storage_id = ${storageId}`);
      await db.execute(sql`DELETE FROM storages WHERE id = ${storageId}`);
      await db.execute(sql`DELETE FROM blobs WHERE hash = ${hash}`);
    });
    await db.execute(sql`INSERT INTO blobs
      (hash, raw_size, encoding, encoded_size, ref_count)
      VALUES (${hash}, 1, 'raw', 1, 0)`);
    await db.execute(sql`INSERT INTO storages
      (id, user_id, org_id, name, s3_prefix)
      VALUES (${storageId}, ${mine}, ${orgId}, 'memory', ${`storage/${storageId}`})`);
    await db.execute(sql`INSERT INTO pi_memory_stage1_candidates
      (memory_storage_id, org_id, user_id, pi_session_id, source_run_id,
       source_history_hash, source_completed_at, eligible_at)
      VALUES (${storageId}, ${orgId}, ${mine}, 'mine', ${randomUUID()},
              ${hash}, now(), now())`);

    const plan = await planRelationalErasure(db);
    const runnable = {
      ...plan,
      unattributableDescendants: [],
    };
    const handler = createRelationalErasureCollector(db, runnable);
    const { job } = await sealedJob(mine, RELATIONAL_ERASURE_COLLECTOR_VERSION);
    const [collector] = await claimErasureWork(db, job.id, "inventory");
    if (!collector) {
      throw new Error("Missing relational inventory lease");
    }
    await executeErasureWork(db, collector, handler, context.signal);
    const sealed = await seal(job.id, job);
    const claimed = await claimErasureWork(db, job.id, "verification");
    const eraser = claimed.find((lease) => {
      return lease.item.itemKey !== lease.item.sinkId;
    });
    if (!eraser) {
      throw new Error("Missing relational erase lease");
    }
    await expect(
      executeErasureWork(db, eraser, handler, context.signal),
    ).rejects.toThrow(
      "Conversation history reference accounting failed: missing or insufficient blob references",
    );
    const retained = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM storages WHERE id = ${storageId}) AS storages,
      (SELECT count(*)::int FROM pi_memory_stage1_candidates
       WHERE memory_storage_id = ${storageId}) AS candidates`);
    expect(retained.rows).toStrictEqual([{ storages: 1, candidates: 1 }]);
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  });

  it("deletes a thread the account created under a surviving member's Agent", async () => {
    const mine = account("mine");
    const theirs = account("theirs");
    const orgId = `org_sweep_${randomUUID().replaceAll("-", "")}`;
    const agentId = randomUUID();
    onTestFinished(async () => {
      await db.execute(
        sql`DELETE FROM chat_threads WHERE user_id IN (${mine}, ${theirs})`,
      );
      await db.execute(sql`DELETE FROM agents WHERE id = ${agentId}`);
    });

    // The other member owns the Agent; this account only owns a thread inside
    // it. September 12 kept exactly this row.
    await db.execute(
      sql`INSERT INTO agents (id, name, org_id, owner)
          VALUES (${agentId}, ${"sweep-agent"}, ${orgId}, ${theirs})`,
    );
    await db.execute(
      sql`INSERT INTO chat_threads (user_id, agent_id) VALUES (${mine}, ${agentId})`,
    );
    await db.execute(
      sql`INSERT INTO chat_threads (user_id, agent_id) VALUES (${theirs}, ${agentId})`,
    );

    const plan = await planRelationalErasure(db);
    await drive(mine, {
      ...plan,
      unattributableDescendants: [],
    });

    const residual = await relationalErasureResidual(
      db,
      { subjectKind: "user", subjectId: mine },
      plan,
    );
    expect(residual).toStrictEqual([]);

    // The surviving member keeps their Agent and their own thread.
    const survivors = await db.execute(
      sql`SELECT count(*)::int AS rows FROM agents WHERE id = ${agentId}`,
    );
    expect(survivors.rows).toStrictEqual([{ rows: 1 }]);
    const theirThreads = await db.execute(
      sql`SELECT count(*)::int AS rows FROM chat_threads WHERE user_id = ${theirs}`,
    );
    expect(theirThreads.rows).toStrictEqual([{ rows: 1 }]);
  });

  it("removes attributed orphan provenance and unattributed retained provenance without removing another owner's", async () => {
    const mine = account("provenance_mine");
    const theirs = account("provenance_theirs");
    const orgId = `org_sweep_${randomUUID().replaceAll("-", "")}`;
    const agentId = randomUUID();
    const sourceThreadId = randomUUID();
    const legacyId = randomUUID();
    const orphanId = randomUUID();
    const survivorId = randomUUID();
    onTestFinished(async () => {
      await db.execute(
        sql`DELETE FROM chat_agent_run_context WHERE id IN (${legacyId}, ${orphanId}, ${survivorId})`,
      );
      await db.execute(
        sql`DELETE FROM chat_threads WHERE id = ${sourceThreadId}`,
      );
      await db.execute(sql`DELETE FROM agents WHERE id = ${agentId}`);
    });
    await db.execute(
      sql`INSERT INTO agents (id, name, org_id, owner)
          VALUES (${agentId}, 'provenance-agent', ${orgId}, ${theirs})`,
    );
    await db.execute(
      sql`INSERT INTO chat_threads (id, user_id, agent_id)
          VALUES (${sourceThreadId}, ${mine}, ${agentId})`,
    );
    await db.execute(sql`
      INSERT INTO chat_agent_run_context
        (id, source_chat_thread_id, source_agent_id, source_user_id)
      VALUES
        (${legacyId}, ${sourceThreadId}, ${agentId}, NULL),
        (${orphanId}, ${randomUUID()}, ${randomUUID()}, ${mine}),
        (${survivorId}, ${randomUUID()}, ${randomUUID()}, ${theirs})
    `);
    const plan = await planRelationalErasure(db);
    const before = await relationalErasureResidual(
      db,
      { subjectKind: "user", subjectId: mine },
      plan,
    );
    expect(before).toContainEqual({ table: "chat_agent_run_context", rows: 1 });
    await drive(mine, { ...plan, unattributableDescendants: [] });
    const remaining = await db.execute(
      sql`SELECT id FROM chat_agent_run_context WHERE id IN (${legacyId}, ${orphanId}, ${survivorId})`,
    );
    expect(remaining.rows).toStrictEqual([{ id: survivorId }]);
    await expect(
      relationalErasureResidual(
        db,
        { subjectKind: "user", subjectId: mine },
        plan,
      ),
    ).resolves.toStrictEqual([]);
  });

  it("removes source catalog rows across Agent, run and site cascades without deleting a survivor's catalog", async () => {
    const mine = account("catalog_mine");
    const theirs = account("catalog_theirs");
    const orgId = `org_sweep_${randomUUID().replaceAll("-", "")}`;
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const runId = randomUUID();
    const generationJobId = randomUUID();
    const presentationJobId = randomUUID();
    const fileId = randomUUID();
    const imageId = randomUUID();
    const videoId = randomUUID();
    const siteId = randomUUID();
    const survivorSiteId = randomUUID();
    const presentationId = randomUUID();
    const survivorFileId = randomUUID();
    const survivorCatalogId = randomUUID();
    onTestFinished(async () => {
      await db.execute(sql`DELETE FROM artifacts WHERE org_id = ${orgId}`);
      await db.execute(sql`DELETE FROM hosted_sites WHERE org_id = ${orgId}`);
      await db.execute(sql`DELETE FROM agent_sessions WHERE id = ${sessionId}`);
      await db.execute(sql`DELETE FROM agents WHERE id = ${agentId}`);
      await db.execute(sql`
        DELETE FROM built_in_generation_jobs
        WHERE id IN (${generationJobId}, ${presentationJobId})
      `);
      await db.execute(
        sql`DELETE FROM run_uploaded_files WHERE id = ${survivorFileId}`,
      );
    });

    // The account owns the Agent, while another user owns the session, run,
    // file, and catalog. Deleting the Agent cascades all three source rows.
    await db.execute(sql`
      INSERT INTO agents (id, org_id, owner, name)
      VALUES (${agentId}, ${orgId}, ${mine}, 'erasure catalog source')
    `);
    await db.execute(sql`
      INSERT INTO agent_sessions (id, user_id, org_id, agent_id)
      VALUES (${sessionId}, ${theirs}, ${orgId}, ${agentId})
    `);
    await db.execute(sql`
      INSERT INTO agent_runs (id, session_id, user_id, org_id, status, prompt)
      VALUES (${runId}, ${sessionId}, ${theirs}, ${orgId}, 'completed', 'catalog sweep')
    `);
    await db.execute(sql`
      INSERT INTO run_uploaded_files
        (id, run_id, source, external_id, user_id, org_id, url)
      VALUES
        (${fileId}, ${runId}, 'test', ${fileId}, ${theirs}, ${orgId},
         ${`https://files.example.test/${fileId}`}),
        (${survivorFileId}, NULL, 'test', ${survivorFileId}, ${theirs}, ${orgId},
         ${`https://files.example.test/${survivorFileId}`})
    `);
    await db.execute(sql`
      INSERT INTO image_artifacts (id, file_id) VALUES (${imageId}, ${fileId})
    `);
    await db.execute(sql`
      INSERT INTO built_in_generation_jobs
        (id, type, org_id, user_id, request)
      VALUES
        (${generationJobId}, 'video', ${orgId}, ${mine}, '{}'::jsonb),
        (${presentationJobId}, 'presentation', ${orgId}, ${mine}, '{}'::jsonb)
    `);
    await db.execute(sql`
      INSERT INTO video_artifacts (id, file_id, generation_job_id)
      VALUES (${videoId}, ${survivorFileId}, ${generationJobId})
    `);
    await db.execute(sql`
      INSERT INTO hosted_sites
        (id, org_id, user_id, slug, public_brand, public_slug)
      VALUES
        (${siteId}, ${orgId}, ${mine}, ${`s-${siteId.slice(0, 8)}`},
         'vm0', ${`p-${siteId}`}),
        (${survivorSiteId}, ${orgId}, ${theirs},
         ${`s-${survivorSiteId.slice(0, 8)}`}, 'vm0', ${`p-${survivorSiteId}`})
    `);
    await db.execute(sql`
      INSERT INTO presentation_artifacts
        (id, hosted_site_id, generation_job_id)
      VALUES (${presentationId}, ${survivorSiteId}, ${presentationJobId})
    `);
    await db.execute(sql`
      INSERT INTO artifact_catalog_pending_files
        (file_id, org_id, author_user_id)
      VALUES (${fileId}, ${orgId}, ${theirs})
      ON CONFLICT (file_id) DO NOTHING
    `);
    const sourceCatalog = [
      ["file", fileId],
      ["image", imageId],
      ["video", videoId],
      ["hosted-site", siteId],
      ["presentation", presentationId],
    ] as const;
    for (const [kind, entityId] of sourceCatalog) {
      await db.execute(sql`
        INSERT INTO artifacts
          (org_id, author_user_id, kind, entity_id, logical_key,
           projection_created_at, title)
        VALUES (${orgId}, ${theirs}, ${kind}, ${entityId},
                ${`sweep:${entityId}`}, now(), ${kind})
      `);
    }
    await db.execute(sql`
      INSERT INTO artifacts
        (id, org_id, author_user_id, kind, entity_id, logical_key,
         projection_created_at, title)
      VALUES (${survivorCatalogId}, ${orgId}, ${theirs}, 'file',
              ${survivorFileId}, ${`sweep:${survivorFileId}`}, now(),
              'survivor')
    `);

    // Prove the explicit operation while its sources still exist. The legacy
    // AFTER DELETE triggers cannot satisfy this assertion. Roll back so the
    // full fenced sweep below starts from the same persisted fixture.
    const rollback = new Error("rollback explicit catalog assertion");
    await expect(
      db.transaction(async (tx) => {
        await expect(deleteErasedArtifactCatalog(tx, mine)).resolves.toBe(5);
        const catalogAfterCleanup = await tx.execute(sql`
          SELECT id FROM artifacts WHERE org_id = ${orgId}
        `);
        expect(catalogAfterCleanup.rows).toStrictEqual([
          { id: survivorCatalogId },
        ]);
        const sourcesBeforeDeletion = await tx.execute(sql`
          SELECT
            (SELECT count(*)::int FROM run_uploaded_files
             WHERE id = ${fileId}) AS files,
            (SELECT count(*)::int FROM hosted_sites
             WHERE id = ${siteId}) AS sites,
            (SELECT count(*)::int FROM video_artifacts
             WHERE id = ${videoId}) AS videos,
            (SELECT count(*)::int FROM presentation_artifacts
             WHERE id = ${presentationId}) AS presentations
        `);
        expect(sourcesBeforeDeletion.rows).toStrictEqual([
          { files: 1, sites: 1, videos: 1, presentations: 1 },
        ]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    const plan = await planRelationalErasure(db);
    await drive(mine, { ...plan, unattributableDescendants: [] });
    const catalogs = await db.execute(sql`
      SELECT id, entity_id AS "entityId" FROM artifacts WHERE org_id = ${orgId}
    `);
    expect(catalogs.rows).toStrictEqual([
      { id: survivorCatalogId, entityId: survivorFileId },
    ]);
    const pending = await db.execute(sql`
      SELECT count(*)::int AS rows FROM artifact_catalog_pending_files
      WHERE file_id = ${fileId}
    `);
    expect(pending.rows).toStrictEqual([{ rows: 0 }]);
    const sources = await db.execute(sql`
      SELECT count(*)::int AS rows FROM run_uploaded_files
      WHERE id IN (${fileId}, ${survivorFileId})
    `);
    expect(sources.rows).toStrictEqual([{ rows: 1 }]);
    const sites = await db.execute(sql`
      SELECT id FROM hosted_sites WHERE org_id = ${orgId}
    `);
    expect(sites.rows).toStrictEqual([{ id: survivorSiteId }]);
  });

  it("refuses to verify while rows remain unattributable", async () => {
    const subjectId = account("gated");
    const plan = await planRelationalErasure(db);
    // Keep the unattributable-descendant gate for all non-deferred tables.
    // This deliberate negative case pins the gate independently of test data.
    const unresolved = {
      ...plan,
      unattributableDescendants: ["unattributed_account_data_fixture"],
    };
    expect(() => {
      return assertRelationalSweepComplete(unresolved);
    }).toThrow("account_erasure_relational:descendant_unattributable");

    const { job, sealed } = await drive(subjectId, unresolved);
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  });

  // The gate is the point, so it is proved against a plan that is complete in
  // every other respect: one descendant is put back out of reach and nothing
  // else changes. If a future change were to soften the gate, this is the
  // case that goes red rather than a completion claim quietly turning true.
  it("still refuses a complete plan with one descendant put out of reach", async () => {
    const subjectId = account("negative");
    const plan = await planRelationalErasure(db);
    const reachable = { ...plan, unattributableDescendants: [] };
    expect(() => {
      return assertRelationalSweepComplete(reachable);
    }).not.toThrow();

    const withdrawn = {
      ...reachable,
      descendants: reachable.descendants.filter((path) => {
        return path.child !== "browser_session_screenshots";
      }),
      unreachableDescendants: ["browser_session_screenshots"],
    };
    expect(() => {
      return assertRelationalSweepComplete(withdrawn);
    }).toThrow(
      "account_erasure_relational:descendant_unreachable:browser_session_screenshots",
    );

    const { job, sealed } = await drive(subjectId, withdrawn);
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  });

  it("finalizes the job when the sweep is complete and verified", async () => {
    const subjectId = account("clean");
    const plan = await planRelationalErasure(db);
    const { job, sealed } = await drive(subjectId, {
      ...plan,
      unattributableDescendants: [],
    });

    const finished = await finalizeErasureJob(db, job.id, sealed);
    // No rows existed for this account, so the sink verified no applicable
    // data rather than claiming an erasure it did not perform.
    expect(finished.state).toBe("verified_no_applicable_data");
  });

  it("refuses work captured for the pre-catalog-cleanup collector", async () => {
    const subjectId = account("skew");
    const plan = await planRelationalErasure(db);
    const { job } = await sealedJob(
      subjectId,
      "0a4f9d63-2b17-45c8-9e0a-7f31c6d8b204",
    );
    const [collector] = await claimErasureWork(db, job.id, "inventory");
    expect(collector).toBeDefined();
    if (collector) {
      await executeErasureWork(
        db,
        collector,
        createRelationalErasureCollector(db, plan),
        context.signal,
      );
    }
    // Version skew is a capability outcome, not a sweep: nothing was deleted.
    await expect(seal(job.id, job)).rejects.toThrow(
      "account_erasure:capture_incomplete",
    );
  });
});
