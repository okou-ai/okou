import { browserUserActionsContract } from "@okouai/api-contracts/contracts/browser-user-actions";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  applyBrowserUserAction$,
  cancelBrowserUserAction$,
  createBrowserUserAction$,
  preflightBrowserUserAction$,
  readBrowserUserAction$,
  type BrowserUserActionServiceError,
} from "../services/browser-user-actions.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";

const authOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;
const createAuthOptions = {
  ...authOptions,
  acceptAnySandboxCapability: true,
  accept: ["agent", "sandbox"],
} as const;
const disabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Browser native input is not enabled",
      code: "FORBIDDEN" as const,
    }),
  }),
});

function errorResponse(error: BrowserUserActionServiceError) {
  return {
    status: error.status,
    body: { error: { message: error.message, code: error.code } },
  };
}

const browserNativeInputEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.BrowserNativeInput, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

const browserNativeFileInputEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.BrowserNativeFileInput, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

const createBody$ = bodyResultOf(browserUserActionsContract.create);
const getParams$ = pathParamsOf(browserUserActionsContract.get);
const preflightParams$ = pathParamsOf(browserUserActionsContract.preflight);
const preflightBody$ = bodyResultOf(browserUserActionsContract.preflight);
const applyParams$ = pathParamsOf(browserUserActionsContract.apply);
const applyBody$ = bodyResultOf(browserUserActionsContract.apply);
const cancelParams$ = pathParamsOf(browserUserActionsContract.cancel);
const cancelBody$ = bodyResultOf(browserUserActionsContract.cancel);

const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await set(browserNativeInputEnabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return disabled;
  }
  if (auth.tokenType !== "agent" && auth.tokenType !== "sandbox") {
    return badRequestMessage("Browser user actions require a run token");
  }
  const body = await get(createBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (
    body.data.kind === "input" &&
    body.data.fields.some((field) => {
      return field.fieldKind === "file";
    })
  ) {
    const fileEnabled = await set(browserNativeFileInputEnabled$);
    signal.throwIfAborted();
    if (!fileEnabled) {
      return disabled;
    }
  }
  const result = await set(
    createBrowserUserAction$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      runId: auth.runId,
      input: body.data,
    },
    signal,
  );
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 201 as const, body: result.value };
});

const getInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await set(browserNativeInputEnabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return disabled;
  }
  const result = await set(
    readBrowserUserAction$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      requestToken: get(getParams$).requestToken,
    },
    signal,
  );
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: result.value };
});

const applyInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await set(browserNativeInputEnabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return disabled;
  }
  const body = await get(applyBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    applyBrowserUserAction$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      requestToken: get(applyParams$).requestToken,
      input: body.data,
    },
    signal,
  );
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: result.value };
});

const preflightInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await set(browserNativeInputEnabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return disabled;
  }
  const body = await get(preflightBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    preflightBrowserUserAction$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      requestToken: get(preflightParams$).requestToken,
    },
    signal,
  );
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: result.value };
});

const cancelInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await set(browserNativeInputEnabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return disabled;
  }
  const body = await get(cancelBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    cancelBrowserUserAction$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      requestToken: get(cancelParams$).requestToken,
    },
    signal,
  );
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: result.value };
});

export const browserUserActionRoutes: readonly RouteEntry[] = [
  {
    route: browserUserActionsContract.create,
    handler: authRoute(createAuthOptions, createInner$),
  },
  {
    route: browserUserActionsContract.get,
    handler: authRoute(authOptions, getInner$),
  },
  {
    route: browserUserActionsContract.preflight,
    handler: authRoute(authOptions, preflightInner$),
  },
  {
    route: browserUserActionsContract.apply,
    handler: authRoute(authOptions, applyInner$),
  },
  {
    route: browserUserActionsContract.cancel,
    handler: authRoute(authOptions, cancelInner$),
  },
];
