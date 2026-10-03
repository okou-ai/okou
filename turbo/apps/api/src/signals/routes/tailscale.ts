import {
  tailscaleContract,
  type CreateTailscaleConfigRequest,
  type UpdateTailscaleRequest,
} from "@okouai/api-contracts/contracts/tailscale";
import { command } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  createTailscaleConfig$,
  deleteTailscaleConfig$,
  listTailscaleConfigs$,
  tailscaleFailure,
  updateTailscaleConfig$,
} from "../services/tailscale.service";
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
function errorResponse(error: ReturnType<typeof tailscaleFailure>) {
  return {
    status:
      error.kind === "not_found"
        ? (404 as const)
        : error.kind === "forbidden"
          ? (403 as const)
          : (409 as const),
    body: { error: { code: error.code, message: error.message } },
  };
}
const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const configs = await set(
    listTailscaleConfigs$,
    get(organizationAuthContext$),
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: { configs } };
});
const detail$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const { configId } = get(pathParamsOf(tailscaleContract.get));
  const [config] = await set(
    listTailscaleConfigs$,
    get(organizationAuthContext$),
    configId,
  );
  signal.throwIfAborted();
  return config
    ? { status: 200 as const, body: config }
    : errorResponse(tailscaleFailure("notFound"));
});
const createConfig$ = command(
  async (
    { get, set },
    body: CreateTailscaleConfigRequest,
    signal: AbortSignal,
  ) => {
    const featureContext = await set(encryptionContext$, signal);
    const result = await set(createTailscaleConfig$, {
      owner: get(organizationAuthContext$),
      body,
      featureContext,
    });
    signal.throwIfAborted();
    return result;
  },
);
const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(tailscaleContract.create));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(createConfig$, body.data, signal);
  return !result.ok
    ? errorResponse(result)
    : result.value === undefined
      ? { status: 204 as const, body: undefined }
      : { status: 201 as const, body: result.value };
});
const updateConfig$ = command(
  async (
    { get, set },
    configId: string,
    body: UpdateTailscaleRequest,
    signal: AbortSignal,
  ) => {
    const featureContext = await set(encryptionContext$, signal);
    const result = await set(updateTailscaleConfig$, {
      owner: get(organizationAuthContext$),
      configId,
      body,
      featureContext,
    });
    signal.throwIfAborted();
    return result;
  },
);
const update$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(tailscaleContract.update));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { configId } = get(pathParamsOf(tailscaleContract.update));
  const result = await set(updateConfig$, configId, body.data, signal);
  return result.ok
    ? { status: 200 as const, body: result.value }
    : errorResponse(result);
});
const delete$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(tailscaleContract.delete));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { configId } = get(pathParamsOf(tailscaleContract.delete));
  const result = await set(deleteTailscaleConfig$, {
    owner: get(organizationAuthContext$),
    configId,
    expectedRevision: body.data.expectedRevision,
  });
  signal.throwIfAborted();
  return result.ok
    ? { status: 204 as const, body: undefined }
    : errorResponse(result);
});
export const tailscaleRoutes: readonly RouteEntry[] = [
  { route: tailscaleContract.list, handler: authRoute(ownerAuth, list$) },
  { route: tailscaleContract.get, handler: authRoute(ownerAuth, detail$) },
  { route: tailscaleContract.create, handler: authRoute(ownerAuth, create$) },
  { route: tailscaleContract.update, handler: authRoute(ownerAuth, update$) },
  { route: tailscaleContract.delete, handler: authRoute(ownerAuth, delete$) },
];
