import { computed, state } from "ccstate";
import {
  WORKFLOW_TEMPLATE_ITEMS,
  type WorkflowTemplateItem,
} from "@okouai/core/workflow-template-items";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorCatalogItemBySlug } from "../external/connectors.ts";

/**
 * Entry kinds on the chat landing page. The values match the template picker
 * categories so a card can open the picker straight on its own tab.
 */
const START_CARD_KINDS = [
  "slides",
  "website",
  "illustration",
  "workflow",
] as const;

export type StartCardKind = (typeof START_CARD_KINDS)[number];

/** Cards shown at once. The remaining kinds surface on the next visit. */
const START_CARD_COUNT = 3;

function shuffled<T>(items: readonly T[]): T[] {
  return items
    .map((item) => {
      return { item, order: Math.random() };
    })
    .sort((left, right) => {
      return left.order - right.order;
    })
    .map((entry) => {
      return entry.item;
    });
}

// Drawn once per page load: the row must not reshuffle while the user reads it.
const internalStartCardOrder$ = state<readonly StartCardKind[]>(
  shuffled(START_CARD_KINDS),
);
const drawnWorkflowTemplate = shuffled(WORKFLOW_TEMPLATE_ITEMS)[0];
const internalStartCardWorkflow$ = state<WorkflowTemplateItem | undefined>(
  drawnWorkflowTemplate,
);

/** The workflow template whose name and connectors the workflow card shows. */
export const startCardWorkflowTemplate$ = computed((get) => {
  return get(internalStartCardWorkflow$);
});

/** Marks shown in the workflow card's flow diagram. */
export interface StartCardConnectorIcon {
  readonly slug: ConnectorSlug;
  readonly icon: PublicConnectorCatalogIcon;
}

// The drawn template is fixed for the page load, so its lookups are built once.
// They resolve one connector each: the chat landing page must not pull the full
// connector catalog just to draw three marks.
const workflowConnectorItems$ = (drawnWorkflowTemplate?.connectorSlugs ?? [])
  .slice(0, 3)
  .map((connectorSlug) => {
    return connectorCatalogItemBySlug(connectorSlug);
  });

export const startCardWorkflowConnectorIcons$ = computed(
  async (get): Promise<readonly StartCardConnectorIcon[]> => {
    const pending = workflowConnectorItems$.map((item$) => {
      return get(item$);
    });
    const items = await Promise.all(pending);
    return items.flatMap((item) => {
      return item ? [{ slug: item.slug, icon: item.icon }] : [];
    });
  },
);

export const startCardKinds$ = computed((get): readonly StartCardKind[] => {
  const workflowTemplate = get(startCardWorkflowTemplate$);
  return get(internalStartCardOrder$)
    .filter((kind) => {
      if (kind === "workflow") {
        return workflowTemplate !== undefined;
      }
      return true;
    })
    .slice(0, START_CARD_COUNT);
});
