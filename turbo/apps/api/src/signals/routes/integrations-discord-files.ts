import { command } from "ccstate";
import {
  integrationsDiscordUploadInitContract,
  integrationsDiscordUploadMaterializeContract,
  integrationsDiscordUploadCompleteContract,
  integrationsDiscordDownloadFileContract,
} from "@okouai/api-contracts/contracts/integrations-discord-files";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { discordClient } from "../external/discord-client";
import {
  DiscordFileFetchError,
  resolveDiscordAttachmentUrl,
} from "../external/discord-file-fetcher";
import { requireDiscordRunReadAccess$ } from "../services/discord-access.service";
import {
  discordApiFailure,
  discordUnavailable,
} from "../services/discord-api-response";
import {
  CanonicalPublicationConflictError,
  prepareCanonicalPublishedAsset$,
} from "../services/canonical-asset.service";
import {
  completeCanonicalDiscordDelivery$,
  materializeCanonicalDiscordAsset$,
} from "../services/canonical-discord-asset-delivery.service";
import {
  requireDiscordOutputAccess$,
  resolveDiscordOutputChannel$,
} from "../services/discord-output-destination.service";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";

const init$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const parsed = await get(
    bodyResultOf(integrationsDiscordUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const body = parsed.data;
  const destination = await set(
    resolveDiscordOutputChannel$,
    {
      ...auth,
      channelId: body.channelId,
      recipientId: body.userId,
      guildId: body.guildId,
    },
    signal,
  );
  if (destination.kind === "denied") {
    return destination.response;
  }
  const access = await set(
    requireDiscordOutputAccess$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      channelId: destination.channelId,
      guildId: body.guildId,
      createThread: false,
      attachFiles: true,
      allowOtherDmRecipients: true,
    },
    signal,
  );
  signal.throwIfAborted();
  if (access.kind === "denied") {
    return access.response;
  }
  const contentType = body.contentType
    .replace(/;.*$/su, "")
    .trim()
    .toLowerCase();
  if (!isAllowedUploadType(contentType)) {
    return badRequestMessage("Unsupported Discord file type");
  }
  const prepared = await settle(
    set(
      prepareCanonicalPublishedAsset$,
      {
        provider: "discord",
        runId: "runId" in auth ? auth.runId : null,
        userId: auth.userId,
        orgId: auth.orgId,
        operationId: body.operationId,
        filename: body.filename,
        contentType,
        size: body.length,
        checksumSha256: body.checksumSha256,
        destination: {
          provider: "discord",
          connectionId: access.binding.connectionId,
          guildId: access.binding.guildId,
          channelId: destination.channelId,
          ...(body.comment !== undefined ? { comment: body.comment } : {}),
        },
      },
      signal,
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!prepared.ok) {
    if (prepared.error instanceof CanonicalPublicationConflictError) {
      return conflict(prepared.error.message);
    }
    throw prepared.error;
  }
  if (!prepared.value) {
    return notFound("Upload owner is no longer available");
  }
  return { status: 200 as const, body: prepared.value };
});

const materialize$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const parsed = await get(
    bodyResultOf(integrationsDiscordUploadMaterializeContract.materialize),
  );
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const result = await set(
    materializeCanonicalDiscordAsset$,
    {
      ...parsed.data,
      userId: auth.userId,
      orgId: auth.orgId,
      runId: "runId" in auth ? auth.runId : null,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return result.response;
  }
  const { ok: _, ...body } = result;
  return { status: 200 as const, body };
});

const complete$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const parsed = await get(
    bodyResultOf(integrationsDiscordUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const result = await set(
    completeCanonicalDiscordDelivery$,
    {
      ...parsed.data,
      userId: auth.userId,
      orgId: auth.orgId,
      runId: "runId" in auth ? auth.runId : null,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return result.response;
  }
  const { ok: _, ...body } = result;
  return { status: 200 as const, body };
});

const resolveFileUrl$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(integrationsDiscordDownloadFileContract.fileUrl));
  const auth = get(organizationAuthContext$);
  const access = await set(
    requireDiscordRunReadAccess$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      channelId: query.channelId,
      guildId: query.guildId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (access.kind === "denied") {
    return access.response;
  }
  const message = await discordClient.fetchDiscordMessage(
    {
      botToken: access.botToken,
      channelId: query.channelId,
      messageId: query.messageId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (message.kind !== "ok") {
    return discordApiFailure(message);
  }
  if (
    message.data.channel_id !== query.channelId ||
    message.data.id !== query.messageId
  ) {
    return discordUnavailable();
  }
  const attachment = message.data.attachments.find((file) => {
    return file.id === query.attachmentId;
  });
  if (!attachment) {
    return discordUnavailable();
  }
  const metadata = resolveDiscordAttachmentUrl({
    channelId: query.channelId,
    attachmentId: attachment.id,
    filename: attachment.filename,
    size: attachment.size,
    ...(attachment.content_type !== undefined
      ? { contentType: attachment.content_type }
      : {}),
    url: attachment.url,
  });
  return Response.json(metadata, {
    headers: { "Cache-Control": "private, no-store" },
  });
});

const fileUrl$ = command(async ({ set }, signal: AbortSignal) => {
  const result = await settle(set(resolveFileUrl$, signal), signal);
  signal.throwIfAborted();
  if (result.ok) {
    return result.value;
  }
  if (!(result.error instanceof DiscordFileFetchError)) {
    throw result.error;
  }
  if (result.error.code === "too-large") {
    return createErrorResponse("PAYLOAD_TOO_LARGE", result.error.message);
  }
  return {
    status: 502 as const,
    body: {
      error: { code: "DISCORD_FILE_ERROR", message: result.error.message },
    },
  };
});

const writeAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "discord:write",
} as const;
const readAuth = { ...writeAuth, requiredCapability: "discord:read" } as const;

export const integrationsDiscordFileRoutes: readonly RouteEntry[] = [
  {
    route: integrationsDiscordUploadInitContract.init,
    handler: authRoute(writeAuth, init$),
  },
  {
    route: integrationsDiscordUploadMaterializeContract.materialize,
    handler: authRoute(writeAuth, materialize$),
  },
  {
    route: integrationsDiscordUploadCompleteContract.complete,
    handler: authRoute(writeAuth, complete$),
  },
  {
    route: integrationsDiscordDownloadFileContract.fileUrl,
    handler: authRoute(readAuth, fileUrl$),
  },
];
