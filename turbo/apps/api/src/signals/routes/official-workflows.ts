import {
  officialWorkflowInstallationsContract,
  officialWorkflowsContract,
} from "@okouai/api-contracts/contracts/official-workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command, computed } from "ccstate";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { deleteWorkflow$ } from "../services/workflow-delete.service";
import { workflowDetail$ } from "../services/workflow-detail.service";
import {
  getOfficialWorkflow$,
  getOfficialWorkflowInstallationDefinition$,
  installOfficialWorkflow$,
  listActiveOfficialWorkflows$,
  type OfficialWorkflowInstallResult,
} from "../services/official-workflow-installation.service";
import { reconcileOfficialWorkflowInstallation$ } from "../services/official-workflow-reconciliation.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";

const officialWorkflowReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const officialWorkflowWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

function memberFromAuth(auth: {
  readonly userId: string;
  readonly orgRole?: string | null;
}) {
  return { userId: auth.userId, role: auth.orgRole ?? "member" };
}

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

const officialWorkflowsEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.OfficialWorkflows, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

function mutationFailure(
  result: Exclude<OfficialWorkflowInstallResult, { kind: "ok" }>,
) {
  if (result.kind === "bad-request") {
    return badRequestMessage(result.message);
  }
  if (result.kind === "not-found") {
    return notFound(result.message);
  }
  if (result.kind === "forbidden") {
    return forbidden(result.message);
  }
  return conflict(result.message);
}

const listOfficialWorkflowsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(officialWorkflowsEnabled$))) {
      return forbidden("Official Workflows are not enabled");
    }
    signal.throwIfAborted();
    const workflows = await set(listActiveOfficialWorkflows$, signal);
    return { status: 200 as const, body: [...workflows] };
  },
);

const getOfficialWorkflowInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(officialWorkflowsEnabled$))) {
      return forbidden("Official Workflows are not enabled");
    }
    signal.throwIfAborted();
    const params = get(pathParamsOf(officialWorkflowsContract.get));
    const workflow = await set(
      getOfficialWorkflow$,
      params.definitionName,
      signal,
    );
    return workflow
      ? { status: 200 as const, body: workflow }
      : notFound(`Official Workflow not found: ${params.definitionName}`);
  },
);

const installBody$ = bodyResultOf(officialWorkflowsContract.install);
const installOfficialWorkflowInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await get(officialWorkflowsEnabled$))) {
      return forbidden("Official Workflows are not enabled");
    }
    signal.throwIfAborted();
    const params = get(pathParamsOf(officialWorkflowsContract.install));
    const body = await get(installBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(
      installOfficialWorkflow$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        agentId: body.data.agentId,
        definitionName: params.definitionName,
        blueprints: body.data.blueprints,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return mutationFailure(result);
    }
    const detail = await set(
      workflowDetail$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        workflowId: result.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!detail?.official) {
      throw new Error("Installed Official Workflow is not readable");
    }
    const definition = await set(
      getOfficialWorkflowInstallationDefinition$,
      detail.official.definitionName,
      signal,
    );
    return {
      status: 201 as const,
      body: { workflow: detail, ...(definition ? { definition } : {}) },
    };
  },
);

const getInstallationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(officialWorkflowInstallationsContract.get));
    const detail = await set(
      workflowDetail$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        workflowId: params.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!detail?.official) {
      return notFound(
        `Official Workflow installation not found: ${params.workflowId}`,
      );
    }
    const definition = await set(
      getOfficialWorkflowInstallationDefinition$,
      detail.official.definitionName,
      signal,
    );
    return {
      status: 200 as const,
      body: { workflow: detail, ...(definition ? { definition } : {}) },
    };
  },
);

const reconfigureBody$ = bodyResultOf(
  officialWorkflowInstallationsContract.reconfigure,
);
const reconfigureInstallationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(officialWorkflowInstallationsContract.reconfigure),
    );
    const body = await get(reconfigureBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const reconciliation = await set(
      reconcileOfficialWorkflowInstallation$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        workflowId: params.workflowId,
        overrides: body.data.blueprints,
      },
      signal,
    );
    signal.throwIfAborted();
    const result: OfficialWorkflowInstallResult =
      reconciliation.kind === "current"
        ? { kind: "ok", workflowId: reconciliation.workflowId }
        : reconciliation.kind === "invalid" ||
            reconciliation.kind === "needs-reconfiguration"
          ? { kind: "bad-request", message: reconciliation.message }
          : reconciliation.kind === "not-found"
            ? {
                kind: "not-found",
                message: `Official Workflow installation not found: ${params.workflowId}`,
              }
            : {
                kind: "conflict",
                message:
                  reconciliation.kind === "retry"
                    ? reconciliation.message
                    : "Official Workflow changed during reconfiguration; retry",
              };
    if (result.kind !== "ok") {
      return mutationFailure(result);
    }
    const detail = await set(
      workflowDetail$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        workflowId: result.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!detail?.official) {
      throw new Error("Reconfigured Official Workflow is not readable");
    }
    const definition = await set(
      getOfficialWorkflowInstallationDefinition$,
      detail.official.definitionName,
      signal,
    );
    return {
      status: 200 as const,
      body: { workflow: detail, ...(definition ? { definition } : {}) },
    };
  },
);

const uninstallInstallationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(officialWorkflowInstallationsContract.uninstall),
    );
    const detail = await set(
      workflowDetail$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        workflowId: params.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!detail?.official || detail.ownerUserId !== auth.userId) {
      return notFound(
        `Official Workflow installation not found: ${params.workflowId}`,
      );
    }
    const deleted = await set(
      deleteWorkflow$,
      {
        orgId: auth.orgId,
        workflowId: params.workflowId,
        allowOfficialInstallationDeletion: true,
        serializeOfficialLifecycle: true,
      },
      signal,
    );
    signal.throwIfAborted();
    return deleted
      ? { status: 204 as const, body: undefined }
      : notFound(
          `Official Workflow installation not found: ${params.workflowId}`,
        );
  },
);

export const officialWorkflowRoutes: readonly RouteEntry[] = [
  {
    route: officialWorkflowsContract.list,
    handler: authRoute(officialWorkflowReadAuth, listOfficialWorkflowsInner$),
  },
  {
    route: officialWorkflowsContract.get,
    handler: authRoute(officialWorkflowReadAuth, getOfficialWorkflowInner$),
  },
  {
    route: officialWorkflowsContract.install,
    handler: authRoute(
      officialWorkflowWriteAuth,
      installOfficialWorkflowInner$,
    ),
  },
  {
    route: officialWorkflowInstallationsContract.get,
    handler: authRoute(officialWorkflowReadAuth, getInstallationInner$),
  },
  {
    route: officialWorkflowInstallationsContract.reconfigure,
    handler: authRoute(
      officialWorkflowWriteAuth,
      reconfigureInstallationInner$,
    ),
  },
  {
    route: officialWorkflowInstallationsContract.uninstall,
    handler: authRoute(officialWorkflowWriteAuth, uninstallInstallationInner$),
  },
];
