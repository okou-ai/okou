import { parseArgs } from "node:util";

import postgres from "postgres";

// Permanent extractor-v1 backfill. The API worker owns bounded archive I/O;
// this operator command only publishes durable work for exact retained versions.
const { values } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
    "all-retained": { type: "boolean", default: false },
    "after-version-id": { type: "string", default: "" },
    "version-id": { type: "string", multiple: true },
    limit: { type: "string", default: "500" },
  },
});
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
  throw new Error("--limit must be an integer between 1 and 2000");
}
const connectionUrl = process.env.DATABASE_URL;
if (!connectionUrl) {
  throw new Error("DATABASE_URL is required");
}
const db = postgres(connectionUrl, { max: 1 });
try {
  const ids = values["version-id"] ?? [];
  const rows = await db`
    SELECT v.id
    FROM storage_versions v
    JOIN storages s ON s.id = v.storage_id
    WHERE v.id > ${values["after-version-id"]}
      AND (${values["all-retained"]} OR s.head_version_id = v.id OR v.id = ANY(${ids}))
      AND NOT EXISTS (
        SELECT 1 FROM pi_resource_version_indexes i
        WHERE i.storage_version_id = v.id AND i.extractor_version = 1
      )
    ORDER BY v.id
    LIMIT ${limit}
  `;
  const selected = rows.map((row) => {
    if (typeof row.id !== "string") {
      throw new Error("Expected a Storage version ID from the database");
    }
    return row.id;
  });
  let enqueued = 0;
  if (values.migrate && selected.length > 0) {
    const inserted = await db`
      INSERT INTO pi_resource_version_indexes (storage_version_id, extractor_version)
      SELECT id, 1 FROM storage_versions WHERE id = ANY(${selected})
      ON CONFLICT DO NOTHING
      RETURNING storage_version_id
    `;
    enqueued = inserted.length;
  }
  const coverage = await db`
    SELECT status, count(*)::text AS count
    FROM pi_resource_version_indexes WHERE extractor_version = 1 GROUP BY status
  `;
  console.log(
    JSON.stringify(
      {
        dryRun: !values.migrate,
        selected: selected.length,
        enqueued,
        nextAfterVersionId: selected.at(-1) ?? null,
        coverage,
      },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
