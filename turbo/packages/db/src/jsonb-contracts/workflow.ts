import type { JsonObject } from "./shared";
import type { WorkflowAttachments as ApiWorkflowAttachments } from "@okouai/api-contracts/contracts/workflow-attachments";
import type { OfficialWorkflowParameterBinding as ApiOfficialWorkflowParameterBinding } from "@okouai/api-contracts/contracts/official-workflow-bindings";

export type WorkflowAttachments = ApiWorkflowAttachments;
export type WorkflowAutomationEventConfig = JsonObject;
export type OfficialWorkflowParameterBinding =
  ApiOfficialWorkflowParameterBinding;
export type OfficialWorkflowParameterBindings =
  OfficialWorkflowParameterBinding[];
