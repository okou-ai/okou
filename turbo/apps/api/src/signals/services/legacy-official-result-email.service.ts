import {
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  MORNING_BRIEF_PREFERENCES_PATH,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import type { AgentRunOfficialWorkflowProvenance } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  legacyOfficialResultEmailClaims,
  legacyOfficialResultEmailOutbox,
} from "@okouai/db/runtime/legacy-official-result-email";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { users } from "@okouai/db/schema/user";
import { workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import {
  LEGACY_OFFICIAL_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS,
  LEGACY_OFFICIAL_RESULT_EMAIL_TEXT_MAX_CHARACTERS,
  LEGACY_OFFICIAL_RESULT_EMAIL_TEXT_TRUNCATION_MARKER,
  LEGACY_OFFICIAL_RESULT_EMAIL_TITLE_MAX_CHARACTERS,
} from "../../lib/legacy-official-result-email";
import { logger } from "../../lib/log";
import { db$, writeDb$ } from "../external/db";
import {
  buildFromAddress,
  buildOneClickUnsubscribeUrl,
  buildUnsubscribeHeaders,
  type EmailTemplate,
  getUserEmail$,
} from "./email-common.service";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { readAcceptedOfficialWorkflowRevision$ } from "./official-workflow-catalog-read.service";
import { getRunOutputText$ } from "./run-output.service";

/*
 * Bounded legacy consumer of the retired platform completion email (#39524).
 *
 * Release-1 APIs (1.729.0 / a3f7131 and earlier) register the
 * `workflow-automation:result-email` Run callback at claim time whenever the
 * claimed Automation's physical `official_result_email_enabled` is true. Release
 * 2 registers it nowhere and never writes that column, but its reconfiguration
 * preserves a historical true value, so a release-1 claim still executing during
 * the overlap can capture new work. This module finishes such callbacks exactly
 * as release 1 did: same eligibility, permanent per-source claim, preference
 * decision, outbox content and source identity. The legacy outbox entries are
 * drained by the shared outbox.
 *
 * Remove this module, its callback dispatch case and kind, the
 * `official-automation-result` outbox decoder and render branch, and
 * `@okouai/db/runtime/legacy-official-result-email` with release 3 of #39378,
 * after the release-2 API serves, no release-1 artifact or claim/handler
 * invocation still executes, no pending/failed legacy callback or
 * pending/sending legacy outbox entry remains, and rollback cannot select an
 * artifact without this consumer.
 */
const log = logger("api:legacy-official-result-email");
const EMPTY_RESULT_FALLBACK = "This run completed without a text result.";
const SHORT_TRUNCATION_MARKER = "…";

// Callbacks persisted before #36766 also carry `publicBrand`; parsing strips it.
const callbackPayloadSchema = z.object({
  automationId: z.string().uuid(),
  workflowName: z.string().min(1).max(64),
});

function truncateWithMarker(
  value: string,
  maxCharacters: number,
  marker: string,
): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) {
    return value;
  }
  const markerCharacters = Array.from(marker);
  return [
    ...characters.slice(0, maxCharacters - markerCharacters.length),
    ...markerCharacters,
  ].join("");
}

const userEmailIsUnsubscribed$ = command(
  async ({ get }, userId: string, signal: AbortSignal): Promise<boolean> => {
    const db = get(db$);
    const [user] = await db
      .select({ emailUnsubscribed: users.emailUnsubscribed })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    signal.throwIfAborted();
    return user?.emailUnsubscribed ?? false;
  },
);

function resultEmailTitle(workflowName: string): string {
  return truncateWithMarker(
    `Result from ${workflowName}`,
    LEGACY_OFFICIAL_RESULT_EMAIL_TITLE_MAX_CHARACTERS,
    SHORT_TRUNCATION_MARKER,
  );
}

function resultEmailSubject(workflowName: string): string {
  return truncateWithMarker(
    workflowName,
    LEGACY_OFFICIAL_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS,
    SHORT_TRUNCATION_MARKER,
  );
}

const resultEmailWorkflowLabel$ = command(
  async (
    { set },
    workflowName: string,
    provenance: AgentRunOfficialWorkflowProvenance | null,
    signal: AbortSignal,
  ): Promise<string> => {
    if (!provenance) {
      return workflowName;
    }
    const definition = provenance.definitions.find((candidate) => {
      return candidate.name === workflowName;
    });
    if (!definition) {
      throw new Error(
        `Official Workflow provenance does not contain ${workflowName}`,
      );
    }
    const revision = await set(
      readAcceptedOfficialWorkflowRevision$,
      { name: definition.name, revision: definition.revision },
      signal,
    );
    if (!revision) {
      throw new Error(
        `Official Workflow revision ${definition.name}@${definition.revision} is unavailable`,
      );
    }
    return revision.definition.workflow.displayName;
  },
);

function boundedResultText(output: string | undefined): string {
  const normalized = output?.trim();
  return truncateWithMarker(
    normalized || EMPTY_RESULT_FALLBACK,
    LEGACY_OFFICIAL_RESULT_EMAIL_TEXT_MAX_CHARACTERS,
    LEGACY_OFFICIAL_RESULT_EMAIL_TEXT_TRUNCATION_MARKER,
  );
}

interface WorkflowAutomationManageUrlArgs {
  readonly automationId: string;
  readonly userId: string;
  readonly productUrl: string;
}

const workflowAutomationManageUrl$ = command(
  async (
    { get },
    args: WorkflowAutomationManageUrlArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const db = get(db$);
    const [automation] = await db
      .select({
        workflowId: workflowAutomations.workflowId,
        officialDefinitionName: workflows.officialDefinitionName,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .where(
        and(
          eq(workflowAutomations.id, args.automationId),
          eq(workflowAutomations.ownerUserId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      automation?.officialDefinitionName ===
      MORNING_BRIEF_OFFICIAL_DEFINITION_NAME
    ) {
      return `${args.productUrl}${MORNING_BRIEF_PREFERENCES_PATH}`;
    }
    return automation
      ? `${args.productUrl}/workflows/${encodeURIComponent(
          automation.workflowId,
        )}/automations?automationId=${encodeURIComponent(args.automationId)}`
      : `${args.productUrl}/workflows`;
  },
);

interface ResultEmailEnqueueArgs {
  readonly userId: string;
  readonly runId: string;
  readonly automationId: string;
  readonly workflowName: string;
  readonly userEmail: string;
  readonly workflowLabel: string;
  readonly output: string | undefined;
  readonly productUrl: string;
  readonly manageUrl: string;
}
const enqueueResultEmail$ = command(
  async (
    { set },
    args: ResultEmailEnqueueArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const claims = legacyOfficialResultEmailClaims;
    const outbox = legacyOfficialResultEmailOutbox;
    const template = {
      template: "official-automation-result",
      props: {
        title: resultEmailTitle(args.workflowName),
        resultText: boundedResultText(args.output),
        runUrl: `${args.productUrl}/activities/${encodeURIComponent(args.runId)}`,
        manageUrl: args.manageUrl,
      },
    } satisfies EmailTemplate;
    // Unsubscribe and complaint handling upsert this row. Materialize it first
    // so the statement below always reads a committed preference.
    await db
      .insert(users)
      .values({ id: args.userId })
      .onConflictDoNothing({ target: users.id });
    signal.throwIfAborted();
    // One statement replaces the retired TX-0173: the opt-out read, the
    // permanent source claim and the outbox entry commit together, so a crash or
    // concurrent retry can neither leave a claim without its email nor enqueue
    // twice. A preference committed before the statement suppresses the email;
    // one committed later is ordered after the enqueue. The claim has no foreign
    // keys, so outbox, Run or Automation cleanup cannot reopen the source.
    const claim = db.$with("legacy_result_email_claim").as(
      db
        .insert(claims)
        .select(
          sql`SELECT ${args.runId}::uuid, ${args.automationId}::uuid, gen_random_uuid()
          FROM ${users}
          WHERE ${eq(users.id, args.userId)}
            AND ${eq(users.emailUnsubscribed, false)}`,
        )
        .onConflictDoNothing({
          target: [claims.runId, claims.workflowAutomationId],
        })
        .returning({ emailOutboxId: claims.emailOutboxId }),
    );
    const enqueued = await db
      .with(claim)
      .insert(outbox)
      .select(
        sql`SELECT ${claim.emailOutboxId}, ${buildFromAddress()},
          ${sql.param(args.userEmail, outbox.toAddresses)}::jsonb,
          ${resultEmailSubject(args.workflowLabel)},
          ${sql.param(
            buildUnsubscribeHeaders(buildOneClickUnsubscribeUrl(args.userId)),
            outbox.headers,
          )}::jsonb,
          ${sql.param(template, outbox.template)}::jsonb,
          ${args.runId}::uuid, ${args.automationId}::uuid
          FROM ${claim}`,
      )
      .returning({ id: outbox.id });
    signal.throwIfAborted();

    return enqueued.length > 0;
  },
);

export const handleLegacyOfficialResultEmailCallback$ = command(
  async (
    { get, set },
    envelope: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    const db = get(db$);
    if (envelope.status !== "completed") {
      return { success: true, skipped: true };
    }

    const payload = callbackPayloadSchema.safeParse(envelope.payload);
    if (!payload.success) {
      return {
        success: false,
        error: "Invalid Official Automation result email callback payload",
      };
    }

    const [run] = await db
      .select({
        status: agentRuns.status,
        userId: agentRuns.userId,
        officialWorkflowProvenance: agentRuns.officialWorkflowProvenance,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, envelope.runId))
      .limit(1);
    signal.throwIfAborted();
    if (run?.status !== "completed") {
      return { success: true, skipped: true };
    }

    if (await set(userEmailIsUnsubscribed$, run.userId, signal)) {
      signal.throwIfAborted();
      return { success: true, skipped: true };
    }

    const userEmail = await set(getUserEmail$, run.userId, signal);
    signal.throwIfAborted();
    if (!userEmail) {
      return { success: true, skipped: true };
    }

    const output = await set(getRunOutputText$, envelope.runId, signal);
    const workflowLabel = await set(
      resultEmailWorkflowLabel$,
      payload.data.workflowName,
      run.officialWorkflowProvenance ?? null,
      signal,
    );
    const productUrl = env("APP_URL");
    const manageUrl = await set(
      workflowAutomationManageUrl$,
      {
        automationId: payload.data.automationId,
        userId: run.userId,
        productUrl,
      },
      signal,
    );
    const enqueued = await set(
      enqueueResultEmail$,
      {
        userId: run.userId,
        runId: envelope.runId,
        automationId: payload.data.automationId,
        workflowName: payload.data.workflowName,
        userEmail,
        workflowLabel,
        output,
        productUrl,
        manageUrl,
      },
      signal,
    );

    log.debug("Legacy Official Automation result email callback handled", {
      runId: envelope.runId,
      automationId: payload.data.automationId,
      enqueued,
    });
    return enqueued ? { success: true } : { success: true, skipped: true };
  },
);
