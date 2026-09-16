import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { githubChatThreadRoutes } from "@okouai/db/schema/github-chat-thread-route";
import { githubInstallations } from "@okouai/db/schema/github-installation";
import { and, eq, isNotNull } from "drizzle-orm";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { now, nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { getGithubInstallationAccessToken } from "./github-app.service";
import {
  githubChatCallbackPayloadSchema,
  type GitHubDeliveryTarget,
} from "./github-chat-callback-payload";
import {
  postGithubIssueComment,
  removeGithubCommentReaction,
} from "./github-issues-api.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { resolveGithubAgentReplyFooterText } from "./github-agent-reply-footer.service";
import { snapshotIntegrationReply } from "./integration-artifact-reply.service";

const L = logger("InternalCallbacksGithubChat");

interface ClaimedGitHubChatDelivery {
  readonly id: string;
  readonly runId: string;
  readonly payload: unknown;
}

interface GitHubChatRunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly sessionId: string;
  readonly chatThreadId: string;
  readonly agentId: string;
}

async function markDelivered(db: Db, callbackId: string): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "delivered", deliveredAt: nowDate() })
    .where(eq(agentRunCallbacks.id, callbackId));
}

async function markFailed(
  db: Db,
  callbackId: string,
  error: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "failed", lastError: error.slice(0, 4000) })
    .where(eq(agentRunCallbacks.id, callbackId));
}

function recordDelivery(args: {
  readonly runId: string;
  readonly startedAt: number;
  readonly success: boolean;
  readonly outcome: "delivered" | "failed" | "skipped_revoked";
}): void {
  recordSandboxOperation({
    sandboxType: "chat",
    actionType: "github_chat_delivery",
    durationMs: Math.max(0, now() - args.startedAt),
    success: args.success,
    runId: args.runId,
    dimensions: { outcome: args.outcome },
  });
}

async function claimGitHubChatDelivery(
  db: Db,
  callbackId: string,
): Promise<ClaimedGitHubChatDelivery | undefined> {
  const [callback] = await db
    .update(agentRunCallbacks)
    .set({ attempts: 1, lastAttemptAt: nowDate() })
    .where(
      and(
        eq(agentRunCallbacks.id, callbackId),
        eq(agentRunCallbacks.internalKind, "github:chat"),
        eq(agentRunCallbacks.status, "pending"),
        eq(agentRunCallbacks.attempts, 0),
      ),
    )
    .returning({
      id: agentRunCallbacks.id,
      runId: agentRunCallbacks.runId,
      payload: agentRunCallbacks.payload,
    });
  return callback;
}

async function loadGitHubChatDeliveryContext(
  args: {
    readonly db: Db;
    readonly callback: ClaimedGitHubChatDelivery;
  },
  signal: AbortSignal,
) {
  const payload = githubChatCallbackPayloadSchema.parse(args.callback.payload);
  const [run] = await args.db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      sessionId: agentRuns.sessionId,
      chatThreadId: agentRuns.chatThreadId,
      agentId: chatThreads.agentId,
    })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, args.callback.runId),
        eq(agentRuns.triggerSource, "github"),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!run?.chatThreadId || run.agentId !== payload.agentId) {
    throw new Error("GitHub chat delivery run context is unavailable");
  }
  const runContext: GitHubChatRunContext = {
    userId: run.userId,
    orgId: run.orgId,
    sessionId: run.sessionId,
    chatThreadId: run.chatThreadId,
    agentId: run.agentId,
  };

  const [event] = await args.db
    .select({ content: canonicalChatEventContent() })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, payload.chatEventId),
        eq(chatEvents.runId, args.callback.runId),
        eq(chatEvents.chatThreadId, runContext.chatThreadId),
        chatEventTypeIn([
          "output.message",
          "output.error",
          "run.failed",
          "run.cancelled",
        ]),
        isNotNull(canonicalChatEventContent()),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!event?.content) {
    throw new Error("GitHub chat delivery message is unavailable");
  }

  const [installation] = await args.db
    .select({
      installationId: githubInstallations.installationId,
    })
    .from(githubChatThreadRoutes)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, githubChatThreadRoutes.installationId),
    )
    .where(
      and(
        eq(githubChatThreadRoutes.installationId, payload.installationId),
        eq(githubChatThreadRoutes.repo, payload.repo),
        eq(githubChatThreadRoutes.subjectNumber, payload.subjectNumber),
        eq(githubChatThreadRoutes.userId, runContext.userId),
        eq(githubChatThreadRoutes.chatThreadId, runContext.chatThreadId),
        eq(githubInstallations.orgId, runContext.orgId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return {
    payload,
    run: runContext,
    messageContent: event.content,
    installation: installation?.installationId
      ? { ghInstallationId: installation.installationId }
      : undefined,
  };
}

function escapeGitHubSubText(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function formatGitHubComment(args: {
  readonly response: string;
  readonly logsUrl?: string;
  readonly footerText?: string;
  readonly triggerCommentBody?: string;
}): string {
  const parts: string[] = [];
  if (args.triggerCommentBody) {
    parts.push(
      args.triggerCommentBody
        .split("\n")
        .map((line) => {
          return `> ${line}`;
        })
        .join("\n"),
      "",
    );
  }
  const footerParts: string[] = [];
  if (args.logsUrl) {
    footerParts.push(`📋 [Audit](${args.logsUrl})`);
  }
  if (args.footerText) {
    footerParts.push(escapeGitHubSubText(args.footerText));
  }
  parts.push(
    footerParts.length > 0
      ? `${args.response}\n\n<sub>${footerParts.join(" · ")}</sub>`
      : args.response,
  );
  return parts.join("\n");
}

async function githubAccessToken(
  args: {
    readonly ghInstallationId: string;
  },
  signal: AbortSignal,
): Promise<string> {
  const appId = optionalEnv("GITHUB_APP_ID");
  const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !privateKey) {
    throw new Error("GitHub App not configured");
  }
  const { token } = await getGithubInstallationAccessToken(
    {
      appId,
      privateKey,
      installationId: args.ghInstallationId,
    },
    signal,
  );
  return token;
}

async function buildGitHubDeliveryComment(
  args: {
    readonly db: Db;
    readonly runId: string;
    readonly run: GitHubChatRunContext;
    readonly target: GitHubDeliveryTarget;
    readonly messageContent: string;
  },
  signal: AbortSignal,
): Promise<string> {
  const featureContext = await loadUserFeatureSwitchContext(
    args.db,
    args.run.orgId,
    args.run.userId,
  );
  signal.throwIfAborted();
  const logsUrl = isFeatureEnabled(FeatureSwitchKey.OkouDebug, featureContext)
    ? `${env("APP_URL")}/activities/${encodeURIComponent(args.runId)}`
    : undefined;
  const footerText = await resolveGithubAgentReplyFooterText({
    db: args.db,
    orgId: args.run.orgId,
    runId: args.runId,
    installationId: args.target.installationId,
    agentId: args.target.agentId,
  });
  signal.throwIfAborted();
  return formatGitHubComment({
    response: args.messageContent,
    logsUrl,
    footerText,
    triggerCommentBody: args.target.triggerCommentBody,
  });
}

async function deliverClaimedGitHubChatCallback(
  args: {
    readonly db: Db;
    readonly callback: ClaimedGitHubChatDelivery;
    readonly status: "completed" | "failed";
  },
  signal: AbortSignal,
): Promise<"delivered" | "skipped_revoked"> {
  const context = await loadGitHubChatDeliveryContext(args, signal);
  if (!context.installation) {
    return "skipped_revoked";
  }
  const token = await githubAccessToken(
    {
      ghInstallationId: context.installation.ghInstallationId,
    },
    signal,
  );
  const body = await buildGitHubDeliveryComment(
    {
      db: args.db,
      runId: args.callback.runId,
      run: context.run,
      target: context.payload,
      messageContent: await snapshotIntegrationReply(
        {
          db: args.db,
          runId: args.callback.runId,
          deliveryKey: `callback:${args.callback.id}`,
          publicBrand: context.payload.publicBrand,
          content: context.messageContent,
        },
        signal,
      ),
    },
    signal,
  );
  await postGithubIssueComment(
    {
      token,
      repo: context.payload.repo,
      issueNumber: context.payload.subjectNumber,
      body,
    },
    signal,
  );
  signal.throwIfAborted();
  if (context.payload.triggerCommentId && context.payload.triggerReactionId) {
    await removeGithubCommentReaction(
      {
        token,
        repo: context.payload.repo,
        commentId: context.payload.triggerCommentId,
        reactionId: context.payload.triggerReactionId,
      },
      signal,
    );
    signal.throwIfAborted();
  }
  return "delivered";
}

export async function dispatchGitHubChatDeliveryOnce(
  db: Db,
  callbackId: string,
  status: "completed" | "failed",
  signal: AbortSignal,
): Promise<void> {
  const startedAt = now();
  signal.throwIfAborted();
  const callback = await claimGitHubChatDelivery(db, callbackId);
  if (!callback) {
    return;
  }
  const delivery = await settleIncludingAbort(
    deliverClaimedGitHubChatCallback(
      {
        db,
        callback,
        status,
      },
      signal,
    ),
  );
  if (!delivery.ok) {
    const message =
      delivery.error instanceof Error
        ? delivery.error.message
        : "Unknown error";
    await markFailed(db, callbackId, message);
    recordDelivery({
      runId: callback.runId,
      startedAt,
      success: false,
      outcome: "failed",
    });
    L.warn("Canonical GitHub delivery failed", {
      callbackId,
      runId: callback.runId,
      error: delivery.error,
    });
    return;
  }
  await markDelivered(db, callbackId);
  recordDelivery({
    runId: callback.runId,
    startedAt,
    success: true,
    outcome: delivery.value,
  });
}

export async function deliverGitHubChatAdmissionFailure(
  args: {
    readonly db: Db;
    readonly chatThreadId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly target: GitHubDeliveryTarget;
    readonly chatEventId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const [event] = await args.db
    .select({ content: canonicalChatEventContent() })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, args.chatEventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        chatEventTypeIn(["output.error"]),
        isNotNull(canonicalChatEventContent()),
      ),
    )
    .limit(1);
  const [binding] = await args.db
    .select({ ghInstallationId: githubInstallations.installationId })
    .from(githubChatThreadRoutes)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, githubChatThreadRoutes.installationId),
    )
    .where(
      and(
        eq(githubChatThreadRoutes.installationId, args.target.installationId),
        eq(githubChatThreadRoutes.repo, args.target.repo),
        eq(githubChatThreadRoutes.subjectNumber, args.target.subjectNumber),
        eq(githubChatThreadRoutes.userId, args.userId),
        eq(githubChatThreadRoutes.chatThreadId, args.chatThreadId),
        eq(githubInstallations.orgId, args.orgId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!event?.content || !binding?.ghInstallationId) {
    return;
  }
  const token = await githubAccessToken(
    {
      ghInstallationId: binding.ghInstallationId,
    },
    signal,
  );
  const body = formatGitHubComment({
    response: event.content,
    triggerCommentBody: args.target.triggerCommentBody,
  });
  await postGithubIssueComment(
    {
      token,
      repo: args.target.repo,
      issueNumber: args.target.subjectNumber,
      body,
    },
    signal,
  );
  signal.throwIfAborted();
  if (args.target.triggerCommentId && args.target.triggerReactionId) {
    await removeGithubCommentReaction(
      {
        token,
        repo: args.target.repo,
        commentId: args.target.triggerCommentId,
        reactionId: args.target.triggerReactionId,
      },
      signal,
    );
  }
}
