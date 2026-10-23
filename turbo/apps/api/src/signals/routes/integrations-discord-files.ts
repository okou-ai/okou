import { command } from "ccstate";
import {
  integrationsDiscordUploadInitContract,
  integrationsDiscordUploadMaterializeContract,
  integrationsDiscordUploadCompleteContract,
  integrationsDiscordDownloadFileContract,
  type DiscordDownloadFileQuery,
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
  fetchDiscordAttachment,
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

const resolveAttachment$ = command(
  async (
    { get, set },
    query: DiscordDownloadFileQuery,
    signal: AbortSignal,
  ) => {
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
      return { kind: "response" as const, response: access.response };
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
      return {
        kind: "response" as const,
        response: discordApiFailure(message),
      };
    }
    if (
      message.data.channel_id !== query.channelId ||
      message.data.id !== query.messageId
    ) {
      return { kind: "response" as const, response: discordUnavailable() };
    }
    const attachment = message.data.attachments.find((file) => {
      return file.id === query.attachmentId;
    });
    if (!attachment) {
      return { kind: "response" as const, response: discordUnavailable() };
    }
    return {
      kind: "attachment" as const,
      attachment: {
        channelId: query.channelId,
        attachmentId: attachment.id,
        filename: attachment.filename,
        size: attachment.size,
        ...(attachment.content_type !== undefined
          ? { contentType: attachment.content_type }
          : {}),
        url: attachment.url,
      },
    };
  },
);

const downloadAttempt$ = command(
  async ({ set }, query: DiscordDownloadFileQuery, signal: AbortSignal) => {
    const resolved = await set(resolveAttachment$, query, signal);
    signal.throwIfAborted();
    if (resolved.kind === "response") {
      return resolved;
    }
    const downloaded = await fetchDiscordAttachment(
      resolved.attachment,
      signal,
    );
    signal.throwIfAborted();
    return { kind: "file" as const, ...downloaded };
  },
);

function downloadFailure(error: unknown) {
  if (!(error instanceof DiscordFileFetchError)) {
    throw error;
  }
  if (error.code === "too-large") {
    return createErrorResponse("PAYLOAD_TOO_LARGE", error.message);
  }
  if (error.statusCode === 403 || error.statusCode === 404) {
    return discordUnavailable();
  }
  return {
    status: 502 as const,
    body: { error: { code: "DISCORD_FILE_ERROR", message: error.message } },
  };
}

const download$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(integrationsDiscordDownloadFileContract.download));
  let result = await settle(set(downloadAttempt$, query, signal), signal);
  signal.throwIfAborted();
  if (
    !result.ok &&
    result.error instanceof DiscordFileFetchError &&
    (result.error.statusCode === 403 || result.error.statusCode === 404)
  ) {
    // Attachment URLs expire. Resolve the same provider identity once more,
    // including fresh binding and user/bot access checks, before retrying.
    result = await settle(set(downloadAttempt$, query, signal), signal);
    signal.throwIfAborted();
  }
  if (!result.ok) {
    return downloadFailure(result.error);
  }
  if (result.value.kind === "response") {
    return result.value.response;
  }
  const file = result.value;
  return new Response(file.bytes, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "X-File-Name": encodeURIComponent(file.filename),
      "X-File-Mimetype": file.contentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});

const fileUrl$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(integrationsDiscordDownloadFileContract.fileUrl));
  const result = await settle(
    (async () => {
      const resolved = await set(resolveAttachment$, query, signal);
      signal.throwIfAborted();
      if (resolved.kind === "response") {
        return resolved.response;
      }
      const metadata = resolveDiscordAttachmentUrl(resolved.attachment);
      if (!metadata) {
        return {
          status: 409 as const,
          body: {
            error: {
              code: "DIRECT_DOWNLOAD_UNAVAILABLE",
              message: "Discord attachment requires CDN MIME validation",
            },
          },
        };
      }
      return Response.json(metadata, {
        headers: { "Cache-Control": "private, no-store" },
      });
    })(),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return downloadFailure(result.error);
  }
  return result.value;
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
    route: integrationsDiscordDownloadFileContract.download,
    handler: authRoute(readAuth, download$),
  },
  {
    route: integrationsDiscordDownloadFileContract.fileUrl,
    handler: authRoute(readAuth, fileUrl$),
  },
];
