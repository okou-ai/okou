import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareWorkflowAttachmentBundle } from "@okouai/core/workflow-attachment-bundle";
import postgres from "postgres";

/** Validate the installed deletion function on replayed and fresh schemas. */
export async function validateInactiveWorkflowAttachmentDeletion(
  databaseUrl: string,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  const orgId = `inactive-attachments-${randomUUID()}`;
  const sourceId = "81234567-49ab-4ef0-b234-56789abcdef0";
  // Stable ID assigned by the inactive batch migration for this source.
  const copyId = "1cf8de92-33c5-5a65-841e-5abfa45c3b6d";
  const { descriptor } = await prepareWorkflowAttachmentBundle(
    orgId,
    sourceId,
    [{ path: "reference.txt", content: Buffer.from("source attachment") }],
  );
  assert.ok(descriptor.kind === "bundle");
  const foreignDescriptor = {
    ...descriptor,
    objectKey: descriptor.objectKey.replace(orgId, "org_other"),
  };

  const deleteWorkflow = async (workflowId: string) => {
    const [row] = await sql`
      SELECT public.delete_workflow_rows(
        ${orgId}, ${workflowId}, false, NULL
      )->>'deleted' AS deleted
    `;
    return row?.deleted;
  };

  try {
    await sql`
      INSERT INTO workflows (id, org_id, name, owner_user_id,
        created_by, updated_by, attachments)
      VALUES
        (${sourceId}, ${orgId}, 'original', 'owner',
          'owner', 'owner', ${sql.json(descriptor)}),
        (${copyId}, ${orgId}, 'legacy--wf-original', 'owner',
          'owner', 'owner', ${sql.json(foreignDescriptor)})
    `;
    await assert.rejects(deleteWorkflow(copyId), {
      code: "P0001",
      constraint_name: "workflow_deletion_attachment_owner",
    });
    const [invalidCopy] = await sql`
      SELECT attachments FROM workflows WHERE org_id = ${orgId} AND id = ${copyId}
    `;
    assert.deepEqual(invalidCopy?.attachments, foreignDescriptor);

    await sql`
      UPDATE workflows SET attachments = ${sql.json(descriptor)}
      WHERE org_id = ${orgId} AND id = ${copyId}
    `;
    assert.equal(await deleteWorkflow(copyId), "true");
    const remaining = await sql`
      SELECT id, attachments FROM workflows WHERE org_id = ${orgId}
    `;
    assert.deepEqual(Array.from(remaining), [
      { id: sourceId, attachments: descriptor },
    ]);
    assert.equal(
      (await sql`SELECT id FROM background_jobs WHERE org_id = ${orgId}`)
        .length,
      0,
    );

    assert.equal(await deleteWorkflow(sourceId), "true");
    const jobs = await sql`
      SELECT kind, input FROM background_jobs WHERE org_id = ${orgId}
    `;
    assert.deepEqual(Array.from(jobs), [
      {
        kind: "workflow-attachment-cleanup",
        input: { workflowId: sourceId, objectKey: descriptor.objectKey },
      },
    ]);
  } finally {
    try {
      await sql`DELETE FROM background_jobs WHERE org_id = ${orgId}`;
    } finally {
      await sql.end();
    }
  }
}
