import {
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  MORNING_BRIEF_PREFERENCES_PATH,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import type { AgentRunOfficialWorkflowProvenance } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { officialAutomationResultEmailClaims } from "@okouai/db/schema/official-automation-result-email-claim";
import { users } from "@okouai/db/schema/user";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$ } from "../external/db";
import {
  buildFromAddress,
  buildOneClickUnsubscribeUrl,
  buildUnsubscribeHeaders,
  getUserEmail$,
  OFFICIAL_AUTOMATION_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS,
  OFFICIAL_AUTOMATION_RESULT_EMAIL_TEXT_MAX_CHARACTERS,
  OFFICIAL_AUTOMATION_RESULT_EMAIL_TEXT_TRUNCATION_MARKER,
  OFFICIAL_AUTOMATION_RESULT_EMAIL_TITLE_MAX_CHARACTERS,
} from "./email-common.service";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { readAcceptedOfficialWorkflowRevision$ } from "./official-workflow-catalog-read.service";
import { getRunOutputText$ } from "./run-output.service";

const log = logger("api:official-automation-result-email");
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
    OFFICIAL_AUTOMATION_RESULT_EMAIL_TITLE_MAX_CHARACTERS,
    SHORT_TRUNCATION_MARKER,
  );
}

function resultEmailSubject(workflowName: string): string {
  return truncateWithMarker(
    workflowName,
    OFFICIAL_AUTOMATION_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS,
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
    OFFICIAL_AUTOMATION_RESULT_EMAIL_TEXT_MAX_CHARACTERS,
    OFFICIAL_AUTOMATION_RESULT_EMAIL_TEXT_TRUNCATION_MARKER,
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0173; new non-billing transactions are prohibited.
    const enqueued = await set(writeDb$).transaction(async (tx) => {
      // Linearize the final preference decision with enqueue. Both explicit
      // unsubscribe and complaint handling upsert this same row, so their write
      // locks serialize with this lock before the durable source is claimed.
      // Creating a missing row first also closes the insert-vs-insert gap for a
      // user whose preference projection has not been materialized yet.
      await tx
        .insert(users)
        .values({ id: args.userId })
        .onConflictDoNothing({ target: users.id });
      const [lockedPreference] = await tx
        .select({ emailUnsubscribed: users.emailUnsubscribed })
        .from(users)
        .where(eq(users.id, args.userId))
        .for("update")
        .limit(1);
      signal.throwIfAborted();
      if (lockedPreference?.emailUnsubscribed ?? false) {
        return false;
      }

      const [claim] = await tx
        .insert(officialAutomationResultEmailClaims)
        .values({
          runId: args.runId,
          workflowAutomationId: args.automationId,
        })
        .onConflictDoNothing({
          target: [
            officialAutomationResultEmailClaims.runId,
            officialAutomationResultEmailClaims.workflowAutomationId,
          ],
        })
        .returning({
          emailOutboxId: officialAutomationResultEmailClaims.emailOutboxId,
        });
      signal.throwIfAborted();
      if (!claim) {
        return false;
      }

      await tx.insert(emailOutbox).values({
        id: claim.emailOutboxId,
        fromAddress: buildFromAddress(),
        toAddresses: args.userEmail,
        subject: resultEmailSubject(args.workflowLabel),
        headers: buildUnsubscribeHeaders(
          buildOneClickUnsubscribeUrl(args.userId),
        ),
        template: {
          template: "official-automation-result",
          props: {
            title: resultEmailTitle(args.workflowName),
            resultText: boundedResultText(args.output),
            runUrl: `${args.productUrl}/activities/${encodeURIComponent(args.runId)}`,
            // Keep the persisted props shape rollout-compatible while changing
            // manageUrl from the legacy account unsubscribe destination to the
            // originating automation deep link.
            manageUrl: args.manageUrl,
          },
        },
        sourceRunId: args.runId,
        sourceWorkflowAutomationId: args.automationId,
        status: "pending",
        attempts: 0,
      });
      signal.throwIfAborted();
      return true;
    });
    signal.throwIfAborted();

    return enqueued;
  },
);

export const handleWorkflowAutomationResultEmailInternalCallback$ = command(
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

    log.debug("Official Automation result email callback handled", {
      runId: envelope.runId,
      automationId: payload.data.automationId,
      enqueued,
    });
    return enqueued ? { success: true } : { success: true, skipped: true };
  },
);
