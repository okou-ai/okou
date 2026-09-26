import {
  cloudflareAccessContract,
  type CreateCloudflareAccessConfigRequest,
  type UpdateCloudflareAccessRequest,
  type ConvertCloudflareAccessRequest,
  type DeleteCloudflareAccessRequest,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { command } from "ccstate";
import { cloudflareAccessErrorResponse } from "../../lib/cloudflare-access-error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { clerk$, createClerkReadContext } from "../external/clerk";
import type { RouteEntry } from "../route-entry";
import {
  createCloudflareAccessConfig,
  convertCloudflareAccessToPersonal,
  convertCloudflareAccessToOrganization,
  deleteCloudflareAccessConfig,
  listCloudflareAccessConfigs,
  previewCloudflareAccessConversion,
  previewCloudflareAccessDeletion,
  updateCloudflareAccessConfig,
} from "../services/cloudflare-access.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { loadUserDisplayNames } from "../services/user-profile-directory.service";

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

const listConfigs$ = command(async ({ get }, signal: AbortSignal) => {
  const configs = await listCloudflareAccessConfigs(
    get(db$),
    get(organizationAuthContext$),
  );
  signal.throwIfAborted();
  return configs;
});

const createConfig$ = command(
  async (
    { get, set },
    body: CreateCloudflareAccessConfigRequest,
    signal: AbortSignal,
  ) => {
    const featureContext = await set(encryptionContext$, signal);
    const config = await createCloudflareAccessConfig({
      db: set(writeDb$),
      owner: get(organizationAuthContext$),
      body,
      id: body.id,
      featureContext,
    });
    signal.throwIfAborted();
    return config;
  },
);

const updateConfig$ = command(
  async (
    { get, set },
    configId: string,
    body: UpdateCloudflareAccessRequest,
    signal: AbortSignal,
  ) => {
    const featureContext = await set(encryptionContext$, signal);
    const result = await updateCloudflareAccessConfig({
      db: set(writeDb$),
      owner: get(organizationAuthContext$),
      configId,
      body,
      featureContext,
    });
    signal.throwIfAborted();
    return result;
  },
);

const deleteConfig$ = command(
  async (
    { get, set },
    configId: string,
    body: DeleteCloudflareAccessRequest,
    signal: AbortSignal,
  ) => {
    const result = await deleteCloudflareAccessConfig({
      db: set(writeDb$),
      owner: get(organizationAuthContext$),
      configId,
      body,
    });
    signal.throwIfAborted();
    return result;
  },
);

const list$ = command(async ({ set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const configs = await set(listConfigs$, signal);
  return { status: 200 as const, body: { configs } };
});

const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(cloudflareAccessContract.create));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const config = await set(createConfig$, body.data, signal);
  if (!config.ok) {
    return cloudflareAccessErrorResponse(
      config.kind === "forbidden" ? 403 : 409,
      config.code,
      config.message,
    );
  }
  return config.value === undefined
    ? { status: 204 as const, body: undefined }
    : { status: 201 as const, body: config.value };
});

const update$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(cloudflareAccessContract.update));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { configId } = get(pathParamsOf(cloudflareAccessContract.update));
  const result = await set(updateConfig$, configId, body.data, signal);
  return result.ok
    ? { status: 200 as const, body: result.value }
    : cloudflareAccessErrorResponse(
        result.kind === "not_found"
          ? 404
          : result.kind === "forbidden"
            ? 403
            : 409,
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
  const result = await set(deleteConfig$, configId, body.data, signal);
  return result.ok
    ? { status: 204 as const, body: undefined }
    : cloudflareAccessErrorResponse(
        result.kind === "not_found"
          ? 404
          : result.kind === "forbidden"
            ? 403
            : 409,
        result.code,
        result.message,
      );
});

const promote$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(
    bodyResultOf(cloudflareAccessContract.convertToOrganization),
  );
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { configId } = get(
    pathParamsOf(cloudflareAccessContract.convertToOrganization),
  );
  const result = await convertCloudflareAccessToOrganization({
    db: set(writeDb$),
    owner: get(organizationAuthContext$),
    configId,
    expectedRevision: body.data.expectedRevision,
  });
  signal.throwIfAborted();
  return result.ok
    ? { status: 200 as const, body: result.value }
    : cloudflareAccessErrorResponse(
        result.kind === "not_found"
          ? 404
          : result.kind === "forbidden"
            ? 403
            : 409,
        result.code,
        result.message,
      );
});

const impactPreview$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const { configId } = get(
    pathParamsOf(cloudflareAccessContract.impactPreview),
  );
  const { operation } = get(queryOf(cloudflareAccessContract.impactPreview));
  const owner = get(organizationAuthContext$);
  const result =
    operation === "convert"
      ? await previewCloudflareAccessConversion({
          db: get(db$),
          owner,
          configId,
        })
      : await previewCloudflareAccessDeletion({
          db: get(db$),
          owner,
          configId,
        });
  signal.throwIfAborted();
  if (!result.ok) {
    return cloudflareAccessErrorResponse(
      result.kind === "not_found" ? 404 : 403,
      result.code,
      result.message,
    );
  }
  const { value } = result;
  const names = await loadUserDisplayNames(
    set(writeDb$),
    get(clerk$),
    value.affectedOwnerIds,
    createClerkReadContext(),
    signal,
  );
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      expectedRevision: value.expectedRevision,
      ownHostCount: value.ownHostCount,
      otherHostCount: value.otherHostCount,
      affectedOwners: value.affectedOwnerIds.map((userId) => {
        return { userId, displayName: names.get(userId) ?? null };
      }),
      impactSnapshot: value.impactSnapshot,
    },
  };
});

const convertConfig$ = command(
  async (
    { get, set },
    configId: string,
    body: ConvertCloudflareAccessRequest,
    signal: AbortSignal,
  ) => {
    const result = await convertCloudflareAccessToPersonal({
      db: set(writeDb$),
      owner: get(organizationAuthContext$),
      configId,
      body,
    });
    signal.throwIfAborted();
    return result;
  },
);

const convert$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(
    bodyResultOf(cloudflareAccessContract.convertToPersonal),
  );
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { configId } = get(
    pathParamsOf(cloudflareAccessContract.convertToPersonal),
  );
  const result = await set(convertConfig$, configId, body.data, signal);
  return result.ok
    ? { status: 200 as const, body: result.value }
    : cloudflareAccessErrorResponse(
        result.kind === "not_found"
          ? 404
          : result.kind === "forbidden"
            ? 403
            : 409,
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
  {
    route: cloudflareAccessContract.convertToOrganization,
    handler: authRoute(ownerAuth, promote$),
  },
  {
    route: cloudflareAccessContract.impactPreview,
    handler: authRoute(ownerAuth, impactPreview$),
  },
  {
    route: cloudflareAccessContract.convertToPersonal,
    handler: authRoute(ownerAuth, convert$),
  },
];
