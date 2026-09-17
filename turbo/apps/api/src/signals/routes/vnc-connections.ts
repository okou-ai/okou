import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  VNC_ERROR_CODES,
  type VncErrorCode,
} from "@okouai/api-contracts/contracts/vnc-errors";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { vncErrorResponse } from "../../lib/vnc-error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { hasCurrentVncMembership } from "../services/vnc-owner-lifecycle.service";
import {
  createVncCredential,
  deleteVncCredential,
  listVncCredentials,
  updateVncCredential,
} from "../services/vnc-credential.service";
import {
  createVncConnection,
  deleteVncConnection,
  listVncConnections,
  summarizeVncConnections,
  updateVncConnection,
} from "../services/vnc-connection.service";

const unavailable = Object.freeze(
  vncErrorResponse(
    404,
    VNC_ERROR_CODES.UNAVAILABLE,
    "VNC configuration is not available",
  ),
);
const invalidInput = Object.freeze(
  vncErrorResponse(
    400,
    VNC_ERROR_CODES.INVALID_INPUT,
    "Invalid VNC configuration",
  ),
);
const ownerAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;

const vncAdmission$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = get(organizationAuthContext$);
  const featureContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.VncAccess, featureContext)) {
    return null;
  }
  const isMember = await hasCurrentVncMembership(get(clerk$), auth, signal);
  if (!isMember) {
    return null;
  }
  return {
    db: set(writeDb$),
    featureContext,
    owner: { orgId: auth.orgId, userId: auth.userId },
  };
});

function mapFailure(result: {
  readonly kind: "bad_request" | "not_found" | "conflict";
  readonly code: VncErrorCode;
  readonly message: string;
}) {
  switch (result.kind) {
    case "bad_request": {
      return vncErrorResponse(400, result.code, result.message);
    }
    case "not_found": {
      return vncErrorResponse(404, result.code, result.message);
    }
    case "conflict": {
      return vncErrorResponse(409, result.code, result.message);
    }
  }
}

const listCredentials$ = command(async ({ set }, signal: AbortSignal) => {
  const context = await set(vncAdmission$, signal);
  if (!context) {
    return unavailable;
  }
  const credentials = await listVncCredentials(context.db, context.owner);
  signal.throwIfAborted();
  return { status: 200 as const, body: { credentials } };
});

const createCredential$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = await set(vncAdmission$, signal);
  if (!context) {
    return unavailable;
  }
  const body = await get(bodyResultOf(vncCredentialsContract.create));
  signal.throwIfAborted();
  if (!body.ok) {
    return invalidInput;
  }
  const result = await createVncCredential({
    ...context,
    body: body.data,
    id: body.data.id,
  });
  signal.throwIfAborted();
  if (!result.ok) {
    return mapFailure(result);
  }
  return result.value === undefined
    ? { status: 204 as const, body: undefined }
    : { status: 201 as const, body: result.value };
});

const updateCredential$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = await set(vncAdmission$, signal);
  if (!context) {
    return unavailable;
  }
  const [body, params] = await Promise.all([
    get(bodyResultOf(vncCredentialsContract.update)),
    get(pathParamsOf(vncCredentialsContract.update)),
  ]);
  signal.throwIfAborted();
  if (!body.ok) {
    return invalidInput;
  }
  const result = await updateVncCredential({
    ...context,
    credentialId: params.credentialId,
    body: body.data,
  });
  signal.throwIfAborted();
  return result.ok
    ? { status: 200 as const, body: result.value }
    : mapFailure(result);
});

const deleteCredential$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = await set(vncAdmission$, signal);
  if (!context) {
    return unavailable;
  }
  const [body, params] = await Promise.all([
    get(bodyResultOf(vncCredentialsContract.delete)),
    get(pathParamsOf(vncCredentialsContract.delete)),
  ]);
  signal.throwIfAborted();
  if (!body.ok) {
    return invalidInput;
  }
  const result = await deleteVncCredential({
    ...context,
    credentialId: params.credentialId,
    expectedRevision: body.data.expectedRevision,
  });
  signal.throwIfAborted();
  return result.ok
    ? { status: 204 as const, body: undefined }
    : mapFailure(result);
});

const listConnections$ = command(async ({ set }, signal: AbortSignal) => {
  const context = await set(vncAdmission$, signal);
  if (!context) {
    return unavailable;
  }
  const connections = await listVncConnections(context.db, context.owner);
  signal.throwIfAborted();
  return { status: 200 as const, body: { connections } };
});

const summary$ = command(async ({ set }, signal: AbortSignal) => {
  const context = await set(vncAdmission$, signal);
  if (!context) {
    return unavailable;
  }
  const summary = await summarizeVncConnections(context.db, context.owner);
  signal.throwIfAborted();
  return { status: 200 as const, body: summary };
});

const createConnection$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = await set(vncAdmission$, signal);
  if (!context) {
    return unavailable;
  }
  const body = await get(bodyResultOf(vncConnectionsContract.create));
  signal.throwIfAborted();
  if (!body.ok) {
    return invalidInput;
  }
  const result = await createVncConnection({ ...context, body: body.data });
  signal.throwIfAborted();
  if (!result.ok) {
    return mapFailure(result);
  }
  return result.value === undefined
    ? { status: 204 as const, body: undefined }
    : { status: 201 as const, body: result.value };
});

const updateConnection$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = await set(vncAdmission$, signal);
  if (!context) {
    return unavailable;
  }
  const [body, params] = await Promise.all([
    get(bodyResultOf(vncConnectionsContract.update)),
    get(pathParamsOf(vncConnectionsContract.update)),
  ]);
  signal.throwIfAborted();
  if (!body.ok) {
    return invalidInput;
  }
  const result = await updateVncConnection({
    ...context,
    connectionId: params.connectionId,
    body: body.data,
  });
  signal.throwIfAborted();
  return result.ok
    ? { status: 200 as const, body: result.value }
    : mapFailure(result);
});

const deleteConnection$ = command(async ({ get, set }, signal: AbortSignal) => {
  const context = await set(vncAdmission$, signal);
  if (!context) {
    return unavailable;
  }
  const [body, params] = await Promise.all([
    get(bodyResultOf(vncConnectionsContract.delete)),
    get(pathParamsOf(vncConnectionsContract.delete)),
  ]);
  signal.throwIfAborted();
  if (!body.ok) {
    return invalidInput;
  }
  const result = await deleteVncConnection({
    ...context,
    connectionId: params.connectionId,
    expectedGeneration: body.data.expectedGeneration,
  });
  signal.throwIfAborted();
  return result.ok
    ? { status: 204 as const, body: undefined }
    : mapFailure(result);
});

export const vncConnectionsRoutes: readonly RouteEntry[] = [
  {
    route: vncCredentialsContract.list,
    handler: authRoute(ownerAuth, listCredentials$),
  },
  {
    route: vncCredentialsContract.create,
    handler: authRoute(ownerAuth, createCredential$),
  },
  {
    route: vncCredentialsContract.update,
    handler: authRoute(ownerAuth, updateCredential$),
  },
  {
    route: vncCredentialsContract.delete,
    handler: authRoute(ownerAuth, deleteCredential$),
  },
  {
    route: vncConnectionsContract.list,
    handler: authRoute(ownerAuth, listConnections$),
  },
  {
    route: vncConnectionsContract.summary,
    handler: authRoute(ownerAuth, summary$),
  },
  {
    route: vncConnectionsContract.create,
    handler: authRoute(ownerAuth, createConnection$),
  },
  {
    route: vncConnectionsContract.update,
    handler: authRoute(ownerAuth, updateConnection$),
  },
  {
    route: vncConnectionsContract.delete,
    handler: authRoute(ownerAuth, deleteConnection$),
  },
];
