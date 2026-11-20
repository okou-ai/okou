import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { array, number, object, string, uuid } from "zod";
import { prepareContentBundle } from "@okouai/core/content-bundle";
import { applyPendingMigrations } from "./migration-runner";

// The release migration is the entry point; every database is fixture-owned.
const connection = process.env.DATABASE_URL;
assert.ok(connection, "Disposable local DATABASE_URL required");
assert.ok(
  ["localhost", "127.0.0.1", "postgres"].includes(new URL(connection).hostname),
);
const admin = postgres(connection, { max: 1, onnotice: () => {} });
const journal = object({
  entries: array(object({ tag: string(), when: number() })),
}).parse(
  JSON.parse(
    await readFile(
      new URL("../src/migrations/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ),
);
const migration = journal.entries.find((entry) => {
  return entry.tag === "1567_copy_inactive_single_agent_pilot";
});
assert.ok(migration);
const migrationSql = await readFile(
  new URL(`../src/migrations/${migration.tag}.sql`, import.meta.url),
  "utf8",
);
const cohort = array(
  object({ org: string(), user: string(), target: uuid(), source: uuid() }),
)
  .length(3)
  .parse(
    Array.from(
      migrationSql.matchAll(
        /\('(org_[^']+)', '(user_[^']+)', '([^']+)', '([^']+)'\)/gu,
      ),
      (match) => {
        return {
          org: match[1],
          user: match[2],
          target: match[3],
          source: match[4],
        };
      },
    ),
  );
const projectId = (org: string, user: string, source: string) => {
  const hash = createHash("md5")
    .update(`inactive-single-agent-project-v1:${org}:${user}:${source}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
};
const seed = await prepareContentBundle([
  { path: "instructions.md", content: Buffer.from("default seed") },
]);
const source = await prepareContentBundle([
  { path: "instructions.md", content: Buffer.from("legacy authored content") },
]);
const empty = await prepareContentBundle([
  { path: "instructions.md", content: Buffer.alloc(0) },
]);

try {
  for (const excluded of [false, true]) {
    const database = `inactive_pilot_${randomUUID().replaceAll("-", "")}`;
    const address = new URL(connection);
    address.pathname = `/${database}`;
    const sql = postgres(address.toString(), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${database}"`);
      await applyPendingMigrations(sql, { beforeMillis: migration.when });
      const chats: string[] = [];
      for (const [index, member] of cohort.entries()) {
        await sql`INSERT INTO agents(id,org_id,owner,name,display_name,visibility,instructions,instructions_bundle)
          VALUES(${member.target},${member.org},${member.user},'okou','Okou','public','default seed',${sql.json(seed.descriptor)}),
            (${member.source},${member.org},${member.user},'legacy','Legacy','public','legacy authored content',${sql.json(source.descriptor)})`;
        await sql`INSERT INTO org_metadata(org_id,default_agent_id,created_at)
          VALUES(${member.org},${member.target},now()-interval '60 days')`;
        await sql`INSERT INTO org_members_metadata(org_id,user_id,created_at)
          VALUES(${member.org},${member.user},now()-interval '60 days')`;
        await sql`INSERT INTO org_members_cache(org_id,user_id,role) VALUES(${member.org},${member.user},'admin')`;
        await sql`INSERT INTO user_feature_switches(org_id,user_id,switches)
          VALUES(${member.org},${member.user},'{"singleAgent":false,"featureGuides":false,"otherFlag":true}')`;
        const chat = randomUUID();
        chats.push(chat);
        await sql`INSERT INTO chat_threads(id,user_id,agent_id,title,framework,framework_session_id,
          created_at,updated_at,last_message_at,last_read_at)
          VALUES(${chat},${member.user},${member.source},'retained title','codex',${`session-${index}`},
            now()-interval '60 days',now()-interval '60 days',now()-interval '60 days',now()-interval '60 days')`;
        if (index < 2) {
          await sql`INSERT INTO instructions(org_id,user_id,content,bundle)
            VALUES(${member.org},${member.user},'',${sql.json(empty.descriptor)})`;
        }
        await sql`INSERT INTO agent_runs(id,org_id,user_id,agent_id,chat_thread_id,status,prompt,
          trigger_source,autonomy_budget,created_at)
          VALUES(${randomUUID()},${member.org},${member.user},${member.source},${chat},
            'completed','retained history','web',0,now()-interval '60 days')`;
        if (excluded) {
          // Failed manual and completed scheduled Runs both count as activity;
          // an old pending Run must block even outside the 30-day window.
          await sql`INSERT INTO agent_runs(id,org_id,user_id,agent_id,status,prompt,trigger_source,autonomy_budget,created_at)
            VALUES(${randomUUID()},${member.org},${member.user},${member.source},
              ${index === 0 ? "failed" : index === 1 ? "completed" : "pending"},'activity',
              ${index === 1 ? "automation-schedule" : "web"},0,
              ${new Date(Date.now() - (index === 0 ? 30 * 86400000 - 3600000 : (index === 2 ? 60 : 1) * 86400000))})`;
        }
      }
      const foreignOrg = `foreign-${randomUUID()}`;
      await sql`INSERT INTO user_feature_switches(org_id,user_id,switches)
        VALUES(${foreignOrg},'foreign','{"singleAgent":false}')`;
      const preserved = async () => {
        return JSON.stringify([
          Array.from(await sql`SELECT * FROM agents ORDER BY id`),
          Array.from(await sql`SELECT * FROM agent_runs ORDER BY id`),
          Array.from(
            await sql`SELECT to_jsonb(c)-'agent_id'-'project_id'-'updated_at' AS value FROM chat_threads c ORDER BY id`,
          ),
          Array.from(
            await sql`SELECT * FROM feature_guide_editions ORDER BY id`,
          ),
          Array.from(
            await sql`SELECT * FROM user_feature_switches WHERE org_id=${foreignOrg}`,
          ),
        ]);
      };
      const before = await preserved();
      // Exercise UTC-without-zone activity timestamps under a non-UTC session.
      await sql.unsafe("SET TIME ZONE 'Asia/Shanghai'");
      if (!excluded) {
        const member = cohort[0];
        assert.ok(member);
        const collision = projectId(member.org, member.user, member.source);
        await sql`INSERT INTO projects(id,org_id,user_id,name) VALUES(${collision},${foreignOrg},'foreign','collision')`;
        const frontier =
          await sql`SELECT max(created_at)::text AS value FROM drizzle.__drizzle_migrations`;
        await assert.rejects(
          applyPendingMigrations(sql, { beforeMillis: migration.when + 1 }),
          /Inactive pilot Project identity belongs/u,
        );
        assert.equal(await preserved(), before);
        assert.deepEqual(
          await sql`SELECT max(created_at)::text AS value FROM drizzle.__drizzle_migrations`,
          frontier,
        );
        assert.equal(
          (await sql`SELECT count(*)::int AS n FROM workflows`)[0]?.n,
          0,
        );
        assert.equal(
          (await sql`SELECT count(*)::int AS n FROM project_events`)[0]?.n,
          0,
        );
        await sql`DELETE FROM projects WHERE id=${collision}`;
      }
      await applyPendingMigrations(sql, { beforeMillis: migration.when + 1 });
      assert.equal(await preserved(), before);
      for (const [index, member] of cohort.entries()) {
        const chatId = chats[index];
        assert.ok(chatId);
        const flag = (
          await sql`SELECT switches FROM user_feature_switches WHERE org_id=${member.org} AND user_id=${member.user}`
        )[0];
        assert.deepEqual(flag?.switches, {
          singleAgent: !excluded,
          featureGuides: false,
          otherFlag: true,
        });
        const chat = (
          await sql`SELECT agent_id,project_id FROM chat_threads WHERE id=${chatId}`
        )[0];
        assert.equal(chat?.agent_id, excluded ? member.source : member.target);
        if (excluded) {
          assert.equal(chat?.project_id, null);
        } else {
          assert.equal(
            chat?.project_id,
            projectId(member.org, member.user, member.source),
          );
          const workflow = (
            await sql`SELECT * FROM workflows WHERE org_id=${member.org}`
          )[0];
          assert.equal(workflow?.name, "legacy--instruction");
          assert.equal(workflow?.owner_user_id, member.user);
          assert.equal(workflow?.instruction, "legacy authored content");
          assert.deepEqual(workflow?.content_bundle, source.descriptor);
          assert.deepEqual(workflow?.attachments, { kind: "empty" });
          const personal = (
            await sql`SELECT content,bundle FROM instructions WHERE org_id=${member.org} AND user_id=${member.user}`
          )[0];
          assert.equal(personal?.content, index < 2 ? "" : "default seed");
          assert.deepEqual(
            personal?.bundle,
            index < 2 ? empty.descriptor : seed.descriptor,
          );
        }
      }
      assert.equal(
        (await sql`SELECT count(*)::int AS n FROM workflows`)[0]?.n,
        excluded ? 0 : 3,
      );
      assert.equal(
        (await sql`SELECT count(*)::int AS n FROM projects`)[0]?.n,
        excluded ? 0 : 3,
      );
      assert.deepEqual(
        Array.from(
          await sql`SELECT kind, count(*)::int AS n FROM project_events GROUP BY kind ORDER BY kind::text`,
        ),
        excluded
          ? []
          : [
              { kind: "created", n: 3 },
              { kind: "sort_updated", n: 3 },
            ],
      );
      assert.equal(
        (await sql`SELECT count(*)::int AS n FROM chat_thread_events`)[0]?.n,
        excluded ? 0 : 6,
      );
      const after = JSON.stringify([
        Array.from(await sql`SELECT * FROM workflows ORDER BY id`),
        Array.from(await sql`SELECT * FROM projects ORDER BY id`),
        Array.from(await sql`SELECT * FROM project_events ORDER BY id`),
        Array.from(await sql`SELECT * FROM chat_thread_events ORDER BY id`),
      ]);
      await applyPendingMigrations(sql, { beforeMillis: migration.when + 1 });
      assert.equal(
        JSON.stringify([
          Array.from(await sql`SELECT * FROM workflows ORDER BY id`),
          Array.from(await sql`SELECT * FROM projects ORDER BY id`),
          Array.from(await sql`SELECT * FROM project_events ORDER BY id`),
          Array.from(await sql`SELECT * FROM chat_thread_events ORDER BY id`),
        ]),
        after,
      );
      console.log(
        `Inactive pilot ${excluded ? "activity exclusion" : "copy, atomic rollback and replay"} passed`,
      );
    } finally {
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
  }
} finally {
  await admin.end();
}
