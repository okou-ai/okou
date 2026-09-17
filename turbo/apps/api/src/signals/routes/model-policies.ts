import { command } from "ccstate";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage } from "../../lib/error";
import { publishModelPoliciesChangedForOrgSafely } from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import {
  listOrgModelPolicies$,
  updateOrgModelPolicies$,
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
    route: modelPoliciesMainContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateModelPoliciesInner$,
    ),
  },
];
