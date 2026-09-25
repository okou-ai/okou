import type {
  SocialKitDownloadArtifactResult,
  SocialKitDownloadError,
  SocialKitDownloadProviderResult,
  SocialKitDownloadRequestSnapshot,
} from "@okouai/db/jsonb-contracts/socialkit-download-job";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { agentRuns } from "./agent-run";

export const SOCIALKIT_DOWNLOAD_STATUSES = [
  "submitting",
  "processing",
  "materializing",
  "artifact_failed",
  "provider_failed",
  "completed",
] as const;

export type SocialKitDownloadStatus =
  (typeof SOCIALKIT_DOWNLOAD_STATUSES)[number];

export const socialKitDownloadJobs = pgTable(
  "socialkit_download_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    status: varchar("status", { length: 24 })
      .$type<SocialKitDownloadStatus>()
      .default("submitting")
      .notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    /**
     * Retired: current APIs neither read nor write it and rely on the
     * `okou` default; drop it after older API deployments drain.
     */
    publicBrand: varchar("public_brand", { length: 8 })
      .default("okou")
      .notNull(),
    request: jsonb("request")
      .$type<SocialKitDownloadRequestSnapshot>()
      .notNull(),
    providerJobId: text("provider_job_id"),
    providerResult:
      jsonb("provider_result").$type<SocialKitDownloadProviderResult>(),
    artifact: jsonb("artifact").$type<SocialKitDownloadArtifactResult>(),
    error: jsonb("error").$type<SocialKitDownloadError>(),
    creditsCharged: bigint("credits_charged", { mode: "number" }),
    retryCount: integer("retry_count").default(0).notNull(),
    claimExpiresAt: timestamp("claim_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      uniqueIndex("uq_socialkit_download_jobs_provider_job").on(
        table.providerJobId,
      ),
      uniqueIndex("uq_socialkit_download_jobs_user_active")
        .on(table.userId)
        .where(
          sql`status IN ('submitting', 'processing', 'materializing', 'artifact_failed')`,
        ),
      index("idx_socialkit_download_jobs_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt.desc(),
      ),
      index("idx_socialkit_download_jobs_reconcile").on(
        table.status,
        table.claimExpiresAt,
      ),
      index("idx_socialkit_download_jobs_run").on(table.runId),
    ];
  },
);
