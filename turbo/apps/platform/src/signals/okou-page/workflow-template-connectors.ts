import { WORKFLOW_TEMPLATE_ITEMS } from "@okouai/core/workflow-template-items";
import { connectorCatalogBriefs } from "../external/connectors.ts";

/**
 * Label and icon for every connector a built-in workflow template names, in one
 * request. Template cards read it for their icon row; a slug the current user
 * cannot see is absent and its icon is left out.
 */
export const workflowTemplateConnectorBriefs$ = connectorCatalogBriefs(
  WORKFLOW_TEMPLATE_ITEMS.flatMap((item) => {
    return item.connectorSlugs;
  }),
);
