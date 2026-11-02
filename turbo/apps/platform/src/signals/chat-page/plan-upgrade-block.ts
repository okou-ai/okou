import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import { openSettingsBillingPlansDialog$ } from "../okou-page/settings/settings-dialog.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";
import { logsListContract } from "@okouai/api-contracts/client/logs";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { computed, type Computed } from "ccstate";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { billingStatusAsync$ } from "../okou-page/billing.ts";
import { pathname$ } from "../route.ts";
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

/** Only the latest successfully completed response can own a trailing card. */
function completedResponseRunId(
  groups: readonly ChatEventGroup[],
): string | undefined {
  const lastGroup = groups.at(-1);
  if (lastGroup?.role !== "assistant") {
    return undefined;
  }
  const completion = lastGroup.events
    .slice()
    .reverse()
    .find((event) => {
      return isChatRunTerminalEventType(event.eventType);
    });
  return completion?.eventType === "run.completed"
    ? completion.runId
    : undefined;
}

export function createFirstTaskUpgradeEligibility(
  groups$: Computed<ChatEventGroup[]>,
) {
  const completedRunId$ = computed((get) => {
    return completedResponseRunId(get(groups$));
  });
  return computed(async (get): Promise<boolean> => {
    const owner = get(authenticatedSessionKey$);
    const enabled = get(featureSwitch$)[FeatureSwitchKey.FirstTaskUpgrade];
    const runId = get(completedRunId$);
    // Refresh the history check when returning from another chat.
    get(pathname$);
    if (!owner || !enabled || !runId) {
      return false;
    }
    const client = get(apiClient$)(logsListContract);
    const billing = await get(billingStatusAsync$);
    if (billing.tier !== "limited-free-1") {
      return false;
    }
    // This authenticated history spans the user's chats in the workspace.
    // Include every status so a second task never becomes a "first" offer.
    const result = await accept(
      client.list({ query: { limit: 2, triggerSource: "web" } }),
      [200],
    );
    const onlyRun = result.body.data[0];
    return (
      !result.body.pagination.hasMore &&
      result.body.data.length === 1 &&
      onlyRun?.id === runId &&
      onlyRun.status === "completed"
    );
  });
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
