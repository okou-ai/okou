import {
  cloudflareAccessContract,
  sshCloudflareAccessContract,
  type CloudflareAccessConfig,
  type CreateCloudflareAccessRequest,
  type SshCloudflareAccessConfig,
  type UpdateCloudflareAccessRequest,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  CLOUDFLARE_ACCESS_ERROR_CODES,
  type CloudflareAccessErrorCode,
} from "@okouai/api-contracts/contracts/cloudflare-access-errors";
import {
  SSH_ERROR_CODES,
  type SshErrorCode,
} from "@okouai/api-contracts/contracts/ssh-errors";
import { command } from "ccstate";
import { cloudflareAccessErrorResponse } from "../../lib/cloudflare-access-error";
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

function toSshCloudflareAccessConfig(
  config: CloudflareAccessConfig,
): SshCloudflareAccessConfig {
  const { sshHosts, ...metadata } = config;
  return { ...metadata, hosts: sshHosts };
}

function toSshCloudflareAccessError(
  code: CloudflareAccessErrorCode,
  message: string,
): { readonly code: SshErrorCode; readonly message: string } {
  switch (code) {
    case CLOUDFLARE_ACCESS_ERROR_CODES.RESOURCE_ID_CONFLICT: {
      return {
        code: SSH_ERROR_CODES.RESOURCE_ID_CONFLICT,
        message: "This resource ID cannot be used for this SSH configuration.",
      };
    }
    case CLOUDFLARE_ACCESS_ERROR_CODES.REVISION_EXHAUSTED: {
      return {
        code: SSH_ERROR_CODES.REVISION_EXHAUSTED,
        message: "SSH configuration revision limit reached",
      };
    }
    default: {
      return { code, message };
    }
  }
}

function sshCloudflareAccessErrorResponse<Status extends 400 | 404 | 409>(
  status: Status,
  code: CloudflareAccessErrorCode,
  message: string,
) {
  const error = toSshCloudflareAccessError(code, message);
  return sshErrorResponse(status, error.code, error.message);
}

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
    body: CreateCloudflareAccessRequest & { readonly id: string },
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
    expectedRevision: number,
    signal: AbortSignal,
  ) => {
    const result = await deleteCloudflareAccessConfig({
      db: set(writeDb$),
      owner: get(organizationAuthContext$),
      configId,
      expectedRevision,
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

const sshList$ = command(async ({ set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const configs = await set(listConfigs$, signal);
  return {
    status: 200 as const,
    body: { configs: configs.map(toSshCloudflareAccessConfig) },
  };
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
    return cloudflareAccessErrorResponse(409, config.code, config.message);
  }
  return config.value === undefined
    ? { status: 204 as const, body: undefined }
    : { status: 201 as const, body: config.value };
});

const sshCreate$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(sshCloudflareAccessContract.create));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const config = await set(createConfig$, body.data, signal);
  if (!config.ok) {
    return sshCloudflareAccessErrorResponse(409, config.code, config.message);
  }
  return config.value === undefined
    ? { status: 204 as const, body: undefined }
    : {
        status: 201 as const,
        body: toSshCloudflareAccessConfig(config.value),
      };
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
        result.kind === "not_found" ? 404 : 409,
        result.code,
        result.message,
      );
});

const sshUpdate$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(sshCloudflareAccessContract.update));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { configId } = get(pathParamsOf(sshCloudflareAccessContract.update));
  const result = await set(updateConfig$, configId, body.data, signal);
  return result.ok
    ? {
        status: 200 as const,
        body: toSshCloudflareAccessConfig(result.value),
      }
    : sshCloudflareAccessErrorResponse(
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
  const result = await set(
    deleteConfig$,
    configId,
    body.data.expectedRevision,
    signal,
  );
  return result.ok
    ? { status: 204 as const, body: undefined }
    : cloudflareAccessErrorResponse(
        result.kind === "not_found" ? 404 : 409,
        result.code,
        result.message,
      );
});

const sshDelete$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(sshCloudflareAccessContract.delete));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { configId } = get(pathParamsOf(sshCloudflareAccessContract.delete));
  const result = await set(
    deleteConfig$,
    configId,
    body.data.expectedRevision,
    signal,
  );
  return result.ok
    ? { status: 204 as const, body: undefined }
    : sshCloudflareAccessErrorResponse(
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
  {
    route: sshCloudflareAccessContract.list,
    handler: authRoute(ownerAuth, sshList$),
  },
  {
    route: sshCloudflareAccessContract.create,
    handler: authRoute(ownerAuth, sshCreate$),
  },
  {
    route: sshCloudflareAccessContract.update,
    handler: authRoute(ownerAuth, sshUpdate$),
  },
  {
    route: sshCloudflareAccessContract.delete,
    handler: authRoute(ownerAuth, sshDelete$),
  },
];
