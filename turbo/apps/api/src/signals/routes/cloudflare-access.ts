import {
  cloudflareAccessContract,
  type CreateCloudflareAccessConfigRequest,
  type UpdateCloudflareAccessRequest,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { command } from "ccstate";
import { cloudflareAccessErrorResponse } from "../../lib/cloudflare-access-error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
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

const listConfigs$ = command(
  async ({ get }, view: "legacy" | "scoped", signal: AbortSignal) => {
    const configs = await listCloudflareAccessConfigs(
      get(db$),
      get(organizationAuthContext$),
      view,
    );
    signal.throwIfAborted();
    return configs;
  },
);

const createConfig$ = command(
  async (
    { get, set },
    body: CreateCloudflareAccessConfigRequest,
    view: "legacy" | "scoped",
    signal: AbortSignal,
  ) => {
    const featureContext = await set(encryptionContext$, signal);
    const config = await createCloudflareAccessConfig({
      db: set(writeDb$),
      owner: get(organizationAuthContext$),
      body,
      id: body.id,
      featureContext,
      view,
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
    view: "legacy" | "scoped",
    signal: AbortSignal,
  ) => {
    const featureContext = await set(encryptionContext$, signal);
    const result = await updateCloudflareAccessConfig({
      db: set(writeDb$),
      owner: get(organizationAuthContext$),
      configId,
      body,
      featureContext,
      view,
    });
    signal.throwIfAborted();
    return result;
  },
);

const deleteConfig$ = command(
  async (
    { get, set },
    configId: string,
    expectedRevision: number,
    view: "legacy" | "scoped",
    signal: AbortSignal,
  ) => {
    const result = await deleteCloudflareAccessConfig({
      db: set(writeDb$),
      owner: get(organizationAuthContext$),
      configId,
      expectedRevision,
      view,
    });
    signal.throwIfAborted();
    return result;
  },
);

const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const view =
    get(queryOf(cloudflareAccessContract.list)).view === "scoped"
      ? "scoped"
      : "legacy";
  const configs = await set(listConfigs$, view, signal);
  return { status: 200 as const, body: { configs } };
});

const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(cloudflareAccessContract.create));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const view =
    get(queryOf(cloudflareAccessContract.create)).view === "scoped"
      ? "scoped"
      : "legacy";
  const config = await set(createConfig$, body.data, view, signal);
  if (!config.ok) {
    return cloudflareAccessErrorResponse(
      config.kind === "forbidden"
        ? 403
        : config.kind === "not_found"
          ? 404
          : 409,
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
  const view =
    get(queryOf(cloudflareAccessContract.update)).view === "scoped"
      ? "scoped"
      : "legacy";
  const result = await set(updateConfig$, configId, body.data, view, signal);
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
  const view =
    get(queryOf(cloudflareAccessContract.delete)).view === "scoped"
      ? "scoped"
      : "legacy";
  const result = await set(
    deleteConfig$,
    configId,
    body.data.expectedRevision,
    view,
    signal,
  );
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
