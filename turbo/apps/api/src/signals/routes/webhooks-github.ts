import { createHmac, timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import { webhookGithubContract } from "@okouai/api-contracts/contracts/webhooks";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route-entry";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { now } from "../../lib/time";
import { safeJsonParse, safeSync, tapError } from "../utils";
import {
  gitHubDeploymentStatusEventSchema,
  gitHubInstallationEventSchema,
  gitHubIssueCommentEventSchema,
  gitHubPullRequestReviewActionSchema,
  gitHubPullRequestReviewEventSchema,
  gitHubPullRequestEventSchema,
  gitHubWorkflowJobEventSchema,
  gitHubWorkflowRunEventSchema,
  handleGithubDeploymentStatusEvent$,
  handleGithubInstallationEvent$,
  handleGithubIssueCommentEvent$,
  handleGithubPullRequestReviewEvent$,
  handleGithubPullRequestEvent$,
  handleGithubWorkflowJobEvent$,
  handleGithubWorkflowRunEvent$,
} from "../services/webhooks-github.service";

const L = logger("WebhookGithubRoute");

interface GithubWebhookHeaders {
  readonly signature: string;
  readonly event: string;
  readonly deliveryId: string;
}

function jsonError(message: string, status: 400 | 401 | 503): Response {
  return Response.json({ error: message }, { status });
}

function githubWebhookHeaders(headers: Headers): GithubWebhookHeaders | null {
  const signature = headers.get("x-hub-signature-256");
  const event = headers.get("x-github-event");
  const deliveryId = headers.get("x-github-delivery");
  return signature && event && deliveryId
    ? { signature, event, deliveryId }
    : null;
}

function verifyGitHubWebhookSignature(args: {
  readonly secret: string;
  readonly signature: string;
  readonly body: string;
}): boolean {
  const expected = `sha256=${createHmac("sha256", args.secret)
    .update(args.body)
    .digest("hex")}`;

  const result = safeSync(() => {
    return timingSafeEqual(Buffer.from(args.signature), Buffer.from(expected));
  });
  return "ok" in result ? result.ok : false;
}

const postGithubWorkflowRunWebhook$ = command(
  (
    { set },
    args: {
      readonly payload: unknown;
      readonly deliveryId: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Response => {
    const parsed = gitHubWorkflowRunEventSchema.safeParse(args.payload);
    if (!parsed.success) {
      L.error("Invalid workflow_run event payload", {
        error: parsed.error,
      });
      return jsonError("Invalid payload structure", 400);
    }

    const backgroundScheduledAt = now();
    waitUntil(
      tapError(
        set(
          handleGithubWorkflowRunEvent$,
          {
            payload: parsed.data,
            deliveryId: args.deliveryId,
            apiStartTime: args.apiStartTime,
            backgroundScheduledAt,
          },
          signal,
        ),
        (error) => {
          L.error("Error handling workflow_run event", { error });
        },
      ),
    );
    return new Response("OK", { status: 200 });
  },
);

const postGithubInstallationWebhook$ = command(
  ({ set }, payload: unknown, signal: AbortSignal): Response => {
    const parsed = gitHubInstallationEventSchema.safeParse(payload);
    if (!parsed.success) {
      L.error("Invalid installation event payload", { error: parsed.error });
      return jsonError("Invalid payload structure", 400);
    }

    waitUntil(
      tapError(
        set(handleGithubInstallationEvent$, parsed.data, signal),
        (error) => {
          L.error("Error handling installation event", { error });
        },
      ),
    );
    return new Response("OK", { status: 200 });
  },
);

interface GithubBackgroundWebhookArgs {
  readonly payload: unknown;
  readonly deliveryId: string;
  readonly apiStartTime: number;
}

const postGithubPullRequestWebhook$ = command(
  (
    { set },
    args: GithubBackgroundWebhookArgs,
    signal: AbortSignal,
  ): Response => {
    const parsed = gitHubPullRequestEventSchema.safeParse(args.payload);
    if (!parsed.success) {
      L.error("Invalid pull_request event payload", { error: parsed.error });
      return jsonError("Invalid payload structure", 400);
    }
    waitUntil(
      tapError(
        set(
          handleGithubPullRequestEvent$,
          {
            payload: parsed.data,
            deliveryId: args.deliveryId,
            apiStartTime: args.apiStartTime,
            backgroundScheduledAt: now(),
          },
          signal,
        ),
        (error) => {
          L.error("Error handling pull_request event", { error });
        },
      ),
    );
    return new Response("OK", { status: 200 });
  },
);

const postGithubIssueCommentWebhook$ = command(
  (
    { set },
    args: GithubBackgroundWebhookArgs,
    signal: AbortSignal,
  ): Response => {
    const parsed = gitHubIssueCommentEventSchema.safeParse(args.payload);
    if (!parsed.success) {
      L.error("Invalid issue_comment event payload", { error: parsed.error });
      return jsonError("Invalid payload structure", 400);
    }
    waitUntil(
      tapError(
        set(
          handleGithubIssueCommentEvent$,
          {
            payload: parsed.data,
            deliveryId: args.deliveryId,
            apiStartTime: args.apiStartTime,
            backgroundScheduledAt: now(),
          },
          signal,
        ),
        (error) => {
          L.error("Error handling issue_comment event", { error });
        },
      ),
    );
    return new Response("OK", { status: 200 });
  },
);

const postGithubWorkflowJobWebhook$ = command(
  (
    { set },
    args: GithubBackgroundWebhookArgs,
    signal: AbortSignal,
  ): Response => {
    const parsed = gitHubWorkflowJobEventSchema.safeParse(args.payload);
    if (!parsed.success) {
      L.error("Invalid workflow_job event payload", { error: parsed.error });
      return jsonError("Invalid payload structure", 400);
    }
    waitUntil(
      tapError(
        set(
          handleGithubWorkflowJobEvent$,
          {
            payload: parsed.data,
            deliveryId: args.deliveryId,
            apiStartTime: args.apiStartTime,
            backgroundScheduledAt: now(),
          },
          signal,
        ),
        (error) => {
          L.error("Error handling workflow_job event", { error });
        },
      ),
    );
    return new Response("OK", { status: 200 });
  },
);

const postGithubPullRequestReviewWebhook$ = command(
  (
    { set },
    args: GithubBackgroundWebhookArgs,
    signal: AbortSignal,
  ): Response => {
    const action = gitHubPullRequestReviewActionSchema.safeParse(args.payload);
    if (!action.success) {
      L.error("Invalid pull_request_review event payload", {
        error: action.error,
      });
      return jsonError("Invalid payload structure", 400);
    }
    if (action.data.action !== "submitted") {
      L.debug("Ignoring unhandled pull_request_review action", {
        action: action.data.action,
      });
      return new Response("OK", { status: 200 });
    }

    const parsed = gitHubPullRequestReviewEventSchema.safeParse(args.payload);
    if (!parsed.success) {
      L.error("Invalid pull_request_review event payload", {
        error: parsed.error,
      });
      return jsonError("Invalid payload structure", 400);
    }
    waitUntil(
      tapError(
        set(
          handleGithubPullRequestReviewEvent$,
          {
            payload: parsed.data,
            deliveryId: args.deliveryId,
            apiStartTime: args.apiStartTime,
            backgroundScheduledAt: now(),
          },
          signal,
        ),
        (error) => {
          L.error("Error handling pull_request_review event", { error });
        },
      ),
    );
    return new Response("OK", { status: 200 });
  },
);

const postGithubDeploymentStatusWebhook$ = command(
  (
    { set },
    args: GithubBackgroundWebhookArgs,
    signal: AbortSignal,
  ): Response => {
    const parsed = gitHubDeploymentStatusEventSchema.safeParse(args.payload);
    if (!parsed.success) {
      L.error("Invalid deployment_status event payload", {
        error: parsed.error,
      });
      return jsonError("Invalid payload structure", 400);
    }
    waitUntil(
      tapError(
        set(
          handleGithubDeploymentStatusEvent$,
          {
            payload: parsed.data,
            deliveryId: args.deliveryId,
            apiStartTime: args.apiStartTime,
            backgroundScheduledAt: now(),
          },
          signal,
        ),
        (error) => {
          L.error("Error handling deployment_status event", { error });
        },
      ),
    );
    return new Response("OK", { status: 200 });
  },
);

const postGithubWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const apiStartTime = now();
    const webhookSecret = optionalEnv("GITHUB_APP_WEBHOOK_SECRET");

    if (!webhookSecret) {
      return jsonError("GitHub App integration is not configured", 503);
    }

    const request = get(request$);
    const headers = githubWebhookHeaders(request.raw.headers);
    if (!headers) {
      return jsonError("Missing GitHub webhook headers", 401);
    }

    const body = await request.text();
    signal.throwIfAborted();

    const signatureVerified = await verifyGitHubWebhookSignature({
      secret: webhookSecret,
      signature: headers.signature,
      body,
    });
    signal.throwIfAborted();

    if (!signatureVerified) {
      return jsonError("Invalid signature", 401);
    }

    const payload = safeJsonParse(body);
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return jsonError("Invalid JSON payload", 400);
    }

    if (headers.event === "ping") {
      return Response.json({ message: "pong" });
    }

    const backgroundArgs = {
      payload,
      deliveryId: headers.deliveryId,
      apiStartTime,
    };

    if (headers.event === "pull_request") {
      return await set(postGithubPullRequestWebhook$, backgroundArgs, signal);
    }

    if (headers.event === "issue_comment") {
      return await set(postGithubIssueCommentWebhook$, backgroundArgs, signal);
    }

    if (headers.event === "workflow_job") {
      return await set(postGithubWorkflowJobWebhook$, backgroundArgs, signal);
    }

    if (headers.event === "pull_request_review") {
      return await set(
        postGithubPullRequestReviewWebhook$,
        backgroundArgs,
        signal,
      );
    }

    if (headers.event === "deployment_status") {
      return await set(
        postGithubDeploymentStatusWebhook$,
        backgroundArgs,
        signal,
      );
    }

    if (headers.event === "workflow_run") {
      return await set(
        postGithubWorkflowRunWebhook$,
        {
          payload,
          deliveryId: headers.deliveryId,
          apiStartTime,
        },
        signal,
      );
    }

    if (headers.event === "installation") {
      return await set(postGithubInstallationWebhook$, payload, signal);
    }

    L.debug("Ignoring unhandled GitHub event", { event: headers.event });
    return new Response("OK", { status: 200 });
  },
);

export const webhooksGithubRoutes: readonly RouteEntry[] = [
  {
    route: webhookGithubContract.post,
    handler: postGithubWebhook$,
  },
];
