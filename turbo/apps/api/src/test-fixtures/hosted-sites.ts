/**
 * Current APIs cannot reproduce historical VM0 identities or rolling
 * deployments left by historical and rollback writers.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { HostedSitePrepareRequest } from "@okouai/api-contracts/contracts/host";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { ArtifactSharePolicy } from "@okouai/api-contracts/contracts/artifact-shares";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import type { HostedSiteManifest } from "@okouai/db/jsonb-contracts/hosted-site";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { artifactShares } from "@okouai/db/schema/artifact-share";
import { createStore } from "ccstate";

import { writeDb$ } from "../signals/external/db";
import { nowDate } from "../lib/time";

export async function insertLegacyHostedSiteFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly site: string;
  readonly publicBrand?: PublicBrand;
}): Promise<string> {
  const db = createStore().set(writeDb$);
  const [site] = await db
    .insert(hostedSites)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      slug: args.site,
      requestedSlug: args.site,
      publicSlug: args.site,
      publicBrand: args.publicBrand ?? "vm0",
    })
    .returning({ id: hostedSites.id });
  if (!site) {
    throw new Error("Expected a historical hosted site");
  }
  return site.id;
}

/** Old writers could leave multiple uploads on one site; current prepare cannot. */
export async function insertLegacyHostedSiteHistoryFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly site: string;
  readonly files: HostedSitePrepareRequest["files"];
  readonly immutableFirst: boolean;
}) {
  const siteId = await insertLegacyHostedSiteFixture({
    ...args,
    publicBrand: "okou",
  });
  const db = createStore().set(writeDb$);
  const deployments = [];
  for (const deploymentVersion of [1, 2]) {
    const id = randomUUID();
    const manifest: HostedSiteManifest = {
      version: 1,
      publicBrand: "okou",
      deploymentId: id,
      siteId,
      site: args.site,
      publicSlug: args.site,
      deploymentVersion,
      ...(args.immutableFirst && deploymentVersion === 1
        ? { immutableContent: true as const }
        : {}),
      createdAt: nowDate().toISOString(),
      spaFallback: false,
      files: Object.fromEntries(
        args.files.map((file) => {
          return [file.path, file];
        }),
      ),
    };
    const artifactUrl = `https://dpl-${id}.okou.app`;
    const r2Prefix = `sites/orgs/${args.orgId}/${args.site}/versions/${deploymentVersion}`;
    await db.insert(hostedDeployments).values({
      id,
      siteId,
      orgId: args.orgId,
      userId: args.userId,
      publicBrand: "okou",
      artifactUrl,
      r2Prefix,
      manifest,
      manifestHash: createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex"),
      contentHash: createHash("sha256")
        .update(JSON.stringify(args.files))
        .digest("hex"),
      fileCount: args.files.length,
      sizeBytes: args.files.reduce((size, file) => {
        return size + file.size;
      }, 0),
      url: `https://${args.site}.okou.app`,
    });
    deployments.push({ id, artifactUrl, r2Prefix, deploymentVersion });
  }
  return { siteId, deployments };
}

/**
 * Public-only prepare cannot create the historical private deployment and
 * snapshot identity. Tests install only that persisted starting state here;
 * policy storage stays at the R2 boundary and behavior uses production routes.
 */
export async function insertLegacyHostedSitePublicationFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly site: string;
  readonly files: HostedSitePrepareRequest["files"];
  readonly publicBrand?: PublicBrand;
}) {
  const publicBrand = args.publicBrand ?? "okou";
  const siteId = await insertLegacyHostedSiteFixture({ ...args, publicBrand });
  const deploymentId = randomUUID();
  const shareId = randomUUID();
  const snapshotId = randomUUID();
  const publicToken = randomBytes(12).toString("hex");
  const privatePrefix = `private-sites/${publicBrand}/${deploymentId}`;
  const snapshotPrefix = `shared-artifacts/${publicBrand}/${snapshotId}/${deploymentId}`;
  const policyKey = `artifact-shares/${publicBrand}/${shareId}.json`;
  const manifest = {
    version: 1,
    access: "owner-private-v1",
    publicBrand,
    deploymentId,
    siteId,
    site: args.site,
    publicSlug: args.site,
    deploymentVersion: 1,
    createdAt: nowDate().toISOString(),
    spaFallback: false,
    files: Object.fromEntries(
      args.files.map((file) => {
        return [file.path, file];
      }),
    ),
  } satisfies HostedSiteManifest;
  const artifactUrl = new URL(
    artifactReferencePath(deploymentId, "index.html"),
    "https://app.okou.ai",
  ).href;
  const db = createStore().set(writeDb$);
  await db.insert(privateHostedDeployments).values({
    id: deploymentId,
    siteId,
    orgId: args.orgId,
    userId: args.userId,
    publicBrand,
    status: "ready",
    readyAt: nowDate(),
    artifactUrl,
    r2Prefix: privatePrefix,
    manifest,
    manifestHash: createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex"),
    contentHash: createHash("sha256")
      .update(JSON.stringify(args.files))
      .digest("hex"),
    fileCount: args.files.length,
    sizeBytes: args.files.reduce((size, file) => {
      return size + file.size;
    }, 0),
    url: artifactUrl,
  });
  await db.insert(artifactShares).values({
    id: shareId,
    userId: args.userId,
    orgId: args.orgId,
    publicBrand,
    targetKind: "html",
    targetId: siteId,
  });
  const policy = {
    version: 1,
    delivery: "artifact-registry-v1",
    revision: randomUUID(),
    shareId,
    ownerId: args.userId,
    orgId: args.orgId,
    publicBrand,
    audience: "public",
    status: "active",
    publicToken,
    publicSlug: args.site,
    target: {
      kind: "html",
      id: deploymentId,
      siteId,
      snapshotId,
      deploymentVersion: 1,
      manifest,
    },
  } satisfies ArtifactSharePolicy;
  return {
    siteId,
    publicSlug: args.site,
    publicBrand,
    deploymentId,
    shareId,
    snapshotId,
    publicToken,
    manifest,
    artifactUrl,
    policy,
    policyKey,
    privatePrefix,
    snapshotPrefix,
  };
}
