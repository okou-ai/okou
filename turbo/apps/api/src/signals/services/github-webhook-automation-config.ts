import {
  githubDeploymentStatusCreatedEventConfigSchema,
  githubIssueCommentCreatedEventConfigSchema,
  githubPullRequestEventConfigSchema,
  githubPullRequestReviewSubmittedEventConfigSchema,
  githubWorkflowJobCompletedEventConfigSchema,
  type GithubAutomationEventConfig,
  type WorkflowAutomationEventType,
} from "@okouai/api-contracts/contracts/workflows";

export type GithubWebhookAutomationEventType = Extract<
  WorkflowAutomationEventType,
  | "github-deployment-status-created"
  | "github-issue-comment-created"
  | "github-pull-request"
  | "github-pull-request-review-submitted"
  | "github-workflow-job-completed"
>;

export type GithubWebhookAutomationEventConfig = Extract<
  GithubAutomationEventConfig,
  | { readonly event: "deployment_status_created" }
  | { readonly event: "issue_comment_created" }
  | { readonly event: "pull_request" }
  | { readonly event: "pull_request_review_submitted" }
  | { readonly event: "workflow_job_completed" }
>;

export function parseGithubWebhookAutomationConfig(
  eventType: GithubWebhookAutomationEventType,
  eventConfig: unknown,
): GithubWebhookAutomationEventConfig | null {
  switch (eventType) {
    case "github-workflow-job-completed": {
      const parsed =
        githubWorkflowJobCompletedEventConfigSchema.safeParse(eventConfig);
      return parsed.success ? parsed.data : null;
    }
    case "github-pull-request": {
      const parsed = githubPullRequestEventConfigSchema.safeParse(eventConfig);
      return parsed.success ? parsed.data : null;
    }
    case "github-pull-request-review-submitted": {
      const parsed =
        githubPullRequestReviewSubmittedEventConfigSchema.safeParse(
          eventConfig,
        );
      return parsed.success ? parsed.data : null;
    }
    case "github-deployment-status-created": {
      const parsed =
        githubDeploymentStatusCreatedEventConfigSchema.safeParse(eventConfig);
      return parsed.success ? parsed.data : null;
    }
    case "github-issue-comment-created": {
      const parsed =
        githubIssueCommentCreatedEventConfigSchema.safeParse(eventConfig);
      return parsed.success ? parsed.data : null;
    }
  }
}
