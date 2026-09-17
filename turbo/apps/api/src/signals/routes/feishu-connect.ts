import { feishuRequestPlatform$ as feishuPlatform$ } from "../context/feishu-platform";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { command, computed } from "ccstate";
import { eq } from "drizzle-orm";
import {
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import {
  PUBLIC_BRAND_PRESENTATION,
  PUBLIC_BRAND,
} from "@okouai/core/public-brand";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import { InvalidFeishuCredentialsError } from "../external/feishu-client";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { settle } from "../utils";
import {
  configureFeishuInstallation$,
  type ConfigureFeishuResult,
  disconnectFeishuConnection$,
  feishuConnectStatus,
  removeFeishuInstallation$,
  updateFeishuInstallationAgent$,
} from "../services/feishu-connect.service";

function adminRequired(platformName: string) {
  return {
    status: 403 as const,
    body: {
      error: {
        message: `Only organization admins can manage ${platformName} bots`,
        code: "FORBIDDEN" as const,
      },
    },
  };
}

const feishuPlatformName$ = computed((get) => {
  return FEISHU_PLATFORMS[get(feishuPlatform$)].name;
});

const feishuIntegrationDisabled$ = computed((get) => {
  return Object.freeze({
    status: 403 as const,
    body: Object.freeze({
      error: Object.freeze({
        message: `${get(feishuPlatformName$)} integration is not enabled`,
        code: "FORBIDDEN" as const,
      }),
    }),
  });
});

const feishuIntegrationEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(
    FEISHU_PLATFORMS[get(feishuPlatform$)].featureSwitch,
    context,
  );
});

function appIdInUse(platformName: string) {
  return conflict(
    `This ${platformName} App ID is already registered in ${PUBLIC_BRAND_PRESENTATION.brandName}`,
  );
}

const getStatus$ = computed(async (get) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return get(feishuIntegrationDisabled$);
  }
  const auth = get(organizationAuthContext$);
  const body = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      platform: get(feishuPlatform$),
      userId: auth.userId,
      publicBrand: PUBLIC_BRAND,
      isAdmin: auth.orgRole === "admin",
    }),
  );
  return { status: 200 as const, body };
});

const checkAppId$ = computed(async (get) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return get(feishuIntegrationDisabled$);
  }
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired(get(feishuPlatformName$));
  }
  const query = get(queryOf(feishuConnectContract.checkAppId));
  const [installation] = await get(db$)
    .select({ id: feishuOrgInstallations.id })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.appId, query.appId))
    .limit(1);
  return installation
    ? appIdInUse(get(feishuPlatformName$))
    : { status: 200 as const, body: { available: true as const } };
});

const setup$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return get(feishuIntegrationDisabled$);
  }
  const auth = get(organizationAuthContext$);
  const publicBrand = PUBLIC_BRAND;
  if (auth.orgRole !== "admin") {
    return adminRequired(get(feishuPlatformName$));
  }
  const bodyResult = await get(bodyResultOf(feishuConnectContract.setup));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const configured = await settle(
    set(
      configureFeishuInstallation$,
      {
        orgId: auth.orgId,
        platform: get(feishuPlatform$),
        userId: auth.userId,
        publicBrand,
        ...bodyResult.data,
      },
      signal,
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!configured.ok) {
    if (configured.error instanceof InvalidFeishuCredentialsError) {
      return badRequestMessage(
        `Invalid App ID or App Secret. Check the credentials in ${get(feishuPlatformName$)} and try again.`,
      );
    }
    throw configured.error;
  }
  const result: ConfigureFeishuResult = configured.value;
  if (result.kind === "agent_not_found") {
    return badRequestMessage("Select an agent from this organization");
  }
  if (result.kind === "installation_not_found") {
    return notFound(`${get(feishuPlatformName$)} integration not found`);
  }
  if (result.kind === "app_identity_mismatch") {
    return conflict(
      `A configured ${get(feishuPlatformName$)} installation cannot be changed to a different App ID. Add a separate installation instead.`,
    );
  }
  if (result.kind === "app_in_use") {
    return appIdInUse(get(feishuPlatformName$));
  }
  if (result.kind === "installation_exists") {
    return conflict(
      `This workspace already has a ${get(feishuPlatformName$)} bot`,
    );
  }
  const status = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      platform: get(feishuPlatform$),
      userId: auth.userId,
      publicBrand,
      isAdmin: auth.orgRole === "admin",
      preferredInstallationId: result.installationId,
    }),
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: status };
});

const remove$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return get(feishuIntegrationDisabled$);
  }
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired(get(feishuPlatformName$));
  }
  const status = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      platform: get(feishuPlatform$),
      userId: auth.userId,
      publicBrand: PUBLIC_BRAND,
      isAdmin: true,
    }),
  );
  signal.throwIfAborted();
  if (!status.installationId) {
    return notFound(`${get(feishuPlatformName$)} integration not found`);
  }
  const removed = await set(
    removeFeishuInstallation$,
    {
      orgId: auth.orgId,
      platform: get(feishuPlatform$),
      installationId: status.installationId,
    },
    signal,
  );
  signal.throwIfAborted();
  return removed
    ? { status: 200 as const, body: { success: true as const } }
    : notFound(`${get(feishuPlatformName$)} integration not found`);
});

const updateInstallation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(feishuIntegrationEnabled$))) {
      return get(feishuIntegrationDisabled$);
    }
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired(get(feishuPlatformName$));
    }
    const params = get(pathParamsOf(feishuConnectContract.updateInstallation));
    const bodyResult = await get(
      bodyResultOf(feishuConnectContract.updateInstallation),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const updated = await set(
      updateFeishuInstallationAgent$,
      {
        orgId: auth.orgId,
        platform: get(feishuPlatform$),
        userId: auth.userId,
        installationId: params.installationId,
        defaultAgentId: bodyResult.data.defaultAgentId,
        setupCompleted: bodyResult.data.setupCompleted,
      },
      signal,
    );
    if (updated.kind === "agent_not_found") {
      return badRequestMessage("Select an agent from this organization");
    }
    if (updated.kind === "installation_not_found") {
      return notFound(`${get(feishuPlatformName$)} integration not found`);
    }
    if (updated.kind === "bot_identity_mismatch") {
      return conflict(
        `The ${get(feishuPlatformName$)} app now resolves to a different bot identity. Restore the original app credentials or configure a separate installation.`,
      );
    }
    const status = await get(
      feishuConnectStatus({
        orgId: auth.orgId,
        platform: get(feishuPlatform$),
        userId: auth.userId,
        publicBrand: PUBLIC_BRAND,
        isAdmin: auth.orgRole === "admin",
        preferredInstallationId: params.installationId,
      }),
    );
    signal.throwIfAborted();
    const installation = status.installations?.find((item) => {
      return item.id === params.installationId;
    });
    return installation
      ? { status: 200 as const, body: installation }
      : notFound(`${get(feishuPlatformName$)} integration not found`);
  },
);

const removeInstallation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(feishuIntegrationEnabled$))) {
      return get(feishuIntegrationDisabled$);
    }
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired(get(feishuPlatformName$));
    }
    const params = get(pathParamsOf(feishuConnectContract.removeInstallation));
    const removed = await set(
      removeFeishuInstallation$,
      {
        orgId: auth.orgId,
        platform: get(feishuPlatform$),
        installationId: params.installationId,
      },
      signal,
    );
    signal.throwIfAborted();
    return removed
      ? { status: 200 as const, body: { success: true as const } }
      : notFound(`${get(feishuPlatformName$)} integration not found`);
  },
);

const disconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return get(feishuIntegrationDisabled$);
  }
  const auth = get(organizationAuthContext$);
  const status = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      platform: get(feishuPlatform$),
      userId: auth.userId,
      publicBrand: PUBLIC_BRAND,
      isAdmin: auth.orgRole === "admin",
    }),
  );
  signal.throwIfAborted();
  if (!status.installationId) {
    return notFound(`${get(feishuPlatformName$)} connection not found`);
  }
  const disconnected = await set(
    disconnectFeishuConnection$,
    {
      orgId: auth.orgId,
      platform: get(feishuPlatform$),
      userId: auth.userId,
      installationId: status.installationId,
    },
    signal,
  );
  signal.throwIfAborted();
  return disconnected
    ? { status: 200 as const, body: { success: true as const } }
    : notFound(`${get(feishuPlatformName$)} connection not found`);
});

const disconnectInstallation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(feishuIntegrationEnabled$))) {
      return get(feishuIntegrationDisabled$);
    }
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(feishuConnectContract.disconnectInstallation),
    );
    const disconnected = await set(
      disconnectFeishuConnection$,
      {
        orgId: auth.orgId,
        platform: get(feishuPlatform$),
        userId: auth.userId,
        installationId: params.installationId,
      },
      signal,
    );
    signal.throwIfAborted();
    return disconnected
      ? { status: 200 as const, body: { success: true as const } }
      : notFound(`${get(feishuPlatformName$)} connection not found`);
  },
);

const auth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

function connectRoutes(
  contract: typeof feishuConnectContract | typeof larkConnectContract,
): readonly RouteEntry[] {
  return [
    {
      route: contract.getStatus,
      handler: authRoute(auth, getStatus$),
    },
    {
      route: contract.checkAppId,
      handler: authRoute(auth, checkAppId$),
    },
    {
      route: contract.setup,
      handler: authRoute(auth, setup$),
    },
    {
      route: contract.updateInstallation,
      handler: authRoute(auth, updateInstallation$),
    },
    {
      route: contract.removeInstallation,
      handler: authRoute(auth, removeInstallation$),
    },
    {
      route: contract.disconnectInstallation,
      handler: authRoute(auth, disconnectInstallation$),
    },
    {
      route: contract.remove,
      handler: authRoute(auth, remove$),
    },
    {
      route: contract.disconnect,
      handler: authRoute(auth, disconnect$),
    },
  ];
}
export const feishuConnectRoutes: readonly RouteEntry[] = [
  ...connectRoutes(feishuConnectContract),
  ...connectRoutes(larkConnectContract),
];
