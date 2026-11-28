import { command } from "ccstate";
import { integrationsTeamsUploadInitContract } from "@okouai/api-contracts/contracts/integrations";

import {
  badRequestMessage,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { preparePublishedImFile$ } from "../services/canonical-asset.service";
import { resolveTeamsWriteTarget$ } from "../services/teams-write-access.service";

const init$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsTeamsUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const runId = "runId" in auth ? auth.runId : undefined;
  if (!auth.orgId) {
    return resourceUnavailable(
      "Choose an organization before uploading to Teams",
    );
  }
  const contentType =
    body.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (body.length > 100 * 1024 * 1024 || !isAllowedUploadType(contentType)) {
    return badRequestMessage(
      "Unsupported Teams upload type or file exceeds 100 MB",
    );
  }
  const target = await set(
    resolveTeamsWriteTarget$,
    {
      ...(runId !== undefined ? { runId } : {}),
      userId: auth.userId,
      orgId: auth.orgId,
      preflight: true,
      body: {
        conversationId: body.conversationId,
        user: body.user,
        activityId: body.activityId,
      },
    },
    signal,
  );
  if ("status" in target) {
    return target;
  }
  const prepared = await set(
    preparePublishedImFile$,
    {
      runId: runId ?? null,
      userId: auth.userId,
      orgId: auth.orgId,
      filename: body.filename,
      contentType,
      size: body.length,
      ...(body.checksumSha256 !== undefined
        ? { checksumSha256: body.checksumSha256 }
        : {}),
    },
    signal,
  );
  if (!prepared) {
    return notFound("Agent run not found");
  }
  return {
    status: 200 as const,
    body: {
      uploadId: prepared.assetId,
      uploadUrl: prepared.uploadUrl,
      fileUrl: prepared.url,
      filename: body.filename,
      contentType,
      size: body.length,
      uploadHeaders: prepared.uploadHeaders,
    },
  };
});

export const integrationsTeamsUploadInitRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTeamsUploadInitContract.init,
    handler: authRoute({ requiredCapability: "teams:write" }, init$),
  },
];
