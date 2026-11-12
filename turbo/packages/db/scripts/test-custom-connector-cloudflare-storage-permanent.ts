import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Permanent ownership and dependency invariants, on replayed and fresh schemas. */
export async function validateCustomConnectorCloudflareStorage(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const org = `cloudflare-binding-${randomUUID()}`;
  const foreignOrg = `${org}-other`;
  const config = randomUUID();
  const personal = randomUUID();
  const foreign = randomUUID();
  const http = randomUUID();
  const mcp = randomUUID();
  const spare = randomUUID();
  try {
    for (const [id, owner, scope] of [
      [config, org, "organization"],
      [personal, org, "personal"],
      [foreign, foreignOrg, "organization"],
    ]) {
      await client.query(
        `INSERT INTO cloudflare_access_configs
        (id,org_id,user_id,scope,name,encrypted_client_id,encrypted_client_secret)
        VALUES ($1,$2,$3,$4,'Fixture network','encrypted-fixture-id','encrypted-fixture-secret')`,
        [id, owner, scope === "personal" ? org : null, scope],
      );
    }
    for (const id of [http, spare]) {
      await client.query(
        `INSERT INTO org_custom_connectors
        (id,org_id,slug,display_name,auth_mode,prefix_templates,created_by)
        VALUES ($1,$2,$3,'Fixture HTTP','none','["https://api.example.com/"]',$2)`,
        [id, org, `_${id}`],
      );
    }
    await client.query(
      `INSERT INTO org_custom_connectors
      (id,org_id,slug,display_name,auth_mode,mcp_endpoint,mcp_transport,created_by)
      VALUES ($1,$2,$3,'Fixture MCP','none','https://api.example.com/mcp','streamable-http',$2)`,
      [mcp, org, `_${mcp}`],
    );
    const insert = `INSERT INTO org_custom_connector_cloudflare_bindings
      (connector_id,org_id,config_id) VALUES ($1,$2,$3)`;
    await assert.rejects(client.query(insert, [spare, org, personal]), {
      constraint: "fk_custom_connector_cloudflare_config",
    });
    await assert.rejects(client.query(insert, [spare, org, foreign]), {
      constraint: "fk_custom_connector_cloudflare_config",
    });
    await assert.rejects(client.query(insert, [spare, foreignOrg, foreign]), {
      constraint: "fk_custom_connector_cloudflare_connector",
    });
    await client.query(insert, [http, org, config]);
    await client.query(insert, [mcp, org, config]);
    await assert.rejects(client.query(insert, [http, org, config]), {
      code: "23505",
    });
    await assert.rejects(
      client.query("DELETE FROM cloudflare_access_configs WHERE id=$1", [
        config,
      ]),
      { constraint: "fk_custom_connector_cloudflare_config" },
    );
    await assert.rejects(
      client.query(
        "UPDATE cloudflare_access_configs SET scope='personal',user_id=$2 WHERE id=$1",
        [config, org],
      ),
      { constraint: "fk_custom_connector_cloudflare_config" },
    );
    // Credential rotation and an outgoing connector edit preserve the association.
    await client.query(
      "UPDATE cloudflare_access_configs SET encrypted_client_secret='rotated-fixture',generation=generation+1 WHERE id=$1",
      [config],
    );
    await client.query(
      "UPDATE org_custom_connectors SET display_name='Renamed HTTP' WHERE id=$1 RETURNING id,org_id,display_name,storage_version",
      [http],
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM org_custom_connector_cloudflare_bindings WHERE config_id=$1",
          [config],
        )
      ).rows[0].count,
      2,
    );
    await client.query("DELETE FROM org_custom_connectors WHERE id=$1", [http]);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM org_custom_connector_cloudflare_bindings WHERE config_id=$1",
          [config],
        )
      ).rows[0].count,
      1,
    );
    await assert.rejects(
      client.query("DELETE FROM cloudflare_access_configs WHERE id=$1", [
        config,
      ]),
      { constraint: "fk_custom_connector_cloudflare_config" },
    );
    await client.query("DELETE FROM org_custom_connectors WHERE id=$1", [mcp]);
    await client.query(
      "UPDATE cloudflare_access_configs SET scope='personal',user_id=$2 WHERE id=$1",
      [config, org],
    );
    await client.query("DELETE FROM cloudflare_access_configs WHERE id=$1", [
      config,
    ]);
    const competitor = new Client({ connectionString: databaseUrl });
    await competitor.connect();
    try {
      for (const operation of ["delete", "convert"]) {
        const racingConfig = randomUUID();
        await client.query(
          `INSERT INTO cloudflare_access_configs
            (id,org_id,scope,name,encrypted_client_id,encrypted_client_secret)
            VALUES ($1,$2,'organization','Racing network','fixture-id','fixture-secret')`,
          [racingConfig, org],
        );
        const [bound, changed] = await Promise.allSettled([
          client.query(insert, [spare, org, racingConfig]),
          competitor.query(
            operation === "delete"
              ? "DELETE FROM cloudflare_access_configs WHERE id=$1"
              : "UPDATE cloudflare_access_configs SET scope='personal',user_id=$2 WHERE id=$1",
            operation === "delete" ? [racingConfig] : [racingConfig, org],
          ),
        ]);
        if (bound.status === "fulfilled") {
          assert.equal(changed.status, "rejected");
          if (changed.status === "rejected") {
            assert.equal(
              changed.reason.constraint,
              "fk_custom_connector_cloudflare_config",
            );
            // PostgreSQL versions and the winning FK check can report either
            // referential code; the named constraint and persisted state own the invariant.
            assert.ok(["23503", "23001"].includes(changed.reason.code));
          }
          assert.equal(
            (
              await client.query(
                "SELECT scope FROM cloudflare_access_configs WHERE id=$1",
                [racingConfig],
              )
            ).rows[0].scope,
            "organization",
          );
          await client.query(
            "DELETE FROM org_custom_connector_cloudflare_bindings WHERE connector_id=$1",
            [spare],
          );
        } else {
          assert.equal(changed.status, "fulfilled");
          assert.equal(
            bound.reason.constraint,
            "fk_custom_connector_cloudflare_config",
          );
        }
      }
    } finally {
      await competitor.end();
    }
  } finally {
    await client.query("DELETE FROM org_custom_connectors WHERE org_id=$1", [
      org,
    ]);
    await client.query(
      "DELETE FROM cloudflare_access_configs WHERE org_id IN ($1,$2)",
      [org, foreignOrg],
    );
    await client.end();
  }
}
