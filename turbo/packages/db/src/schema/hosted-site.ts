import {
  foreignKey,
  index,
  integer,
  pgTable,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  hostedDeploymentColumns,
  hostedSiteColumns,
  privateHostedDeploymentColumns,
} from "../columns/hosted-site";
export {
  HOSTED_DEPLOYMENT_STATUSES,
  type HostedDeploymentStatus,
} from "../columns/hosted-site";
export type {
  HostedSiteManifest,
  HostedSiteManifestFile,
} from "../jsonb-contracts/hosted-site";

export const hostedSites = pgTable(
  "hosted_sites",
  {
    ...hostedSiteColumns(),
    // Physical compatibility for the API preceding runtime version retirement.
    // Drop with its mirror trigger after that API leaves serving and rollback.
    activeDeploymentVersion: integer("active_deployment_version"),
    nextDeploymentVersion: integer("next_deployment_version")
      .notNull()
      .default(2),
  },
  (table) => {
    return [
      index("idx_hosted_sites_org").on(table.orgId),
      uniqueIndex("idx_hosted_sites_org_slug").on(table.orgId, table.slug),
      uniqueIndex("idx_hosted_sites_org_chat_thread_requested_slug")
        .on(table.orgId, table.chatThreadId, table.requestedSlug)
        .where(
          sql`${table.chatThreadId} IS NOT NULL AND ${table.requestedSlug} IS NOT NULL`,
        ),
      uniqueIndex("idx_hosted_sites_org_requested_slug_non_chat")
        .on(table.orgId, table.requestedSlug)
        .where(
          sql`${table.chatThreadId} IS NULL AND ${table.requestedSlug} IS NOT NULL`,
        ),
      uniqueIndex("idx_hosted_sites_public_slug").on(table.publicSlug),
      unique("idx_hosted_sites_id_public_brand").on(
        table.id,
        table.publicBrand,
      ),
    ];
  },
);

export const hostedDeployments = pgTable(
  "hosted_deployments",
  {
    ...hostedDeploymentColumns(() => {
      return hostedSites.id;
    }),
    // Existing rows retain their version; new immutable publications are v1
    // for outgoing API readers until the #35240 column contraction.
    deploymentVersion: integer("deployment_version").default(1),
  },
  (table) => {
    return [
      index("idx_hosted_deployments_site").on(table.siteId),
      uniqueIndex("idx_hosted_deployments_site_version")
        .on(table.siteId, table.deploymentVersion)
        .where(sql`${table.deploymentVersion} IS NOT NULL`),
      uniqueIndex("idx_hosted_deployments_site_manifest_version").on(
        table.siteId,
        sql`((${table.manifest}->>'deploymentVersion')::integer)`,
      ),
      index("idx_hosted_deployments_org").on(table.orgId),
      index("idx_hosted_deployments_status").on(table.status),
      foreignKey({
        name: "fk_hosted_deployments_site_public_brand",
        columns: [table.siteId, table.publicBrand],
        foreignColumns: [hostedSites.id, hostedSites.publicBrand],
      }).onDelete("cascade"),
    ];
  },
);

// Separate rows keep older API binaries from publishing private deployments.
export const privateHostedDeployments = pgTable(
  "private_hosted_deployments",
  {
    ...privateHostedDeploymentColumns(() => {
      return hostedSites.id;
    }),
    deploymentVersion: integer("deployment_version").notNull().default(1),
  },
  (table) => {
    return [
      index("idx_private_hosted_deployments_site").on(table.siteId),
      uniqueIndex("idx_private_hosted_deployments_site_version").on(
        table.siteId,
        table.deploymentVersion,
      ),
      uniqueIndex("idx_private_hosted_deployments_site_manifest_version").on(
        table.siteId,
        sql`((${table.manifest}->>'deploymentVersion')::integer)`,
      ),
      index("idx_private_hosted_deployments_org").on(table.orgId),
      index("idx_private_hosted_deployments_status").on(table.status),
      foreignKey({
        name: "fk_private_hosted_deployments_site_public_brand",
        columns: [table.siteId, table.publicBrand],
        foreignColumns: [hostedSites.id, hostedSites.publicBrand],
      }).onDelete("cascade"),
    ];
  },
);
