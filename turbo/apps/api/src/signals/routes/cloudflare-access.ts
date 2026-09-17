import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { command } from "ccstate";
import { sshErrorResponse } from "../../lib/ssh-error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  createCloudflareAccessConfig,
  deleteCloudflareAccessConfig,
  listCloudflareAccessConfigs,
  updateCloudflareAccessConfig,
} from "../services/cloudflare-access.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";

const ownerAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;
const encryptionContext$ = command(async ({ get }, signal: AbortSignal) => {
  const owner = get(organizationAuthContext$);
  const context = await get(
    userFeatureSwitchContext(owner.orgId, owner.userId),
  );
  signal.throwIfAborted();
  return context;
});
const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const configs = await listCloudflareAccessConfigs(
    get(db$),
    get(organizationAuthContext$),
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: { configs } };
});
const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const featureContext = await set(encryptionContext$, signal);
  const body = await get(bodyResultOf(cloudflareAccessContract.create));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const config = await createCloudflareAccessConfig({
    db: set(writeDb$),
    owner: get(organizationAuthContext$),
    body: body.data,
    id: body.data.id,
    featureContext,
  });
  signal.throwIfAborted();
  if (!config.ok) {
    return sshErrorResponse(409, config.code, config.message);
  }
  return config.value === undefined
    ? { status: 204 as const, body: undefined }
    : { status: 201 as const, body: config.value };
});
const update$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const featureContext = await set(encryptionContext$, signal);
  const body = await get(bodyResultOf(cloudflareAccessContract.update));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { configId } = get(pathParamsOf(cloudflareAccessContract.update));
  const result = await updateCloudflareAccessConfig({
    db: set(writeDb$),
    owner: get(organizationAuthContext$),
    configId,
    body: body.data,
    featureContext,
  });
  signal.throwIfAborted();
  return result.ok
    ? { status: 200 as const, body: result.value }
    : sshErrorResponse(
        result.kind === "not_found" ? 404 : 409,
        result.code,
        result.message,
      );
});
const delete$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(cloudflareAccessContract.delete));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { configId } = get(pathParamsOf(cloudflareAccessContract.delete));
  const result = await deleteCloudflareAccessConfig({
    db: set(writeDb$),
    owner: get(organizationAuthContext$),
    configId,
    expectedRevision: body.data.expectedRevision,
  });
  signal.throwIfAborted();
  return result.ok
    ? { status: 204 as const, body: undefined }
    : sshErrorResponse(
        result.kind === "not_found" ? 404 : 409,
        result.code,
        result.message,
      );
});
export const cloudflareAccessRoutes: readonly RouteEntry[] = [
  {
    route: cloudflareAccessContract.list,
    handler: authRoute(ownerAuth, list$),
  },
  {
    route: cloudflareAccessContract.create,
    handler: authRoute(ownerAuth, create$),
  },
  {
    route: cloudflareAccessContract.update,
    handler: authRoute(ownerAuth, update$),
  },
  {
    route: cloudflareAccessContract.delete,
    handler: authRoute(ownerAuth, delete$),
  },
];
