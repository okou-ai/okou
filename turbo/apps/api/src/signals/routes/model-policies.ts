import { command } from "ccstate";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { FeatureSwitchKey, isFeatureEnabled } from "@okouai/core";
import { writeDb$ } from "../external/db";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage, notFound } from "../../lib/error";
import { publishModelPoliciesChangedForOrgSafely } from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import {
  listOrgModelPolicies$,
  updateOrgModelPolicies$,
  updateOrgModelMode$,
} from "../services/model-policy.service";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only admins can manage model policies",
      code: "FORBIDDEN",
    }),
  }),
});

const updateBody$ = bodyResultOf(modelPoliciesMainContract.update);
const updateModeBody$ = bodyResultOf(modelPoliciesMainContract.updateMode);

const listModelPoliciesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await set(
      listOrgModelPolicies$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    return { status: 200 as const, body };
  },
);

const updateModelPoliciesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const body = await get(updateBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      updateOrgModelPolicies$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        policies: body.data.policies,
        revision: body.data.revision,
      },
      signal,
    );
    if (!result.ok) {
      if ("response" in result) {
        return result.response;
      }
      return badRequestMessage(result.message);
    }

    await publishModelPoliciesChangedForOrgSafely(auth.orgId);
    signal.throwIfAborted();
    return { status: 200 as const, body: result.data };
  },
);

const updateModelModeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    const body = await get(updateModeBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const context = await loadUserFeatureSwitchContext(
      set(writeDb$),
      auth.orgId,
      auth.userId,
    );
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.AutoModel, context)) {
      return adminRequired;
    }
    const mode = await set(
      updateOrgModelMode$,
      { orgId: auth.orgId, mode: body.data.mode },
      signal,
    );
    signal.throwIfAborted();
    if (mode === null) {
      return notFound("Organization not found");
    }
    await publishModelPoliciesChangedForOrgSafely(auth.orgId);
    signal.throwIfAborted();
    return { status: 200 as const, body: { mode } };
  },
);

export const modelPoliciesRoutes: readonly RouteEntry[] = [
  {
    route: modelPoliciesMainContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        acceptAnySandboxCapability: true,
      },
      listModelPoliciesInner$,
    ),
  },
  {
    route: modelPoliciesMainContract.updateMode,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateModelModeInner$,
    ),
  },
  {
    route: modelPoliciesMainContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateModelPoliciesInner$,
    ),
  },
];
