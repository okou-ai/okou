import { command } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { resourceUnavailable } from "../../lib/error";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  applyUserPermissionGrants$,
  applyUserPermissionGrantsBatch$,
  listUserPermissionGrants$,
} from "../services/user-permission-grants.service";

const userPermissionGrantAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const listQuery$ = queryOf(userPermissionGrantsContract.list);
const applyBody$ = bodyResultOf(userPermissionGrantsContract.apply);
const applyBatchBody$ = bodyResultOf(userPermissionGrantsContract.applyBatch);

function permissionGrantScopeFromQuery(query: { readonly agentId?: string }): {
  readonly agentId: string;
} {
  if (query.agentId !== undefined) {
    return { agentId: query.agentId };
  }
  throw new Error("Expected permission grant scope");
}

const listUserPermissionGrantsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(listQuery$);
    const scope = permissionGrantScopeFromQuery(query);
    const result = await set(
      listUserPermissionGrants$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        role: auth.orgRole ?? "member",
        ...scope,
      },
      signal,
    );
    signal.throwIfAborted();

    if ("kind" in result) {
      return { status: 200 as const, body: [...result.grants] };
    }
    return result;
  },
);

const applyUserPermissionGrantsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(applyBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      applyUserPermissionGrants$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        role: auth.orgRole ?? "member",
        apply: bodyResult.data,
      },
      signal,
    );
    signal.throwIfAborted();

    if ("kind" in result) {
      return { status: 200 as const, body: [...result.grants] };
    }
    return result;
  },
);

const applyUserPermissionGrantsBatchInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const features = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    if (
      !isFeatureEnabled(FeatureSwitchKey.BatchConnectorPermissions, features)
    ) {
      return resourceUnavailable(
        "Batch connector permissions are not available",
      );
    }
    const bodyResult = await get(applyBatchBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const result = await set(
      applyUserPermissionGrantsBatch$,
      { orgId: auth.orgId, userId: auth.userId, apply: bodyResult.data },
      signal,
    );
    if ("kind" in result) {
      return { status: 200 as const, body: [...result.grants] };
    }
    return result;
  },
);

export const userPermissionGrantsRoutes: readonly RouteEntry[] = [
  {
    route: userPermissionGrantsContract.applyBatch,
    handler: authRoute(
      userPermissionGrantAuthOptions,
      applyUserPermissionGrantsBatchInner$,
    ),
  },
  {
    route: userPermissionGrantsContract.list,
    handler: authRoute(
      userPermissionGrantAuthOptions,
      listUserPermissionGrantsInner$,
    ),
  },
  {
    route: userPermissionGrantsContract.apply,
    handler: authRoute(
      userPermissionGrantAuthOptions,
      applyUserPermissionGrantsInner$,
    ),
  },
];
