import {
  tailscaleContract,
  type CreateTailscaleConfigRequest,
  type UpdateTailscaleRequest,
} from "@okouai/api-contracts/contracts/tailscale";
import { command } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { clerk$, createClerkReadContext } from "../external/clerk";
import { loadUserDisplayNames } from "../services/user-profile-directory.service";
import type { RouteEntry } from "../route-entry";
import {
  createTailscaleConfig$,
  deleteTailscaleConfig$,
  listTailscaleConfigs$,
  tailscaleFailure,
  updateTailscaleConfig$,
  convertTailscaleToOrganization$,
  convertTailscaleToPersonal$,
  previewTailscaleImpact$,
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
    body: body.data,
  });
  signal.throwIfAborted();
  return result.ok
    ? { status: 204 as const, body: undefined }
    : errorResponse(result);
});
const promote$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(tailscaleContract.convertToOrganization));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { configId } = get(
    pathParamsOf(tailscaleContract.convertToOrganization),
  );
  const result = await set(convertTailscaleToOrganization$, {
    owner: get(organizationAuthContext$),
    configId,
    expectedRevision: body.data.expectedRevision,
  });
  signal.throwIfAborted();
  return result.ok
    ? { status: 200 as const, body: result.value }
    : errorResponse(result);
});
const convert$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(tailscaleContract.convertToPersonal));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { configId } = get(pathParamsOf(tailscaleContract.convertToPersonal));
  const result = await set(convertTailscaleToPersonal$, {
    owner: get(organizationAuthContext$),
    configId,
    body: body.data,
  });
  signal.throwIfAborted();
  return result.ok
    ? { status: 200 as const, body: result.value }
    : errorResponse(result);
});
const impactPreview$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const { configId } = get(pathParamsOf(tailscaleContract.impactPreview));
  const { operation } = get(queryOf(tailscaleContract.impactPreview));
  const result = await set(previewTailscaleImpact$, {
    owner: get(organizationAuthContext$),
    configId,
    operation,
  });
  signal.throwIfAborted();
  if (!result.ok) {
    return errorResponse(result);
  }
  const names = await loadUserDisplayNames(
    set(writeDb$),
    get(clerk$),
    result.value.affectedOwnerIds,
    createClerkReadContext(),
    signal,
  );
  signal.throwIfAborted();
  const { affectedOwnerIds, ...value } = result.value;
  return {
    status: 200 as const,
    body: {
      ...value,
      affectedOwners: affectedOwnerIds.map((userId) => {
        return { userId, displayName: names.get(userId) ?? null };
      }),
    },
  };
});
export const tailscaleRoutes: readonly RouteEntry[] = [
  { route: tailscaleContract.list, handler: authRoute(ownerAuth, list$) },
  { route: tailscaleContract.create, handler: authRoute(ownerAuth, create$) },
  { route: tailscaleContract.update, handler: authRoute(ownerAuth, update$) },
  { route: tailscaleContract.delete, handler: authRoute(ownerAuth, delete$) },
  {
    route: tailscaleContract.convertToOrganization,
    handler: authRoute(ownerAuth, promote$),
  },
  {
    route: tailscaleContract.impactPreview,
    handler: authRoute(ownerAuth, impactPreview$),
  },
  {
    route: tailscaleContract.convertToPersonal,
    handler: authRoute(ownerAuth, convert$),
  },
];
