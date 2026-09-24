import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bootstrapId,
  buildManifest,
  buildPointer,
  policySchema,
  sha256,
  validateActivePointer,
  validateFiles,
  validateIdentity,
  validatePlan,
  type PlanSite,
  type Share,
  type Site,
} from "./model";

const orgId = "selected-org";
const siteId = "00000000-0000-4000-8000-000000000001";
const sourceId = "00000000-0000-4000-8000-000000000002";
const shareId = "00000000-0000-4000-8000-000000000003";
const site: Site = {
  id: siteId,
  org_id: orgId,
  user_id: "owner",
  slug: "example",
  requested_slug: null,
  public_brand: "okou",
  public_slug: "example",
  active_deployment_id: null,
  created_at: new Date("2026-09-18T00:00:00Z"),
  deleted_at: null,
};
const share: Share = {
  id: shareId,
  org_id: orgId,
  user_id: "owner",
  public_brand: "okou",
  target_kind: "html",
  target_id: siteId,
};
const policy = policySchema.parse({
  version: 1,
  revision: "00000000-0000-4000-8000-000000000004",
  shareId,
  ownerId: "owner",
  orgId,
  publicBrand: "okou",
  delivery: "artifact-registry-v1",
  audience: "public",
  status: "active",
  publicToken: "0123456789abcdef01234567",
  publicSlug: "example",
  target: {
    kind: "html",
    id: sourceId,
    siteId,
    snapshotId: "00000000-0000-4000-8000-000000000005",
    deploymentVersion: 3,
    manifest: {
      version: 1,
      access: "owner-private-v1",
      publicBrand: "okou",
      deploymentId: sourceId,
      siteId,
      publicSlug: "example",
      createdAt: "2026-09-18T00:00:00.000Z",
      spaFallback: false,
      files: {
        "/index.html": {
          path: "/index.html",
          size: 5,
          sha256: sha256("hello"),
          contentType: "text/html",
        },
      },
    },
  },
});
const planned: PlanSite = {
  siteId,
  ownerId: "owner",
  publicBrand: "okou",
  publicSlug: "example",
  requestedSlug: "example",
  shareId,
  publicToken: policy.publicToken,
  source: policy.target,
  sourceEtags: { "/index.html": '"snapshot-etag"' },
  artifactKind: "hosted-site",
  deploymentId: bootstrapId(orgId, policy.target),
  createdAt: policy.target.manifest.createdAt,
};

await test("historical public bootstrap keeps version 3 so a pending version 4 still wins", () => {
  assert.equal(buildManifest(planned).deploymentVersion, 3);
  assert.equal(buildPointer(planned).deploymentVersion, 3);
  assert.ok(!("access" in buildManifest(planned)));
  assert.equal(
    buildManifest({ ...planned, artifactKind: "presentation-html" })
      .artifactKind,
    "presentation-html",
  );
});

await test("resume accepts its redirected token policy and durable bootstrap binding", () => {
  const redirected = {
    ...policy,
    revision: "00000000-0000-4000-8000-000000000006",
  };
  delete redirected.publicSlug;
  validatePlan(
    orgId,
    planned,
    { ...site, active_deployment_id: planned.deploymentId },
    share,
    redirected,
  );
  validateActivePointer(planned, buildPointer(planned));
});

await test("a public pointer left by a newer uncommitted upload blocks backwards promotion", () => {
  assert.throws(() => {
    return validateActivePointer(planned, {
      ...buildPointer(planned),
      deploymentId: "00000000-0000-4000-8000-000000000007",
      deploymentVersion: 4,
    });
  }, /another_or_changed_active_pointer/u);
  assert.throws(() => {
    return validatePlan(
      orgId,
      planned,
      {
        ...site,
        active_deployment_id: "00000000-0000-4000-8000-000000000007",
      },
      share,
      policy,
    );
  }, /another_active_deployment/u);
});

await test("same slug cannot authorize another owner, organization, site or brand", () => {
  assert.throws(() => {
    return validateIdentity(
      orgId,
      site,
      { ...share, user_id: "other" },
      policy,
    );
  }, /share_scope_mismatch/u);
  assert.throws(() => {
    return validateIdentity("other-org", site, share, policy);
  }, /site_scope_changed/u);
  assert.throws(() => {
    return validateIdentity(orgId, site, share, {
      ...policy,
      target: { ...policy.target, siteId: sourceId },
    });
  }, /policy_scope_mismatch/u);
  assert.throws(() => {
    return validateIdentity(orgId, site, share, {
      ...policy,
      publicBrand: "vm0",
    });
  }, /policy_scope_mismatch/u);
});

await test("a new policy snapshot, token, or alias requires a new reviewed plan", () => {
  assert.throws(() => {
    return validatePlan(orgId, planned, site, share, {
      ...policy,
      target: {
        ...policy.target,
        snapshotId: "00000000-0000-4000-8000-000000000008",
      },
    });
  }, /plan_source_changed/u);
  assert.throws(() => {
    return validatePlan(orgId, planned, site, share, {
      ...policy,
      publicToken: "abcdef0123456789abcdef01",
    });
  }, /plan_source_changed/u);
  assert.throws(() => {
    return validatePlan(orgId, planned, site, share, {
      ...policy,
      publicSlug: "someone-elses-site",
    });
  }, /unexpected_policy_alias/u);
});

await test("revoked/non-public policies and paths escaping the snapshot are rejected", () => {
  assert.equal(
    policySchema.safeParse({
      ...policy,
      status: "revoked",
      audience: "private",
      publicToken: null,
    }).success,
    false,
  );
  const original = planned.source.manifest.files["/index.html"];
  assert.ok(original);
  for (const path of [
    "/../index.html",
    "//outside/index.html",
    "/manifest.json",
    "/a\\b",
  ]) {
    assert.throws(() => {
      return validateFiles({
        ...planned.source.manifest.files,
        [path]: { ...original, path },
      });
    }, /invalid_file_path/u);
  }
});
