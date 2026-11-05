import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

export async function validateConnectorSkillBundleSchema(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const orgId = `org_${randomUUID()}`;
  const storageId = randomUUID();
  const connectorId = randomUUID();
  const source = createHash("sha256").update(randomUUID()).digest("hex");
  const nextSource = createHash("sha256").update(randomUUID()).digest("hex");
  const hash = `sha256:${source}`;
  const bundle = { sha256: "c".repeat(64), archiveBytes: 100 };
  try {
    const constraints = await client.query(`SELECT conname, convalidated
      FROM pg_constraint WHERE conname IN (
        'connector_catalog_entries_skill_content_bundle_check',
        'org_custom_connectors_skill_content_bundle_check'
      ) ORDER BY conname`);
    assert.deepEqual(constraints.rows, [
      {
        conname: "connector_catalog_entries_skill_content_bundle_check",
        convalidated: true,
      },
      {
        conname: "org_custom_connectors_skill_content_bundle_check",
        convalidated: true,
      },
    ]);
    await client.query(
      "INSERT INTO storages(id,user_id,org_id,name,s3_prefix) VALUES($1,'schema-user',$2,'schema-connector',$3)",
      [storageId, orgId, `${orgId}/schema`],
    );
    for (const id of [source, nextSource]) {
      await client.query(
        "INSERT INTO storage_versions(id,storage_id,s3_key,size,archive_size,file_count,created_by) VALUES($1,$2,$3,10,100,1,'schema-user')",
        [id, storageId, `${orgId}/schema/${id}`],
      );
    }
    // An INSERT using only legacy columns leaves preparation unpopulated.
    await client.query(
      `INSERT INTO org_custom_connectors(id,org_id,slug,display_name,auth_mode,prefix_templates,fields,header_injections,query_injections,skill_markdown,skill_storage_version_id,created_by)
      VALUES($1,$2,'_schema-connector','Schema Connector','none','["https://schema.example.test/"]','[]','[]','[]','Original Skill',$3,'schema-user')`,
      [connectorId, orgId, source],
    );
    await client.query(
      `INSERT INTO connector_catalog_entries(hash,slug,label,description,category,icon,tags,generation,auth_methods,mcp,skill,firewall,permission_summary)
      VALUES($1,'schema-connector','Schema','Schema','testing','{}','{}','{}','[]',NULL,$2,'{"kind":"none"}','{}')`,
      [
        hash,
        {
          kind: "bundled",
          versionId: source,
          archiveSize: 100,
          storageName: "connector-skill@schema",
          storageVersionPrefix: `__system__/volume/connector-skill@schema/${source}`,
          size: 10,
          fileCount: 1,
        },
      ],
    );
    for (const table of [
      "org_custom_connectors",
      "connector_catalog_entries",
    ] as const) {
      const where = table === "org_custom_connectors" ? "id=$3" : "hash=$3";
      const id = table === "org_custom_connectors" ? connectorId : hash;
      const update = `UPDATE ${table} SET skill_content_bundle=$1,skill_content_bundle_source_version_id=$2 WHERE ${where}`;
      const initial = await client.query(
        `SELECT skill_content_bundle,skill_content_bundle_source_version_id FROM ${table} WHERE ${table === "org_custom_connectors" ? "id=$1" : "hash=$1"}`,
        [id],
      );
      assert.deepEqual(initial.rows, [
        {
          skill_content_bundle: null,
          skill_content_bundle_source_version_id: null,
        },
      ]);
      await client.query(update, [bundle, source, id]);
      for (const [descriptor, version] of [
        [undefined, source],
        [null, source],
        [bundle, null],
        [bundle, "invalid"],
        [{ archiveBytes: 100 }, source],
        [{ ...bundle, extra: true }, source],
        [{ ...bundle, sha256: null }, source],
        [{ ...bundle, sha256: "invalid" }, source],
        ...[0, 1.5, 33554433, "100", null].map((archiveBytes) => {
          return [{ ...bundle, archiveBytes }, source];
        }),
      ]) {
        await assert.rejects(
          client.query(update, [
            descriptor === undefined ? null : JSON.stringify(descriptor),
            version,
            id,
          ]),
          (error: unknown) => {
            return (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "23514" &&
              "constraint" in error &&
              error.constraint === `${table}_skill_content_bundle_check`
            );
          },
        );
      }
    }
    await assert.rejects(
      client.query(
        "UPDATE connector_catalog_entries SET skill_content_bundle_source_version_id=$1 WHERE hash=$2",
        [nextSource, hash],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      client.query(
        "UPDATE connector_catalog_entries SET skill=$1 WHERE hash=$2",
        [{ kind: "none" }, hash],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      client.query(
        "UPDATE connector_catalog_entries SET skill='{}' WHERE hash=$1",
        [hash],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      client.query(
        "UPDATE connector_catalog_entries SET skill_content_bundle=$1 WHERE hash=$2",
        [{ ...bundle, archiveBytes: 101 }, hash],
      ),
      { code: "23514" },
    );
    // The preceding writer can edit or remove a Skill without knowing the new
    // columns. Its stale reference remains detectable by source identity.
    await client.query(
      "UPDATE org_custom_connectors SET skill_markdown='New Skill',skill_storage_version_id=$1,updated_at=now() WHERE id=$2",
      [nextSource, connectorId],
    );
    const stale = await client.query(
      "SELECT skill_storage_version_id,skill_content_bundle,skill_content_bundle_source_version_id FROM org_custom_connectors WHERE id=$1",
      [connectorId],
    );
    assert.deepEqual(stale.rows, [
      {
        skill_storage_version_id: nextSource,
        skill_content_bundle: bundle,
        skill_content_bundle_source_version_id: source,
      },
    ]);
    await client.query(
      "UPDATE org_custom_connectors SET skill_markdown=NULL,skill_storage_version_id=NULL WHERE id=$1",
      [connectorId],
    );
    await client.query(
      "UPDATE org_custom_connectors SET skill_content_bundle=NULL,skill_content_bundle_source_version_id=NULL WHERE id=$1",
      [connectorId],
    );
  } finally {
    await client.query("DELETE FROM connector_catalog_entries WHERE hash=$1", [
      hash,
    ]);
    await client.query("DELETE FROM org_custom_connectors WHERE id=$1", [
      connectorId,
    ]);
    await client.query("DELETE FROM storage_versions WHERE storage_id=$1", [
      storageId,
    ]);
    await client.query("DELETE FROM storages WHERE id=$1", [storageId]);
    await client.end();
  }
  console.log(
    "Connector Skill bundle constraints and outgoing writer compatibility passed",
  );
}
