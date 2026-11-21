import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowAutomationsContract,
  type WorkflowDetailResponse,
} from "@okouai/api-contracts/contracts/workflows";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export function salesWorkflow(
  context: TestContext,
  overrides: Partial<WorkflowDetailResponse> = {},
): WorkflowDetailResponse {
  const date = "2026-09-12T08:00:00Z";
  return {
    id: context.resourceId,
    agentId: crypto.randomUUID(),
    agentName: "research",
    agentDisplayName: "Research Bot",
    name: "sales-research",
    displayName: "Sales Research",
    description: "Collect leads",
    ownerUserId: "test-user-123",
    createdByUserId: "test-user-123",
    updatedByUserId: "test-user-123",
    createdAt: date,
    updatedAt: date,
    visibility: "private",
    canManage: true,
    canPublish: true,
    official: null,
    importSource: null,
    instruction: "Review the pipeline",
    files: [{ path: "notes.md", size: 9 }],
    fileContents: [{ path: "notes.md", content: "Keep notes" }],
    automations: [],
    ...overrides,
  };
}

export function serveWorkflows(
  context: TestContext,
  read: () => WorkflowDetailResponse[],
) {
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    return respond(200, read());
  });
  context.mocks.api(workflowsDetailContract.get, ({ params, respond }) => {
    const item = read().find((w) => {
      return w.id === params.workflowId;
    });
    return item
      ? respond(200, item)
      : respond(404, { error: { code: "NOT_FOUND", message: "Unavailable" } });
  });
  context.mocks.api(workflowAutomationsContract.list, ({ params, respond }) => {
    return respond(
      200,
      read().find((w) => {
        return w.id === params.workflowId;
      })?.automations ?? [],
    );
  });
}
