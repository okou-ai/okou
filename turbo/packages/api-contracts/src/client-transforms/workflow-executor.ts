import {
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowSummary,
} from "../contracts/workflows";
import type { ClientResponseTransform } from "./types";

// Installed iOS search models require a UUID and use it as the subtitle when
// description is absent. The nil UUID represents an absent executor on the
// wire only. iOS navigation and actions address the real Workflow ID.
function legacyWorkflow<T extends WorkflowSummary>(row: T) {
  return row.agentId === null
    ? {
        ...row,
        agentId: "00000000-0000-0000-0000-000000000000",
        description: row.description ?? `/${row.name}`,
      }
    : row;
}

// Bound these to the last strict reader once the nullable model ships. Remove
// them when the supported iOS floor includes only compatible readers.
export const iosWorkflowListTransform: ClientResponseTransform = {
  client: "ios",
  method: workflowsCollectionContract.list.method,
  path: workflowsCollectionContract.list.path,
  status: 200,
  maxVersion: null,
  since: "#49886",
  transform: (body) => {
    return workflowsCollectionContract.list.responses[200]
      .parse(body)
      .map(legacyWorkflow);
  },
};

export const iosWorkflowDetailTransform: ClientResponseTransform = {
  client: "ios",
  method: workflowsDetailContract.get.method,
  path: workflowsDetailContract.get.path,
  status: 200,
  maxVersion: null,
  since: "#49886",
  transform: (body) => {
    return legacyWorkflow(
      workflowsDetailContract.get.responses[200].parse(body),
    );
  },
};
