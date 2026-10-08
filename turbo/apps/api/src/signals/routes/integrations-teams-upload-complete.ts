import { command } from "ccstate";
import { env } from "../../lib/env";
import {
  integrationsTeamsUploadCompleteContract,
  type TeamsUploadCompleteBody,
} from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { sendTeamsMessage } from "../external/teams-bot-client";
import {
  materializeUploadedArtifact$,
  uploadedArtifactFetchUrl$,
} from "../services/uploaded-artifact.service";
import { recordTeamsUploadedFile$ } from "../services/run-uploaded-files.service";
import {
  loadInstallation,
  resolveTeamsMessageTarget,
  routeError,
  teamsErrorResponse,
} from "../services/teams-message-target.service";
import type { RouteEntry } from "../route-entry";

interface UploadedFileInfo {
  readonly key: string;
  readonly size: number;
  readonly filename: string;
  readonly fileUrl: string;
}

function buildTeamsFileText(args: {
  readonly body: TeamsUploadCompleteBody;
  readonly file: UploadedFileInfo;
}): string {
  const fileLink = `[${args.file.filename}](${args.file.fileUrl})`;
  return [args.body.text, fileLink]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

function buildMetadata(args: {
  readonly body: TeamsUploadCompleteBody;
  readonly conversationId: string;
  readonly s3Key: string;
  readonly sourceUrl: string;
  readonly teamsActivityId: string | undefined;
}): Record<string, unknown> {
  return {
    conversationId: args.conversationId,
    uploadId: args.body.uploadId,
    s3Key: args.s3Key,
    sourceUrl: args.sourceUrl,
    ...(args.body.activityId ? { activityId: args.body.activityId } : {}),
    ...(args.body.text ? { text: args.body.text } : {}),
    teamsMessage: args.teamsActivityId
      ? { activityId: args.teamsActivityId }
      : {},
  };
}

const complete$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const runId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;
  const bodyResult = await get(
    bodyResultOf(integrationsTeamsUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const db = set(writeDb$);
  const installation = await loadInstallation(db, auth.orgId);
  signal.throwIfAborted();
  if (!installation) {
    return routeError(
      404,
      "No Microsoft Teams installation found for this organization",
      "NOT_FOUND",
    );
  }
  if (!installation.serviceUrl) {
    return routeError(
      404,
      "Microsoft Teams installation has no service URL yet. Send a message to the Teams bot first.",
      "NOT_FOUND",
    );
  }

  const object = await set(
    materializeUploadedArtifact$,
    { userId: auth.userId, orgId: auth.orgId, id: body.uploadId },
    signal,
  );
  if (!object) {
    return routeError(404, "Uploaded file not found", "NOT_FOUND");
  }

  const target = await resolveTeamsMessageTarget(
    {
      db,
      installation,
      userId: auth.userId,
      body,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in target) {
    return target;
  }

  const file: UploadedFileInfo = {
    key: object.key,
    size: object.size,
    filename: object.filename,
    fileUrl: object.url,
  };
  const mimetype = body.contentType ?? object.contentType;

  const fetchUrl = await set(uploadedArtifactFetchUrl$, object, signal);
  signal.throwIfAborted();
  const result = await sendTeamsMessage(
    {
      serviceUrl: installation.serviceUrl,
      conversationId: target.conversationId,
      activityId: target.activityId,
      tenantId: installation.teamsTenantId,
      text: buildTeamsFileText({
        body,
        file: { ...file, fileUrl: new URL(file.fileUrl, env("APP_URL")).href },
      }),
      attachments: [
        {
          contentType: mimetype,
          contentUrl: fetchUrl,
          name: file.filename,
        },
      ],
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind === "teams-error") {
    return teamsErrorResponse(result);
  }

  const externalId =
    result.activityId ?? `${target.conversationId}:${body.uploadId}`;
  await set(
    recordTeamsUploadedFile$,
    {
      runId,
      externalId,
      userId: auth.userId,
      orgId: auth.orgId,
      filename: file.filename,
      contentType: mimetype,
      sizeBytes: file.size,
      url: file.fileUrl,
      layout: object.layout,
      metadata: buildMetadata({
        body,
        conversationId: target.conversationId,
        s3Key: file.key,
        sourceUrl: file.fileUrl,
        teamsActivityId: result.activityId,
      }),
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      activityId: result.activityId,
      conversationId: target.conversationId,
      filename: file.filename,
      mimetype,
      size: file.size,
      url: file.fileUrl,
    },
  };
});

const teamsWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "teams:write",
} as const;

export const integrationsTeamsUploadCompleteRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTeamsUploadCompleteContract.complete,
    handler: authRoute(teamsWriteAuth, complete$),
  },
];
