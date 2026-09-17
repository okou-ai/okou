import type { GenerationTemplateIdentity } from "@okouai/core/generation-template-identity";

import { getDatasetName, ingestToAxiom } from "../signals/external/axiom";
import { env } from "./env";
import { nowDate } from "./time";

const TEMPLATE_USAGE_DATASET = "web-logs";
const TEMPLATE_USAGE_CONTEXT = "api:template-usage";
const TEMPLATE_USED_TYPE = "template_used";

/**
 * Which of the three paths that build a template prompt recorded this usage.
 *
 * This names how a message reached a run, not the channel it arrived on. The
 * three differ in when the template becomes guidance, which is what makes a
 * count comparable: a message can sit in the queue for minutes before its
 * template is used, or be steered into a run that is already executing.
 */
export type TemplateUsageDispatchPath =
  | "active-input"
  | "normal-send"
  | "queued-claim";

/** What the surrounding request knows about a template usage. */
export interface TemplateUsageLogContext {
  readonly dispatchPath: TemplateUsageDispatchPath;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  /** Normal sends only: whether an agent token or a human session sent this. */
  readonly triggerSource?: string;
}

function templateUsageEvent(
  context: TemplateUsageLogContext,
  identity: GenerationTemplateIdentity,
  index: number,
  count: number,
): Record<string, unknown> {
  return {
    _time: nowDate().toISOString(),
    level: "info",
    message: "Generation template used",
    source: "api",
    type: TEMPLATE_USED_TYPE,
    context: TEMPLATE_USAGE_CONTEXT,
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
    // The first attached template is the one the run treats as primary; see
    // projectUserMessage, which takes `primaryTemplate ??=` in parts order.
    templateRole: index === 0 ? "primary" : "inline",
    templateIndex: index,
    templateCount: count,
    ...context,
  };
}

/**
 * Record that a template made it into a run prompt.
 *
 * Called only for selections the prompt builder resolved. A selection rejected
 * because a switch is off or a private package is not mounted never reaches the
 * agent, so counting it would overstate usage.
 *
 * One event per template rather than one per message: a message can attach
 * several, and a single event would force every consumer to unpack an array
 * before it could count anything. `templateIndex` and `templateCount` keep the
 * message reconstructable.
 */
export function logTemplateUsage(
  context: TemplateUsageLogContext,
  identities: readonly GenerationTemplateIdentity[],
): void {
  if (identities.length === 0) {
    return;
  }
  ingestToAxiom(
    getDatasetName(TEMPLATE_USAGE_DATASET),
    identities.map((identity, index) => {
      return templateUsageEvent(context, identity, index, identities.length);
    }),
  );
}
