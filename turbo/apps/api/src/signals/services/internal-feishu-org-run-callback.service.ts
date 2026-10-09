import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agents } from "@okouai/db/schema/agent";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import { buildFeishuAgentResponseMessage } from "../../lib/feishu-message-card";
import { logger } from "../../lib/log";
import {
  removeFeishuMessageReaction,
  replyWithFeishuMessage,
  sendFeishuMessage,
} from "../external/feishu-client";
import { writeDb$, type Db } from "../external/db";
import { tapError } from "../utils";
import {
  feishuOrgCallbackPayloadSchema as callbackPayloadSchema,
  type FeishuOrgCallbackPayload,
} from "./feishu-org-callback-payload";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { formatRunErrorForRunOwner$ } from "./run-error-format.service";
import { getRunOutputText$ } from "./run-output.service";
import { saveRunSummary$ } from "./run-summary.service";
import { resolveIntegrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";

const L = logger("InternalCallbacksFeishuOrg");

interface RunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly agentId: string;
  readonly chatThreadId: string | null;
}

async function loadRun(db: Db, runId: string): Promise<RunContext | undefined> {
  const [run] = await db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      prompt: agentRuns.prompt,
      agentId: agents.id,
      chatThreadId: agentRuns.chatThreadId,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .innerJoin(agents, eq(agents.id, agentSessions.agentId))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return run;
}

const clearThinkingReaction$ = command(
  async (
    { set },
    payload: FeishuOrgCallbackPayload,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!payload.reactionId) {
      return;
    }
    await tapError(
      removeFeishuMessageReaction(
        {
          db: set(writeDb$),
          installationId: payload.installationId,
          messageId: payload.messageId,
          reactionId: payload.reactionId,
        },
        signal,
      ),
      (error) => {
        L.warn("Failed to clear Feishu thinking indicator", {
          error,
          messageId: payload.messageId,
        });
      },
    );
  },
);

async function sendFeishuCallbackResponse(
  args: {
    readonly db: Db;
    readonly payload: FeishuOrgCallbackPayload;
    readonly runId: string;
    readonly message: ReturnType<typeof buildFeishuAgentResponseMessage>;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.payload.replyInThread) {
    await replyWithFeishuMessage(
      {
        db: args.db,
        installationId: args.payload.installationId,
        messageId: args.payload.messageId,
        message: args.message,
        replyInThread: true,
      },
      signal,
    );
  } else {
    await sendFeishuMessage(
      {
        db: args.db,
        installationId: args.payload.installationId,
        receiveIdType: "chat_id",
        receiveId: args.payload.chatId,
        message: args.message,
        idempotencyKey: args.runId,
      },
      signal,
    );
  }
  signal.throwIfAborted();
}

async function loadFeishuCallbackConnection(
  db: Db,
  payload: FeishuOrgCallbackPayload,
) {
  const [connection] = await db
    .select({ id: feishuOrgConnections.id })
    .from(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.id, payload.connectionId),
        eq(feishuOrgConnections.installationId, payload.installationId),
      ),
    )
    .limit(1);
  return connection;
}

export const handleFeishuOrgInternalCallback$ = command(
  async (
    { set },
    callback: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    const db = set(writeDb$);
    if (callback.status === "progress") {
      return { success: true, skipped: true };
    }
    const parsed = callbackPayloadSchema.safeParse(callback.payload);
    if (!parsed.success) {
      return { success: false, error: "Invalid Feishu callback payload" };
    }
    const payload = parsed.data;
    if (payload.canonicalChatDelivery) {
      return { success: true, skipped: true };
    }
    const run = await loadRun(db, callback.runId);
    signal.throwIfAborted();
    if (!run) {
      await set(clearThinkingReaction$, payload, signal);
      return { success: false, error: "Agent run not found" };
    }
    const [installation] = await db
      .select({
        orgId: feishuOrgInstallations.orgId,
        defaultAgentId: orgMetadata.defaultAgentId,
      })
      .from(feishuOrgInstallations)
      .leftJoin(
        orgMetadata,
        eq(orgMetadata.orgId, feishuOrgInstallations.orgId),
      )
      .where(
        and(
          eq(feishuOrgInstallations.id, payload.installationId),
          eq(feishuOrgInstallations.orgId, run.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return { success: false, error: "Feishu installation not found" };
    }
    const connection = await loadFeishuCallbackConnection(db, payload);
    signal.throwIfAborted();
    if (!connection) {
      await set(clearThinkingReaction$, payload, signal);
      return { success: true, skipped: true };
    }
    const output =
      callback.status === "failed"
        ? undefined
        : await set(getRunOutputText$, callback.runId, signal);
    signal.throwIfAborted();
    const errorText =
      callback.status === "failed"
        ? await set(
            formatRunErrorForRunOwner$,
            {
              runId: callback.runId,
              chatThreadId: run.chatThreadId,
              errorMessage: callback.error ?? "Agent execution failed.",
            },
            signal,
          )
        : undefined;
    signal.throwIfAborted();
    const presentation = await resolveIntegrationAgentResponsePresentation(
      {
        db: db,
        orgId: run.orgId,
        runId: callback.runId,
        agentId: payload.agentId ?? run.agentId,
        defaultAgentId: installation.defaultAgentId ?? undefined,
      },
      signal,
    );
    signal.throwIfAborted();
    const responseText =
      callback.status === "failed"
        ? (errorText ?? "Agent execution failed.")
        : (output ?? "Task completed successfully.");
    const responseMessage = buildFeishuAgentResponseMessage({
      text: responseText,
      footerText: presentation.footerText,
    });
    await sendFeishuCallbackResponse(
      {
        db: db,
        payload,
        runId: callback.runId,
        message: responseMessage,
      },
      signal,
    );
    await set(clearThinkingReaction$, payload, signal);
    signal.throwIfAborted();
    await set(
      saveRunSummary$,
      {
        runId: callback.runId,
        triggerSource: "feishu",
        prompt: run.prompt,
        resultText: output ?? "",
      },
      signal,
    );
    signal.throwIfAborted();
    return { success: true };
  },
);
