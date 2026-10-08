import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  WORKFLOW_TEMPLATE_ITEMS,
  type WorkflowTemplateItem,
} from "@okouai/core/workflow-template-items";
import { command, computed, state } from "ccstate";
import { connectorCatalogItemBySlug } from "../external/connectors.ts";
import { personalModelProviders$ } from "../external/personal-model-providers.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "./settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "./settings/codex-device-auth.ts";

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
      return kind !== "workflow" || workflowTemplate !== undefined;
    })
    .slice(0, START_CARD_COUNT);
});

/**
 * Whether the subscription card leads the row: it stays until the member has
 * any personal model account. Personal accounts are only ever Claude or Codex
 * subscriptions, so an empty list is exactly "nothing connected yet". A
 * successful connect reloads the list, which retires the card in place.
 */
export const startCardSubscriptionPinned$ = computed(
  async (get): Promise<boolean> => {
    const { modelProviders } = await get(personalModelProviders$);
    return modelProviders.length === 0;
  },
);

export type StartCardSubscriptionProvider =
  "codex-oauth-token" | "claude-code-oauth-token";

/** Opens the chosen personal subscription connection on every plan. */
export const connectStartCardSubscription$ = command(
  async (
    { set },
    provider: StartCardSubscriptionProvider,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const args = { mode: "connect" as const };
    if (provider === "codex-oauth-token") {
      await set(openCodexDeviceAuthDialogPersonal$, args, signal);
      return;
    }
    await set(openClaudeCodeDeviceAuthDialogPersonal$, args, signal);
  },
);
