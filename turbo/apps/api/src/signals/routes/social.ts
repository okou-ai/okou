import {
  publicSocialErrorCode,
  publicSocialErrorMessage,
  projectPublicSocialResponse,
  redactSocialProviderIdentity,
  socialContract,
  socialKitResponseSchema,
} from "@okouai/api-contracts/contracts/social";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";
import { socialKitRequest$ } from "../services/social.service";
import { socialStatus$ } from "../services/social-status.service";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import {
  createSocialKitDownload$,
  getSocialKitDownload$,
  listSocialKitDownloads$,
  reconcileSocialKitDownload$,
  SOCIALKIT_RECONCILIATION_TIMEOUT_MS,
} from "../services/socialkit-download.service";

const socialKitRequestBody$ = bodyResultOf(socialContract.request);
const socialKitDownloadBody$ = bodyResultOf(socialContract.createDownload);
const socialKitDownloadPathParams$ = pathParamsOf(socialContract.getDownload);
const socialKitDownloadNotFound = notFound("SocialKit download not found");
const socialStatusQuery$ = queryOf(socialContract.status);

const socialStatusInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    const { platform } = get(socialStatusQuery$);
    return {
      status: 200 as const,
      body: await set(socialStatus$, platform, signal),
    };
  },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentFacing(auth: { readonly tokenType: string }): boolean {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox";
}

/**
 * Remove upstream implementation details at the agent boundary. Internal
 * services keep the provider key for billing, reconciliation, and logs, but
 * neither the provider identity nor its diagnostics belong in agent context.
 */
function redactAgentSocialResponse<T>(response: T): T {
  if (!isRecord(response) || !isRecord(response.body)) {
    return response;
  }

  const body = response.body;
  const socialResponse = socialKitResponseSchema.safeParse(body);
  const projection = socialResponse.success
    ? projectPublicSocialResponse(socialResponse.data)
    : undefined;
  if (projection && !projection.ok) {
    throw new Error("Validated Okou Social response cannot be projected");
  }
  const publicBody = projection?.ok
    ? projection.response
    : redactSocialProviderIdentity(body);
  if (!isRecord(publicBody)) {
    return response;
  }
  const error = publicBody.error;
  if (!isRecord(error)) {
    return { ...response, body: publicBody } as T;
  }

  const sanitizedBody = {
    ...publicBody,
    error: {
      ...error,
      ...(typeof error.code === "string"
        ? { code: publicSocialErrorCode(error.code) }
        : {}),
      ...(typeof error.message === "string"
        ? { message: publicSocialErrorMessage(error.message) }
        : {}),
    },
  };
  return { ...response, body: sanitizedBody } as T;
}

function agentSafeResponse<T>(
  auth: { readonly tokenType: string },
  response: T,
): T {
  return isAgentFacing(auth) ? redactAgentSocialResponse(response) : response;
}

const socialKitRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(socialKitRequestBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return agentSafeResponse(auth, bodyResult.response);
    }
    const response = await set(
      socialKitRequest$,
      { auth, body: bodyResult.data },
      signal,
    );
    return agentSafeResponse(auth, response);
  },
);

const createSocialKitDownloadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(socialKitDownloadBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return agentSafeResponse(auth, bodyResult.response);
    }
    const publicBrand = PUBLIC_BRAND;
    const reconciliationSignal = AbortSignal.timeout(
      SOCIALKIT_RECONCILIATION_TIMEOUT_MS,
    );
    const response = await set(
      createSocialKitDownload$,
      { auth, body: bodyResult.data, publicBrand },
      signal,
    );
    if (response.status === 202) {
      waitUntil(
        set(
          reconcileSocialKitDownload$,
          response.body.downloadId,
          reconciliationSignal,
        ),
      );
    }
    if (response.status === 409) {
      const active = await set(
        listSocialKitDownloads$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          query: { limit: 1, status: "active" },
        },
        signal,
      );
      const download = active.downloads[0];
      if (download?.resumeCommand) {
        return agentSafeResponse(auth, {
          ...response,
          body: {
            error: {
              ...response.body.error,
              recovery: {
                downloadId: download.downloadId,
                resumeCommand: download.resumeCommand,
              },
            },
          },
        });
      }
    }
    return agentSafeResponse(auth, response);
  },
);

const listSocialKitDownloadsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const response = await set(
      listSocialKitDownloads$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        query: get(queryOf(socialContract.listDownloads)),
      },
      signal,
    );
    return {
      status: 200 as const,
      body: {
        ...response,
        downloads: response.downloads.map((download) => {
          return agentSafeResponse(auth, { body: download }).body;
        }),
      },
    };
  },
);

const getSocialKitDownloadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(socialKitDownloadPathParams$);
    const response = await set(
      getSocialKitDownload$,
      {
        downloadId: params.downloadId,
        orgId: auth.orgId,
        userId: auth.userId,
      },
      signal,
    );
    if (!response) {
      return agentSafeResponse(auth, socialKitDownloadNotFound);
    }
    if (
      response.status === "processing" ||
      response.status === "materializing" ||
      response.status === "artifact_failed"
    ) {
      waitUntil(
        set(
          reconcileSocialKitDownload$,
          response.downloadId,
          AbortSignal.timeout(SOCIALKIT_RECONCILIATION_TIMEOUT_MS),
        ),
      );
    }
    return agentSafeResponse(auth, { status: 200 as const, body: response });
  },
);

export const socialRoutes: readonly RouteEntry[] = [
  {
    route: socialContract.status,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "social:read",
      },
      socialStatusInner$,
    ),
  },
  {
    route: socialContract.request,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "social:read",
      },
      socialKitRequestInner$,
    ),
  },
  {
    route: socialContract.createDownload,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "social:read",
      },
      createSocialKitDownloadInner$,
    ),
  },
  {
    route: socialContract.listDownloads,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "social:read",
      },
      listSocialKitDownloadsInner$,
    ),
  },
  {
    route: socialContract.getDownload,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "social:read",
      },
      getSocialKitDownloadInner$,
    ),
  },
];
