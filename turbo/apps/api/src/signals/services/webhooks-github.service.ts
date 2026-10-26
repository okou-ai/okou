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
import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  type infer as zInfer,
  type ZodType,
} from "zod";

import { logger } from "../../lib/log";
import { db$, writeDb$ } from "../external/db";
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

const gitHubUserSchema = object({
  id: number(),
  login: string(),
  type: string(),
});

const gitHubLabelSchema = object({
  id: number(),
  name: string(),
});

const gitHubPullRequestMarkerSchema = object({}).passthrough();

const gitHubIssueSchema = object({
  number: number(),
  title: string(),
  body: string().nullable(),
  html_url: string().optional(),
  created_at: string().optional(),
  updated_at: string().optional(),
  labels: array(gitHubLabelSchema),
  user: gitHubUserSchema,
  pull_request: gitHubPullRequestMarkerSchema.optional(),
});

const gitHubCommentSchema = object({
  id: number(),
  body: string(),
  html_url: string().optional(),
  created_at: string().optional(),
  user: gitHubUserSchema,
  author_association: string().optional(),
});

const gitHubRepositorySchema = object({
  id: number().optional(),
  full_name: string(),
});

const gitHubInstallationRefSchema = object({
  id: number(),
});

export const gitHubIssueCommentEventSchema = object({
  action: string(),
  issue: gitHubIssueSchema,
  comment: gitHubCommentSchema,
  repository: gitHubRepositorySchema,
  installation: gitHubInstallationRefSchema,
  sender: gitHubUserSchema,
});

export const gitHubWorkflowJobActionSchema = object({
  action: string(),
});

export const gitHubWorkflowJobEventSchema: ZodType<GithubWorkflowJobEventPayload> =
  object({
    action: literal("completed"),
    workflow_job: object({
      id: number(),
      run_id: number(),
      workflow_name: string().nullable(),
      head_branch: string().nullable(),
      head_sha: string(),
      run_url: string(),
      run_attempt: number(),
      name: string(),
      status: string(),
      conclusion: githubWorkflowRunConclusionSchema.nullable(),
      html_url: string(),
      labels: array(string()),
      runner_id: number().nullable().default(null),
      runner_name: string().nullable().default(null),
      runner_group_id: number().nullable().default(null),
      runner_group_name: string().nullable().default(null),
    }),
    repository: gitHubRepositorySchema,
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

export const gitHubPullRequestReviewActionSchema = object({
  action: string(),
});

export const gitHubPullRequestReviewEventSchema: ZodType<GithubPullRequestReviewEventPayload> =
  object({
    action: literal("submitted"),
    review: object({
      id: number(),
      user: gitHubUserSchema,
      state: githubPullRequestReviewStateSchema,
      html_url: string(),
      commit_id: string(),
      submitted_at: string().nullable().default(null),
      author_association: string(),
    }),
    pull_request: object({
      number: number(),
      title: string(),
      html_url: string(),
      draft: boolean(),
      base: object({ ref: string() }),
      head: object({ ref: string() }),
    }),
    repository: gitHubRepositorySchema,
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

const gitHubAppReferenceSchema = object({
  id: number(),
  slug: string().nullable(),
  name: string().nullable(),
});

export const gitHubDeploymentStatusEventSchema: ZodType<GithubDeploymentStatusEventPayload> =
  object({
    action: string(),
    deployment_status: object({
      id: number(),
      state: githubDeploymentStateSchema,
      environment: string().nullable().default(null),
      environment_url: string().nullable().default(null),
      log_url: string().nullable().default(null),
      creator: gitHubUserSchema.nullable().default(null),
    }),
    deployment: object({
      id: number(),
      ref: string(),
      sha: string(),
      task: string(),
      environment: string(),
      production_environment: boolean(),
      transient_environment: boolean(),
      creator: gitHubUserSchema.nullable().default(null),
      performed_via_github_app: gitHubAppReferenceSchema
        .nullable()
        .default(null),
    }),
    repository: gitHubRepositorySchema,
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

export const gitHubPullRequestEventSchema: ZodType<GithubPullRequestEventPayload> =
  object({
    action: string(),
    pull_request: object({
      number: number(),
      title: string(),
      html_url: string(),
      draft: boolean(),
      merged: boolean().nullable().default(null),
      merged_at: string().nullable().default(null),
      merge_commit_sha: string().nullable().default(null),
      merged_by: gitHubUserSchema.nullable().default(null),
      user: gitHubUserSchema,
      base: object({ ref: string() }),
      head: object({ ref: string(), sha: string() }),
      labels: array(gitHubLabelSchema),
    }),
    label: gitHubLabelSchema.optional(),
    repository: gitHubRepositorySchema,
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

export const gitHubWorkflowRunEventSchema: ZodType<GithubWorkflowRunEventPayload> =
  object({
    action: string(),
    workflow_run: object({
      id: number(),
      workflow_id: number(),
      name: string().nullable(),
      path: string(),
      run_number: number(),
      run_attempt: number(),
      status: string(),
      conclusion: githubWorkflowRunConclusionSchema.nullable(),
      head_branch: string().nullable(),
      head_sha: string(),
      event: string(),
      html_url: string(),
      actor: gitHubUserSchema.nullable(),
      triggering_actor: gitHubUserSchema.nullable(),
      pull_requests: array(object({ number: number() })),
    }),
    repository: object({
      id: number(),
      full_name: string(),
    }),
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

const gitHubInstallationAccountSchema = object({
  id: number(),
  login: string(),
  type: string(),
});

export const gitHubInstallationEventSchema = object({
  action: string(),
  installation: object({
    id: number(),
    account: gitHubInstallationAccountSchema,
  }),
  sender: object({
    id: number(),
    login: string(),
  }).optional(),
});

type GitHubIssueCommentEvent = zInfer<typeof gitHubIssueCommentEventSchema>;
type GitHubInstallationEvent = zInfer<typeof gitHubInstallationEventSchema>;

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

const loadGithubChangedUserIds$ = command(
  async (
    { get },
    args: {
      readonly installationId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    const db = get(db$);
    const links = await db
      .select({ userId: githubUserLinks.userId })
      .from(githubUserLinks)
      .where(eq(githubUserLinks.installationId, args.installationId));
    signal.throwIfAborted();

    const admins = await db
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
  },
);

const cleanupDeletedGithubInstallation$ = command(
  async (
    { get, set },
    args: {
      readonly ghInstallationId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = get(db$);
    const [installation] = await db
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

    const userIds = await set(
      loadGithubChangedUserIds$,
      {
        installationId: installation.id,
        orgId: installation.orgId,
      },
      signal,
    );

    await set(writeDb$)
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
  },
);

export const handleGithubInstallationEvent$ = command(
  async (
    { set },
    payload: GitHubInstallationEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    set(writeDb$);
    const ghInstallationId = String(payload.installation.id);

    if (payload.action === "deleted") {
      await set(
        cleanupDeletedGithubInstallation$,
        {
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
