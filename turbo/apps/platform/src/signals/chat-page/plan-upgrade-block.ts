import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import { openSettingsBillingPlansDialog$ } from "../okou-page/settings/settings-dialog.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";
import type { Element, Root } from "hast";
import type { ChatEventGroup } from "./chat-event.ts";

export interface PlanUpgradeDescriptor {
  readonly href: string;
}

export interface PlanUpgradeSignals extends PlanUpgradeDescriptor {
  readonly open$: typeof openSettingsBillingPlansDialog$;
}

type PlanUpgradeCardSignalsRegistry = CardSignalsRegistry<
  PlanUpgradeDescriptor,
  PlanUpgradeSignals
>;

function planUpgradeInTree(
  node: Root | Element,
): PlanUpgradeSignals | undefined {
  if (node.type === "element" && node.data?.card?.kind === "plan-upgrade") {
    return node.data.card.signals;
  }
  for (const child of node.children) {
    if (child.type === "element") {
      const upgrade = planUpgradeInTree(child);
      if (upgrade) {
        return upgrade;
      }
    }
  }
  return undefined;
}

/** Only the latest successfully completed response can own a trailing card. */
export function completedResponsePlanUpgrade(
  groups: readonly ChatEventGroup[],
): PlanUpgradeSignals | undefined {
  const lastGroup = groups.at(-1);
  if (lastGroup?.role !== "assistant") {
    return undefined;
  }
  const completion = lastGroup.events
    .slice()
    .reverse()
    .find((event) => {
      return event.eventType === "run.completed";
    });
  if (!completion) {
    return undefined;
  }
  for (const event of lastGroup.events) {
    if (event.runId === completion.runId && event.tree !== undefined) {
      const upgrade = planUpgradeInTree(event.tree);
      if (upgrade) {
        return upgrade;
      }
    }
  }
  return undefined;
}

export function parsePlanUpgradeUrl(
  value: string,
): PlanUpgradeDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  if (
    !url ||
    url.pathname !== "/" ||
    url.searchParams.get("settings") !== "billing" ||
    url.searchParams.get("billingView") !== "plans"
  ) {
    return null;
  }

  return {
    href: "/?settings=billing&billingView=plans",
  };
}

export function createPlanUpgradeCardSignalsRegistry(): PlanUpgradeCardSignalsRegistry {
  return createCardSignalsRegistry(
    (descriptor: PlanUpgradeDescriptor) => {
      return descriptor.href;
    },
    (descriptor) => {
      return {
        ...descriptor,
        open$: openSettingsBillingPlansDialog$,
      };
    },
  );
}
