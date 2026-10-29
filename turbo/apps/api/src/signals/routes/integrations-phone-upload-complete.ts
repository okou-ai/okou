import type { LinkLayout } from "@okouai/api-contracts/contracts/link-layout";
import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneMessageVisibility } from "@okouai/db/schema/agentphone-message-visibility";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { command } from "ccstate";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import {
  integrationsPhoneUploadCompleteContract,
  type PhoneUploadCompleteBody,
} from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import {
  getAgentPhoneConversationParticipants,
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
import {
  resolveAgentPhoneParticipantVisibilityRecipients$,
  type AgentPhoneMessageVisibilityRecipient,
} from "../services/agentphone-shared.service";
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
  readonly toNumber: string;
  readonly userChannel: ReturnType<typeof agentPhoneChannelForLinkedHandle>;
  readonly agentphoneAgentId: string;
  readonly group: PhoneFileGroup | undefined;
}

interface PhoneFileGroup {
  readonly groupId: string;
  readonly conversationId: string;
  readonly agentphoneAgentId: string;
  readonly visibilityRecipients: readonly AgentPhoneMessageVisibilityRecipient[];
}

const resolvePhoneFileGroup$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly groupId: string;
      readonly agentphoneAgentId?: string;
    },
    signal: AbortSignal,
  ) => {
    const [group] = await get(db$)
      .select({
        conversationId: agentphoneMessages.conversationId,
        agentphoneAgentId: agentphoneMessages.agentphoneAgentId,
      })
      .from(agentphoneMessages)
      .innerJoin(
        agentphoneMessageVisibility,
        eq(agentphoneMessageVisibility.messageId, agentphoneMessages.id),
      )
      .where(
        and(
          eq(agentphoneMessages.groupId, args.groupId),
          eq(agentphoneMessages.channel, "imessage"),
          isNotNull(agentphoneMessages.conversationId),
          eq(agentphoneMessageVisibility.orgId, args.orgId),
          eq(agentphoneMessageVisibility.userId, args.userId),
          args.agentphoneAgentId
            ? eq(agentphoneMessages.agentphoneAgentId, args.agentphoneAgentId)
            : undefined,
        ),
      )
      .orderBy(
        desc(agentphoneMessages.receivedAt),
        desc(agentphoneMessages.createdAt),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!group?.conversationId) {
      return {
        ok: false as const,
        response: routeError(404, "iMessage group not found", "NOT_FOUND"),
      };
    }

    const roster = await settle(
      getAgentPhoneConversationParticipants(
        { conversationId: group.conversationId },
        signal,
      ),
      signal,
    );
    if (!roster.ok) {
      if (isAgentPhoneApiError(roster.error) && roster.error.status === 404) {
        return {
          ok: false as const,
          response: routeError(404, "iMessage group not found", "NOT_FOUND"),
        };
      }
      if (
        isAgentPhoneApiError(roster.error) ||
        roster.error instanceof TypeError ||
        roster.error instanceof SyntaxError
      ) {
        return {
          ok: false as const,
          response: routeError(
            502,
            "Unable to verify current iMessage group membership",
            "BAD_GATEWAY",
          ),
        };
      }
      throw roster.error;
    }
    const visibilityRecipients = await set(
      resolveAgentPhoneParticipantVisibilityRecipients$,
      roster.value,
      nowDate(),
      signal,
    );
    if (
      !visibilityRecipients.some((recipient) => {
        return (
          recipient.orgId === args.orgId && recipient.userId === args.userId
        );
      })
    ) {
      return {
        ok: false as const,
        response: routeError(
          403,
          "Your connected phone must be a current member of this iMessage group",
          "FORBIDDEN",
        ),
      };
    }
    return {
      ok: true as const,
      group: {
        groupId: args.groupId,
        conversationId: group.conversationId,
        agentphoneAgentId: group.agentphoneAgentId,
        visibilityRecipients,
      } satisfies PhoneFileGroup,
    };
  },
);

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
      toNumber: args.toNumber,
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
    conversationId: args.group?.conversationId ?? null,
    groupId: args.group?.groupId,
    agentphoneAgentId: args.agentphoneAgentId,
    userLinkId: args.userLinkId,
    phoneHandle: args.phoneHandle,
    fromNumber: args.sent.fromNumber ?? "",
    toNumber: args.group?.groupId ?? args.sent.toNumber ?? args.phoneHandle,
    body: args.body.caption,
    channel: args.sent.channel,
    userChannel: args.userChannel,
    mediaUrl: args.uploadedFile.fileUrl,
    visibilityRecipients: args.group?.visibilityRecipients ?? [],
  };
}

const phoneNotConnected = routeError(
  404,
  "No phone is connected to this Okou account",
  "NOT_FOUND",
);

const resolvePhoneFileDestination$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly groupId?: string;
      readonly agentphoneAgentId?: string;
    },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const [userLink] = await db
      .select()
      .from(agentphoneUserLinks)
      .where(
        and(
          eq(agentphoneUserLinks.userId, args.userId),
          eq(agentphoneUserLinks.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!userLink) {
      return { ok: false as const, response: phoneNotConnected };
    }
    const phoneHandle = userLink.phoneHandle;
    const groupId = args.groupId;
    let group: PhoneFileGroup | undefined;
    if (groupId) {
      const resolved = await set(
        resolvePhoneFileGroup$,
        {
          orgId: args.orgId,
          userId: args.userId,
          groupId,
          agentphoneAgentId: args.agentphoneAgentId,
        },
        signal,
      );
      if (!resolved.ok) {
        return resolved;
      }
      group = resolved.group;
    }
    const userChannel = group
      ? "imessage"
      : agentPhoneChannelForLinkedHandle(phoneHandle);

    let agentphoneAgentId = group?.agentphoneAgentId;
    if (!group) {
      const [message] = await db
        .select({ agentphoneAgentId: agentphoneMessages.agentphoneAgentId })
        .from(agentphoneMessages)
        .where(
          and(
            eq(agentphoneMessages.agentphoneUserLinkId, userLink.id),
            args.agentphoneAgentId
              ? eq(agentphoneMessages.agentphoneAgentId, args.agentphoneAgentId)
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
      agentphoneAgentId =
        args.agentphoneAgentId &&
        args.agentphoneAgentId === optionalEnv("AGENTPHONE_AGENT_ID")
          ? args.agentphoneAgentId
          : message?.agentphoneAgentId;
    }
    if (!agentphoneAgentId) {
      return {
        ok: false as const,
        response: routeError(404, "Phone agent not found", "NOT_FOUND"),
      };
    }

    return {
      ok: true as const,
      destination: {
        userLinkId: userLink.id,
        phoneHandle,
        userChannel,
        agentphoneAgentId,
        group,
        toNumber: group?.groupId ?? phoneHandle,
      },
    };
  },
);

const complete$ = command(
  async (
    { get, set },
    body: PhoneUploadCompleteBody & { readonly groupId?: string },
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const runId =
      "runId" in auth && typeof auth.runId === "string"
        ? auth.runId
        : undefined;

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

    const resolved = await set(
      resolvePhoneFileDestination$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        groupId: body.groupId,
        agentphoneAgentId: body.agentphoneAgentId,
      },
      signal,
    );
    if (!resolved.ok) {
      return resolved.response;
    }
    const destination = resolved.destination;

    const mimetype = body.contentType ?? object.contentType;
    const fetchUrl = await set(uploadedArtifactFetchUrl$, object, signal);
    signal.throwIfAborted();
    const sendResult = await settle(
      sendAgentPhoneMessage(
        {
          agentphoneAgentId: destination.agentphoneAgentId,
          toNumber: destination.toNumber,
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
      ...destination,
      mimetype,
      body,
      uploadedFile,
      layout: object.layout,
      sent,
    };
    await set(
      recordAgentPhoneUploadedFile$,
      uploadedFileRecordValues(delivery),
      signal,
    );
    signal.throwIfAborted();

    await set(
      storeOutboundAgentPhoneMessage$,
      outboundPhoneFileValues(delivery),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        messageId: sent.id,
        channel: sent.channel,
        toNumber:
          destination.group?.groupId ??
          sent.toNumber ??
          destination.phoneHandle,
        filename: uploadedFile.filename,
        mimetype,
        size: uploadedFile.size,
        url: uploadedFile.fileUrl,
      },
    };
  },
);

function createCompleteHandler(
  route:
    | typeof integrationsPhoneUploadCompleteContract.complete
    | typeof integrationsPhoneUploadCompleteContract.completeGroup,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(bodyResultOf(route));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(complete$, bodyResult.data, signal);
  });
}

const phoneWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "phone:write",
} as const;

export const integrationsPhoneUploadCompleteRoutes: readonly RouteEntry[] = [
  {
    route: integrationsPhoneUploadCompleteContract.complete,
    handler: authRoute(
      phoneWriteAuth,
      createCompleteHandler(integrationsPhoneUploadCompleteContract.complete),
    ),
  },
  {
    route: integrationsPhoneUploadCompleteContract.completeGroup,
    handler: authRoute(
      phoneWriteAuth,
      createCompleteHandler(
        integrationsPhoneUploadCompleteContract.completeGroup,
      ),
    ),
  },
];
