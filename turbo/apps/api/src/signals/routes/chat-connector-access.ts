import { command, computed } from "ccstate";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  badRequestMessage,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { createUserFeatureSwitchContext } from "../services/feature-switches.service";
import { chatConnectorOverview } from "../services/chat-connector-overview.service";
import { isConnectorCatalogUnavailableError } from "../services/connector-catalog-reader.service";
import { settle } from "../utils";
import {
  chatConnectorAccess,
  connectorAccountAccessDefaults,
  setChatConnectorAccessOverride$,
  setChatConnectorCurrent$,
  updateConnectorAccountDefaultEnabled$,
} from "../services/chat-connector-access.service";

const ownerAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;
const unavailable = notFound("Chat connector account access is not available");
const missing = notFound("Chat or connector account not found");
const owner$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return { orgId: auth.orgId, userId: auth.userId };
});
const featureContext$ = createUserFeatureSwitchContext(owner$);
const featureAvailable$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const context = await get(featureContext$);
  signal.throwIfAborted();
  return isFeatureEnabled(FeatureSwitchKey.ConnectorChatAccountAccess, context);
});

const overviewScope$ = computed((get) => {
  return {
    ...get(owner$),
    ...get(queryOf(chatConnectorAccessContract.overview)),
  };
});
const overview$ = chatConnectorOverview(overviewScope$, featureContext$);
const overviewTargetScope$ = computed((get) => {
  const { threadId, ...target } = get(
    queryOf(chatConnectorAccessContract.overviewTarget),
  );
  return { ...get(owner$), ...(threadId ? { threadId } : {}), target };
});
const overviewTarget$ = chatConnectorOverview(
  overviewTargetScope$,
  featureContext$,
);
const overviewHandler$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(featureAvailable$, signal))) {
    return unavailable;
  }
  const result = await settle(get(overview$));
  signal.throwIfAborted();
  if (!result.ok) {
    if (isConnectorCatalogUnavailableError(result.error)) {
      return providerUnavailable(
        "Connector catalog is temporarily unavailable",
      );
    }
    throw result.error;
  }
  return result.value ? { status: 200 as const, body: result.value } : missing;
});
const overviewTargetHandler$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(featureAvailable$, signal))) {
      return unavailable;
    }
    const result = await settle(get(overviewTarget$));
    signal.throwIfAborted();
    if (!result.ok) {
      if (isConnectorCatalogUnavailableError(result.error)) {
        return providerUnavailable(
          "Connector catalog is temporarily unavailable",
        );
      }
      throw result.error;
    }
    return result.value
      ? { status: 200 as const, body: { connector: result.value[0] ?? null } }
      : missing;
  },
);

const defaultsScope$ = computed((get) => {
  return {
    ...get(owner$),
    target: get(queryOf(chatConnectorAccessContract.accountDefaults)),
  };
});
const defaults$ = connectorAccountAccessDefaults(defaultsScope$);
const defaultsHandler$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(featureAvailable$, signal))) {
    return unavailable;
  }
  const body = await get(defaults$);
  signal.throwIfAborted();
  return { status: 200 as const, body };
});
const updateDefaultHandler$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(featureAvailable$, signal))) {
      return unavailable;
    }
    const body = await get(
      bodyResultOf(chatConnectorAccessContract.updateAccountDefault),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const { connectionId } = get(
      pathParamsOf(chatConnectorAccessContract.updateAccountDefault),
    );
    const result = await set(
      updateConnectorAccountDefaultEnabled$,
      { ...get(owner$), target: body.data.target },
      connectionId,
      body.data.enabled,
      signal,
    );
    return result === "conflict"
      ? badRequestMessage("Another default change won; please save again")
      : result
        ? { status: 200 as const, body: result }
        : missing;
  },
);

const threadScope$ = computed((get) => {
  return {
    ...get(owner$),
    chatThreadId: get(pathParamsOf(chatConnectorAccessContract.getThread))
      .threadId,
    target: get(queryOf(chatConnectorAccessContract.getThread)),
  };
});
const threadAccess$ = chatConnectorAccess(threadScope$);
const threadHandler$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(featureAvailable$, signal))) {
    return unavailable;
  }
  const body = await get(threadAccess$);
  signal.throwIfAborted();
  return body ? { status: 200 as const, body } : missing;
});

const overrideScope$ = computed(async (get) => {
  const body = await get(
    bodyResultOf(chatConnectorAccessContract.setThreadOverride),
  );
  return body.ok
    ? {
        ...get(owner$),
        chatThreadId: get(
          pathParamsOf(chatConnectorAccessContract.setThreadOverride),
        ).threadId,
        target: body.data.target,
      }
    : null;
});
const overrideAccess$ = chatConnectorAccess(overrideScope$);
const overrideHandler$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(featureAvailable$, signal))) {
    return unavailable;
  }
  const body = await get(
    bodyResultOf(chatConnectorAccessContract.setThreadOverride),
  );
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { connectionId, threadId } = get(
    pathParamsOf(chatConnectorAccessContract.setThreadOverride),
  );
  const owner = {
    ...get(owner$),
    chatThreadId: threadId,
    target: body.data.target,
  };
  if (
    !(await set(
      setChatConnectorAccessOverride$,
      owner,
      connectionId,
      body.data.enabled,
      signal,
    ))
  ) {
    return missing;
  }
  const response = await get(overrideAccess$);
  signal.throwIfAborted();
  return response ? { status: 200 as const, body: response } : missing;
});

const currentScope$ = computed(async (get) => {
  const body = await get(
    bodyResultOf(chatConnectorAccessContract.setThreadCurrent),
  );
  return body.ok
    ? {
        ...get(owner$),
        chatThreadId: get(
          pathParamsOf(chatConnectorAccessContract.setThreadCurrent),
        ).threadId,
        target: body.data.target,
      }
    : null;
});
const currentAccess$ = chatConnectorAccess(currentScope$);
const currentHandler$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(featureAvailable$, signal))) {
    return unavailable;
  }
  const body = await get(
    bodyResultOf(chatConnectorAccessContract.setThreadCurrent),
  );
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const owner = {
    ...get(owner$),
    chatThreadId: get(
      pathParamsOf(chatConnectorAccessContract.setThreadCurrent),
    ).threadId,
    target: body.data.target,
  };
  const saved = await set(
    setChatConnectorCurrent$,
    owner,
    body.data.connectionId,
    signal,
  );
  const response = await get(currentAccess$);
  signal.throwIfAborted();
  if (!response) {
    return missing;
  }
  return saved
    ? { status: 200 as const, body: response }
    : badRequestMessage("Account is not allowed or available in this chat");
});

export const chatConnectorAccessRoutes: readonly RouteEntry[] = [
  {
    route: chatConnectorAccessContract.overview,
    handler: authRoute(ownerAuth, overviewHandler$),
  },
  {
    route: chatConnectorAccessContract.overviewTarget,
    handler: authRoute(ownerAuth, overviewTargetHandler$),
  },
  {
    route: chatConnectorAccessContract.accountDefaults,
    handler: authRoute(ownerAuth, defaultsHandler$),
  },
  {
    route: chatConnectorAccessContract.updateAccountDefault,
    handler: authRoute(ownerAuth, updateDefaultHandler$),
  },
  {
    route: chatConnectorAccessContract.getThread,
    handler: authRoute(ownerAuth, threadHandler$),
  },
  {
    route: chatConnectorAccessContract.setThreadOverride,
    handler: authRoute(ownerAuth, overrideHandler$),
  },
  {
    route: chatConnectorAccessContract.setThreadCurrent,
    handler: authRoute(ownerAuth, currentHandler$),
  },
];
