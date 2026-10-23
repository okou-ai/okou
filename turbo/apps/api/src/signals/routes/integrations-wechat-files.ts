import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import {
  integrationsWechatUploadInitContract,
  integrationsWechatUploadMaterializeContract,
  integrationsWechatUploadCompleteContract,
  integrationsWechatDownloadFileContract,
} from "@okouai/api-contracts/contracts/integrations-wechat-files";
import { wechatMessages } from "@okouai/db/schema/wechat";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { wechatItemSchema } from "@okouai/api-contracts/contracts/wechat-protocol";
import { downloadWechatMedia } from "../external/wechat-media";
import {
  requireWechatConnection$,
  requireWechatSendAccess$,
} from "../services/wechat-access.service";
import { decryptStoredSecretValue } from "../services/crypto.utils";
import {
  CanonicalPublicationConflictError,
  prepareCanonicalPublishedAsset$,
} from "../services/canonical-asset.service";
import {
  completeCanonicalWechatDelivery$,
  materializeCanonicalWechatAsset$,
} from "../services/canonical-wechat-asset-delivery.service";
import { settle } from "../utils";
import type { RouteEntry } from "../route-entry";
const init$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const parsed = await get(
    bodyResultOf(integrationsWechatUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const body = parsed.data;
  const access = await set(
    requireWechatSendAccess$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      channelId: body.channelId,
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
    return badRequestMessage("Unsupported Wechat file type");
  }
  const prepared = await settle(
    set(
      prepareCanonicalPublishedAsset$,
      {
        provider: "wechat",
        runId: "runId" in auth ? auth.runId : null,
        userId: auth.userId,
        orgId: auth.orgId,
        operationId: body.operationId,
        filename: body.filename,
        contentType,
        size: body.length,
        checksumSha256: body.checksumSha256,
        destination: {
          provider: "wechat",
          connectionId: access.connection.id,
          generation: access.connection.generation,
          channelId: body.channelId,
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
    bodyResultOf(integrationsWechatUploadMaterializeContract.materialize),
  );
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const result = await set(
    materializeCanonicalWechatAsset$,
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
    bodyResultOf(integrationsWechatUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const result = await set(
    completeCanonicalWechatDelivery$,
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

const download$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(integrationsWechatDownloadFileContract.download));
  const access = await set(
    requireWechatConnection$,
    { ...auth, channelId: query.channelId },
    signal,
  );
  if (access.kind === "denied") {
    return access.response;
  }
  const [row] = await set(writeDb$)
    .select({
      ciphertext: wechatMessages.mediaCiphertext,
      attachments: wechatMessages.attachments,
    })
    .from(wechatMessages)
    .where(
      and(
        eq(wechatMessages.connectionId, query.channelId),
        eq(wechatMessages.id, query.messageId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  const attachment = row?.attachments.find((file) => {
    return file.id === query.attachmentId;
  });
  if (!row?.ciphertext || !attachment) {
    return notFound("This WeChat attachment is unavailable.");
  }
  const items = z
    .array(wechatItemSchema)
    .parse(JSON.parse(await decryptStoredSecretValue(row.ciphertext)));
  signal.throwIfAborted();
  const item = items[Number(query.attachmentId)];
  if (!item) {
    return notFound("This WeChat attachment is unavailable.");
  }
  const downloaded = await settle(downloadWechatMedia(item, signal), signal);
  signal.throwIfAborted();
  if (!downloaded.ok) {
    return {
      status: 502,
      body: {
        error: {
          code: "WECHAT_ATTACHMENT_UNAVAILABLE",
          message:
            "WeChat attachment is unavailable, expired, invalid, or exceeds 10 MiB. Ask the sender to resend it.",
        },
      },
    } as const;
  }
  const live = await set(
    requireWechatConnection$,
    { ...auth, channelId: query.channelId },
    signal,
  );
  if (live.kind === "denied") {
    return live.response;
  }
  return new Response(downloaded.value, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(downloaded.value.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});
const writeAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "wechat:write",
} as const;
export const integrationsWechatFileRoutes: readonly RouteEntry[] = [
  {
    route: integrationsWechatUploadInitContract.init,
    handler: authRoute(writeAuth, init$),
  },
  {
    route: integrationsWechatUploadMaterializeContract.materialize,
    handler: authRoute(writeAuth, materialize$),
  },
  {
    route: integrationsWechatUploadCompleteContract.complete,
    handler: authRoute(writeAuth, complete$),
  },
  {
    route: integrationsWechatDownloadFileContract.download,
    handler: authRoute(
      { ...writeAuth, requiredCapability: "wechat:read" },
      download$,
    ),
  },
];
