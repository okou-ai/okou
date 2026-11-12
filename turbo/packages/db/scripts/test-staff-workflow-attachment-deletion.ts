import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { array, number, object, string } from "zod";
import {
  STAFF_SINGLE_AGENT_ORG_ID,
  staffWorkflowCopyId,
} from "@okouai/core/staff-single-agent-migration";
import { prepareWorkflowAttachmentBundle } from "@okouai/core/workflow-attachment-bundle";
import { applyPendingMigrations } from "./migration-runner";

/** Exercise the actual migration and persisted deletion consumer, without R2 I/O. */
export async function validateStaffWorkflowAttachmentDeletion(
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
  const migration = journal.entries.find((entry) => {
    return entry.tag === "1546_staff_workflow_attachment_deletion";
  });
  assert.ok(migration);
  const databaseName = `staff_deletion_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  const admin = postgres(databaseUrl, { max: 1 });
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const sql = postgres(url.toString(), { max: 1 });
    try {
      await applyPendingMigrations(sql, { beforeMillis: migration.when });
      const orgId = STAFF_SINGLE_AGENT_ORG_ID;
      const owner = "staff-deletion-owner";
      const sourceAgent = randomUUID();
      const targetAgent = randomUUID();
      const sourceId = randomUUID();
      const copyId = staffWorkflowCopyId(sourceId);
      const automationId = randomUUID();
      const bundle = await prepareWorkflowAttachmentBundle(orgId, sourceId, [
        { path: "reference.txt", content: Buffer.from("retained source") },
      ]);
      const descriptor = bundle.descriptor;
      assert.ok(descriptor.kind === "bundle");
      await sql`
        INSERT INTO agents (id, org_id, owner, name, visibility) VALUES
        (${sourceAgent}, ${orgId}, ${owner}, 'source', 'private'),
        (${targetAgent}, ${orgId}, ${owner}, 'target', 'public')
      `;
      await sql`
        INSERT INTO workflows (id, org_id, agent_id, name, owner_user_id, created_by, updated_by, instruction, attachments)
        VALUES (${sourceId}, ${orgId}, ${sourceAgent}, 'original', ${owner}, ${owner}, ${owner}, 'source body', ${sql.json(descriptor)})
      `;
      // The cutover copies the descriptor unchanged under a deterministic new ID.
      await sql`
        INSERT INTO workflows (id, org_id, agent_id, name, owner_user_id, created_by, updated_by, instruction, attachments)
        SELECT ${copyId}, org_id, ${targetAgent}, 'source--wf-original', owner_user_id, created_by, updated_by, instruction, attachments
        FROM workflows WHERE id = ${sourceId}
      `;
      await sql`
        INSERT INTO workflow_automations (id, org_id, workflow_id, owner_user_id, kind, schedule_type, interval_seconds)
        VALUES (${automationId}, ${orgId}, ${copyId}, ${owner}, 'schedule', 'loop', 900)
      `;
      const state = async () => {
        return JSON.stringify([
          Array.from(await sql`SELECT * FROM workflows ORDER BY id`),
          Array.from(await sql`SELECT * FROM workflow_automations ORDER BY id`),
          Array.from(await sql`SELECT * FROM background_jobs ORDER BY id`),
        ]);
      };
      const before = await state();
      await assert.rejects(
        sql`SELECT delete_workflow_rows(${orgId}, ${copyId}, false, NULL)`,
        {
          code: "P0001",
          constraint_name: "workflow_deletion_attachment_owner",
        },
      );
      assert.equal(await state(), before);
      await applyPendingMigrations(sql, { beforeMillis: migration.when + 1 });
      assert.equal(await state(), before);
      await applyPendingMigrations(sql, { beforeMillis: migration.when + 1 });
      assert.equal(await state(), before);
      assert.deepEqual(
        Array.from(
          await sql`SELECT delete_workflow_rows(${orgId}, ${copyId}, false, NULL)->>'deleted' AS deleted`,
        ),
        [{ deleted: "true" }],
      );
      assert.equal(
        (await sql`SELECT id FROM workflows WHERE id = ${copyId}`).length,
        0,
      );
      assert.equal(
        (
          await sql`SELECT id FROM workflow_automations WHERE id = ${automationId}`
        ).length,
        0,
      );
      assert.deepEqual(
        Array.from(
          await sql`SELECT attachments FROM workflows WHERE id = ${sourceId}`,
        ),
        [{ attachments: descriptor }],
      );
      assert.equal((await sql`SELECT id FROM background_jobs`).length, 0);

      // Keep rejecting foreign ownership: neither an unrelated staff ID nor the
      // deterministic ID in another org may adopt the source upload.
      for (const scenario of ["unrelated-staff", "foreign-org"] as const) {
        const foreignOrg =
          scenario === "foreign-org" ? `foreign-${randomUUID()}` : orgId;
        const foreignSource = randomUUID();
        const id =
          scenario === "foreign-org"
            ? staffWorkflowCopyId(foreignSource)
            : randomUUID();
        const agentId = randomUUID();
        const attachments = await prepareWorkflowAttachmentBundle(
          foreignOrg,
          foreignSource,
          [{ path: "reference.txt", content: Buffer.from("foreign source") }],
        );
        await sql`INSERT INTO agents (id, org_id, owner, name, visibility)
          VALUES (${agentId}, ${foreignOrg}, ${owner}, ${scenario}, 'private')`;
        await sql`INSERT INTO workflows (id, org_id, agent_id, name, owner_user_id, created_by, updated_by, attachments)
          VALUES (${id}, ${foreignOrg}, ${agentId}, ${scenario}, ${owner}, ${owner}, ${owner}, ${sql.json(attachments.descriptor)})`;
        const retained = await state();
        await assert.rejects(
          sql`SELECT delete_workflow_rows(${foreignOrg}, ${id}, false, NULL)`,
          {
            code: "P0001",
            constraint_name: "workflow_deletion_attachment_owner",
          },
        );
        assert.equal(await state(), retained);
      }

      // Deleting the actual source still retires only its own upload.
      assert.deepEqual(
        Array.from(
          await sql`SELECT delete_workflow_rows(${orgId}, ${sourceId}, false, NULL)->>'deleted' AS deleted`,
        ),
        [{ deleted: "true" }],
      );
      assert.deepEqual(
        Array.from(
          await sql`SELECT input FROM background_jobs WHERE kind = 'workflow-attachment-cleanup'`,
        ),
        [
          {
            input: {
              workflowId: sourceId,
              objectKey: descriptor.objectKey,
            },
          },
        ],
      );
      console.log(
        "Staff inherited attachment deletion, source retention, fail-closed ownership and migration retry passed",
      );
    } finally {
      await sql.end();
    }
  } finally {
    try {
      if (created) await admin.unsafe(`DROP DATABASE "${databaseName}"`);
    } finally {
      await admin.end();
    }
  }
}
