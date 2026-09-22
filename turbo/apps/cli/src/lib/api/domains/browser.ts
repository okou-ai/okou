import {
  browserAuthorizationRequestsContract,
  browserContract,
  type BrowserAuthorizationRequestCreateResponse,
  type BrowserCreateRequest,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import {
  browserUserActionsContract,
  type BrowserUserActionCreateRequest,
  type BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export interface BrowserUserActionCreateResponse {
  readonly actionUrl: string;
  readonly action: BrowserUserActionResponse;
}

async function client() {
  return initClient(browserContract, await getClientConfig());
}

async function authorizationClient() {
  return initClient(
    browserAuthorizationRequestsContract,
    await getClientConfig(),
  );
}

async function userActionClient() {
  return initClient(browserUserActionsContract, await getClientConfig());
}

export async function createBrowserAuthorizationRequest(): Promise<BrowserAuthorizationRequestCreateResponse> {
  const result = await (
    await authorizationClient()
  ).create({ headers: {}, body: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to create cloud browser authorization request");
}

export async function createBrowser(
  body: BrowserCreateRequest,
): Promise<{ browser: BrowserSession; cdpUrl: string }> {
  const result = await (await client()).create({ headers: {}, body });
  if (result.status === 201) {
    return result.body;
  }
  handleError(result, "Failed to create a new managed browser");
}

export async function useBrowser(): Promise<{
  browser: BrowserSession;
  cdpUrl: string;
}> {
  const result = await (
    await client()
  ).use({
    headers: {},
    body: {},
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to open the managed browser");
}

export async function leaseBrowser(): Promise<BrowserSession> {
  const result = await (
    await client()
  ).lease({
    headers: {},
    body: {},
  });
  if (result.status === 200) {
    return result.body.browser;
  }
  handleError(result, "Failed to extend the managed browser lease");
}

export async function getCurrentBrowser(): Promise<BrowserSession> {
  const result = await (await client()).current({ headers: {} });
  if (result.status === 200) {
    return result.body.browser;
  }
  handleError(result, "Failed to get the current managed browser");
}

export async function createBrowserUserAction(
  body: BrowserUserActionCreateRequest,
): Promise<BrowserUserActionCreateResponse> {
  const result = await (await userActionClient()).create({ headers: {}, body });
  if (result.status === 201) {
    return result.body;
  }
  handleError(result, "Failed to create a Browser user-action request");
}
