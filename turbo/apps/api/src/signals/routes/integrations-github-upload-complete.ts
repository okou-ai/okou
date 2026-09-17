import { command } from "ccstate";
import { env } from "../../lib/env";
import {
  integrationsGithubUploadCompleteContract,
  type GithubUploadCompleteBody,
} from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import { materializeUploadedArtifact$ } from "../services/uploaded-artifact.service";
import { postGithubIssueComment } from "../services/github-issues-api.service";
import {
  getGithubIntegrationAccessToken,
  loadActiveGithubInstallationForOrg,
} from "../services/github-integration-files.service";
import { recordGithubUploadedFile$ } from "../services/run-uploaded-files.service";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";

function routeError<Status extends 404 | 502 | 500>(
  status: Status,
  message: string,
  code: string,
) {
  return { status, body: { error: { message, code } } };
}

function markdownLinkText(text: string): string {
  return text.replace(/\\/gu, String.raw`\\`).replace(/\]/gu, String.raw`\]`);
}

function buildCommentBody(args: {
  readonly filename: string;
  readonly fileUrl: string;
  readonly caption: string | undefined;
}): string {
  const link = `[${markdownLinkText(args.filename)}](${args.fileUrl})`;
  const caption = args.caption?.trim();
  return caption ? `${caption}\n\n${link}` : link;
}

function buildMetadata(args: {
  readonly body: GithubUploadCompleteBody;
  readonly s3Key: string;
  readonly sourceUrl: string;
  readonly commentId: string;
}): Record<string, unknown> {
  return {
    repo: args.body.repo,
    issueNumber: args.body.issueNumber,
    uploadId: args.body.uploadId,
    s3Key: args.s3Key,
    sourceUrl: args.sourceUrl,
    ...(args.body.caption ? { caption: args.body.caption } : {}),
    githubComment: { id: args.commentId },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const complete$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const runId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;
  const bodyResult = await get(
    bodyResultOf(integrationsGithubUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const db = get(db$);
  const installation = await loadActiveGithubInstallationForOrg({
    db,
    orgId: auth.orgId,
  });
  signal.throwIfAborted();
  if (!installation) {
    return routeError(404, "No GitHub installation found", "NOT_FOUND");
  }

  const token = await getGithubIntegrationAccessToken(
    {
      installation,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!token) {
    return routeError(404, "No GitHub installation found", "NOT_FOUND");
  }

  const object = await set(
    materializeUploadedArtifact$,
    { userId: auth.userId, orgId: auth.orgId, id: body.uploadId },
    signal,
  );
  if (!object) {
    return routeError(404, "Uploaded file not found", "NOT_FOUND");
  }

  const filename = object.filename;
  const fileUrl = object.url;
  const mimetype = body.contentType ?? object.contentType;
  const commentBody = buildCommentBody({
    filename,
    fileUrl: new URL(fileUrl, env("APP_URL")).href,
    caption: body.caption,
  });
  const commentResult = await settle(
    postGithubIssueComment(
      {
        token,
        repo: body.repo,
        issueNumber: body.issueNumber,
        body: commentBody,
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!commentResult.ok) {
    return routeError(
      502,
      `GitHub API error: ${errorMessage(commentResult.error)}`,
      "GITHUB_ERROR",
    );
  }
  const commentId = commentResult.value;

  await set(
    recordGithubUploadedFile$,
    {
      runId,
      externalId: commentId,
      userId: auth.userId,
      orgId: auth.orgId,
      filename,
      contentType: mimetype,
      sizeBytes: object.size,
      url: fileUrl,
      publicBrand: object.publicBrand,
      metadata: buildMetadata({
        body,
        s3Key: object.key,
        sourceUrl: fileUrl,
        commentId,
      }),
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      commentId,
      repo: body.repo,
      issueNumber: body.issueNumber,
      filename,
      mimetype,
      size: object.size,
      url: fileUrl,
    },
  };
});

const githubWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "github:write",
} as const;

export const integrationsGithubUploadCompleteRoutes: readonly RouteEntry[] = [
  {
    route: integrationsGithubUploadCompleteContract.complete,
    handler: authRoute(githubWriteAuth, complete$),
  },
];
