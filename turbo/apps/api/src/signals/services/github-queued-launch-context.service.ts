import { agents } from "@okouai/db/schema/agent";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatGithubContext } from "@okouai/db/schema/chat-github-context";
import { githubChatThreadRoutes } from "@okouai/db/schema/github-chat-thread-route";
import { githubInstallations } from "@okouai/db/schema/github-installation";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  githubDeliveryTargetSchema,
  type GitHubDeliveryTarget,
} from "./github-chat-callback-payload";
import { buildGitHubPrompt } from "./github-chat-prompt.service";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";

export interface GitHubQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly githubDelivery: GitHubDeliveryTarget;
  readonly publicBrand: PublicBrand;
}

type GitHubLaunchContextRow = Pick<
  typeof chatGithubContext.$inferSelect,
  | "repo"
  | "subjectNumber"
  | "subjectKind"
  | "triggerCommentId"
  | "issueContext"
  | "messageText"
  | "triggerReactionId"
  | "triggerCommentBody"
  | "publicBrand"
> & {
  readonly installationId: string;
  readonly appId: string | null;
  readonly appSlug: string | null;
  readonly agentId: string;
};

function requiredGitHubLaunchContext(row: GitHubLaunchContextRow | undefined) {
  if (!row || row.issueContext === null || row.messageText === null) {
    return null;
  }
  return {
    ...row,
    issueContext: row.issueContext,
    messageText: row.messageText,
  };
}

async function loadGitHubLaunchContext(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
) {
  const [row] = await db
    .select({
      repo: chatGithubContext.repo,
      subjectNumber: chatGithubContext.subjectNumber,
      subjectKind: chatGithubContext.subjectKind,
      triggerCommentId: chatGithubContext.triggerCommentId,
      issueContext: chatGithubContext.issueContext,
      messageText: chatGithubContext.messageText,
      triggerReactionId: chatGithubContext.triggerReactionId,
      triggerCommentBody: chatGithubContext.triggerCommentBody,
      publicBrand: chatGithubContext.publicBrand,
      installationId: githubChatThreadRoutes.installationId,
      appId: githubInstallations.appId,
      appSlug: githubInstallations.appSlug,
      agentId: agents.id,
    })
    .from(chatEvents)
    .innerJoin(
      chatGithubContext,
      and(
        eq(chatGithubContext.id, chatEvents.contextId),
        eq(chatGithubContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .innerJoin(
      githubChatThreadRoutes,
      and(
        eq(githubChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
        eq(githubChatThreadRoutes.repo, chatGithubContext.repo),
        eq(
          githubChatThreadRoutes.subjectNumber,
          chatGithubContext.subjectNumber,
        ),
        eq(githubChatThreadRoutes.userId, args.userId),
      ),
    )
    .innerJoin(
      githubInstallations,
      and(
        eq(githubInstallations.id, githubChatThreadRoutes.installationId),
        eq(githubInstallations.orgId, args.orgId),
      ),
    )
    .innerJoin(
      chatThreads,
      and(
        eq(chatThreads.id, chatEvents.chatThreadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatEvents.contextType, "github"),
      ),
    )
    .limit(1);
  return requiredGitHubLaunchContext(row);
}

export async function loadGitHubQueuedLaunchMaterial(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
): Promise<GitHubQueuedLaunchMaterial | null> {
  const context = await loadGitHubLaunchContext(db, args);
  if (!context) {
    return null;
  }
  return {
    prompt: context.messageText,
    publicBrand: context.publicBrand,
    appendSystemPrompt: buildGitHubPrompt({
      issueContext: context.issueContext,
      repo: context.repo,
      issueNumber: context.subjectNumber,
      subjectKind: context.subjectKind,
      appId: context.appId,
      appSlug: context.appSlug,
      integrationNote: resolveIntegrationNotePrompt({
        triggerSource: "github",
        featureSwitchContext: args.featureSwitchContext,
      }),
    }),
    githubDelivery: githubDeliveryTargetSchema.parse({
      installationId: context.installationId,
      repo: context.repo,
      subjectNumber: context.subjectNumber,
      subjectKind: context.subjectKind,
      agentId: context.agentId,
      ...(context.triggerCommentId !== null
        ? { triggerCommentId: context.triggerCommentId }
        : {}),
      ...(context.triggerReactionId !== null
        ? { triggerReactionId: context.triggerReactionId }
        : {}),
      ...(context.triggerCommentBody !== null
        ? { triggerCommentBody: context.triggerCommentBody }
        : {}),
    }),
  };
}
