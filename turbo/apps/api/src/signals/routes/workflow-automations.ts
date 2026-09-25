import { command, computed } from "ccstate";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import {
  AUTONOMY_BUDGET_EXHAUSTED_MESSAGE,
  autonomyBudgetExhausted,
  badRequestMessage,
  conflict,
  notFound,
  teamRequired,
} from "../../lib/error";
import {
  childAutonomyBudget,
  loadOwnedRunAutonomyBudget,
} from "../services/autonomy-budget.service";
import {
  loadVisibleWorkflowById,
  type WorkflowMember,
} from "../services/workflow-data.service";
import {
  createWorkflowAutomation$,
  deleteWorkflowAutomation$,
  disableWorkflowAutomation$,
  enableWorkflowAutomation$,
  getWorkflowAutomation,
  listThreadBoundWorkflowAutomations,
  listWorkspaceWorkflowAutomations,
  loadWorkflowAutomations,
  revealWorkflowWebhookSecret,
  runOwnedWorkflowAutomationNow$,
  updateWorkflowAutomation$,
  type AutomationResult,
} from "../services/workflow-automation.service";
import type { RouteEntry, SignalRouteHandler } from "../route-entry";

const workflowAutomationReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const workflowWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

function memberFromAuth(auth: {
  readonly userId: string;
  readonly orgRole?: string | null;
}): WorkflowMember {
  return { userId: auth.userId, role: auth.orgRole ?? "member" };
}

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

function automationErrorResponse(
  result: AutomationResult,
  notFoundMessage = "Workflow automation not found",
) {
  switch (result.kind) {
    case "not-found": {
      return notFound(notFoundMessage);
    }
    case "forbidden": {
      return forbidden(result.message);
    }
    case "conflict": {
      return conflict(result.message);
    }
    case "team-required": {
      return teamRequired(result.message);
    }
    case "bad-request": {
      return badRequestMessage(result.message);
    }
    default: {
      throw new Error(`Unexpected automation result: ${result.kind}`);
    }
  }
}

const createAutomationBody$ = bodyResultOf(workflowAutomationsContract.create);
const updateAutomationBody$ = bodyResultOf(workflowAutomationsContract.update);

const workspaceWorkflowAutomationEntries$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  return await listWorkspaceWorkflowAutomations(db, {
    orgId: auth.orgId,
    member: memberFromAuth(auth),
  });
});

const listWorkspaceAutomationsInner$ = computed(async (get) => {
  const entries = await get(workspaceWorkflowAutomationEntries$);
  return {
    status: 200 as const,
    body: [...entries],
  };
});

const listChatThreadAutomationsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(
    pathParamsOf(workflowAutomationsContract.listForChatThread),
  );
  const db = get(db$);
  const automations = await listThreadBoundWorkflowAutomations(db, {
    orgId: auth.orgId,
    userId: auth.userId,
    threadId: params.threadId,
  });
  return { status: 200 as const, body: [...automations] };
});

const listAutomationsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(workflowAutomationsContract.list));
  const db = get(db$);
  const visible = await loadVisibleWorkflowById(db, {
    orgId: auth.orgId,
    member: memberFromAuth(auth),
    workflowId: params.workflowId,
  });
  if (!visible) {
    return notFound(`Workflow not found: ${params.workflowId}`);
  }
  const automations = await loadWorkflowAutomations(db, {
    orgId: auth.orgId,
    workflowId: visible.workflow.id,
    userId: auth.userId,
  });
  return { status: 200 as const, body: [...automations] };
});

const createAutomationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(workflowAutomationsContract.create));
    const bodyResult = await get(createAutomationBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    let autonomyBudget: number | undefined;
    const db = get(db$);
    if (auth.tokenType === "agent") {
      const sourceAutonomyBudget = await loadOwnedRunAutonomyBudget(db, {
        runId: auth.runId,
        orgId: auth.orgId,
        userId: auth.userId,
      });
      signal.throwIfAborted();
      if (sourceAutonomyBudget === null) {
        return notFound("Source run not found");
      }
      const derived = childAutonomyBudget(sourceAutonomyBudget);
      if (derived.kind === "exhausted") {
        return autonomyBudgetExhausted();
      }
      autonomyBudget = derived.autonomyBudget;
    }

    const automationInputBase = {
      orgId: auth.orgId,
      member: memberFromAuth(auth),
      workflowId: params.workflowId,
      enabled: bodyResult.data.enabled ?? true,
      ...(autonomyBudget === undefined ? {} : { autonomyBudget }),
    };
    const result = await set(
      createWorkflowAutomation$,
      { ...bodyResult.data, ...automationInputBase },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 201 as const, body: result.summary };
    }
    return automationErrorResponse(
      result,
      `Workflow not found: ${params.workflowId}`,
    );
  },
);

const getAutomationInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(workflowAutomationsContract.get));
  const db = get(db$);
  const automation = await getWorkflowAutomation(db, {
    orgId: auth.orgId,
    member: memberFromAuth(auth),
    automationId: params.id,
  });
  if (!automation) {
    return notFound("Workflow automation not found");
  }
  return { status: 200 as const, body: automation };
});

const revealWebhookSecretInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(
    pathParamsOf(workflowAutomationsContract.revealWebhookSecret),
  );
  const db = get(db$);
  const secret = await revealWorkflowWebhookSecret(db, {
    orgId: auth.orgId,
    member: memberFromAuth(auth),
    automationId: params.id,
  });
  if (!secret) {
    return notFound("Workflow webhook automation not found");
  }
  return { status: 200 as const, body: secret };
});

const updateAutomationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(workflowAutomationsContract.update));
    const bodyResult = await get(updateAutomationBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      updateWorkflowAutomation$,
      "schedule" in bodyResult.data
        ? {
            orgId: auth.orgId,
            member: memberFromAuth(auth),
            automationId: params.id,
            schedule: bodyResult.data.schedule,
          }
        : {
            orgId: auth.orgId,
            member: memberFromAuth(auth),
            automationId: params.id,
            eventConfig: bodyResult.data.eventConfig,
          },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 200 as const, body: result.summary };
    }
    return automationErrorResponse(result);
  },
);

const deleteAutomationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(workflowAutomationsContract.delete));
    const result = await set(
      deleteWorkflowAutomation$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        automationId: params.id,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "deleted") {
      return { status: 204 as const, body: undefined };
    }
    return automationErrorResponse(result);
  },
);

const enableAutomationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(workflowAutomationsContract.enable));
    let inheritedAutonomyBudget: number | undefined;
    const db = get(db$);
    if (auth.tokenType === "agent") {
      const sourceAutonomyBudget = await loadOwnedRunAutonomyBudget(db, {
        runId: auth.runId,
        orgId: auth.orgId,
        userId: auth.userId,
      });
      signal.throwIfAborted();
      if (sourceAutonomyBudget === null) {
        return notFound("Source run not found");
      }
      const derived = childAutonomyBudget(sourceAutonomyBudget);
      if (derived.kind === "exhausted") {
        return autonomyBudgetExhausted();
      }
      inheritedAutonomyBudget = derived.autonomyBudget;
    }
    const result = await set(
      enableWorkflowAutomation$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        automationId: params.id,
        ...(inheritedAutonomyBudget === undefined
          ? {}
          : { inheritedAutonomyBudget }),
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 200 as const, body: result.summary };
    }
    return automationErrorResponse(result);
  },
);

const disableAutomationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(workflowAutomationsContract.disable));
    const result = await set(
      disableWorkflowAutomation$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        automationId: params.id,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 200 as const, body: result.summary };
    }
    return automationErrorResponse(result);
  },
);

const runAutomationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(workflowAutomationsContract.run));
    const result = await set(
      runOwnedWorkflowAutomationNow$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        automationId: params.id,
        ...(auth.tokenType === "agent" ? { sourceRunId: auth.runId } : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok" || result.kind === "enqueued") {
      return {
        status: 201 as const,
        body: {
          runId: result.kind === "ok" ? result.runId : null,
          chatThreadId: result.chatThreadId,
        },
      };
    }
    if (result.kind === "run_error") {
      return result.response;
    }
    if (
      result.kind === "conflict" &&
      result.message === AUTONOMY_BUDGET_EXHAUSTED_MESSAGE
    ) {
      return autonomyBudgetExhausted();
    }
    return automationErrorResponse(result);
  },
);

const workflowAutomationRouteHandlers: Readonly<
  Record<keyof typeof workflowAutomationsContract, SignalRouteHandler<unknown>>
> = {
  listWorkspace: authRoute(
    workflowAutomationReadAuth,
    listWorkspaceAutomationsInner$,
  ),
  listForChatThread: authRoute(
    workflowAutomationReadAuth,
    listChatThreadAutomationsInner$,
  ),
  list: authRoute(workflowAutomationReadAuth, listAutomationsInner$),
  create: authRoute(workflowWriteAuth, createAutomationInner$),
  get: authRoute(workflowAutomationReadAuth, getAutomationInner$),
  update: authRoute(workflowWriteAuth, updateAutomationInner$),
  delete: authRoute(workflowWriteAuth, deleteAutomationInner$),
  enable: authRoute(workflowWriteAuth, enableAutomationInner$),
  disable: authRoute(workflowWriteAuth, disableAutomationInner$),
  run: authRoute(workflowWriteAuth, runAutomationInner$),
  revealWebhookSecret: authRoute(workflowWriteAuth, revealWebhookSecretInner$),
};

export const workflowAutomationsRoutes: readonly RouteEntry[] = [
  {
    route: workflowAutomationsContract.listWorkspace,
    handler: workflowAutomationRouteHandlers.listWorkspace,
  },
  {
    route: workflowAutomationsContract.listForChatThread,
    handler: workflowAutomationRouteHandlers.listForChatThread,
  },
  {
    route: workflowAutomationsContract.list,
    handler: workflowAutomationRouteHandlers.list,
  },
  {
    route: workflowAutomationsContract.create,
    handler: workflowAutomationRouteHandlers.create,
  },
  {
    route: workflowAutomationsContract.get,
    handler: workflowAutomationRouteHandlers.get,
  },
  {
    route: workflowAutomationsContract.update,
    handler: workflowAutomationRouteHandlers.update,
  },
  {
    route: workflowAutomationsContract.delete,
    handler: workflowAutomationRouteHandlers.delete,
  },
  {
    route: workflowAutomationsContract.enable,
    handler: workflowAutomationRouteHandlers.enable,
  },
  {
    route: workflowAutomationsContract.disable,
    handler: workflowAutomationRouteHandlers.disable,
  },
  {
    route: workflowAutomationsContract.run,
    handler: workflowAutomationRouteHandlers.run,
  },
  {
    route: workflowAutomationsContract.revealWebhookSecret,
    handler: workflowAutomationRouteHandlers.revealWebhookSecret,
  },
];
