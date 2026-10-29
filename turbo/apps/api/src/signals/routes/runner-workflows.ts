import { command, computed } from "ccstate";
import { runnersWorkflowDownloadContract } from "@okouai/api-contracts/contracts/runners";
import { notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { createWorkflowDownload } from "../services/workflow-download.service";

const workflowScope$ = computed((get) => {
  const auth = get(authContext$);
  if (auth.tokenType !== "sandbox") {
    throw new Error("Workflow download requires its sandbox auth scope");
  }
  const params = get(pathParamsOf(runnersWorkflowDownloadContract.get));
  return {
    ...params,
    authRunId: auth.runId,
    userId: auth.userId,
    orgId: auth.orgId,
  };
});
const currentWorkflow$ = createWorkflowDownload(workflowScope$);

const downloadWorkflow$ = command(async ({ get, set }, signal: AbortSignal) => {
  const workflow = await get(currentWorkflow$);
  signal.throwIfAborted();
  set(setResHeader$, "Cache-Control", "no-store");
  return workflow
    ? { status: 200 as const, body: workflow }
    : notFound("Workflow unavailable");
});

export const runnerWorkflowRoutes: readonly RouteEntry[] = [
  {
    route: runnersWorkflowDownloadContract.get,
    handler: authRoute(
      { accept: ["sandbox"], acceptAnySandboxCapability: true },
      downloadWorkflow$,
    ),
    streamJsonResponse: true,
  },
];
