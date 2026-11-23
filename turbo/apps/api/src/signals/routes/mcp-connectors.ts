import { command, computed, type Computed } from "ccstate";
import {
  MCP_RUNNER_BINDING_REQUIRED,
  mcpConnectorsContract,
  runnerMcpConnectorsContract,
  type McpConnector,
  type McpConnectorOAuthReauthorizationRequest,
} from "@okouai/api-contracts/contracts/mcp-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { eq } from "drizzle-orm";

import { conflict, notFound, resourceUnavailable } from "../../lib/error";
import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { authorization$ } from "../context/hono";
import { runnerAuth$ } from "../auth/runner-auth";
import { verifyOkouToken } from "../auth/tokens";
import type { RouteEntry } from "../route-entry";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import { startCustomConnectorAutomaticOAuthReauthorization$ } from "../services/custom-connector-oauth2.service";
import { db$ } from "../external/db";
import {
  chatConnectorExecutionReadPlan,
  chatConnectorExecutionFromRows,
} from "../services/chat-connector-execution";
import {
  runMcpConnectorList,
  type RunMcpConnectorScope,
} from "../services/run-mcp-connectors.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";

const runMcpAuth$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("Run MCP connector route requires agent authentication");
  }
  return auth;
});
const runMcpScope$ = computed(async (get) => {
  const auth = get(runMcpAuth$);
  const scope = {
    orgId: auth.orgId,
    userId: auth.userId,
    runId: auth.runId,
    customConnectorSourceIds: auth.customConnectorSourceIds,
    builtinConnectorSourceIds: auth.builtinConnectorSourceIds,
  };
  if (!auth.capabilities.includes("connector-account:switch")) {
    return scope;
  }
  const query = chatConnectorExecutionReadPlan({
    orgId: auth.orgId,
    userId: auth.userId,
    kind: "run",
    runId: auth.runId,
  }).as("mcp_chat_accounts");
  const execution = chatConnectorExecutionFromRows(
    await get(db$).select().from(query),
  );
  return {
    ...scope,
    builtinConnectorSourceIds: Object.fromEntries(
      execution.selections.flatMap(({ target, connectionId }) => {
        return target.kind === "builtin"
          ? [[target.connectorSlug, connectionId]]
          : [];
      }),
    ),
    customConnectorSourceIds: Object.fromEntries(
      execution.selections.flatMap(({ target, connectionId }) => {
        return target.kind === "custom"
          ? [[target.customConnectorId, connectionId]]
          : [];
      }),
    ),
  };
});
const runMcpConnectors$ = runMcpConnectorList(runMcpScope$);

function builtinMcpList(scope$: Computed<Promise<RunMcpConnectorScope>>) {
  return runMcpConnectorList(
    computed(async (get) => {
      const { orgId, userId, runId, builtinConnectorSourceIds } =
        await get(scope$);
      return { orgId, userId, runId, builtinConnectorSourceIds };
    }),
  );
}

const builtinMcpConnectors$ = builtinMcpList(runMcpScope$);
function runnerBindingRequired() {
  return {
    status: 409 as const,
    body: {
      error: {
        code: MCP_RUNNER_BINDING_REQUIRED,
        message: "Resolve MCP connectors through this Run's Runner",
      },
    },
  };
}
const usesRunnerMcpBinding$ = command(
  async (
    { set },
    owner: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    return isFeatureEnabled(
      FeatureSwitchKey.MemberConnectorAccountAccess,
      await set(
        loadUserFeatureSwitchContext$,
        owner.orgId,
        owner.userId,
        signal,
      ),
    );
  },
);

const listRunMcpConnectorsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(runMcpAuth$);
    if (
      auth.capabilities.includes("connector-account:switch") &&
      (await set(usesRunnerMcpBinding$, auth, signal))
    ) {
      return runnerBindingRequired();
    }
    const connectors = await get(runMcpConnectors$);
    signal.throwIfAborted();
    return { status: 200 as const, body: { connectors: [...connectors] } };
  },
);

const reauthorizeMcpOAuth$ = command(
  async (
    { set },
    scope: RunMcpConnectorScope,
    request: McpConnectorOAuthReauthorizationRequest & {
      readonly expectedConnectionId?: string;
    },
    descriptors: readonly McpConnector[],
    signal: AbortSignal,
  ) => {
    const target = request.target;
    const connectionId =
      target.kind === "builtin"
        ? scope.builtinConnectorSourceIds?.[target.connectorSlug]
        : scope.customConnectorSourceIds?.[target.customConnectorId];
    if (
      request.expectedConnectionId !== undefined &&
      request.expectedConnectionId !== connectionId
    ) {
      return conflict(
        "MCP connector account changed before scope reauthorization",
      );
    }
    if (target.kind === "builtin") {
      if (
        !connectionId ||
        !descriptors.some((connector) => {
          return (
            connector.target.kind === "builtin" &&
            connector.target.connectorSlug === target.connectorSlug &&
            connector.connectionId === connectionId
          );
        })
      ) {
        return conflict(
          "MCP reauthorization is unavailable for this run's account",
        );
      }
      const url = new URL(
        `/connectors/${encodeURIComponent(target.connectorSlug)}/reconnect/${encodeURIComponent(connectionId)}`,
        env("APP_URL"),
      );
      return {
        status: 200 as const,
        body: {
          kind: "reconnect" as const,
          connectionId,
          authorizationUrl: url.toString(),
        },
      };
    }
    if (!connectionId) {
      return conflict("MCP OAuth reauthorization is unavailable for this run");
    }
    const result = await set(
      startCustomConnectorAutomaticOAuthReauthorization$,
      {
        orgId: scope.orgId,
        userId: scope.userId,
        connectorId: target.customConnectorId,
        connectionId,
        scopes: request.scopes,
      },
      signal,
    );
    if ("status" in result) {
      return result;
    }
    return {
      status: 200 as const,
      body: { ...result, kind: "oauth" as const },
    };
  },
);

const reauthorizeMcpOAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(runMcpAuth$);
    const body = await get(
      bodyResultOf(mcpConnectorsContract.reauthorizeOAuth),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (
      auth.capabilities.includes("connector-account:switch") &&
      (await set(usesRunnerMcpBinding$, auth, signal))
    ) {
      return runnerBindingRequired();
    }
    const [scope, descriptors] = await Promise.all([
      get(runMcpScope$),
      body.data.target.kind === "builtin" ? get(builtinMcpConnectors$) : [],
    ]);
    signal.throwIfAborted();
    return await set(
      reauthorizeMcpOAuth$,
      scope,
      body.data,
      descriptors,
      signal,
    );
  },
);

const runnerMcpBody$ = bodyResultOf(runnerMcpConnectorsContract.resolve);
const runnerMcpRun$ = computed(async (get) => {
  const { runId } = get(pathParamsOf(runnerMcpConnectorsContract.resolve));
  const [run] = await get(db$)
    .select({
      runId: agentRuns.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return run;
});
const runnerMcpScope$ = computed(async (get) => {
  const [run, body] = await Promise.all([
    get(runnerMcpRun$),
    get(runnerMcpBody$),
  ]);
  if (!run || !body.ok) {
    throw new Error("Runner MCP scope requires a validated request and Run");
  }
  const builtinConnectorSourceIds = new Map<string, string>();
  const customConnectorSourceIds = new Map<string, string>();
  for (const binding of body.data.bindings) {
    if (binding.connectionId === null) {
      continue;
    }
    if (binding.kind === "builtin") {
      builtinConnectorSourceIds.set(
        binding.connectorSlug,
        binding.connectionId,
      );
    } else {
      customConnectorSourceIds.set(
        binding.customConnectorId,
        binding.connectionId,
      );
    }
  }
  return {
    ...run,
    builtinConnectorSourceIds: Object.fromEntries(builtinConnectorSourceIds),
    customConnectorSourceIds: Object.fromEntries(customConnectorSourceIds),
  };
});
const runnerMcpConnectors$ = runMcpConnectorList(runnerMcpScope$);
const runnerBuiltinMcpConnectors$ = builtinMcpList(runnerMcpScope$);

function runTokenAllowsMcp(
  token: string,
  run: Pick<RunMcpConnectorScope, "runId" | "orgId" | "userId">,
  capability: "connector:read" | "connector:write",
): boolean {
  const agent = verifyOkouToken(token);
  return (
    agent !== null &&
    agent.runId === run.runId &&
    agent.orgId === run.orgId &&
    agent.userId === run.userId &&
    agent.capabilities.includes(capability) &&
    agent.capabilities.includes("connector-account:switch")
  );
}

const resolveRunnerMcpInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const [runnerAuthorization, runToken, extra] =
      get(authorization$)?.split("~") ?? [];
    const auth = await set(runnerAuth$, runnerAuthorization, signal);
    signal.throwIfAborted();
    if (!auth || !runToken || extra !== undefined) {
      return {
        status: 401 as const,
        body: {
          error: {
            code: "UNAUTHORIZED",
            message: "Runner authentication required",
          },
        },
      };
    }
    const body = await get(runnerMcpBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const run = await get(runnerMcpRun$);
    signal.throwIfAborted();
    if (!run || run.status !== "running") {
      return notFound("Run not found");
    }
    if (auth.type !== "official-runner" && auth.userId !== run.userId) {
      return resourceUnavailable("Run does not belong to user");
    }
    const request = body.data.request;
    const capability =
      request.kind === "list" ? "connector:read" : "connector:write";
    if (!runTokenAllowsMcp(runToken, run, capability)) {
      return resourceUnavailable(
        "MCP resolution is unavailable for this Run credential",
      );
    }
    const membership = await set(
      getMemberRoleAndUpdateCache$,
      run.orgId,
      run.userId,
      signal,
    );
    if (membership.kind !== "member") {
      return resourceUnavailable(
        "MCP resolution is unavailable for this member",
      );
    }
    if (!(await set(usesRunnerMcpBinding$, run, signal))) {
      return conflict("Runner MCP bindings are unavailable");
    }
    if (request.kind === "list") {
      const descriptors = await get(runnerMcpConnectors$);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { kind: "list" as const, connectors: [...descriptors] },
      };
    }
    const [scope, descriptors] = await Promise.all([
      get(runnerMcpScope$),
      request.target.kind === "builtin" ? get(runnerBuiltinMcpConnectors$) : [],
    ]);
    signal.throwIfAborted();
    const result = await set(
      reauthorizeMcpOAuth$,
      scope,
      request,
      descriptors,
      signal,
    );
    return result.status === 200
      ? {
          status: 200 as const,
          body: { kind: "reauthorize" as const, result: result.body },
        }
      : result;
  },
);

export const mcpConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: runnerMcpConnectorsContract.resolve,
    handler: resolveRunnerMcpInner$,
  },
  {
    route: mcpConnectorsContract.list,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      listRunMcpConnectorsInner$,
    ),
  },
  {
    route: mcpConnectorsContract.reauthorizeOAuth,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:write",
      },
      reauthorizeMcpOAuthInner$,
    ),
  },
];
