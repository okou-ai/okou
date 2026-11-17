import { runArtifactResultSchema } from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import {
  and,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

import {
  nullableDriverValueDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";

function readyHostedOutput(
  deployments: typeof hostedDeployments | typeof privateHostedDeployments,
) {
  return exists(
    new QueryBuilder()
      .select({ id: deployments.id })
      .from(deployments)
      .innerJoin(
        hostedSites,
        and(
          eq(hostedSites.id, deployments.siteId),
          eq(hostedSites.userId, agentRuns.userId),
          eq(hostedSites.orgId, agentRuns.orgId),
          isNull(hostedSites.deletedAt),
        ),
      )
      // This association is written only after pointer publication and the
      // ready-state commit. readyAt itself is captured before remote I/O and
      // changes on completion replay, so it is not a readiness receipt.
      .innerJoin(
        runUploadedFiles,
        and(
          eq(runUploadedFiles.runId, agentRuns.id),
          eq(runUploadedFiles.userId, agentRuns.userId),
          eq(runUploadedFiles.orgId, agentRuns.orgId),
          eq(
            sql`${runUploadedFiles.metadata}->>'generatedBy'`,
            "zero-official-website",
          ),
          eq(
            sql`${runUploadedFiles.metadata}->>'deploymentId'`,
            sql`${deployments.id}::text`,
          ),
          eq(
            sql`${runUploadedFiles.metadata}->>'siteId'`,
            sql`${deployments.siteId}::text`,
          ),
          eq(
            runUploadedFiles.url,
            sql`COALESCE(${deployments.artifactUrl}, ${deployments.url})`,
          ),
          isNull(runUploadedFiles.deletedAt),
          gte(runUploadedFiles.createdAt, agentRuns.startedAt),
          lte(runUploadedFiles.createdAt, agentRuns.completedAt),
        ),
      )
      .where(
        and(
          eq(deployments.runId, sql`${agentRuns.id}::text`),
          eq(deployments.userId, agentRuns.userId),
          eq(deployments.orgId, agentRuns.orgId),
          eq(deployments.status, "ready"),
          ne(deployments.url, ""),
        ),
      ),
  );
}

function readyFileOutput() {
  const ownership = alias(runUploadedFiles, "artifact_result_file_owner");
  // externalId also holds non-file provider identities. Keep the ownership
  // lookup on its UUID primary key without casting an arbitrary external ID.
  const ownershipId = sql`CASE WHEN ${runUploadedFiles.externalId}
    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN ${runUploadedFiles.externalId}::uuid END`;
  const privateOutput = exists(
    new QueryBuilder()
      .select({ id: ownership.id })
      .from(ownership)
      .where(
        and(
          eq(ownership.id, ownershipId),
          eq(ownership.userId, agentRuns.userId),
          eq(ownership.orgId, agentRuns.orgId),
          isNull(ownership.deletedAt),
          or(
            isNull(ownership.classification),
            eq(ownership.classification, "published-output"),
          ),
          eq(sql`${ownership.metadata}->>'storage'`, "private-artifact-v1"),
          eq(sql`${ownership.metadata}->>'purpose'`, "artifact"),
          eq(ownership.materializationStatus, "ready"),
          eq(ownership.url, runUploadedFiles.url),
          eq(ownership.storageKey, sql`${runUploadedFiles.metadata}->>'s3Key'`),
          gt(ownership.sizeBytes, 0),
          gte(ownership.createdAt, agentRuns.startedAt),
          lte(ownership.createdAt, agentRuns.completedAt),
        ),
      ),
  );
  return exists(
    new QueryBuilder()
      .select({ id: runUploadedFiles.id })
      .from(runUploadedFiles)
      .where(
        and(
          eq(runUploadedFiles.runId, agentRuns.id),
          eq(runUploadedFiles.userId, agentRuns.userId),
          eq(runUploadedFiles.orgId, agentRuns.orgId),
          isNull(runUploadedFiles.deletedAt),
          ne(runUploadedFiles.url, ""),
          gt(runUploadedFiles.sizeBytes, 0),
          or(
            isNull(runUploadedFiles.classification),
            eq(runUploadedFiles.classification, "published-output"),
          ),
          gte(runUploadedFiles.createdAt, agentRuns.startedAt),
          lte(runUploadedFiles.createdAt, agentRuns.completedAt),
          // The Run association follows verified private-file completion.
          // A direct canonical ready row has no independent post-readiness
          // receipt here; it remains unknown rather than borrowing updatedAt.
          privateOutput,
        ),
      ),
  );
}

/** Current native receipts proving an output was ready by Run completion.
 * Native absence is not no-content: legacy and external outputs can be unknown.
 */
export function runArtifactResultSelection() {
  return sql`CASE WHEN
    ${inArray(agentRuns.status, ["completed", "failed", "cancelled", "timeout"])}
    AND ${isNotNull(agentRuns.startedAt)}
    AND ${isNotNull(agentRuns.completedAt)}
    AND ${lte(agentRuns.startedAt, agentRuns.completedAt)}
    AND (${readyHostedOutput(hostedDeployments)}
      OR ${readyHostedOutput(privateHostedDeployments)}
      OR ${readyFileOutput()})
    THEN 'success' ELSE NULL END`.mapWith(
    nullableDriverValueDecoder(zodDriverValueDecoder(runArtifactResultSchema)),
  );
}
