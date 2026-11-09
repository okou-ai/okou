import { waitUntil } from "../signals/context/wait-until";
import { getDatasetName, ingestToAxiom } from "../signals/external/axiom";
import { settleIncludingAbort } from "../signals/utils";
import { env } from "./env";
import type { TemplateUsageIdentity } from "./template-usage-identity";

export interface TemplateUsageContext {
  readonly runId: string;
  readonly sourceEventId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly dispatchPath: "queued-claim" | "active-input";
  readonly usedAt: Date;
  readonly triggerSource?: string;
}

function templateUsageEvent(
  context: TemplateUsageContext,
  identity: TemplateUsageIdentity,
  index: number,
  count: number,
): Record<string, unknown> {
  return {
    _time: context.usedAt.toISOString(),
    level: "info",
    message: "Generation template used",
    source: "api",
    type: "template_used",
    context: "api:template-usage",
    deploymentCommitSha: env("GIT_COMMIT_SHA"),
    templateCategory: identity.category,
    templateId: identity.templateId,
    templateSlug: identity.templateSlug,
    templateSource: identity.source,
    ...(identity.colorSystemId === undefined
      ? {}
      : { colorSystemId: identity.colorSystemId }),
    ...(identity.workflowCategory === undefined
      ? {}
      : { workflowCategory: identity.workflowCategory }),
    templateRole: index === 0 ? "primary" : "inline",
    templateIndex: index,
    templateCount: count,
    runId: context.runId,
    sourceEventId: context.sourceEventId,
    templateUsageVersion: 2,
    usageEventId: `template-used:v2:${context.sourceEventId}:${index}`,
    orgId: context.orgId,
    userId: context.userId,
    chatThreadId: context.chatThreadId,
    dispatchPath: context.dispatchPath,
    ...(context.triggerSource === undefined
      ? {}
      : { triggerSource: context.triggerSource }),
  };
}

/**
 * Record validated selections only after their input is committed to a run.
 * Delivery is best-effort: stable occurrence IDs support reader deduplication,
 * not exactly-once ingestion. The request lifecycle owns the eventual flush;
 * sink failure, including abort, must not change committed business success.
 */
export function recordTemplateUsage(
  context: TemplateUsageContext,
  identities: readonly TemplateUsageIdentity[],
): void {
  if (identities.length === 0) {
    return;
  }
  waitUntil(
    settleIncludingAbort(() => {
      return ingestToAxiom(
        getDatasetName("web-logs"),
        identities.map((identity, index) => {
          return templateUsageEvent(
            context,
            identity,
            index,
            identities.length,
          );
        }),
      );
    }),
  );
}
