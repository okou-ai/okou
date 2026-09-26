import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

// Frozen September 2026 formats: permanent migrations do not import runtime
// application contracts or schema mappings.
const brandSchema = z.enum(["vm0", "okou"]);
const tokenSchema = z.string().regex(/^(?:[a-z0-9]{10}|[a-f0-9]{24})$/u);
const slugSchema = z
  .string()
  .max(96)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_SITE_BYTES = 512 * 1024 * 1024;

export const fileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  contentType: z.string().min(1),
  immutable: z.boolean().optional(),
});
const manifestSchema = z.object({
  version: z.literal(1),
  access: z.literal("owner-private-v1").optional(),
  publicBrand: brandSchema,
  deploymentId: z.uuid(),
  siteId: z.uuid(),
  publicSlug: slugSchema,
  createdAt: z.iso.datetime({ offset: true }),
  spaFallback: z.boolean(),
  files: z.record(z.string(), fileSchema),
});
const targetSchema = z.object({
  kind: z.literal("html"),
  id: z.uuid(),
  siteId: z.uuid(),
  snapshotId: z.uuid(),
  deploymentVersion: z.number().int().positive(),
  manifest: manifestSchema.extend({ access: z.literal("owner-private-v1") }),
});
export const policySchema = z
  .object({
    version: z.literal(1),
    revision: z.uuid(),
    shareId: z.uuid(),
    ownerId: z.string().min(1),
    orgId: z.string().min(1),
    publicBrand: brandSchema,
    delivery: z.literal("artifact-registry-v1"),
    organizationReference: z
      .string()
      .regex(/^[a-z0-9]{10}$/u)
      .optional(),
    publicSlug: z.string().optional(),
    audience: z.literal("public"),
    status: z.literal("active"),
    publicToken: tokenSchema,
    target: targetSchema,
  })
  .strict();
export const publicationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("publication"),
    publicBrand: brandSchema,
    shareId: z.uuid(),
    publicToken: tokenSchema,
    targetKind: z.literal("html"),
  })
  .strict();
export const legacySiteSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("legacy-site"),
    publicBrand: brandSchema,
    audience: z.literal("public"),
    pointerKey: z.string().startsWith("sites/"),
  })
  .strict();
export const pointerSchema = z
  .object({
    version: z.literal(1),
    publicBrand: brandSchema,
    publicSlug: slugSchema,
    siteId: z.uuid(),
    deploymentId: z.uuid(),
    deploymentVersion: z.number().int().positive(),
    artifactUrl: z.url(),
    prefix: z.string(),
    manifestKey: z.string(),
    spaFallback: z.boolean(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const siteSchema = z.object({
  id: z.uuid(),
  org_id: z.string(),
  user_id: z.string(),
  slug: z.string(),
  requested_slug: z.string().nullable(),
  link_layout_segment: brandSchema,
  public_slug: slugSchema,
  active_deployment_id: z.uuid().nullable(),
  created_at: z.date(),
  deleted_at: z.date().nullable(),
});
export const shareSchema = z.object({
  id: z.uuid(),
  org_id: z.string(),
  user_id: z.string(),
  link_layout_segment: brandSchema,
  target_kind: z.literal("html"),
  target_id: z.uuid(),
});
export const deploymentSchema = z.object({
  id: z.uuid(),
  site_id: z.uuid(),
  org_id: z.string(),
  user_id: z.string(),
  link_layout_segment: brandSchema,
  status: z.enum(["uploading", "ready", "failed", "deleted"]),
  manifest: z.record(z.string(), z.unknown()),
  manifest_hash: z.string(),
  content_hash: z.string(),
  r2_prefix: z.string(),
  artifact_url: z.string().nullable(),
  url: z.string(),
  file_count: z.number().int(),
  size_bytes: z.string().regex(/^\d+$/u),
  spa_fallback: z.boolean(),
  entrypoint: z.string(),
  run_id: z.string().nullable(),
});
export const planSiteSchema = z
  .object({
    siteId: z.uuid(),
    ownerId: z.string().min(1),
    publicBrand: brandSchema,
    publicSlug: slugSchema,
    requestedSlug: z.string(),
    shareId: z.uuid(),
    publicToken: tokenSchema,
    source: targetSchema,
    sourceEtags: z.record(z.string(), z.string().min(1)),
    artifactKind: z.enum(["hosted-site", "presentation-html"]),
    deploymentId: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const planSchema = z
  .object({
    version: z.literal(1),
    orgId: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    sites: z.array(planSiteSchema).min(1).max(50),
  })
  .strict();

export type Site = z.infer<typeof siteSchema>;
export type Share = z.infer<typeof shareSchema>;
export type Policy = z.infer<typeof policySchema>;
export type PlanSite = z.infer<typeof planSiteSchema>;
export type Plan = z.infer<typeof planSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type File = z.infer<typeof fileSchema>;

export class MigrationInvariantError extends Error {}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MigrationInvariantError(message);
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function contentHash(files: readonly File[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => {
    return a.path.localeCompare(b.path);
  })) {
    hash.update(`${file.path}\0${file.sha256}\0${String(file.size)}\0`);
  }
  return hash.digest("hex");
}

export function validateFiles(files: Record<string, File>): void {
  const entries = Object.entries(files);
  assert(entries.length > 0 && entries.length <= 5000, "invalid_file_count");
  assert(files["/index.html"], "missing_index");
  let total = 0;
  for (const [path, file] of entries) {
    assert(
      path === file.path &&
        path.startsWith("/") &&
        !path.startsWith("//") &&
        !/[\\?#]/u.test(path) &&
        !path.includes("\0") &&
        path !== "/manifest.json" &&
        !path.split("/").some((part) => {
          return part === "." || part === "..";
        }),
      "invalid_file_path",
    );
    total += file.size;
  }
  assert(total <= MAX_SITE_BYTES, "site_too_large");
}

export function namespace(brand: "vm0" | "okou"): string {
  return brand === "okou" ? "sites/brands/okou" : "sites";
}

export function aliasKey(
  site: Pick<PlanSite, "publicBrand">,
  alias: string,
): string {
  return `artifact-delivery/${site.publicBrand}/html/${encodeURIComponent(alias)}.json`;
}

export function activeKey(
  site: Pick<PlanSite, "publicBrand" | "publicSlug">,
): string {
  return `${namespace(site.publicBrand)}/${site.publicSlug}/active.json`;
}

export function deploymentPointerKey(site: PlanSite): string {
  return `${namespace(site.publicBrand)}/deployments/${site.deploymentId}.json`;
}

export function prefix(site: PlanSite): string {
  return `${namespace(site.publicBrand)}/publications/${site.deploymentId}`;
}

export function publicUrl(
  site: Pick<PlanSite, "publicBrand">,
  alias: string,
): string {
  const domain = site.publicBrand === "okou" ? "okou.app" : "sites.vm0.io";
  return `https://${alias}.${domain}`;
}

export function bootstrapId(orgId: string, target: Policy["target"]): string {
  const digest = sha256(
    `018-hosted-publication-pointers\0${orgId}\0${target.siteId}\0${target.snapshotId}`,
  );
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function buildManifest(site: PlanSite) {
  return {
    version: 1,
    immutableContent: true,
    publicBrand: site.publicBrand,
    deploymentId: site.deploymentId,
    siteId: site.siteId,
    site: site.requestedSlug,
    publicSlug: site.publicSlug,
    deploymentVersion: site.source.deploymentVersion,
    createdAt: site.createdAt,
    artifactKind: site.artifactKind,
    spaFallback: site.source.manifest.spaFallback,
    files: site.source.manifest.files,
  };
}

export function buildPointer(site: PlanSite) {
  return pointerSchema.parse({
    version: 1,
    publicBrand: site.publicBrand,
    publicSlug: site.publicSlug,
    siteId: site.siteId,
    deploymentId: site.deploymentId,
    deploymentVersion: site.source.deploymentVersion,
    artifactUrl: publicUrl(site, `dpl-${site.deploymentId}`),
    prefix: prefix(site),
    manifestKey: `${prefix(site)}/manifest.json`,
    spaFallback: site.source.manifest.spaFallback,
    updatedAt: site.createdAt,
  });
}

export function legacyRecord(site: PlanSite, pointerKey = activeKey(site)) {
  return legacySiteSchema.parse({
    version: 1,
    kind: "legacy-site",
    publicBrand: site.publicBrand,
    audience: "public",
    pointerKey,
  });
}

export function publicationRecord(site: PlanSite) {
  return publicationSchema.parse({
    version: 1,
    kind: "publication",
    publicBrand: site.publicBrand,
    shareId: site.shareId,
    publicToken: site.publicToken,
    targetKind: "html",
  });
}

export function validateIdentity(
  orgId: string,
  site: Site,
  share: Share,
  policy: Policy,
): void {
  assert(site.org_id === orgId && !site.deleted_at, "site_scope_changed");
  assert(
    share.org_id === orgId &&
      share.user_id === site.user_id &&
      share.link_layout_segment === site.link_layout_segment &&
      share.target_id === site.id,
    "share_scope_mismatch",
  );
  assert(
    policy.orgId === orgId &&
      policy.ownerId === site.user_id &&
      policy.shareId === share.id &&
      policy.publicBrand === site.link_layout_segment &&
      policy.target.siteId === site.id &&
      policy.target.id === policy.target.manifest.deploymentId &&
      policy.target.siteId === policy.target.manifest.siteId &&
      policy.target.manifest.publicBrand === site.link_layout_segment &&
      policy.target.manifest.publicSlug === site.public_slug,
    "policy_scope_mismatch",
  );
  assert(
    policy.publicSlug === site.public_slug || policy.publicSlug === undefined,
    "unexpected_policy_alias",
  );
  assert(policy.publicToken !== site.public_slug, "token_is_named_alias");
  validateFiles(policy.target.manifest.files);
}

export function validatePlan(
  orgId: string,
  planned: PlanSite,
  site: Site,
  share: Share,
  policy: Policy,
): void {
  validateIdentity(orgId, site, share, policy);
  assert(
    planned.siteId === site.id &&
      planned.ownerId === site.user_id &&
      planned.publicBrand === site.link_layout_segment &&
      planned.publicSlug === site.public_slug &&
      planned.requestedSlug === (site.requested_slug ?? site.slug) &&
      planned.shareId === share.id &&
      planned.publicToken === policy.publicToken &&
      planned.deploymentId === bootstrapId(orgId, policy.target) &&
      isDeepStrictEqual(planned.source, policy.target),
    "plan_source_changed",
  );
  assert(
    isDeepStrictEqual(
      Object.keys(planned.sourceEtags).sort(),
      Object.keys(policy.target.manifest.files).sort(),
    ),
    "plan_file_set_changed",
  );
  assert(
    site.active_deployment_id === null ||
      site.active_deployment_id === planned.deploymentId,
    "another_active_deployment",
  );
}

/** A DB rollback after a pointer write must never let this older plan win. */
export function validateActivePointer(site: PlanSite, value: unknown): void {
  const pointer = pointerSchema.parse(value);
  assert(
    isDeepStrictEqual(pointer, buildPointer(site)),
    "another_or_changed_active_pointer",
  );
}

export function validateDeployment(
  site: PlanSite,
  orgId: string,
  row: Deployment,
): void {
  const manifest = buildManifest(site);
  const files = Object.values(manifest.files);
  assert(
    row.id === site.deploymentId &&
      row.site_id === site.siteId &&
      row.org_id === orgId &&
      row.user_id === site.ownerId &&
      row.link_layout_segment === site.publicBrand &&
      (row.status === "uploading" || row.status === "ready") &&
      row.run_id === null &&
      row.r2_prefix === prefix(site) &&
      row.artifact_url === publicUrl(site, `dpl-${site.deploymentId}`) &&
      row.url === publicUrl(site, site.publicSlug) &&
      row.file_count === files.length &&
      row.size_bytes ===
        String(
          files.reduce((sum, file) => {
            return sum + file.size;
          }, 0),
        ) &&
      row.entrypoint === "/index.html" &&
      row.spa_fallback === manifest.spaFallback &&
      isDeepStrictEqual(row.manifest, manifest) &&
      row.manifest_hash === sha256(JSON.stringify(manifest)) &&
      row.content_hash === contentHash(files),
    "bootstrap_deployment_mismatch",
  );
}

export function sourceManifest(value: unknown) {
  return manifestSchema.parse(value);
}

export function snapshotArtifactKind(
  value: unknown,
): "hosted-site" | "presentation-html" {
  return (
    z
      .object({
        artifactKind: z.enum(["hosted-site", "presentation-html"]).optional(),
      })
      .parse(value).artifactKind ?? "hosted-site"
  );
}
