import type {
  HostedSitePrepareRequest,
  HostedSitePrepareResponse,
  HostedSiteCompleteResponse,
  HostedSiteDeploymentsResponse,
  HostedSiteFilesResponse,
} from "@okouai/api-contracts/contracts/host";
import { ApiRequestError, getBaseUrl } from "../core/client-factory";
import { getActiveToken } from "../config";
import { headersWithCliClientHeaders } from "../client-headers";
import {
  absoluteArtifactUrl,
  withAbsoluteArtifactUrl,
} from "../../artifact-url";

async function withAbsoluteHostedUrls<
  T extends {
    readonly url: string;
    readonly artifactUrl?: string;
    readonly aliasUrl?: string;
  },
>(result: T): Promise<T> {
  return {
    ...(await withAbsoluteArtifactUrl(result)),
    ...(result.artifactUrl === undefined
      ? {}
      : { artifactUrl: await absoluteArtifactUrl(result.artifactUrl) }),
    ...(result.aliasUrl === undefined
      ? {}
      : { aliasUrl: await absoluteArtifactUrl(result.aliasUrl) }),
  };
}

function authHeaders(
  token: string,
  options: { readonly json?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (options.json) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

async function parseErrorBody(
  response: Response,
  fallback: string,
): Promise<{ message: string; code: string }> {
  let message = `${fallback} (HTTP ${response.status})`;
  let code = "UNKNOWN";
  try {
    const body = (await response.json()) as {
      error?: { message?: string; code?: string };
    };
    if (body.error?.message) message = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    // keep fallback
  }
  return { message, code };
}

async function getAuthContext(): Promise<{
  readonly baseUrl: string;
  readonly token: string;
}> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  return { baseUrl, token };
}

export async function prepareHostedSite(
  body: HostedSitePrepareRequest,
): Promise<HostedSitePrepareResponse> {
  const { baseUrl, token } = await getAuthContext();
  const response = await fetch(
    new URL("/api/host/deployments/prepare", baseUrl),
    {
      method: "POST",
      headers: headersWithCliClientHeaders(authHeaders(token, { json: true })),
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to prepare hosted-site deployment",
    );
    throw new ApiRequestError(message, code, response.status);
  }
  return withAbsoluteHostedUrls(
    (await response.json()) as HostedSitePrepareResponse,
  );
}

export async function completeHostedSite(
  deploymentId: string,
): Promise<HostedSiteCompleteResponse> {
  const { baseUrl, token } = await getAuthContext();
  const response = await fetch(
    new URL(
      `/api/host/deployments/${encodeURIComponent(deploymentId)}/complete`,
      baseUrl,
    ),
    {
      method: "POST",
      headers: headersWithCliClientHeaders(authHeaders(token, { json: true })),
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to complete hosted-site deployment",
    );
    throw new ApiRequestError(message, code, response.status);
  }
  return withAbsoluteHostedUrls(
    (await response.json()) as HostedSiteCompleteResponse,
  );
}

export async function getHostedSiteFiles(
  publicSlug: string,
  version?: number,
): Promise<HostedSiteFilesResponse> {
  const { baseUrl, token } = await getAuthContext();
  const url = new URL(
    `/api/host/sites/${encodeURIComponent(publicSlug)}/files`,
    baseUrl,
  );
  if (version !== undefined) {
    url.searchParams.set("version", String(version));
  }
  const response = await fetch(url, {
    method: "GET",
    headers: headersWithCliClientHeaders(authHeaders(token)),
  });
  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to get hosted-site files",
    );
    throw new ApiRequestError(message, code, response.status);
  }
  return withAbsoluteHostedUrls(
    (await response.json()) as HostedSiteFilesResponse,
  );
}

export async function getHostedSiteDeployments(
  site: string,
): Promise<HostedSiteDeploymentsResponse> {
  const { baseUrl, token } = await getAuthContext();
  const response = await fetch(
    new URL(`/api/host/sites/${encodeURIComponent(site)}/deployments`, baseUrl),
    {
      method: "GET",
      headers: headersWithCliClientHeaders(authHeaders(token)),
    },
  );
  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to list hosted-site deployments",
    );
    throw new ApiRequestError(message, code, response.status);
  }
  const result = (await response.json()) as HostedSiteDeploymentsResponse;
  return {
    ...result,
    deployments: await Promise.all(
      result.deployments.map(async (deployment) => {
        return {
          ...deployment,
          artifactUrl:
            deployment.artifactUrl === null
              ? null
              : await absoluteArtifactUrl(deployment.artifactUrl),
        };
      }),
    ),
  };
}
