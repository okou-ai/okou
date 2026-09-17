import { command } from "ccstate";
import {
  integrationsPhoneUploadCompleteContract,
  type PhoneUploadCompleteBody,
} from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../external/agentphone-client";
import {
  materializeUploadedArtifact$,
  uploadedArtifactFetchUrl,
} from "../services/uploaded-artifact.service";
import { recordAgentPhoneUploadedFile$ } from "../services/run-uploaded-files.service";
import {
  normalizeAgentPhoneHandle,
  resolveAgentPhoneAgentIdForUserLink,
  resolveAgentPhoneUserLinkForOwner,
  storeOutboundAgentPhoneMessage,
  type AgentPhoneChannel,
} from "../services/agentphone.service";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";

interface UploadedFileInfo {
  readonly key: string;
  readonly size: number;
  readonly filename: string;
  readonly fileUrl: string;
}

function routeError<Status extends 400 | 401 | 403 | 404 | 502>(
  status: Status,
  message: string,
  code: string,
) {
  return { status, body: { error: { message, code } } };
}

function uploadedFileNotFound() {
  return routeError(404, "Uploaded file not found", "NOT_FOUND");
}

function agentPhoneRouteError(error: unknown) {
  if (!isAgentPhoneApiError(error)) {
    return undefined;
  }
  return routeError(
    error.status >= 500 ? 502 : 400,
    `AgentPhone API error: ${error.body || `HTTP ${error.status}`}`,
    "AGENTPHONE_ERROR",
  );
}

function buildMetadata(params: {
  readonly body: PhoneUploadCompleteBody;
  readonly uploadId: string;
  readonly s3Key: string;
  readonly sourceUrl: string;
  readonly agentphoneMessageId: string;
}): Record<string, unknown> {
  return {
    toNumber: normalizeAgentPhoneHandle(params.body.toNumber, "sms"),
    uploadId: params.uploadId,
    s3Key: params.s3Key,
    sourceUrl: params.sourceUrl,
    ...(params.body.caption ? { caption: params.body.caption } : {}),
    agentphoneMessage: { id: params.agentphoneMessageId },
  };
}

const complete$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const runId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;
  const bodyResult = await get(
    bodyResultOf(integrationsPhoneUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const object = await set(
    materializeUploadedArtifact$,
    { userId: auth.userId, orgId: auth.orgId, id: body.uploadId },
    signal,
  );
  if (!object) {
    return uploadedFileNotFound();
  }

  const uploadedFile: UploadedFileInfo = {
    key: object.key,
    size: object.size,
    filename: object.filename,
    fileUrl: object.url,
  };

  const userChannel: AgentPhoneChannel = "sms";
  const phoneHandle = normalizeAgentPhoneHandle(body.toNumber, userChannel);
  const db = set(writeDb$);
  const userLink = await resolveAgentPhoneUserLinkForOwner(db, {
    phoneHandle,
    channel: userChannel,
    userId: auth.userId,
    orgId: auth.orgId,
  });
  signal.throwIfAborted();
  if (!userLink) {
    return routeError(404, "Connected phone handle not found", "NOT_FOUND");
  }

  const agentphoneAgentId = await resolveAgentPhoneAgentIdForUserLink(db, {
    userLinkId: userLink.id,
    phoneHandle,
    channel: userChannel,
    agentphoneAgentId: body.agentphoneAgentId,
  });
  signal.throwIfAborted();
  if (!agentphoneAgentId) {
    return routeError(404, "AgentPhone agent not found", "NOT_FOUND");
  }

  const mimetype = body.contentType ?? object.contentType;
  const fetchUrl = await get(uploadedArtifactFetchUrl(object));
  signal.throwIfAborted();
  const sendResult = await settle(
    sendAgentPhoneMessage(
      {
        agentphoneAgentId,
        toNumber: phoneHandle,
        body: body.caption ?? "",
        mediaUrl: fetchUrl,
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!sendResult.ok) {
    const routeErr = agentPhoneRouteError(sendResult.error);
    if (routeErr) {
      return routeErr;
    }
    throw sendResult.error;
  }
  const sent = sendResult.value;

  await set(
    recordAgentPhoneUploadedFile$,
    {
      runId,
      externalId: sent.id,
      userId: auth.userId,
      orgId: auth.orgId,
      filename: uploadedFile.filename,
      contentType: mimetype,
      sizeBytes: uploadedFile.size,
      url: uploadedFile.fileUrl,
      publicBrand: object.publicBrand,
      metadata: buildMetadata({
        body,
        uploadId: body.uploadId,
        s3Key: uploadedFile.key,
        sourceUrl: uploadedFile.fileUrl,
        agentphoneMessageId: sent.id,
      }),
    },
    signal,
  );
  signal.throwIfAborted();

  await storeOutboundAgentPhoneMessage(db, {
    agentphoneMessageId: sent.id,
    conversationId: null,
    agentphoneAgentId,
    publicBrand: object.publicBrand,
    userLinkId: userLink.id,
    phoneHandle,
    fromNumber: sent.fromNumber ?? "",
    toNumber: sent.toNumber ?? phoneHandle,
    body: body.caption,
    channel: sent.channel,
    userChannel,
    mediaUrl: uploadedFile.fileUrl,
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      messageId: sent.id,
      channel: sent.channel,
      toNumber: sent.toNumber ?? phoneHandle,
      filename: uploadedFile.filename,
      mimetype,
      size: uploadedFile.size,
      url: uploadedFile.fileUrl,
    },
  };
});

const phoneWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "phone:write",
} as const;

export const integrationsPhoneUploadCompleteRoutes: readonly RouteEntry[] = [
  {
    route: integrationsPhoneUploadCompleteContract.complete,
    handler: authRoute(phoneWriteAuth, complete$),
  },
];
