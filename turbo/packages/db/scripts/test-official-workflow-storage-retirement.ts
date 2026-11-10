import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, DatabaseError } from "pg";

/** The predecessor API projects only these surviving revision columns. */
const revisionRead = `SELECT definition_name, revision, payload, content_bundle, created_at
  FROM official_workflow_definition_revisions ORDER BY definition_name, revision`;

export async function validateOfficialWorkflowStorageRetirement(
  databaseUrl: string,
): Promise<void> {
  const migration = await readFile(
    new URL(
      "../src/migrations/1535_retire_official_workflow_storage_bindings.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const scenario of [
      "complete",
      "incomplete-source",
      "incomplete-v1-source",
      "incomplete-v1-file",
      "unsupported-source-version",
      "unmaterialized-catalog",
      "workflow-cleanup-candidate",
      "workflow-cleanup-version",
      "dependent-view",
      "dependent-index",
      "dependent-expression-index",
      "dependent-trigger",
      "dependent-check",
    ]) {
      const schema = `official_retirement_${randomUUID().replaceAll("-", "")}`;
      await client.query(`CREATE SCHEMA "${schema}"`);
      try {
        await client.query(`SET search_path TO "${schema}", public`);
        // Frozen preceding schema: legacy-only and dual-bound revisions remain
        // valid source history; live publications already use bundles only.
        await client.query(`
          CREATE TABLE storages (id uuid PRIMARY KEY, user_id text NOT NULL, name text NOT NULL);
          CREATE TABLE storage_versions (id varchar(64) PRIMARY KEY, storage_id uuid REFERENCES storages(id));
          CREATE TABLE official_workflow_definition_revisions (
            definition_name varchar(64) NOT NULL,
            revision varchar(64) NOT NULL,
            payload jsonb NOT NULL,
            storage_name varchar(256),
            storage_id uuid,
            storage_version varchar(64),
            content_bundle jsonb,
            created_at timestamp NOT NULL DEFAULT now(),
            PRIMARY KEY (definition_name, revision),
            CONSTRAINT official_workflow_definition_revisions_storage_id_storages_id_fk
              FOREIGN KEY (storage_id) REFERENCES storages(id),
            CONSTRAINT official_workflow_definition_revisions_storage_version_storage_versions_id_fk
              FOREIGN KEY (storage_version) REFERENCES storage_versions(id),
            CONSTRAINT official_workflow_definition_revision_delivery_check CHECK (
              (storage_name IS NOT NULL AND storage_id IS NOT NULL AND storage_version IS NOT NULL)
              OR (storage_name IS NULL AND storage_id IS NULL AND storage_version IS NULL AND content_bundle IS NOT NULL)
            )
          );
          CREATE TABLE official_workflow_catalog_releases (id varchar(64) PRIMARY KEY, payload jsonb NOT NULL);
          CREATE TABLE official_workflow_catalog_state (authority varchar(32) PRIMARY KEY, accepted_release_id varchar(64) REFERENCES official_workflow_catalog_releases(id));
          CREATE TABLE retained_run_provenance (id uuid PRIMARY KEY, provenance jsonb NOT NULL);
        `);
        const storageId = randomUUID();
        const storageVersion = "b".repeat(64);
        const bundle = { sha256: "c".repeat(64), archiveBytes: 200 };
        const revision = "a".repeat(64);
        await client.query(
          "INSERT INTO storages VALUES ($1,'__org__','official-workflow@fixture')",
          [storageId],
        );
        await client.query("INSERT INTO storage_versions VALUES ($1,$2)", [
          storageVersion,
          storageId,
        ]);
        const fixtures = [
          {
            name: "legacy-only",
            schemaVersion: 2,
            bound: true,
            bundled: false,
          },
          { name: "dual-bound", schemaVersion: 3, bound: true, bundled: true },
          {
            name: "bundle-only",
            schemaVersion: 3,
            bound: false,
            bundled: true,
          },
          {
            name: "historical-v1",
            schemaVersion: 1,
            bound: true,
            bundled: false,
          },
        ];
        const sources = fixtures.map(({ name, schemaVersion }) => {
          return {
            schemaVersion,
            name,
            revision,
            workflow: {
              displayName: name,
              description: name,
              instruction: `# ${name}\nPreserve this source exactly.`,
              files: [
                {
                  path: "reference.txt",
                  content: "unchanged supplementary bytes\n",
                },
              ],
            },
            blueprints:
              schemaVersion === 1
                ? [
                    {
                      key: "daily",
                      parameters: [
                        {
                          key: "timezone",
                          type: "string",
                          format: "timezone",
                          required: true,
                          derivation: { kind: "user-timezone" },
                        },
                      ],
                      desiredState: {
                        kind: "schedule",
                        schedule: {
                          type: "cron",
                          cronExpression: "0 8 * * *",
                          timezone: { parameter: "timezone" },
                        },
                      },
                      runtime: { resultEmail: true },
                    },
                  ]
                : [],
          };
        });
        for (const [index, source] of sources.entries()) {
          const fixture = fixtures[index]!;
          await client.query(
            `INSERT INTO official_workflow_definition_revisions
            (definition_name,revision,payload,storage_name,storage_id,storage_version,content_bundle)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              source.name,
              revision,
              source,
              fixture.bound ? `official-workflow-${source.name}` : null,
              fixture.bound ? storageId : null,
              fixture.bound ? storageVersion : null,
              fixture.bundled ? bundle : null,
            ],
          );
        }
        const catalog = {
          schemaVersion: 4,
          definitions: [
            { name: "bundle-only", revision, contentBundle: bundle },
          ],
        };
        await client.query(
          "INSERT INTO official_workflow_catalog_releases VALUES ($1,$2)",
          ["d".repeat(64), catalog],
        );
        await client.query(
          "INSERT INTO official_workflow_catalog_state VALUES ('official',$1)",
          ["d".repeat(64)],
        );
        const provenance = {
          schemaVersion: 1,
          definitions: [
            {
              name: "legacy-only",
              revision,
              artifact: {
                orgId: "__system__",
                userId: "__org__",
                storageName: "official-workflow-legacy-only",
                storageId,
                storageVersion,
              },
            },
          ],
        };
        await client.query(
          "INSERT INTO retained_run_provenance VALUES ($1,$2)",
          [randomUUID(), provenance],
        );
        if (scenario === "incomplete-source") {
          await client.query(
            "UPDATE official_workflow_definition_revisions SET payload = payload #- '{workflow,instruction}' WHERE definition_name='legacy-only'",
          );
        } else if (scenario === "incomplete-v1-source") {
          await client.query(
            "UPDATE official_workflow_definition_revisions SET payload = payload #- '{workflow,instruction}' WHERE definition_name='historical-v1'",
          );
        } else if (scenario === "incomplete-v1-file") {
          await client.query(
            "UPDATE official_workflow_definition_revisions SET payload = payload #- '{workflow,files,0,content}' WHERE definition_name='historical-v1'",
          );
        } else if (scenario === "unsupported-source-version") {
          await client.query(
            "UPDATE official_workflow_definition_revisions SET payload = jsonb_set(payload, '{schemaVersion}', '4') WHERE definition_name='historical-v1'",
          );
        } else if (scenario === "unmaterialized-catalog") {
          await client.query(
            "UPDATE official_workflow_catalog_releases SET payload=$1",
            [
              {
                ...catalog,
                definitions: [
                  { name: "legacy-only", revision, contentBundle: bundle },
                ],
              },
            ],
          );
        } else if (scenario === "workflow-cleanup-candidate") {
          await client.query("UPDATE storages SET name='custom-skill@fixture'");
        } else if (scenario === "workflow-cleanup-version") {
          const candidateId = randomUUID();
          await client.query(
            "INSERT INTO storages VALUES ($1,'__org__','custom-skill@fixture')",
            [candidateId],
          );
          await client.query("UPDATE storage_versions SET storage_id=$1", [
            candidateId,
          ]);
        } else if (scenario === "dependent-view") {
          await client.query(
            "CREATE VIEW legacy_consumer AS SELECT storage_id FROM official_workflow_definition_revisions",
          );
        } else if (scenario === "dependent-index") {
          await client.query(
            "CREATE INDEX legacy_consumer ON official_workflow_definition_revisions(storage_id)",
          );
        } else if (scenario === "dependent-expression-index") {
          await client.query(
            "CREATE INDEX legacy_consumer ON official_workflow_definition_revisions((lower(storage_name)))",
          );
        } else if (scenario === "dependent-trigger") {
          await client.query(`
            CREATE FUNCTION legacy_consumer() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
            CREATE TRIGGER legacy_consumer BEFORE UPDATE OF storage_name ON official_workflow_definition_revisions
              FOR EACH ROW EXECUTE FUNCTION legacy_consumer();
          `);
        } else if (scenario === "dependent-check") {
          await client.query(
            "ALTER TABLE official_workflow_definition_revisions ADD CONSTRAINT legacy_consumer CHECK (storage_name IS NULL OR length(storage_name)>0)",
          );
        }
        const retainedBefore = (await client.query(revisionRead)).rows;
        const fullBefore = (
          await client.query(
            "SELECT to_jsonb(r) AS row FROM official_workflow_definition_revisions r ORDER BY definition_name, revision",
          )
        ).rows;
        const objectsBefore = (
          await client.query(
            "SELECT (SELECT jsonb_agg(s) FROM storages s) AS roots, (SELECT jsonb_agg(v) FROM storage_versions v) AS versions, (SELECT jsonb_agg(p) FROM retained_run_provenance p) AS provenance, (SELECT jsonb_agg(c) FROM official_workflow_catalog_releases c) AS catalogs",
          )
        ).rows;
        if (scenario === "complete") {
          await client.query(migration);
          assert.deepEqual(
            (await client.query(revisionRead)).rows,
            retainedBefore,
          );
          // The existing source publisher can materialize an exact retained
          // revision without changing its identity, payload or original bytes.
          await client.query(
            `UPDATE official_workflow_definition_revisions SET content_bundle=$1
            WHERE definition_name=$2 AND revision=$3 AND payload=$4 AND content_bundle IS NULL`,
            [bundle, sources[0]!.name, revision, sources[0]],
          );
          assert.deepEqual(
            (
              await client.query(
                "SELECT payload,content_bundle FROM official_workflow_definition_revisions WHERE definition_name='legacy-only'",
              )
            ).rows,
            [{ payload: sources[0], content_bundle: bundle }],
          );
          await client.query(
            `INSERT INTO official_workflow_definition_revisions (definition_name,revision,payload,content_bundle)
            VALUES ($1,$2,$3,$4) ON CONFLICT (definition_name,revision) DO UPDATE
            SET content_bundle=COALESCE(official_workflow_definition_revisions.content_bundle,EXCLUDED.content_bundle)
            WHERE official_workflow_definition_revisions.payload=EXCLUDED.payload
            RETURNING definition_name`,
            [sources[2]!.name, revision, sources[2], bundle],
          );
        } else {
          const sourceFailure = {
            "incomplete-source": {
              definitionName: "legacy-only",
              failedChecks: ["instruction-not-string"],
            },
            "incomplete-v1-source": {
              definitionName: "historical-v1",
              failedChecks: ["instruction-not-string"],
            },
            "incomplete-v1-file": {
              definitionName: "historical-v1",
              failedChecks: ["invalid-file-entry"],
            },
            "unsupported-source-version": {
              definitionName: "historical-v1",
              failedChecks: ["unsupported-schema-version"],
            },
          };
          await assert.rejects(client.query(migration), (error: unknown) => {
            assert(error instanceof DatabaseError);
            assert.equal(error.code, "P0001");
            if (scenario in sourceFailure) {
              const expected =
                sourceFailure[scenario as keyof typeof sourceFailure];
              assert.equal(
                error.message,
                "C05: a retained Official revision lacks complete immutable source",
              );
              assert.deepEqual(JSON.parse(error.detail!), {
                ...expected,
                revision,
              });
            }
            return true;
          });
          assert.deepEqual(
            (
              await client.query(
                "SELECT to_jsonb(r) AS row FROM official_workflow_definition_revisions r ORDER BY definition_name, revision",
              )
            ).rows,
            fullBefore,
          );
        }
        assert.deepEqual(
          (
            await client.query(
              "SELECT (SELECT jsonb_agg(s) FROM storages s) AS roots, (SELECT jsonb_agg(v) FROM storage_versions v) AS versions, (SELECT jsonb_agg(p) FROM retained_run_provenance p) AS provenance, (SELECT jsonb_agg(c) FROM official_workflow_catalog_releases c) AS catalogs",
            )
          ).rows,
          objectsBefore,
        );
      } finally {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    }
  } finally {
    await client.end();
  }
  console.log(
    "Official revision contraction: immutable source, bundle publication, retained provenance and dependency rejection passed",
  );
}
