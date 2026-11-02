import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

export async function validateSeedSkillBundleSchema(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const url = `https://github.com/okou-ai/okou-skills/tree/main/schema-${randomUUID()}`;
  const sourceVersion = "a".repeat(64);
  const nextVersion = "b".repeat(64);
  const bundle = { sha256: "c".repeat(64), archiveBytes: 200 };
  try {
    // The preceding publisher's INSERT and UPDATE omit both new columns.
    await client.query(
      `INSERT INTO skills (url,name,full_path,storage_id,version_hash,frontmatter,s3_key,size,file_count,synced_at)
       VALUES ($1,'schema-skill','schema-skill',NULL,$2,NULL,NULL,20,1,now())`,
      [url, sourceVersion],
    );
    const initial = await client.query(
      "SELECT content_bundle,content_bundle_source_version_hash FROM skills WHERE url=$1",
      [url],
    );
    assert.deepEqual(initial.rows, [
      { content_bundle: null, content_bundle_source_version_hash: null },
    ]);
    await client.query(
      "UPDATE skills SET content_bundle=$1,content_bundle_source_version_hash=$2 WHERE url=$3",
      [bundle, sourceVersion, url],
    );
    await client.query(
      `INSERT INTO skills (url,name,full_path,storage_id,version_hash,frontmatter,s3_key,size,file_count,synced_at)
       VALUES ($1,'schema-skill','schema-skill',NULL,$2,NULL,NULL,21,1,now())
       ON CONFLICT (url) DO UPDATE SET
         name=excluded.name,full_path=excluded.full_path,
         storage_id=excluded.storage_id,version_hash=excluded.version_hash,
         frontmatter=excluded.frontmatter,s3_key=excluded.s3_key,
         size=excluded.size,file_count=excluded.file_count,
         synced_at=excluded.synced_at,updated_at=now()`,
      [url, nextVersion],
    );
    const precedingRead = await client.query(
      "SELECT version_hash,storage_id FROM skills WHERE url=$1 LIMIT 1",
      [url],
    );
    assert.deepEqual(precedingRead.rows, [
      { version_hash: nextVersion, storage_id: null },
    ]);
    const afterOldWrite = await client.query(
      "SELECT version_hash,content_bundle,content_bundle_source_version_hash FROM skills WHERE url=$1",
      [url],
    );
    assert.deepEqual(afterOldWrite.rows, [
      {
        version_hash: nextVersion,
        content_bundle: bundle,
        content_bundle_source_version_hash: sourceVersion,
      },
    ]);
    for (const [descriptor, version] of [
      [null, sourceVersion],
      [bundle, null],
      [bundle, "invalid"],
      [{ archiveBytes: 200 }, sourceVersion],
      [{ ...bundle, extra: true }, sourceVersion],
      [{ ...bundle, sha256: "invalid" }, sourceVersion],
      ...[0, 1.5, 33554433, "200", null].map((archiveBytes) => {
        return [{ ...bundle, archiveBytes }, sourceVersion];
      }),
    ]) {
      await assert.rejects(
        client.query(
          "UPDATE skills SET content_bundle=$1,content_bundle_source_version_hash=$2 WHERE url=$3",
          [descriptor, version, url],
        ),
        (error: unknown) => {
          return (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23514" &&
            "constraint" in error &&
            error.constraint === "skills_content_bundle_check"
          );
        },
      );
    }
    await client.query(
      "UPDATE skills SET content_bundle=NULL,content_bundle_source_version_hash=NULL WHERE url=$1",
      [url],
    );
  } finally {
    await client.query("DELETE FROM skills WHERE url=$1", [url]);
    await client.end();
  }
  console.log(
    "Seed Skill bundle schema and preceding writer compatibility passed",
  );
}
