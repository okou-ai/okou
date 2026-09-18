import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  readDisabledPaidTools,
  updateDisabledPaidTool,
} from "../services/paid-tools.service";

const paidToolsEnabled$ = computed(async (get) => {
  const { orgId, userId } = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(get(db$), orgId, userId);
  return isFeatureEnabled(FeatureSwitchKey.PaidToolControls, context);
});

function unavailable() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Paid tool controls are not enabled",
        code: "FORBIDDEN" as const,
      },
    },
  };
}

const getPaidTools$ = computed(async (get) => {
  if (!(await get(paidToolsEnabled$))) {
    return unavailable();
  }
  const { orgId, userId } = get(organizationAuthContext$);
  const disabledTools = await readDisabledPaidTools(get(db$), orgId, userId);
  return { status: 200 as const, body: { disabledTools } };
});

const updateBody$ = bodyResultOf(paidToolsContract.update);
const updateParams$ = pathParamsOf(paidToolsContract.update);

const updatePaidTool$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(paidToolsEnabled$))) {
    return unavailable();
  }
  signal.throwIfAborted();
  const body = await get(updateBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { toolId } = get(updateParams$);
  const { orgId, userId } = get(organizationAuthContext$);
  await updateDisabledPaidTool(set(writeDb$), {
    orgId,
    userId,
    toolId,
    disabled: body.data.disabled,
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { toolId, disabled: body.data.disabled },
  };
});

const authOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const paidToolsRoutes: readonly RouteEntry[] = [
  {
    route: paidToolsContract.get,
    handler: authRoute(authOptions, getPaidTools$),
  },
  {
    route: paidToolsContract.update,
    handler: authRoute(authOptions, updatePaidTool$),
  },
];
