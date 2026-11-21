import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

export async function validateConnectorSkillBundleSchema(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const orgId = `org_${randomUUID()}`;
  const connectorId = randomUUID();
  const source = createHash("sha256").update(randomUUID()).digest("hex");
  const nextSource = createHash("sha256").update(randomUUID()).digest("hex");
  const hash = `sha256:${source}`;
  const bundle = { sha256: "c".repeat(64), archiveBytes: 100 };
  async function readPublication() {
    const result = await client.query(
      `SELECT skill_content_bundle, skill_content_bundle_source_version_id
       FROM org_custom_connector_skill_publications WHERE id=$1 AND org_id=$2`,
      [connectorId, orgId],
    );
    return result.rows;
  }
  try {
    await client.query(
      `INSERT INTO org_custom_connectors
        (id, org_id, slug, display_name, auth_mode, prefix_templates, created_by)
       VALUES ($1, $2, '_schema-connector', 'Schema Connector', 'none',
         '["https://schema.example.test/"]', 'schema-user')`,
      [connectorId, orgId],
    );
    assert.deepEqual(await readPublication(), []);
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
      const markdown =
        table === "org_custom_connectors"
          ? ",skill_markdown=CASE WHEN $2::varchar IS NULL THEN NULL ELSE 'Original Skill' END"
          : "";
      const update = `UPDATE ${table} SET skill_content_bundle=$1,skill_content_bundle_source_version_id=$2${markdown} WHERE ${where}`;
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
    // Historical source IDs are independent of the bundle's content digest.
    assert.deepEqual(await readPublication(), [
      {
        skill_content_bundle: bundle,
        skill_content_bundle_source_version_id: source,
      },
    ]);
    // API 2.100.1 can still dual-write. A later native edit leaves the mirror unchanged.
    await client.query(
      "UPDATE org_custom_connectors SET skill_storage_version_id=$1 WHERE id=$2",
      [source, connectorId],
    );
    await client.query(
      `UPDATE org_custom_connectors SET skill_markdown='New Skill', skill_content_bundle_source_version_id=$1
       WHERE id=$2`,
      [nextSource, connectorId],
    );
    assert.deepEqual(await readPublication(), [
      {
        skill_content_bundle: bundle,
        skill_content_bundle_source_version_id: nextSource,
      },
    ]);
    await assert.rejects(
      client.query(
        "UPDATE org_custom_connectors SET skill_markdown=NULL WHERE id=$1",
        [connectorId],
      ),
      {
        code: "23514",
        constraint: "chk_org_custom_connectors_skill_publication_pair",
      },
    );
    await assert.rejects(
      client.query(
        "UPDATE org_custom_connectors SET skill_content_bundle=NULL, skill_content_bundle_source_version_id=NULL WHERE id=$1",
        [connectorId],
      ),
      {
        code: "23514",
        constraint: "chk_org_custom_connectors_skill_publication_pair",
      },
    );
    await client.query(
      `UPDATE org_custom_connectors SET skill_markdown=NULL, skill_content_bundle=NULL,
       skill_content_bundle_source_version_id=NULL WHERE id=$1`,
      [connectorId],
    );
    assert.deepEqual(await readPublication(), []);
    const retained = await client.query(
      "SELECT skill_storage_version_id FROM org_custom_connectors WHERE id=$1",
      [connectorId],
    );
    assert.deepEqual(retained.rows, [{ skill_storage_version_id: source }]);
  } finally {
    await client.query("DELETE FROM connector_catalog_entries WHERE hash=$1", [
      hash,
    ]);
    await client.query("DELETE FROM org_custom_connectors WHERE id=$1", [
      connectorId,
    ]);
    await client.end();
  }
  console.log(
    "Connector Skill bundle constraints and native publication selection passed",
  );
}
