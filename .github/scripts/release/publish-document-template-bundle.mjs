/** One-time publication of the pinned document bundle, using existing registry storage. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    bundle: { type: "string" },
    publish: { type: "boolean", default: false },
    "owner-storage-id": { type: "string" },
  },
});
if (!values.bundle) {
  throw new Error(
    "--bundle <directory> is required; default is verification only",
  );
}
const bundle = path.resolve(values.bundle);
const expected = JSON.parse(
  await readFile(
    new URL("./document-template-bundle.json", import.meta.url),
    "utf8",
  ),
);
const manifest = JSON.parse(
  await readFile(path.join(bundle, "manifest.json"), "utf8"),
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
function safeFile(name) {
  return (
    name.startsWith(`${expected.slug}/`) &&
    !name.includes("\\") &&
    !name.split("/").some((part) => part === ".." || part === "") &&
    !path.isAbsolute(name)
  );
}
for (const key of [
  "resourceId",
  "slug",
  "storageId",
  "versionId",
  "sourceRepository",
  "sourceCommit",
]) {
  assert(manifest[key] === expected[key], `Publication pin mismatch: ${key}`);
}
assert(manifest.archive.sha256 === expected.sha256, "Archive pin mismatch");
assert(
  manifest.archive.path === `${expected.slug}.tar.gz`,
  "Unexpected archive filename",
);
assert(
  Array.isArray(manifest.files) && manifest.files.length === manifest.fileCount,
  "Invalid file count",
);
const files = new Map();
for (const file of manifest.files) {
  assert(
    safeFile(file.path) && !files.has(file.path),
    "Unsafe or duplicate manifest path",
  );
  assert(
    /^[0-9a-f]{64}$/.test(file.hash) &&
      Number.isSafeInteger(file.size) &&
      file.size >= 0,
    "Invalid file metadata",
  );
  files.set(file.path, file);
}
const version = sha256(
  `storage:${manifest.storageId}\n${manifest.files
    .map((file) => `${file.path}:${file.hash}`)
    .sort()
    .join("\n")}`,
);
assert(version === manifest.versionId, "Content-addressed version mismatch");
const archive = await readFile(path.join(bundle, manifest.archive.path));
assert(
  sha256(archive) === expected.sha256 &&
    archive.length === manifest.archive.byteSize,
  "Archive bytes mismatch",
);
const tar = await import("tar");
const seen = new Set();
await tar.t({
  file: path.join(bundle, manifest.archive.path),
  onReadEntry(entry) {
    assert(
      entry.type === "File" &&
        safeFile(entry.path) &&
        files.has(entry.path) &&
        !seen.has(entry.path),
      "Unsafe or unexpected archive entry",
    );
    seen.add(entry.path);
  },
});
assert(seen.size === files.size, "Archive file set mismatch");
const extracted = await mkdtemp(path.join(tmpdir(), "document-bundle-verify-"));
try {
  await tar.x({
    file: path.join(bundle, manifest.archive.path),
    cwd: extracted,
    strict: true,
  });
  let size = 0;
  for (const file of files.values()) {
    const bytes = await readFile(path.join(extracted, file.path));
    assert(
      bytes.length === file.size && sha256(bytes) === file.hash,
      `File mismatch: ${file.path}`,
    );
    size += bytes.length;
  }
  assert(size === manifest.totalSize, "Total size mismatch");
  const catalog = JSON.parse(
    await readFile(path.join(extracted, expected.slug, "catalog.json"), "utf8"),
  );
  assert(
    catalog.length === 51 &&
      new Set(catalog.map((item) => item.id)).size === 51,
    "Expected 51 unique templates",
  );
  for (const category of [
    "creative-brief",
    "contract",
    "service-agreement",
    "invoice",
  ]) {
    assert(
      catalog.filter((item) => item.category === category).length >= 7,
      `Incomplete category: ${category}`,
    );
  }
} finally {
  await rm(extracted, { recursive: true, force: true });
}
console.log(
  `VERIFIED ${expected.resourceId} ${version} ${archive.length} bytes`,
);
if (!values.publish) {
  process.exit(0);
}

// Publishing is an explicit operator step after both companion PRs merge.
assert(
  values["owner-storage-id"],
  "--owner-storage-id must identify an existing official registry storage",
);
const required = (name) => {
  const value = process.env[name];
  assert(value, `Missing ${name}`);
  return value;
};
const { default: postgres } = await import("postgres");
const { S3Client, PutObjectCommand, GetObjectCommand } =
  await import("@aws-sdk/client-s3");
const sql = postgres(required("DATABASE_URL"), { max: 1 });
const client = new S3Client({
  region: "auto",
  endpoint: `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
});
const bucket = required("R2_USER_STORAGES_BUCKET_NAME");
try {
  const [owner] =
    await sql`SELECT id, name, org_id, user_id FROM storages WHERE id = ${values["owner-storage-id"]}`;
  assert(
    owner?.name.startsWith("registry-resource@"),
    "Owner must be an existing official registry storage",
  );
  const name = `registry-resource@${expected.resourceId}`;
  const existing =
    await sql`SELECT id, name, org_id, user_id, s3_prefix, head_version_id FROM storages WHERE id = ${expected.storageId} OR name = ${name}`;
  assert(existing.length <= 1, "Registry storage is ambiguous");
  const previous = existing[0];
  if (previous) {
    assert(
      previous.id === expected.storageId &&
        previous.name === name &&
        previous.org_id === owner.org_id &&
        previous.user_id === owner.user_id,
      "Existing storage identity differs",
    );
    assert(
      previous.head_version_id === null || previous.head_version_id === version,
      "Refusing to replace another version",
    );
  }
  const prefix = previous?.s3_prefix ?? `${owner.org_id}/${expected.storageId}`;
  const s3Key = `${prefix}/${version}`;
  const r2Manifest = {
    version,
    createdAt: "2026-10-14T00:00:00.000Z",
    totalSize: manifest.totalSize,
    fileCount: manifest.fileCount,
    files: manifest.files,
  };
  for (const [suffix, bytes, contentType] of [
    ["archive.tar.gz", archive, "application/gzip"],
    [
      "manifest.json",
      Buffer.from(`${JSON.stringify(r2Manifest)}\n`),
      "application/json",
    ],
  ]) {
    const key = `${s3Key}/${suffix}`;
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 412) {
        throw error;
      }
    }
    const object = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    assert(object.Body, "R2 object body missing");
    assert(
      sha256(Buffer.from(await object.Body.transformToByteArray())) ===
        sha256(bytes),
      "R2 readback mismatch",
    );
  }
  // Immutable preparation can be resumed after interruption. Existing unique keys
  // arbitrate inserts; the final conditional update never replaces another HEAD.
  await sql`INSERT INTO storages (id, name, org_id, user_id, s3_prefix) VALUES (${expected.storageId}, ${name}, ${owner.org_id}, ${owner.user_id}, ${prefix}) ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO storage_versions (id, storage_id, s3_key, size, archive_size, file_count, message, created_by)
    SELECT ${version}, s.id, ${s3Key}, ${manifest.totalSize}, ${archive.length}, ${manifest.fileCount}, ${`Template-artifact@${expected.sourceCommit}`}, 'document-template-publisher'
    FROM storages s WHERE s.id = ${expected.storageId} AND s.name = ${name} AND s.org_id = ${owner.org_id} AND s.user_id = ${owner.user_id} AND s.s3_prefix = ${prefix} AND (s.head_version_id IS NULL OR s.head_version_id = ${version})
    ON CONFLICT (id) DO NOTHING`;
  const [registered] =
    await sql`SELECT storage_id, s3_key, size, archive_size, file_count FROM storage_versions WHERE id = ${version}`;
  assert(
    registered?.storage_id === expected.storageId &&
      registered.s3_key === s3Key &&
      Number(registered.size) === manifest.totalSize &&
      Number(registered.archive_size) === archive.length &&
      registered.file_count === manifest.fileCount,
    "Version identity differs",
  );
  const [published] =
    await sql`UPDATE storages SET head_version_id = ${version}, size = ${manifest.totalSize}, file_count = ${manifest.fileCount}, updated_at = now()
    WHERE id = ${expected.storageId} AND name = ${name} AND org_id = ${owner.org_id} AND user_id = ${owner.user_id} AND s3_prefix = ${prefix} AND (head_version_id IS NULL OR head_version_id = ${version}) RETURNING id`;
  assert(
    published?.id === expected.storageId,
    "Storage changed during publication",
  );
  console.log(`PUBLISHED ${expected.resourceId} ${version}`);
} finally {
  await sql.end();
  client.destroy();
}
