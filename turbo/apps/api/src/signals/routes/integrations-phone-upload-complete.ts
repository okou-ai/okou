import type { LinkLayout } from "@okouai/api-contracts/contracts/link-layout";
import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { and, desc, eq } from "drizzle-orm";
import { command } from "ccstate";
import { optionalEnv } from "../../lib/env";
import {
  integrationsPhoneUploadCompleteContract,
  type PhoneUploadCompleteBody,
} from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../external/agentphone-client";
import {
  materializeUploadedArtifact$,
  uploadedArtifactFetchUrl$,
} from "../services/uploaded-artifact.service";
import { recordAgentPhoneUploadedFile$ } from "../services/run-uploaded-files.service";
import {
  agentPhoneChannelForLinkedHandle,
  normalizeAgentPhoneHandle,
  storeOutboundAgentPhoneMessage$,
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
    `Phone provider error: ${error.body || `HTTP ${error.status}`}`,
    "AGENTPHONE_ERROR",
  );
}

function buildMetadata(params: {
  readonly body: PhoneUploadCompleteBody;
  readonly toNumber: string;
  readonly uploadId: string;
  readonly s3Key: string;
  readonly sourceUrl: string;
  readonly agentphoneMessageId: string;
}): Record<string, unknown> {
  return {
    toNumber: params.toNumber,
    uploadId: params.uploadId,
    s3Key: params.s3Key,
    sourceUrl: params.sourceUrl,
    ...(params.body.caption ? { caption: params.body.caption } : {}),
    agentphoneMessage: { id: params.agentphoneMessageId },
  };
}

interface PhoneFileDelivery {
  readonly runId: string | undefined;
  readonly auth: {
    readonly userId: string;
    readonly orgId: string;
  };
  readonly userLinkId: string;
  readonly mimetype: string;
  readonly body: PhoneUploadCompleteBody;
  readonly uploadedFile: UploadedFileInfo;
  readonly layout: LinkLayout;
  readonly sent: Awaited<ReturnType<typeof sendAgentPhoneMessage>>;
  readonly phoneHandle: string;
  readonly userChannel: ReturnType<typeof agentPhoneChannelForLinkedHandle>;
  readonly agentphoneAgentId: string;
}

function uploadedFileRecordValues(args: PhoneFileDelivery) {
  return {
    runId: args.runId,
    externalId: args.sent.id,
    userId: args.auth.userId,
    orgId: args.auth.orgId,
    filename: args.uploadedFile.filename,
    contentType: args.mimetype,
    sizeBytes: args.uploadedFile.size,
    url: args.uploadedFile.fileUrl,
    layout: args.layout,
    metadata: buildMetadata({
      body: args.body,
      toNumber: args.phoneHandle,
      uploadId: args.body.uploadId,
      s3Key: args.uploadedFile.key,
      sourceUrl: args.uploadedFile.fileUrl,
      agentphoneMessageId: args.sent.id,
    }),
  };
}

function outboundPhoneFileValues(args: PhoneFileDelivery) {
  return {
    agentphoneMessageId: args.sent.id,
    conversationId: null,
    agentphoneAgentId: args.agentphoneAgentId,
    userLinkId: args.userLinkId,
    phoneHandle: args.phoneHandle,
    fromNumber: args.sent.fromNumber ?? "",
    toNumber: args.sent.toNumber ?? args.phoneHandle,
    body: args.body.caption,
    channel: args.sent.channel,
    userChannel: args.userChannel,
    mediaUrl: args.uploadedFile.fileUrl,
    visibilityRecipients: [],
  };
}

const phoneNotConnected = routeError(
  404,
  "No phone is connected to this Okou account",
  "NOT_FOUND",
);

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

  const db = get(db$);
  const [userLink] = await db
    .select()
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.userId, auth.userId),
        eq(agentphoneUserLinks.orgId, auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!userLink) {
    return phoneNotConnected;
  }
  const phoneHandle = userLink.phoneHandle;
  const userChannel = agentPhoneChannelForLinkedHandle(phoneHandle);

  const [message] = await db
    .select({ agentphoneAgentId: agentphoneMessages.agentphoneAgentId })
    .from(agentphoneMessages)
    .where(
      and(
        eq(agentphoneMessages.agentphoneUserLinkId, userLink.id),
        body.agentphoneAgentId
          ? eq(agentphoneMessages.agentphoneAgentId, body.agentphoneAgentId)
          : undefined,
        eq(
          agentphoneMessages.phoneHandle,
          normalizeAgentPhoneHandle(phoneHandle, userChannel),
        ),
      ),
    )
    .orderBy(desc(agentphoneMessages.createdAt))
    .limit(1);
  signal.throwIfAborted();
  const agentphoneAgentId =
    body.agentphoneAgentId &&
    body.agentphoneAgentId === optionalEnv("AGENTPHONE_AGENT_ID")
      ? body.agentphoneAgentId
      : (message?.agentphoneAgentId ?? null);
  if (!agentphoneAgentId) {
    return routeError(404, "Phone agent not found", "NOT_FOUND");
  }

  const mimetype = body.contentType ?? object.contentType;
  const fetchUrl = await set(uploadedArtifactFetchUrl$, object, signal);
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

  const delivery: PhoneFileDelivery = {
    runId,
    auth,
    userLinkId: userLink.id,
    mimetype,
    body,
    uploadedFile,
    layout: object.layout,
    sent,
    phoneHandle,
    userChannel,
    agentphoneAgentId,
  };
  await set(
    recordAgentPhoneUploadedFile$,
    uploadedFileRecordValues(delivery),
    signal,
  );
  signal.throwIfAborted();

  await set(storeOutboundAgentPhoneMessage$, outboundPhoneFileValues(delivery));
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
