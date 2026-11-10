import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { array, number, object, string } from "zod";
import { applyPendingMigrations } from "./migration-runner";

/** Exercise contraction, retained business data and atomic dependency rejection. */
export async function validateWorkflowPublicationContraction(
  databaseUrl: string,
): Promise<void> {
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
  const contraction = journal.entries.find((entry) => {
    return entry.tag === "1539_drop_workflow_publication_fence";
  });
  assert.ok(contraction);
  const name = `workflow_publication_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const admin = postgres(databaseUrl, { max: 1 });
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const sql = postgres(url.toString(), { max: 1 });
    try {
      await applyPendingMigrations(sql, { beforeMillis: contraction.when });
      const agentId = randomUUID();
      const workflowId = randomUUID();
      await sql`
        INSERT INTO agents (id, org_id, owner, name, visibility)
        VALUES (${agentId}, 'c11-org', 'c11-owner', 'c11-agent', 'private')
      `;
      await sql`
        INSERT INTO workflows (id, org_id, agent_id, name, owner_user_id, created_by, updated_by, instruction)
        VALUES (${workflowId}, 'c11-org', ${agentId}, 'c11-workflow', 'c11-owner', 'c11-owner', 'c11-owner', 'Retain this instruction')
      `;
      await sql`
        INSERT INTO storage_publication_generations (org_id, agent_id, subject)
        VALUES ('c11-org', ${agentId}, 'c11-owner')
      `;
      await sql`
        INSERT INTO storage_publication_tokens
          (org_id, agent_id, subject, publication_key, generation, token)
        VALUES ('c11-org', ${agentId}, 'c11-owner', ${`workflow:${workflowId}`}, 1, ${randomUUID()})
      `;
      const businessState = async () => {
        return JSON.stringify([
          Array.from(await sql`SELECT * FROM agents ORDER BY id`),
          Array.from(await sql`SELECT * FROM workflows ORDER BY id`),
        ]);
      };
      const state = async () => {
        return JSON.stringify([
          await businessState(),
          Array.from(await sql`SELECT * FROM storage_publication_generations`),
          Array.from(await sql`SELECT * FROM storage_publication_tokens`),
          Array.from(
            await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
          ),
        ]);
      };
      for (const scenario of ["foreign-protocol", "owned-index", "view"]) {
        if (scenario === "foreign-protocol")
          await sql`UPDATE storage_publication_tokens SET publication_key = 'other:retained'`;
        if (scenario === "owned-index")
          await sql`CREATE INDEX c11_consumer ON storage_publication_generations (updated_at)`;
        if (scenario === "view")
          await sql`CREATE VIEW c11_consumer AS SELECT * FROM storage_publication_generations`;
        const before = await state();
        await assert.rejects(
          applyPendingMigrations(sql, { beforeMillis: contraction.when + 1 }),
          scenario === "view"
            ? { code: "2BP01" }
            : scenario === "foreign-protocol"
              ? /retained publication state belongs to another protocol/u
              : /unexpected owned object on publication storage/u,
        );
        // A view blocks the second DROP; the first DROP and journal must roll back.
        assert.equal(await state(), before, scenario);
        if (scenario === "foreign-protocol")
          await sql`UPDATE storage_publication_tokens SET publication_key = ${`workflow:${workflowId}`}`;
        if (scenario === "owned-index") await sql`DROP INDEX c11_consumer`;
        if (scenario === "view") await sql`DROP VIEW c11_consumer`;
      }
      const before = await businessState();
      await applyPendingMigrations(sql, { beforeMillis: contraction.when + 1 });
      assert.equal(await businessState(), before);
      await applyPendingMigrations(sql, { beforeMillis: contraction.when + 1 });
      assert.equal(await businessState(), before);
      assert.deepEqual(
        Array.from(
          await sql`SELECT delete_workflow_rows('c11-org', ${workflowId}, false, NULL)->>'deleted' AS deleted`,
        ),
        [{ deleted: "true" }],
      );
      assert.deepEqual(
        Array.from(
          await sql`SELECT delete_agent_rows(${agentId}, 'c11-org', 'c11-owner', false)->>'kind' AS kind`,
        ),
        [{ kind: "deleted" }],
      );
      console.log(
        "Workflow publication contraction, atomic rejection and deletion checks passed",
      );
    } finally {
      await sql.end();
    }
  } finally {
    try {
      if (created) await admin.unsafe(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  }
}
