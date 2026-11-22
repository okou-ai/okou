import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

export async function validatePermanentAgentInstructions(
  connectionString: string,
): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const id = randomUUID();
    const orgId = `instruction-invariant-${id}`;
    const created = await client.query(
      "INSERT INTO legacy_agent_api_profiles (id, org_id, owner, name) VALUES ($1, $2, 'instruction-owner', 'test') RETURNING instructions",
      [id, orgId],
    );
    assert.deepEqual(created.rows, [{ instructions: "" }]);
    const body = "\uFEFF  raw instructions\r\n中文\n";
    await client.query(
      "UPDATE legacy_agent_api_profiles SET instructions=$2 WHERE id=$1",
      [id, body],
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT instructions FROM legacy_agent_api_profiles WHERE id=$1",
          [id],
        )
      ).rows,
      [{ instructions: body }],
    );
    await assert.rejects(
      client.query(
        "UPDATE legacy_agent_api_profiles SET instructions=NULL WHERE id=$1",
        [id],
      ),
      { code: "23502" },
    );
    await client.query("DELETE FROM legacy_agent_api_profiles WHERE id=$1", [
      id,
    ]);
  } finally {
    await client.end();
  }
}
