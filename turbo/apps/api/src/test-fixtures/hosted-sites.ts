/**
 * Current APIs cannot reproduce historical VM0 identities or rolling
 * deployments left by historical and rollback writers.
 */
import { createHash, randomUUID } from "node:crypto";
import type { HostedSitePrepareRequest } from "@okouai/api-contracts/contracts/host";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { HostedSiteManifest } from "@okouai/db/jsonb-contracts/hosted-site";
import { hostedDeployments, hostedSites } from "@okouai/db/runtime/hosted-site";
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
