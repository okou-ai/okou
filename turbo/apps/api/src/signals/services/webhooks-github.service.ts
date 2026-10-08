import {
  githubDeploymentStateSchema,
  githubPullRequestReviewStateSchema,
  githubWorkflowRunConclusionSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { githubInstallations } from "@okouai/db/schema/github-installation";
import { githubUserLinks } from "@okouai/db/schema/github-user-link";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import {
  dispatchGithubWebhookAutomations$,
  type GithubDeploymentStatusEventPayload,
  type GithubIssueCommentEventPayload,
  type GithubPullRequestEventPayload,
  type GithubPullRequestReviewEventPayload,
  type GithubWorkflowJobEventPayload,
} from "./github-webhook-automation-event.service";
import {
  dispatchGithubWorkflowRunAutomations$,
  type GithubWorkflowRunEventPayload,
} from "./github-workflow-run-event.service";

const L = logger("WebhookGithub");

const gitHubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  type: z.string(),
});

const gitHubLabelSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const gitHubPullRequestMarkerSchema = z.object({}).passthrough();

const gitHubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  labels: z.array(gitHubLabelSchema),
  user: gitHubUserSchema,
  pull_request: gitHubPullRequestMarkerSchema.optional(),
});

const gitHubCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  html_url: z.string().optional(),
  created_at: z.string().optional(),
  user: gitHubUserSchema,
  author_association: z.string().optional(),
});

const gitHubRepositorySchema = z.object({
  id: z.number().optional(),
  full_name: z.string(),
});

const gitHubInstallationRefSchema = z.object({
  id: z.number(),
});

export const gitHubIssueCommentEventSchema = z.object({
  action: z.string(),
  issue: gitHubIssueSchema,
  comment: gitHubCommentSchema,
  repository: gitHubRepositorySchema,
  installation: gitHubInstallationRefSchema,
  sender: gitHubUserSchema,
});

export const gitHubWorkflowJobEventSchema: z.ZodType<GithubWorkflowJobEventPayload> =
  z.object({
    action: z.string(),
    workflow_job: z.object({
      id: z.number(),
      run_id: z.number(),
      workflow_name: z.string().nullable(),
      head_branch: z.string().nullable(),
      head_sha: z.string(),
      run_url: z.string(),
      run_attempt: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: githubWorkflowRunConclusionSchema.nullable(),
      html_url: z.string(),
      labels: z.array(z.string()),
      runner_id: z.number().nullable().default(null),
      runner_name: z.string().nullable().default(null),
      runner_group_id: z.number().nullable().default(null),
      runner_group_name: z.string().nullable().default(null),
    }),
    repository: gitHubRepositorySchema,
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

export const gitHubPullRequestReviewActionSchema = z.object({
  action: z.string(),
});

export const gitHubPullRequestReviewEventSchema: z.ZodType<GithubPullRequestReviewEventPayload> =
  z.object({
    action: z.literal("submitted"),
    review: z.object({
      id: z.number(),
      user: gitHubUserSchema,
      state: githubPullRequestReviewStateSchema,
      html_url: z.string(),
      commit_id: z.string(),
      submitted_at: z.string().nullable().default(null),
      author_association: z.string(),
    }),
    pull_request: z.object({
      number: z.number(),
      title: z.string(),
      html_url: z.string(),
      draft: z.boolean(),
      base: z.object({ ref: z.string() }),
      head: z.object({ ref: z.string() }),
    }),
    repository: gitHubRepositorySchema,
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

const gitHubAppReferenceSchema = z.object({
  id: z.number(),
  slug: z.string().nullable(),
  name: z.string().nullable(),
});

export const gitHubDeploymentStatusEventSchema: z.ZodType<GithubDeploymentStatusEventPayload> =
  z.object({
    action: z.string(),
    deployment_status: z.object({
      id: z.number(),
      state: githubDeploymentStateSchema,
      environment: z.string().nullable().default(null),
      environment_url: z.string().nullable().default(null),
      log_url: z.string().nullable().default(null),
      creator: gitHubUserSchema.nullable().default(null),
    }),
    deployment: z.object({
      id: z.number(),
      ref: z.string(),
      sha: z.string(),
      task: z.string(),
      environment: z.string(),
      production_environment: z.boolean(),
      transient_environment: z.boolean(),
      creator: gitHubUserSchema.nullable().default(null),
      performed_via_github_app: gitHubAppReferenceSchema
        .nullable()
        .default(null),
    }),
    repository: gitHubRepositorySchema,
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

export const gitHubPullRequestEventSchema: z.ZodType<GithubPullRequestEventPayload> =
  z.object({
    action: z.string(),
    pull_request: z.object({
      number: z.number(),
      title: z.string(),
      html_url: z.string(),
      draft: z.boolean(),
      merged: z.boolean().nullable().default(null),
      merged_at: z.string().nullable().default(null),
      merge_commit_sha: z.string().nullable().default(null),
      merged_by: gitHubUserSchema.nullable().default(null),
      user: gitHubUserSchema,
      base: z.object({ ref: z.string() }),
      head: z.object({ ref: z.string(), sha: z.string() }),
      labels: z.array(gitHubLabelSchema),
    }),
    label: gitHubLabelSchema.optional(),
    repository: gitHubRepositorySchema,
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

export const gitHubWorkflowRunEventSchema: z.ZodType<GithubWorkflowRunEventPayload> =
  z.object({
    action: z.string(),
    workflow_run: z.object({
      id: z.number(),
      workflow_id: z.number(),
      name: z.string().nullable(),
      path: z.string(),
      run_number: z.number(),
      run_attempt: z.number(),
      status: z.string(),
      conclusion: githubWorkflowRunConclusionSchema.nullable(),
      head_branch: z.string().nullable(),
      head_sha: z.string(),
      event: z.string(),
      html_url: z.string(),
      actor: gitHubUserSchema.nullable(),
      triggering_actor: gitHubUserSchema.nullable(),
      pull_requests: z.array(z.object({ number: z.number() })),
    }),
    repository: z.object({
      id: z.number(),
      full_name: z.string(),
    }),
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

const gitHubInstallationAccountSchema = z.object({
  id: z.number(),
  login: z.string(),
  type: z.string(),
});

export const gitHubInstallationEventSchema = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    account: gitHubInstallationAccountSchema,
  }),
  sender: z
    .object({
      id: z.number(),
      login: z.string(),
    })
    .optional(),
});

type GitHubIssueCommentEvent = z.infer<typeof gitHubIssueCommentEventSchema>;
type GitHubInstallationEvent = z.infer<typeof gitHubInstallationEventSchema>;

export const handleGithubPullRequestEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GithubPullRequestEventPayload;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchGithubWebhookAutomations$,
      {
        deliveryId: args.deliveryId,
        event: {
          eventType: "github-pull-request",
          webhookEvent: "pull_request",
          payload: args.payload,
        },
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
  },
);

export const handleGithubWorkflowRunEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GithubWorkflowRunEventPayload;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchGithubWorkflowRunAutomations$,
      {
        deliveryId: args.deliveryId,
        payload: args.payload,
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
  },
);

export const handleGithubWorkflowJobEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GithubWorkflowJobEventPayload;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchGithubWebhookAutomations$,
      {
        deliveryId: args.deliveryId,
        event: {
          eventType: "github-workflow-job-completed",
          webhookEvent: "workflow_job",
          payload: args.payload,
        },
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
  },
);

export const handleGithubPullRequestReviewEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GithubPullRequestReviewEventPayload;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchGithubWebhookAutomations$,
      {
        deliveryId: args.deliveryId,
        event: {
          eventType: "github-pull-request-review-submitted",
          webhookEvent: "pull_request_review",
          payload: args.payload,
        },
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
  },
);

export const handleGithubDeploymentStatusEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GithubDeploymentStatusEventPayload;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchGithubWebhookAutomations$,
      {
        deliveryId: args.deliveryId,
        event: {
          eventType: "github-deployment-status-created",
          webhookEvent: "deployment_status",
          payload: args.payload,
        },
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
  },
);

export const handleGithubIssueCommentEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GitHubIssueCommentEvent;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { payload } = args;
    await set(
      dispatchGithubWebhookAutomations$,
      {
        deliveryId: args.deliveryId,
        event: {
          eventType: "github-issue-comment-created",
          webhookEvent: "issue_comment",
          payload: payload as GithubIssueCommentEventPayload,
        },
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
  },
);

async function loadGithubChangedUserIds(
  args: {
    readonly db: Db;
    readonly installationId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<readonly string[]> {
  const links = await args.db
    .select({ userId: githubUserLinks.userId })
    .from(githubUserLinks)
    .where(eq(githubUserLinks.installationId, args.installationId));
  signal.throwIfAborted();

  const admins = await args.db
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, args.orgId),
        eq(orgMembersCache.role, "admin"),
      ),
    );
  signal.throwIfAborted();

  return Array.from(
    new Set(
      [...links, ...admins].map((row) => {
        return row.userId;
      }),
    ),
  );
}

async function cleanupDeletedGithubInstallation(
  args: {
    readonly db: Db;
    readonly ghInstallationId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [installation] = await args.db
    .select({ id: githubInstallations.id, orgId: githubInstallations.orgId })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, args.ghInstallationId))
    .limit(1);
  signal.throwIfAborted();

  if (!installation) {
    L.debug("No GitHub installation found for deleted event", {
      installationId: args.ghInstallationId,
    });
    return false;
  }

  const userIds = await loadGithubChangedUserIds(
    {
      db: args.db,
      installationId: installation.id,
      orgId: installation.orgId,
    },
    signal,
  );

  await args.db
    .delete(githubInstallations)
    .where(eq(githubInstallations.id, installation.id));
  signal.throwIfAborted();

  if (userIds.length > 0) {
    await publishUserSignal(userIds, "github:changed");
    signal.throwIfAborted();
  }

  L.debug("Cleaned up deleted GitHub installation", {
    installationId: args.ghInstallationId,
    recordId: installation.id,
  });
  return true;
}

export const handleGithubInstallationEvent$ = command(
  async (
    { set },
    payload: GitHubInstallationEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const ghInstallationId = String(payload.installation.id);

    if (payload.action === "deleted") {
      await cleanupDeletedGithubInstallation(
        {
          db,
          ghInstallationId,
        },
        signal,
      );
      return;
    }

    if (payload.action !== "created") {
      L.debug("Ignoring installation event", { action: payload.action });
      return;
    }

    L.debug("Ignoring GitHub installation created event", {
      installationId: ghInstallationId,
      targetId: String(payload.installation.account.id),
    });
  },
);
