import type {
  OfficialWorkflowCatalogReleasePayload as ApiOfficialWorkflowCatalogReleasePayload,
  OfficialWorkflowDefinitionRevisionPayload as ApiOfficialWorkflowDefinitionRevisionPayload,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";

export type OfficialWorkflowCatalogReleasePayload =
  ApiOfficialWorkflowCatalogReleasePayload;
export type OfficialWorkflowDefinitionRevisionPayload =
  ApiOfficialWorkflowDefinitionRevisionPayload;

/** Additive release metadata; older releases default to no hidden threads. */
export type OfficialWorkflowHiddenThreadDefinitionNames = readonly string[];
