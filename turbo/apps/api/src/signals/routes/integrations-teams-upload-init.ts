import { command } from "ccstate";
import {
  integrationsTeamsUploadInitContract,
  type TeamsUploadInitBody,
} from "@okouai/api-contracts/contracts/integrations";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";

import { resolveTeamsWriteTarget$ } from "../services/teams-write-access.service";
import {
  prepareCanonicalPublishedAsset$,
  CanonicalPublicationConflictError,
} from "../services/canonical-asset.service";
import { settle } from "../utils";
import {
  conflict,
  notFound,
  badRequestMessage,
  resourceUnavailable,
} from "../../lib/error";
import { isAllowedUploadType } from "../../lib/uploads-constants";

const prepareCanonicalTeamsUpload$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | null;
      readonly body: TeamsUploadInitBody;
    },
    signal: AbortSignal,
  ) => {
    const { body, orgId, userId, runId } = args;
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
        ...(runId !== null ? { runId } : {}),
        userId: userId,
        orgId: orgId,
        body: body.canonical,
      },
      signal,
    );
    if ("status" in target) {
      return target;
    }
    const result = await settle(
      set(
        prepareCanonicalPublishedAsset$,
        {
          provider: "teams",
          runId,
          userId: userId,
          orgId: orgId,
          operationId: body.canonical.operationId,
          checksumSha256: body.canonical.checksumSha256,
          filename: body.filename,
          contentType,
          size: body.length,
          destination: {
            provider: "teams",
            tenantId: target.installation.teamsTenantId,
            conversationId: target.conversationId,
            source: target.source,
            ...(target.recipientId ? { recipientId: target.recipientId } : {}),
            ...(body.canonical.activityId
              ? { activityId: body.canonical.activityId }
              : {}),
            ...(body.canonical.text ? { text: body.canonical.text } : {}),
          },
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      if (result.error instanceof CanonicalPublicationConflictError) {
        return conflict(result.error.message);
      }
      throw result.error;
    }
    const prepared = result.value;
    if (!prepared) {
      return notFound("Agent run not found");
    }
    return {
      status: 200 as const,
      body: {
        uploadId: prepared.assetId,
        operationId: prepared.operationId,
        uploadUrl: prepared.uploadUrl ?? "",
        uploadRequired: Boolean(prepared.uploadUrl),
        fileUrl: prepared.url,
        filename: body.filename,
        contentType,
        size: body.length,
        uploadHeaders: prepared.uploadHeaders ?? {},
      },
    };
  },
);

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
  return await set(
    prepareCanonicalTeamsUpload$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      runId: runId ?? null,
      body,
    },
    signal,
  );
});

export const integrationsTeamsUploadInitRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTeamsUploadInitContract.init,
    handler: authRoute({ requiredCapability: "teams:write" }, init$),
  },
];
