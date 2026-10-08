#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Client } from "pg";
import { z } from "zod";
import {
  activeKey,
  aliasKey,
  assert,
  bootstrapId,
  buildManifest,
  buildPointer,
  contentHash,
  deploymentPointerKey,
  deploymentSchema,
  legacyRecord,
  MigrationInvariantError,
  planSchema,
  policySchema,
  prefix,
  publicUrl,
  publicationRecord,
  sha256,
  shareSchema,
  siteSchema,
  snapshotArtifactKind,
  sourceManifest,
  validateActivePointer,
  validateDeployment,
  validateIdentity,
  validatePlan,
  type Deployment,
  type Plan,
  type PlanSite,
  type Policy,
} from "./model";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const options = {
  "org-id": { type: "string" },
  "site-id": { type: "string", multiple: true },
  plan: { type: "string" },
  report: { type: "string" },
  "max-sites": { type: "string", default: "1" },
  migrate: { type: "boolean", default: false },
  verify: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} as const;

function requiredEnv(name: string): string {
  const value = process.env[name];
  assert(value, `missing_configuration:${name}`);
  return value;
}

function missing(error: unknown): boolean {
  return (
    error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)
  );
}

function precondition(error: unknown): boolean {
  return error instanceof Error && error.name === "PreconditionFailed";
}

/** No deletes, unconditional puts, bucket-wide scans or credentials in reports. */
class Storage {
  constructor(
    readonly client: S3Client,
    readonly bucket: string,
  ) {}

  async read(key: string, maxBytes: number, etag?: string) {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(etag ? { IfMatch: etag } : {}),
        }),
      );
      assert(
        result.Body &&
          result.ETag &&
          result.ContentLength !== undefined &&
          result.ContentLength <= maxBytes,
        "invalid_or_oversize_object",
      );
      const bytes = await result.Body.transformToByteArray();
      assert(
        bytes.byteLength === result.ContentLength &&
          bytes.byteLength <= maxBytes,
        "object_size_changed",
      );
      return { bytes, etag: result.ETag, contentType: result.ContentType };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async json(key: string) {
    const object = await this.read(key, MAX_JSON_BYTES);
    if (!object) return null;
    const value: unknown = JSON.parse(
      Buffer.from(object.bytes).toString("utf8"),
    );
    return { value, etag: object.etag };
  }

  async putOnce(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const previous = await this.read(key, bytes.byteLength);
    if (!previous) {
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            IfNoneMatch: "*",
            Metadata: { sha256: sha256(bytes) },
          }),
        );
      } catch (error) {
        if (!precondition(error)) throw error;
      }
    }
    const actual = previous ?? (await this.read(key, bytes.byteLength));
    assert(
      actual &&
        actual.bytes.byteLength === bytes.byteLength &&
        sha256(actual.bytes) === sha256(bytes) &&
        actual.contentType === contentType,
      "immutable_destination_conflict",
    );
  }

  async putJsonOnce(key: string, value: unknown): Promise<void> {
    const previous = await this.json(key);
    if (previous) {
      assert(
        isDeepStrictEqual(previous.value, value),
        "immutable_json_conflict",
      );
      return;
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: JSON.stringify(value),
          ContentType: "application/json",
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (!precondition(error)) throw error;
    }
    assert(
      isDeepStrictEqual((await this.json(key))?.value, value),
      "json_readback_failed",
    );
  }

  async compareAndSwap(
    key: string,
    previousEtag: string,
    value: unknown,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: "application/json",
        IfMatch: previousEtag,
      }),
    );
    assert(
      isDeepStrictEqual((await this.json(key))?.value, value),
      "cas_readback_failed",
    );
  }
}

async function rows(db: Client, query: string, parameters: readonly unknown[]) {
  const result = await db.query<Record<string, unknown>>(query, [
    ...parameters,
  ]);
  return result.rows;
}

async function identity(
  db: Client,
  orgId: string,
  siteId: string,
  lock: boolean,
) {
  const sites = await rows(
    db,
    `SELECT id, org_id, user_id, slug, requested_slug, link_layout_segment,
      public_slug, active_deployment_id, created_at, deleted_at
     FROM hosted_sites WHERE id = $1 AND org_id = $2${lock ? " FOR UPDATE" : ""}`,
    [siteId, orgId],
  );
  assert(sites.length === 1, "missing_selected_site");
  const site = siteSchema.parse(sites[0]);
  // The production API takes the site lock before this share lock as well.
  const shares = await rows(
    db,
    `SELECT id, org_id, user_id, link_layout_segment, target_kind, target_id
     FROM artifact_shares WHERE target_kind = 'html' AND target_id = $1${lock ? " FOR UPDATE" : ""}`,
    [siteId],
  );
  assert(shares.length === 1, "missing_selected_share");
  return { site, share: shareSchema.parse(shares[0]) };
}

function policyKey(site: Pick<PlanSite, "publicBrand" | "shareId">): string {
  return `artifact-shares/${site.publicBrand}/${site.shareId}.json`;
}

async function readPolicy(
  storage: Storage,
  brand: "vm0" | "okou",
  shareId: string,
) {
  const stored = await storage.json(policyKey({ publicBrand: brand, shareId }));
  assert(stored, "missing_share_policy");
  return { policy: policySchema.parse(stored.value), etag: stored.etag };
}

async function privateSource(
  db: Client,
  orgId: string,
  ownerId: string,
  policy: Policy,
) {
  const sourceRows = await rows(
    db,
    `SELECT id, site_id, org_id, user_id, link_layout_segment, status, manifest,
      manifest_hash, content_hash, r2_prefix, artifact_url, url, file_count,
      size_bytes::text, spa_fallback, entrypoint, run_id
     FROM private_hosted_deployments WHERE id = $1`,
    [policy.target.id],
  );
  assert(sourceRows.length === 1, "missing_private_source_deployment");
  const source = deploymentSchema.parse(sourceRows[0]);
  assert(
    source.site_id === policy.target.siteId &&
      source.org_id === orgId &&
      source.user_id === ownerId &&
      source.link_layout_segment === policy.publicBrand &&
      source.status === "ready" &&
      source.manifest.deploymentVersion === policy.target.deploymentVersion,
    "private_source_scope_mismatch",
  );
  assert(
    isDeepStrictEqual(sourceManifest(source.manifest), policy.target.manifest),
    "private_source_manifest_changed",
  );
  const kind = source.manifest.artifactKind;
  assert(
    kind === undefined ||
      kind === "hosted-site" ||
      kind === "presentation-html",
    "unknown_artifact_kind",
  );
  return kind ?? "hosted-site";
}

async function bootstrapRow(
  db: Client,
  planned: PlanSite,
): Promise<Deployment | null> {
  const result = await rows(
    db,
    `SELECT id, site_id, org_id, user_id, link_layout_segment, status, manifest,
      manifest_hash, content_hash, r2_prefix, artifact_url, url, file_count,
      size_bytes::text, spa_fallback, entrypoint, run_id
     FROM hosted_deployments WHERE id = $1`,
    [planned.deploymentId],
  );
  return result.length ? deploymentSchema.parse(result[0]) : null;
}

async function verifyAliases(storage: Storage, planned: PlanSite) {
  const token = await storage.json(aliasKey(planned, planned.publicToken));
  assert(
    token && isDeepStrictEqual(token.value, publicationRecord(planned)),
    "token_alias_mismatch",
  );
  const named = await storage.json(aliasKey(planned, planned.publicSlug));
  assert(
    named &&
      (isDeepStrictEqual(named.value, publicationRecord(planned)) ||
        isDeepStrictEqual(named.value, legacyRecord(planned))),
    "named_alias_conflict",
  );
  const pointer = await storage.json(activeKey(planned));
  if (pointer) validateActivePointer(planned, pointer.value);
  if (isDeepStrictEqual(named.value, legacyRecord(planned))) {
    assert(pointer, "converted_alias_without_pointer");
  }
  return named;
}

async function verifySnapshot(
  storage: Storage,
  planned: PlanSite,
  migrate: boolean,
) {
  const sourcePrefix = `shared-artifacts/${planned.publicBrand}/${planned.source.snapshotId}/${planned.source.id}`;
  const storedManifest = await storage.json(`${sourcePrefix}/manifest.json`);
  assert(
    storedManifest &&
      isDeepStrictEqual(
        sourceManifest(storedManifest.value),
        planned.source.manifest,
      ),
    "snapshot_manifest_mismatch",
  );
  assert(
    snapshotArtifactKind(storedManifest.value) === planned.artifactKind,
    "snapshot_artifact_kind_mismatch",
  );
  const etags: Record<string, string> = {};
  // One bounded object is held at a time; every source is conditionally read on
  // apply, SHA-256 checked, then every destination is independently read back.
  for (const file of Object.values(planned.source.manifest.files)) {
    const source = await storage.read(
      `${sourcePrefix}${file.path}`,
      file.size,
      planned.sourceEtags[file.path],
    );
    assert(
      source &&
        source.bytes.byteLength === file.size &&
        sha256(source.bytes) === file.sha256,
      "snapshot_bytes_mismatch",
    );
    etags[file.path] = source.etag;
    if (migrate)
      await storage.putOnce(
        `${prefix(planned)}${file.path}`,
        source.bytes,
        file.contentType,
      );
  }
  return etags;
}

async function preflight(
  db: Client,
  storage: Storage,
  orgId: string,
  siteId: string,
  planned?: PlanSite,
) {
  const { site, share } = await identity(db, orgId, siteId, false);
  const { policy } = await readPolicy(
    storage,
    site.link_layout_segment,
    share.id,
  );
  validateIdentity(orgId, site, share, policy);
  const artifactKind = await privateSource(db, orgId, site.user_id, policy);
  const candidate: PlanSite = planned ?? {
    siteId,
    ownerId: site.user_id,
    publicBrand: site.link_layout_segment,
    publicSlug: site.public_slug,
    requestedSlug: site.requested_slug ?? site.slug,
    shareId: share.id,
    publicToken: policy.publicToken,
    source: policy.target,
    sourceEtags: {},
    artifactKind,
    deploymentId: bootstrapId(orgId, policy.target),
    createdAt: policy.target.manifest.createdAt,
  };
  assert(
    candidate.artifactKind === artifactKind,
    "source_artifact_kind_changed",
  );
  assert(
    candidate.createdAt === policy.target.manifest.createdAt,
    "bootstrap_timestamp_changed",
  );
  await verifyAliases(storage, candidate);
  const sourceEtags = await verifySnapshot(storage, candidate, false);
  const complete = planned ?? { ...candidate, sourceEtags };
  validatePlan(orgId, complete, site, share, policy);
  const existing = await bootstrapRow(db, complete);
  if (existing) validateDeployment(complete, orgId, existing);
  const collisions = await rows(
    db,
    `SELECT id FROM hosted_deployments WHERE site_id = $1
      AND (manifest->>'deploymentVersion')::integer = $2 AND id <> $3`,
    [siteId, complete.source.deploymentVersion, complete.deploymentId],
  );
  assert(
    collisions.length === 0,
    "historical_public_version_already_allocated",
  );
  await existingCatalog(db, orgId, complete, false);
  return complete;
}

async function transaction<T>(
  db: Client,
  operation: () => Promise<T>,
): Promise<T> {
  await db.query("BEGIN");
  try {
    const result = await operation();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function validateLocked(
  db: Client,
  storage: Storage,
  orgId: string,
  planned: PlanSite,
) {
  const { site, share } = await identity(db, orgId, planned.siteId, true);
  const stored = await readPolicy(
    storage,
    planned.publicBrand,
    planned.shareId,
  );
  validatePlan(orgId, planned, site, share, stored.policy);
  assert(
    (await privateSource(db, orgId, planned.ownerId, stored.policy)) ===
      planned.artifactKind,
    "source_artifact_kind_changed",
  );
  const named = await verifyAliases(storage, planned);
  return { site, stored, named };
}

async function reserveDeployment(
  db: Client,
  storage: Storage,
  orgId: string,
  planned: PlanSite,
) {
  await transaction(db, async () => {
    await validateLocked(db, storage, orgId, planned);
    const existing = await bootstrapRow(db, planned);
    if (existing) {
      validateDeployment(planned, orgId, existing);
      return;
    }
    const manifest = buildManifest(planned);
    const files = Object.values(manifest.files);
    // Deliberately reuse the private snapshot's historical version. Allocation
    // scans max(public, private), so every already pending newer upload wins.
    await db.query(
      `INSERT INTO hosted_deployments
        (id, site_id, org_id, user_id, run_id, link_layout_segment, status, artifact_url,
         r2_prefix, manifest, manifest_hash, content_hash, entrypoint, spa_fallback,
         file_count, size_bytes, url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, $5, 'uploading', $6, $7, $8::jsonb,
         $9, $10, '/index.html', $11, $12, $13, $14, $15, now())`,
      [
        planned.deploymentId,
        planned.siteId,
        orgId,
        planned.ownerId,
        planned.publicBrand,
        publicUrl(planned, `dpl-${planned.deploymentId}`),
        prefix(planned),
        JSON.stringify(manifest),
        sha256(JSON.stringify(manifest)),
        contentHash(files),
        manifest.spaFallback,
        files.length,
        files.reduce((sum, file) => {
          return sum + file.size;
        }, 0),
        publicUrl(planned, planned.publicSlug),
        planned.createdAt,
      ],
    );
  });
}

async function existingCatalog(
  db: Client,
  orgId: string,
  planned: PlanSite,
  lock: boolean,
) {
  const catalog = await rows(
    db,
    `SELECT id, org_id, author_user_id, kind, entity_id, logical_key
     FROM artifacts WHERE logical_key = $1 OR (kind = 'hosted-site' AND entity_id = $2)${lock ? " FOR UPDATE" : ""}`,
    [`site:${planned.siteId}`, planned.siteId],
  );
  const expectedKind =
    planned.artifactKind === "presentation-html"
      ? "presentation"
      : "hosted-site";
  if (catalog.length) {
    assert(catalog.length === 1, "multiple_site_catalog_rows");
    const row = z
      .object({
        org_id: z.string(),
        author_user_id: z.string(),
        kind: z.string(),
        entity_id: z.uuid(),
        logical_key: z.string(),
      })
      .parse(catalog[0]);
    assert(
      row.org_id === orgId &&
        row.author_user_id === planned.ownerId &&
        row.logical_key === `site:${planned.siteId}` &&
        row.kind === expectedKind,
      "catalog_owner_or_kind_mismatch",
    );
    if (row.kind === "presentation") {
      const presentations = await rows(
        db,
        "SELECT hosted_site_id FROM presentation_artifacts WHERE id = $1",
        [row.entity_id],
      );
      assert(
        presentations.length === 1 &&
          presentations[0]?.hosted_site_id === planned.siteId,
        "catalog_presentation_mismatch",
      );
    } else assert(row.entity_id === planned.siteId, "catalog_site_mismatch");
    return true;
  }
  return false;
}

async function ensureCatalog(
  db: Client,
  orgId: string,
  planned: PlanSite,
  siteCreatedAt: Date,
) {
  if (await existingCatalog(db, orgId, planned, true)) return;
  const expectedKind =
    planned.artifactKind === "presentation-html"
      ? "presentation"
      : "hosted-site";
  let entityId = planned.siteId;
  if (expectedKind === "presentation") {
    const presentation = await rows(
      db,
      `INSERT INTO presentation_artifacts (hosted_site_id) VALUES ($1)
       ON CONFLICT (hosted_site_id) DO UPDATE SET hosted_site_id = EXCLUDED.hosted_site_id RETURNING id`,
      [planned.siteId],
    );
    entityId = z.object({ id: z.uuid() }).parse(presentation[0]).id;
  }
  await db.query(
    `INSERT INTO artifacts (org_id, author_user_id, kind, entity_id, logical_key,
       projection_created_at, title, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $6)`,
    [
      orgId,
      planned.ownerId,
      expectedKind,
      entityId,
      `site:${planned.siteId}`,
      siteCreatedAt,
      planned.requestedSlug,
    ],
  );
}

async function migrateSite(
  db: Client,
  storage: Storage,
  orgId: string,
  planned: PlanSite,
) {
  await reserveDeployment(db, storage, orgId, planned);
  await verifySnapshot(storage, planned, true);
  await storage.putJsonOnce(
    `${prefix(planned)}/manifest.json`,
    buildManifest(planned),
  );
  await transaction(db, async () => {
    const { site, stored, named } = await validateLocked(
      db,
      storage,
      orgId,
      planned,
    );
    const deployment = await bootstrapRow(db, planned);
    assert(deployment, "missing_reserved_bootstrap");
    validateDeployment(planned, orgId, deployment);
    await ensureCatalog(db, orgId, planned, site.created_at);
    // Existing token aliases already resolve the same policy. Redirect the
    // advertised URL before conversion, without changing authorization/bytes.
    if (stored.policy.publicSlug !== undefined) {
      const next = { ...stored.policy, revision: randomUUID() };
      delete next.publicSlug;
      await storage.compareAndSwap(policyKey(planned), stored.etag, next);
    }
    // Immutable deployment URLs are public routes too. Publish them only after
    // the live policy is revalidated and while the share row lock excludes a
    // concurrent revocation. Staging unregistered bytes grants no access.
    await storage.putJsonOnce(
      deploymentPointerKey(planned),
      buildPointer(planned),
    );
    await storage.putJsonOnce(
      aliasKey(planned, `dpl-${planned.deploymentId}`),
      legacyRecord(planned, deploymentPointerKey(planned)),
    );
    // The named publication continues serving its snapshot until the pointer
    // and all its contents are readable. Existing pointer content must match.
    await storage.putJsonOnce(activeKey(planned), buildPointer(planned));
    if (isDeepStrictEqual(named.value, publicationRecord(planned))) {
      await storage.compareAndSwap(
        aliasKey(planned, planned.publicSlug),
        named.etag,
        legacyRecord(planned),
      );
    }
    await db.query(
      `UPDATE hosted_deployments SET status = 'ready', ready_at = COALESCE(ready_at, now()),
        updated_at = now(), error = NULL WHERE id = $1`,
      [planned.deploymentId],
    );
    await db.query(
      "UPDATE hosted_sites SET active_deployment_id = $1, updated_at = now() WHERE id = $2",
      [planned.deploymentId, planned.siteId],
    );
  });
  await verifyCompleted(db, storage, orgId, planned);
}

async function verifyCompleted(
  db: Client,
  storage: Storage,
  orgId: string,
  planned: PlanSite,
) {
  const { site, share } = await identity(db, orgId, planned.siteId, false);
  const { policy } = await readPolicy(
    storage,
    planned.publicBrand,
    planned.shareId,
  );
  validatePlan(orgId, planned, site, share, policy);
  assert(
    policy.publicSlug === undefined &&
      site.active_deployment_id === planned.deploymentId,
    "migration_incomplete",
  );
  const row = await bootstrapRow(db, planned);
  assert(row && row.status === "ready", "bootstrap_not_ready");
  validateDeployment(planned, orgId, row);
  const named = await verifyAliases(storage, planned);
  assert(
    isDeepStrictEqual(named.value, legacyRecord(planned)),
    "alias_not_converted",
  );
  const active = await storage.json(activeKey(planned));
  assert(active, "missing_active_pointer");
  validateActivePointer(planned, active.value);
  assert(
    await existingCatalog(db, orgId, planned, false),
    "missing_catalog_projection",
  );
  assert(
    isDeepStrictEqual(
      (await storage.json(deploymentPointerKey(planned)))?.value,
      buildPointer(planned),
    ),
    "immutable_pointer_mismatch",
  );
  assert(
    isDeepStrictEqual(
      (await storage.json(aliasKey(planned, `dpl-${planned.deploymentId}`)))
        ?.value,
      legacyRecord(planned, deploymentPointerKey(planned)),
    ),
    "immutable_alias_mismatch",
  );
  assert(
    isDeepStrictEqual(
      (await storage.json(`${prefix(planned)}/manifest.json`))?.value,
      buildManifest(planned),
    ),
    "public_manifest_mismatch",
  );
  for (const file of Object.values(planned.source.manifest.files)) {
    const publicFile = await storage.read(
      `${prefix(planned)}${file.path}`,
      file.size,
    );
    assert(
      publicFile &&
        publicFile.bytes.byteLength === file.size &&
        sha256(publicFile.bytes) === file.sha256 &&
        publicFile.contentType === file.contentType,
      "public_file_verification_failed",
    );
  }
}

async function existingPlan(path: string): Promise<Plan | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return planSchema.parse(value);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

function parseOptions() {
  const { values } = parseArgs({ options, strict: true });
  if (values.help) {
    console.log(
      "Usage: backfill.ts --org-id ORG --site-id UUID [--site-id UUID] --plan FILE [--max-sites 1..50] [--migrate | --verify] [--report FILE]\nDefault is read-only. Creates a local immutable plan when absent; --migrate and --verify require an existing plan. Production hostname formats are frozen. Never selects all sites implicitly.",
    );
    return null;
  }
  assert(
    values["org-id"] && values.plan && values["site-id"]?.length,
    "explicit_org_sites_and_plan_required",
  );
  const orgId = values["org-id"];
  const siteIds = values["site-id"].map((id) => {
    return z.uuid().parse(id);
  });
  const limit = Number(values["max-sites"]);
  assert(
    Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= 50 &&
      siteIds.length <= limit &&
      new Set(siteIds).size === siteIds.length,
    "invalid_or_exceeded_site_limit",
  );
  assert(
    !(values.migrate && values.verify),
    "migrate_and_verify_are_exclusive",
  );
  return { ...values, orgId, siteIds, plan: values.plan };
}

function validateSelectedPlan(
  plan: Plan | null,
  orgId: string,
  siteIds: readonly string[],
) {
  if (plan) {
    assert(
      plan.orgId === orgId &&
        new Set(
          plan.sites.map((site) => {
            return site.siteId;
          }),
        ).size === plan.sites.length,
      "plan_org_or_duplicate_site_mismatch",
    );
    assert(
      siteIds.every((id) => {
        return plan.sites.some((site) => {
          return site.siteId === id;
        });
      }),
      "site_not_in_plan",
    );
  }
}

async function main(): Promise<void> {
  const values = parseOptions();
  if (!values) return;
  const { orgId, siteIds } = values;
  let plan = await existingPlan(values.plan);
  assert(
    !(values.migrate || values.verify) || plan,
    "apply_and_verify_require_reviewed_plan",
  );
  validateSelectedPlan(plan, orgId, siteIds);
  const db = new Client({ connectionString: requiredEnv("DATABASE_URL") });
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${requiredEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv("R2_HOSTED_SITES_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_HOSTED_SITES_SECRET_ACCESS_KEY"),
    },
  });
  const storage = new Storage(s3, requiredEnv("R2_HOSTED_SITES_BUCKET_NAME"));
  const report = {
    mode: values.migrate ? "migrate" : values.verify ? "verify" : "dry-run",
    startedAt: new Date().toISOString(),
    selected: siteIds.length,
    checked: 0,
    completed: 0,
    success: false,
  };
  try {
    await db.connect();
    await db.query("SET statement_timeout = '10s'");
    await db.query("SET lock_timeout = '1s'");
    // A failed network call cannot hold a production row lock indefinitely.
    await db.query("SET idle_in_transaction_session_timeout = '90s'");
    if (!values.migrate)
      await db.query("SET default_transaction_read_only = on");
    const plannedSites: PlanSite[] = [];
    // Validate every selected site before any migration writes.
    for (const id of siteIds) {
      plannedSites.push(
        await preflight(
          db,
          storage,
          orgId,
          id,
          plan?.sites.find((site) => {
            return site.siteId === id;
          }),
        ),
      );
      report.checked += 1;
    }
    if (!plan) {
      plan = {
        version: 1,
        orgId,
        createdAt: new Date().toISOString(),
        sites: plannedSites,
      };
      await writeFile(values.plan, `${JSON.stringify(plan, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    }
    for (const site of plannedSites) {
      if (values.migrate) await migrateSite(db, storage, orgId, site);
      if (values.verify) await verifyCompleted(db, storage, orgId, site);
      report.completed += 1;
      console.log(
        JSON.stringify({
          ...report,
          phase: values.migrate || values.verify ? "verified" : "preflight",
        }),
      );
    }
    report.success = true;
  } finally {
    if (values.report)
      await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`, {
        mode: 0o600,
      });
    console.log(JSON.stringify(report));
    await db.end();
    s3.destroy();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    // Never print raw provider errors, SQL parameters, credentials or tokens.
    const reason =
      error instanceof MigrationInvariantError
        ? error.message
        : error instanceof z.ZodError
          ? "invalid_input_or_persisted_shape"
          : "provider_or_io_failure";
    console.error(JSON.stringify({ error: "migration_failed", reason }));
    process.exitCode = 1;
  });
}
