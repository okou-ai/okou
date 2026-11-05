import {
  initClient,
  type ServerInferRequest,
  type ServerInferResponseBody,
} from "@okouai/api-contracts/contracts/trpc-contract";
import {
  workflowVisibilityContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowAutomationsContract,
  type WorkflowFileEntry,
  type WorkflowDetailResponse,
  type WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { getClientConfig, handleError } from "../core/client-factory";

export type WorkflowAutomationCreateRequest = ServerInferRequest<
  typeof workflowAutomationsContract.create
>["body"];
export type WorkflowAutomationUpdateRequest = ServerInferRequest<
  typeof workflowAutomationsContract.update
>["body"];
export type WorkflowAutomationSummary = ServerInferResponseBody<
  typeof workflowAutomationsContract.get,
  200
>;
type WorkflowAutomationListEntry = ServerInferResponseBody<
  typeof workflowAutomationsContract.listWorkspace,
  200
>[number];

export async function listWorkflows(query: {
  agentId?: string;
}): Promise<WorkflowSummary[]> {
  const config = await getClientConfig();
  const client = initClient(workflowsCollectionContract, config);
  const result = await client.list({ query });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list workflows");
}

export async function createWorkflow(body: {
  agentId: string;
  chatThreadId?: string;
  name: string;
  instruction?: string;
  files?: WorkflowFileEntry[];
  displayName?: string;
  description?: string;
  visibility?: "public" | "private";
}): Promise<WorkflowSummary> {
  const config = await getClientConfig();
  const client = initClient(workflowsCollectionContract, config);
  const result = await client.create({ body });
  if (result.status === 201) return result.body;
  handleError(result, `Failed to create workflow "${body.name}"`);
}

export async function getWorkflow(
  workflowId: string,
): Promise<WorkflowDetailResponse> {
  const config = await getClientConfig();
  const client = initClient(workflowsDetailContract, config);
  const result = await client.get({ params: { workflowId } });
  if (result.status === 200) return result.body;
  handleError(result, `Workflow "${workflowId}" not found`);
}

export async function updateWorkflow(
  workflowId: string,
  body: {
    instruction?: string | null;
    files?: WorkflowFileEntry[];
    displayName?: string | null;
    description?: string | null;
  },
): Promise<WorkflowDetailResponse> {
  const config = await getClientConfig();
  const client = initClient(workflowsDetailContract, config);
  const result = await client.update({ params: { workflowId }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update workflow "${workflowId}"`);
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(workflowsDetailContract, config);
  const result = await client.delete({ params: { workflowId } });
  if (result.status === 204) return;
  handleError(result, `Workflow "${workflowId}" not found`);
}

export async function copyWorkflow(
  workflowId: string,
  toAgentId: string,
): Promise<WorkflowSummary> {
  const config = await getClientConfig();
  const client = initClient(workflowsDetailContract, config);
  const result = await client.copy({
    params: { workflowId },
    body: { toAgentId },
  });
  if (result.status === 201) return result.body;
  handleError(result, `Failed to copy workflow "${workflowId}"`);
}

export async function listWorkflowAutomations(
  workflowId: string,
): Promise<readonly WorkflowAutomationSummary[]> {
  const config = await getClientConfig();
  const client = initClient(workflowAutomationsContract, config);
  const result = await client.list({ params: { workflowId } });
  if (result.status === 200) return result.body;
  handleError(
    result,
    `Failed to list automations for workflow "${workflowId}"`,
  );
}

export async function listWorkspaceWorkflowAutomations(): Promise<
  readonly WorkflowAutomationListEntry[]
> {
  const config = await getClientConfig();
  const client = initClient(workflowAutomationsContract, config);
  const result = await client.listWorkspace({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list workflow automations");
}

export async function createWorkflowAutomation(
  workflowId: string,
  body: WorkflowAutomationCreateRequest,
): Promise<WorkflowAutomationSummary> {
  const config = await getClientConfig();
  const client = initClient(workflowAutomationsContract, config);
  const result = await client.create({ params: { workflowId }, body });
  if (result.status === 201) return result.body;
  handleError(result, `Failed to add automation to workflow "${workflowId}"`);
}

export async function getWorkflowAutomation(
  id: string,
): Promise<WorkflowAutomationSummary> {
  const config = await getClientConfig();
  const client = initClient(workflowAutomationsContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Workflow automation "${id}" not found`);
}

export async function updateWorkflowAutomation(
  id: string,
  body: WorkflowAutomationUpdateRequest,
): Promise<WorkflowAutomationSummary> {
  const config = await getClientConfig();
  const client = initClient(workflowAutomationsContract, config);
  const result = await client.update({ params: { id }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update workflow automation "${id}"`);
}

export async function deleteWorkflowAutomation(id: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(workflowAutomationsContract, config);
  const result = await client.delete({ params: { id } });
  if (result.status === 204) return;
  handleError(result, `Workflow automation "${id}" not found`);
}

export async function enableWorkflowAutomation(
  id: string,
): Promise<WorkflowAutomationSummary> {
  const config = await getClientConfig();
  const client = initClient(workflowAutomationsContract, config);
  const result = await client.enable({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to enable workflow automation "${id}"`);
}

export async function disableWorkflowAutomation(
  id: string,
): Promise<WorkflowAutomationSummary> {
  const config = await getClientConfig();
  const client = initClient(workflowAutomationsContract, config);
  const result = await client.disable({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to disable workflow automation "${id}"`);
}

export async function setWorkflowVisibility(
  workflowId: string,
  visibility: "public" | "private",
): Promise<WorkflowSummary> {
  const client = initClient(
    workflowVisibilityContract,
    await getClientConfig(),
  );
  const result =
    visibility === "public"
      ? await client.publish({ params: { workflowId } })
      : await client.demote({ params: { workflowId } });
  if (result.status === 200) return result.body;
  handleError(
    result,
    `Failed to ${visibility === "public" ? "publish" : "unpublish"} workflow "${workflowId}"`,
  );
}
